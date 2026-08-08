import type {
  CharacterActionDefinitionV2,
  CharacterActionPresentationV2,
  CharacterManifestV2
} from './character-v2-schema';
import type { CharacterBehaviorStateSnapshot } from './behavior-contracts';
import { resolveCharacterPresentation } from './character-presentation-resolver';

export type CharacterActionHistoryEntry = {
  actionId: string;
  startedAtMs: number;
  finishedAtMs: number | null;
  outcome: 'completed' | 'interrupted' | 'failed' | null;
};

export type CharacterActionRecency = {
  latestStartedAtMs: number;
  latestFinishedAtMs: number | null;
};

export type CharacterBehaviorActionSelectionInput = {
  manifest: CharacterManifestV2;
  skinId: string;
  state: CharacterBehaviorStateSnapshot;
  direction: 'left' | 'right';
  nowMs: number;
  history: readonly CharacterActionHistoryEntry[];
  actionRecencyById: Readonly<Record<string, CharacterActionRecency>>;
  random: () => number;
};

export type CharacterBehaviorActionSelection = {
  actionId: string;
  stateId: string;
  presentation: CharacterActionPresentationV2;
  reason: 'semantic' | 'state-preference' | 'default-fallback';
};

const ACTION_UNAVAILABLE = 'CHARACTER_BEHAVIOR_PRESENTATION_UNAVAILABLE';

type ActionCandidate = {
  action: CharacterActionDefinitionV2;
  stateId: string;
  presentation: CharacterActionPresentationV2;
};

const CONTROLLED_PRESENTATION_FALLBACKS: Partial<Record<
  CharacterActionDefinitionV2['semantic'],
  CharacterActionDefinitionV2['semantic']
>> = { hide: 'move', emerge: 'idle' };

/** 按主状态优先、修饰状态快照顺序收集动作归属，避免共享动作的归属随机变化。 */
function referencedActions(
  manifest: CharacterManifestV2,
  state: CharacterBehaviorStateSnapshot,
  stateIds: readonly string[]
): Array<{ actionId: string; stateId: string }> {
  const actions: Array<{ actionId: string; stateId: string }> = [];
  const seenActionIds = new Set<string>();

  for (const stateId of stateIds) {
    const definition = manifest.states.find((candidate) => candidate.id === stateId);
    if (!definition || (stateId !== state.primaryStateId && definition.kind !== 'modifier')) continue;

    for (const actionId of definition.actionIds) {
      if (!seenActionIds.has(actionId)) {
        seenActionIds.add(actionId);
        actions.push({ actionId, stateId });
      }
    }
  }

  return actions;
}

/** 判断动作状态白名单、黑名单和修饰状态约束是否全部满足。 */
function matchesStateConstraints(
  action: CharacterActionDefinitionV2,
  state: CharacterBehaviorStateSnapshot
): boolean {
  const modifierStateIds = new Set(state.modifierStateIds);

  return (
    (action.allowedPrimaryStateIds.length === 0 || action.allowedPrimaryStateIds.includes(state.primaryStateId))
    && !action.forbiddenPrimaryStateIds.includes(state.primaryStateId)
    && action.requiredModifierStateIds.every((stateId) => modifierStateIds.has(stateId))
    && !action.forbiddenModifierStateIds.some((stateId) => modifierStateIds.has(stateId))
  );
}

/** 判断动作方向是否允许当前朝向。 */
function matchesDirection(
  action: CharacterActionDefinitionV2,
  direction: CharacterBehaviorActionSelectionInput['direction']
): boolean {
  return action.direction === 'any' || action.direction === direction;
}

/** 取得指定逻辑动作最近一次用于冷却的结束时间；未结束时使用开始时间。 */
function latestCooldownAt(
  input: CharacterBehaviorActionSelectionInput,
  actionId: string
): number | undefined {
  const indexed = input.actionRecencyById[actionId];
  if (indexed) {
    return Math.max(indexed.latestStartedAtMs, indexed.latestFinishedAtMs ?? -Infinity);
  }
  const values = input.history
    .filter((entry) => entry.actionId === actionId)
    .map((entry) => entry.finishedAtMs ?? entry.startedAtMs);
  return values.length ? Math.max(...values) : undefined;
}

