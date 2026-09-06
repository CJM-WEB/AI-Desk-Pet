import type {
  CharacterActionDefinitionV2,
  CharacterManifestV2,
  PublishedCharacterActionPresentationV2
} from './character-v2-schema';
import type { CharacterBehaviorStateSnapshot } from './behavior-contracts';
import type { ResolvedBehaviorTarget } from './behavior-target-resolver';
import { resolveCharacterPresentation } from './character-presentation-resolver';

import type { CharacterActionHistoryEntry } from './behavior-scheduler';
export type { CharacterActionHistoryEntry } from './behavior-scheduler';

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
  presentation: PublishedCharacterActionPresentationV2;
  reason: 'semantic' | 'state-preference' | 'default-fallback';
};

const ACTION_UNAVAILABLE = 'CHARACTER_BEHAVIOR_PRESENTATION_UNAVAILABLE';

type ActionCandidate = {
  action: CharacterActionDefinitionV2;
  stateId: string;
  presentation: PublishedCharacterActionPresentationV2;
};

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

/** 定向能力只承诺当前皮肤的精确表现，不能把普通默认回退伪装成目标动作。 */
function hasCurrentSkinPresentation(
  input: CharacterBehaviorActionSelectionInput,
  actionId: string
): boolean {
  return Boolean(input.manifest.skins
    .find(skin => skin.id === input.skinId)
    ?.presentations.some(presentation => (
      presentation.actionId === actionId && presentation.frames.length > 0
    )));
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

type ActionHardConstraintOptions = Readonly<{
  state?: CharacterBehaviorStateSnapshot;
  respectRepeatSuppression?: boolean;
  requireCurrentSkinPresentation?: boolean;
}>;

/** 普通、定向与单动作授权共用同一组状态、方向、时间与表现硬约束。 */
function satisfiesActionHardConstraints(
  action: CharacterActionDefinitionV2,
  input: CharacterBehaviorActionSelectionInput,
  options: ActionHardConstraintOptions = {}
): boolean {
  return matchesStateConstraints(action, options.state ?? input.state)
    && matchesDirection(action, input.direction)
    && !isCoolingDown(action, input)
    && (options.respectRepeatSuppression !== true || !isRepeatSuppressed(action, input))
    && (options.requireCurrentSkinPresentation !== true
      || hasCurrentSkinPresentation(input, action.id));
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
    if (!action || !satisfiesActionHardConstraints(action, input, { state })) return [];

    const resolved = resolveCharacterPresentation(input.manifest, input.skinId, action.id);
    if (!resolved) return [];

    return [{ action, stateId, presentation: resolved.presentation }];
  });
}

/** 按显式私有目标收集逻辑动作归属，后续仍执行全部硬约束。 */
function directedActionReferences(
  input: CharacterBehaviorActionSelectionInput,
  target: Exclude<ResolvedBehaviorTarget, { kind: 'action' }>
): Array<{ actionId: string; stateId: string }> {
  if (target.kind === 'state') {
    const state = input.manifest.states.find(candidate => candidate.id === target.stateId);
    return state?.actionIds.map(actionId => ({ actionId, stateId: state.id })) ?? [];
  }
  if (target.kind === 'state_action') {
    const state = input.manifest.states.find(candidate => candidate.id === target.stateId);
    return state?.actionIds.includes(target.actionId)
      ? [{ actionId: target.actionId, stateId: state.id }]
      : [];
  }

  const stateOrder = [
    input.state.primaryStateId,
    ...input.state.modifierStateIds,
    ...input.manifest.states.map(state => state.id)
  ];
  const seenActionIds = new Set<string>();
  const actionsById = new Map(input.manifest.actions.map(action => [action.id, action]));
  return stateOrder.flatMap(stateId => {
    const state = input.manifest.states.find(candidate => candidate.id === stateId);
    if (!state) return [];
    return state.actionIds.flatMap(actionId => {
      const action = actionsById.get(actionId);
      if (!action || action.semantic !== target.semantic || seenActionIds.has(actionId)) return [];
      seenActionIds.add(actionId);
      return [{ actionId, stateId }];
    });
  });
}

