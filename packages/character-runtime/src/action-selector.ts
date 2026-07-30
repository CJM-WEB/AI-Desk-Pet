import type {
  ActionClip,
  CharacterManifestV1,
  CharacterStateId
} from './character-schema';

export type ActionSelectionReason = 'matched' | 'idle_fallback';

export type ActionSelectionInput = {
  manifest: CharacterManifestV1;
  stateId: CharacterStateId;
  direction?: 'left' | 'right';
  recentActionIds: readonly string[];
  random: () => number;
};

export type ActionSelectionResult = {
  stateId: CharacterStateId;
  action: ActionClip;
  reason: ActionSelectionReason;
};

function matchesDirection(action: ActionClip, direction: ActionSelectionInput['direction']): boolean {
  return !direction
    || !action.direction
    || action.direction === 'any'
    || action.direction === direction;
}

function hasUsableWeight(action: ActionClip): boolean {
  return Number.isFinite(action.weight) && action.weight > 0;
}

function eligibleActions(
  actions: readonly ActionClip[],
  direction: ActionSelectionInput['direction']
): ActionClip[] {
  const seenActionIds = new Set<string>();

  // 先过滤不可播放动作，再按标识去重，避免损坏数据扩大单个动作的权重。
  return actions.filter((action) => {
    if (
      seenActionIds.has(action.id)
      || action.frames.length === 0
      || !hasUsableWeight(action)
      || !matchesDirection(action, direction)
    ) {
      return false;
    }

    seenActionIds.add(action.id);
    return true;
  });
}

function availableActions(
  actions: readonly ActionClip[],
  direction: ActionSelectionInput['direction'],
  recentActionIds: readonly string[]
): ActionClip[] {
  const candidates = eligibleActions(actions, direction);
  const recentActionIdSet = new Set(recentActionIds);
  const cooledCandidates = candidates.filter((action) => !recentActionIdSet.has(action.id));

  return cooledCandidates.length > 0 ? cooledCandidates : candidates;
}

function selectWeightedAction(actions: readonly ActionClip[], random: () => number): ActionClip | undefined {
  const totalWeight = actions.reduce((sum, action) => sum + action.weight, 0);

  if (!Number.isFinite(totalWeight) || totalWeight <= 0) {
    return undefined;
  }

  const randomValue = random();
  if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue >= 1) {
    throw new Error('CHARACTER_RANDOM_OUT_OF_RANGE');
  }

  const targetWeight = randomValue * totalWeight;
  let accumulatedWeight = 0;

  for (const action of actions) {
    accumulatedWeight += action.weight;
    if (targetWeight < accumulatedWeight) {
      return action;
    }
  }

  return actions.at(-1);
}

function selectFromState(
  manifest: CharacterManifestV1,
  stateId: CharacterStateId,
  direction: ActionSelectionInput['direction'],
  recentActionIds: readonly string[],
  random: () => number
): ActionClip | undefined {
  const state = manifest.states.find((candidate) => candidate.id === stateId);

  return state
    ? selectWeightedAction(availableActions(state.actions, direction, recentActionIds), random)
    : undefined;
}

export function selectCharacterAction(input: ActionSelectionInput): ActionSelectionResult {
  const action = selectFromState(
    input.manifest,
    input.stateId,
    input.direction,
    input.recentActionIds,
    input.random
  );

  if (action) {
    return { stateId: input.stateId, action, reason: 'matched' };
  }

  // 降级只检索当前清单的待机状态，不会访问或借用其他角色的素材。
  const idleAction = selectFromState(
    input.manifest,
    'idle',
    input.direction,
    input.recentActionIds,
    input.random
  );

  if (!idleAction) {
    throw new Error('CHARACTER_IDLE_UNAVAILABLE');
  }

  return { stateId: 'idle', action: idleAction, reason: 'idle_fallback' };
}