/** 取得指定逻辑动作最近一次开始时间，用于重复抑制。 */
function latestStartedAt(
  input: CharacterBehaviorActionSelectionInput,
  actionId: string
): number | undefined {
  const indexed = input.actionRecencyById[actionId];
  if (indexed) return indexed.latestStartedAtMs;
  const values = input.history
    .filter((entry) => entry.actionId === actionId)
    .map((entry) => entry.startedAtMs);
  return values.length ? Math.max(...values) : undefined;
}

/** 冷却仅在时间已充分经过时解除；未来记录会继续限制动作。 */
function isCoolingDown(
  action: CharacterActionDefinitionV2,
  input: CharacterBehaviorActionSelectionInput
): boolean {
  const lastAtMs = latestCooldownAt(input, action.id);
  return lastAtMs !== undefined && input.nowMs - lastAtMs < action.cooldownMs;
}

/** 重复抑制仅在动作最近一次开始仍处于限制窗口时生效。 */
function isRepeatSuppressed(
  action: CharacterActionDefinitionV2,
  input: CharacterBehaviorActionSelectionInput
): boolean {
  const lastStartedAtMs = latestStartedAt(input, action.id);
  return lastStartedAtMs !== undefined && input.nowMs - lastStartedAtMs < action.repeatSuppressionMs;
}

/** 以注入随机源在正偏好权重中选择一个候选。 */
function selectWeightedCandidate(
  candidates: readonly ActionCandidate[],
  random: () => number
): ActionCandidate | undefined {
  const totalPreference = candidates.reduce((sum, candidate) => sum + candidate.action.preference, 0);
  if (!Number.isFinite(totalPreference) || totalPreference <= 0) return undefined;

  const randomValue = random();
  if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue >= 1) {
    throw new Error('CHARACTER_RANDOM_OUT_OF_RANGE');
  }

  const target = randomValue * totalPreference;
  let accumulatedPreference = 0;
  for (const candidate of candidates) {
    accumulatedPreference += candidate.action.preference;
    if (target < accumulatedPreference) return candidate;
  }

  return candidates.at(-1);
}

/** 以给定状态上下文收集满足所有硬约束且已有可播放表现的候选。 */
function eligibleCandidates(
  input: CharacterBehaviorActionSelectionInput,
  state: CharacterBehaviorStateSnapshot,
  stateIds: readonly string[]
): ActionCandidate[] {
  const actionsById = new Map(input.manifest.actions.map((action) => [action.id, action]));

  return referencedActions(input.manifest, state, stateIds).flatMap(({ actionId, stateId }) => {
    const action = actionsById.get(actionId);
    if (!action || !matchesStateConstraints(action, state) || !matchesDirection(action, input.direction)) {
      return [];
    }

    const resolved = resolveCharacterPresentation(input.manifest, input.skinId, action.id);
    if (!resolved || isCoolingDown(action, input)) return [];

    return [{ action, stateId, presentation: resolved.presentation }];
  });
}

/** 先剔除可替代的重复动作，再按语义与偏好选出一个候选。 */
function selectFromStateContext(
  input: CharacterBehaviorActionSelectionInput,
  state: CharacterBehaviorStateSnapshot,
  stateIds: readonly string[]
): Omit<CharacterBehaviorActionSelection, 'reason'> | undefined {
  const candidates = eligibleCandidates(input, state, stateIds);
  const nonRepeatedCandidates = candidates.filter((candidate) => !isRepeatSuppressed(candidate.action, input));
  const repeatAdjustedCandidates = nonRepeatedCandidates.length ? nonRepeatedCandidates : candidates;
  const semanticCandidates = input.state.desiredActionSemantic
    ? repeatAdjustedCandidates.filter((candidate) => candidate.action.semantic === input.state.desiredActionSemantic)
    : [];
  const selected = selectWeightedCandidate(
    semanticCandidates.length ? semanticCandidates : repeatAdjustedCandidates,
    input.random
  );

  return selected && {
    actionId: selected.action.id,
    stateId: selected.stateId,
    presentation: selected.presentation
  };
}