/** 状态目标以即将进入的主/修饰状态校验动作自身的状态白名单。 */
function targetStateContext(
  input: CharacterBehaviorActionSelectionInput,
  stateId: string
): CharacterBehaviorStateSnapshot {
  const targetState = input.manifest.states.find(state => state.id === stateId);
  if (targetState?.kind === 'primary') {
    return { ...input.state, primaryStateId: stateId };
  }
  if (targetState?.kind === 'modifier') {
    return {
      ...input.state,
      modifierStateIds: [...new Set([...input.state.modifierStateIds, stateId])]
    };
  }
  return input.state;
}

/** 对给定动作归属应用与普通选择相同的状态、方向、冷却和表现约束。 */
function eligibleDirectedCandidates(
  input: CharacterBehaviorActionSelectionInput,
  references: readonly { actionId: string; stateId: string }[],
  enterReferencedState: boolean
): ActionCandidate[] {
  const actionsById = new Map(input.manifest.actions.map(action => [action.id, action]));
  return references.flatMap(({ actionId, stateId }) => {
    const action = actionsById.get(actionId);
    if (!action || !satisfiesActionHardConstraints(action, input, {
      ...(enterReferencedState ? { state: targetStateContext(input, stateId) } : {}),
      respectRepeatSuppression: true,
      requireCurrentSkinPresentation: true
    })) return [];

    const resolved = resolveCharacterPresentation(input.manifest, input.skinId, action.id);
    return resolved ? [{ action, stateId, presentation: resolved.presentation }] : [];
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
  const semanticCandidates = state.desiredActionSemantic
    ? repeatAdjustedCandidates.filter((candidate) => candidate.action.semantic === state.desiredActionSemantic)
    : [];
  const candidatesForSelection = semanticCandidates.length
    ? semanticCandidates
    : repeatAdjustedCandidates;
  const selected = selectWeightedCandidate(
    candidatesForSelection,
    input.random
  );

  return selected && {
    actionId: selected.action.id,
    stateId: selected.stateId,
    presentation: selected.presentation
  };
}

/** 选择当前行为状态允许、可播放且可调度的逻辑动作。 */
export function selectCharacterBehaviorAction(
  input: CharacterBehaviorActionSelectionInput
): CharacterBehaviorActionSelection {
  const currentStateIds = [input.state.primaryStateId, ...input.state.modifierStateIds];
  const selected = selectFromStateContext(input, input.state, currentStateIds);
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
  if (!fallback) throw new Error('CHARACTER_BEHAVIOR_PRESENTATION_UNAVAILABLE');

  return { ...fallback, stateId: defaultState.id, reason: 'default-fallback' };
}

/** 为已解析私有目标选择唯一可授权动作，不允许默认待机回退冒充定向结果。 */
export function selectDirectedCharacterBehaviorAction(
  input: CharacterBehaviorActionSelectionInput,
  target: ResolvedBehaviorTarget
): CharacterBehaviorActionSelection {
  if (target.kind === 'action') {
    return authorizeCharacterBehaviorAction(input, target.actionId, {
      respectRepeatSuppression: true,
      requireCurrentSkinPresentation: true
    });
  }

  const candidate = selectWeightedCandidate(
    eligibleDirectedCandidates(
      input,
      directedActionReferences(input, target),
      target.kind === 'state' || target.kind === 'state_action'
    ),
    input.random
  );
  if (!candidate) throw new Error(ACTION_UNAVAILABLE);
  return {
    actionId: candidate.action.id,
    stateId: candidate.stateId,
    presentation: candidate.presentation,
    reason: target.kind === 'semantic' ? 'semantic' : 'state-preference'
  };
}

/** 按配置 ID 重新授权回退动作，并复用状态、方向、冷却与表现硬约束。 */
export function authorizeCharacterBehaviorAction(
  input: CharacterBehaviorActionSelectionInput,
  actionId: string,
  options: Omit<ActionHardConstraintOptions, 'state'> = {}
): CharacterBehaviorActionSelection {
  const action = input.manifest.actions.find((candidate) => candidate.id === actionId);
  const state = input.manifest.states.find((candidate) => candidate.actionIds.includes(actionId));
  if (
    !action
    || !state
    || !satisfiesActionHardConstraints(action, input, options)
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