/** 缺少藏身动作时，仅按清单显式回退复用既有动作和表现。 */
function selectControlledPresentationFallback(
  input: CharacterBehaviorActionSelectionInput,
  state: CharacterBehaviorStateSnapshot
): Omit<CharacterBehaviorActionSelection, 'reason'> | undefined {
  const semantic = state.desiredActionSemantic;
  const targetSemantic = semantic ? CONTROLLED_PRESENTATION_FALLBACKS[semantic] : undefined;
  const skin = input.manifest.skins.find((candidate) => candidate.id === input.skinId);
  const fallback = semantic && targetSemantic
    ? skin?.semanticFallbacks.find((candidate) => candidate.semantic === semantic)
    : undefined;
  const action = fallback ? input.manifest.actions.find((candidate) => candidate.id === fallback.actionId) : undefined;
  if (!action || action.semantic !== targetSemantic || isCoolingDown(action, input)) return undefined;

  const resolved = resolveCharacterPresentation(input.manifest, input.skinId, action.id);
  if (!resolved) return undefined;
  return { actionId: action.id, stateId: state.primaryStateId, presentation: resolved.presentation };
}

/** 选择当前行为状态允许、可播放且可调度的逻辑动作。 */
export function selectCharacterBehaviorAction(
  input: CharacterBehaviorActionSelectionInput
): CharacterBehaviorActionSelection {
  const currentStateIds = [input.state.primaryStateId, ...input.state.modifierStateIds];
  const selected = selectFromStateContext(input, input.state, currentStateIds);
  const selectedSemantic = selected
    ? input.manifest.actions.find((action) => action.id === selected.actionId)?.semantic
    : undefined;
  const controlledFallback = selectedSemantic === input.state.desiredActionSemantic
    ? undefined
    : selectControlledPresentationFallback(input, input.state);
  if (controlledFallback) return { ...controlledFallback, reason: 'semantic' };
  if (selected) {
    return {
      ...selected,
      reason: input.state.desiredActionSemantic === input.manifest.actions.find((action) => action.id === selected.actionId)?.semantic
        ? 'semantic'
        : 'state-preference'
    };
  }

  const defaultState = input.manifest.states.find((state) => state.id === input.manifest.defaultStateId);
  if (!defaultState || defaultState.kind !== 'primary') {
    throw new Error('CHARACTER_BEHAVIOR_PRESENTATION_UNAVAILABLE');
  }

  const defaultContext: CharacterBehaviorStateSnapshot = {
    ...input.state,
    primaryStateId: defaultState.id,
    modifierStateIds: []
  };
  const fallback = selectFromStateContext(input, defaultContext, [defaultState.id]);
  const fallbackSemantic = fallback
    ? input.manifest.actions.find((action) => action.id === fallback.actionId)?.semantic
    : undefined;
  const defaultControlledFallback = fallbackSemantic === defaultContext.desiredActionSemantic
    ? undefined
    : selectControlledPresentationFallback(input, defaultContext);
  if (defaultControlledFallback) return { ...defaultControlledFallback, reason: 'semantic' };
  if (!fallback) throw new Error('CHARACTER_BEHAVIOR_PRESENTATION_UNAVAILABLE');

  return { ...fallback, stateId: defaultState.id, reason: 'default-fallback' };
}

/** 按配置 ID 重新授权回退动作，并复用状态、方向、冷却与表现硬约束。 */
export function authorizeCharacterBehaviorAction(
  input: CharacterBehaviorActionSelectionInput,
  actionId: string
): CharacterBehaviorActionSelection {
  const action = input.manifest.actions.find((candidate) => candidate.id === actionId);
  const state = input.manifest.states.find((candidate) => candidate.actionIds.includes(actionId));
  if (
    !action
    || !state
    || !matchesStateConstraints(action, input.state)
    || !matchesDirection(action, input.direction)
    || isCoolingDown(action, input)
  ) {
    throw new Error(ACTION_UNAVAILABLE);
  }

  const resolved = resolveCharacterPresentation(input.manifest, input.skinId, action.id);
  if (!resolved) throw new Error(ACTION_UNAVAILABLE);
  return {
    actionId: action.id,
    stateId: state.id,
    presentation: resolved.presentation,
    reason: 'state-preference'
  };
}
