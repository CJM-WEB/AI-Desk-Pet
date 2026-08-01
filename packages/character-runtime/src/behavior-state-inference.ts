import {
  TRUSTED_BEHAVIOR_SIGNALS,
  type CharacterManifestV2,
  type CharacterStateDefinitionV2
} from './character-v2-schema';
import type {
  CharacterAgentBehaviorIntent,
  CharacterBehaviorSignal,
  CharacterBehaviorStateSnapshot,
  CharacterStandardSemantic,
  TrustedBehaviorSignal
} from './behavior-contracts';

export type CharacterBehaviorInferenceInput = {
  manifest: CharacterManifestV2;
  previous: CharacterBehaviorStateSnapshot;
  signal: CharacterBehaviorSignal;
  agentIntent?: CharacterAgentBehaviorIntent;
};

const EDGE_SIGNALS = new Set<TrustedBehaviorSignal>([
  'idle', 'user-interaction', 'conversation-start', 'task-start', 'task-success', 'task-failure'
]);
const PROTECTED_PRIMARY_SEMANTICS = new Set<CharacterStandardSemantic>([
  'think', 'move', 'celebrate', 'fail'
]);

/** 将本次本地事件映射为可参与状态仲裁的标准语义。 */
function signalSemantic(signal: CharacterBehaviorSignal): CharacterStandardSemantic | null {
  switch (signal.type) {
    case 'idle-due': return 'idle';
    case 'conversation-start': return 'listen';
    case 'listening': return signal.active ? 'listen' : null;
    case 'thinking': return signal.active ? 'think' : null;
    case 'movement': return signal.active ? 'move' : null;
    case 'task': return signal.phase === 'success' ? 'celebrate' : signal.phase === 'failure' ? 'fail' : null;
    case 'user-interaction': return null;
  }
}

/** 合并活动事实；边沿信号只对当前一次推断有效。 */
function activeSignals(previous: CharacterBehaviorStateSnapshot, signal: CharacterBehaviorSignal): TrustedBehaviorSignal[] {
  const current = new Set(previous.activeSignals.filter((value) => !EDGE_SIGNALS.has(value)));
  const setMovementSignal = (value: 'move-start' | 'move-stop') => {
    current.delete('move-start');
    current.delete('move-stop');
    current.add(value);
  };

  switch (signal.type) {
    case 'idle-due': current.add('idle'); break;
    case 'user-interaction': current.add('user-interaction'); break;
    case 'conversation-start': current.add('conversation-start'); break;
    case 'listening': signal.active ? current.add('listening') : current.delete('listening'); break;
    case 'thinking': signal.active ? current.add('thinking') : current.delete('thinking'); break;
    case 'task': current.add(`task-${signal.phase}` as TrustedBehaviorSignal); break;
    case 'movement': setMovementSignal(signal.active ? 'move-start' : 'move-stop'); break;
  }

  return TRUSTED_BEHAVIOR_SIGNALS.filter((value): value is TrustedBehaviorSignal => current.has(value));
}

function standardSemantic(state: CharacterStateDefinitionV2): CharacterStandardSemantic | null {
  return typeof state.semantic === 'string' ? state.semantic : null;
}

/** 条件子句始终完整求值，避免 all/any 的短路影响可观察顺序。 */
function conditionMatches(
  condition: CharacterStateDefinitionV2['enterConditions'][number],
  signals: readonly TrustedBehaviorSignal[],
  semantic: CharacterStandardSemantic | null,
  stateIds: ReadonlySet<string>
): boolean {
  const matches = condition.clauses.map((clause) => {
    switch (clause.kind) {
      case 'signal': return signals.includes(clause.signal);
      case 'semantic': return semantic === clause.semantic;
      case 'state': return stateIds.has(clause.stateId);
    }
  });

  return condition.mode === 'all' ? matches.every(Boolean) : matches.some(Boolean);
}

function conditionsMatch(
  conditions: CharacterStateDefinitionV2['enterConditions'],
  signals: readonly TrustedBehaviorSignal[],
  semantic: CharacterStandardSemantic | null,
  stateIds: ReadonlySet<string>
): boolean {
  return conditions.every((condition) => conditionMatches(condition, signals, semantic, stateIds));
}

/** 返回满足进入条件的候选状态，保持清单原始顺序供稳定仲裁使用。 */
function eligibleStates(
  states: readonly CharacterStateDefinitionV2[],
  signals: readonly TrustedBehaviorSignal[],
  inferredStateIds: ReadonlySet<string>
): CharacterStateDefinitionV2[] {
  return states.filter((state) => conditionsMatch(
    state.enterConditions,
    signals,
    standardSemantic(state),
    new Set([...inferredStateIds, state.id])
  ));
}

function sortByIntensity(states: readonly CharacterStateDefinitionV2[]): CharacterStateDefinitionV2[] {
  return states
    .map((state, index) => ({ state, index }))
    .sort((left, right) => right.state.intensity - left.state.intensity || left.index - right.index)
    .map(({ state }) => state);
}

/** 选择单一主状态：先条件、再强度、最后保留清单顺序。 */
function selectPrimaryState(
  states: readonly CharacterStateDefinitionV2[],
  signals: readonly TrustedBehaviorSignal[],
  semantic: CharacterStandardSemantic | null,
  requiredStateId?: string
): CharacterStateDefinitionV2 | undefined {
  const candidates = eligibleStates(states.filter((state) => (
    state.kind === 'primary'
    && (requiredStateId ? state.id === requiredStateId : standardSemantic(state) === semantic)
  )), signals, new Set());

  return sortByIntensity(candidates)[0];
}

function isCompatibleModifier(
  candidate: CharacterStateDefinitionV2,
  selected: readonly CharacterStateDefinitionV2[]
): boolean {
  const selectedIds = new Set(selected.map((state) => state.id));
  if (![...selectedIds].every((stateId) => candidate.coexistWithStateIds.includes(stateId))) return false;
  if ([...selectedIds].some((stateId) => candidate.forbiddenStateIds.includes(stateId))) return false;

  return selected.every((state) => !state.forbiddenStateIds.includes(candidate.id));
}

/** 在主状态确定后按清单顺序选择可共存的修饰状态。 */
function selectModifierStates(
  manifest: CharacterManifestV2,
  previous: CharacterBehaviorStateSnapshot,
  primary: CharacterStateDefinitionV2,
  signals: readonly TrustedBehaviorSignal[]
): CharacterStateDefinitionV2[] {
  const previousModifierIds = new Set(previous.modifierStateIds);
  const selected = [primary];

  manifest.states.filter((state) => state.kind === 'modifier').forEach((candidate) => {
    const stateIds = new Set([...selected.map((state) => state.id), candidate.id]);
    const exited = previousModifierIds.has(candidate.id) && candidate.exitConditions.some((condition) => conditionMatches(
      condition,
      signals,
      standardSemantic(candidate),
      stateIds
    ));
    if (!exited
      && conditionsMatch(candidate.enterConditions, signals, standardSemantic(candidate), stateIds)
      && isCompatibleModifier(candidate, selected)) {
      selected.push(candidate);
    }
  });

  return selected.slice(1);
}

function defaultPrimary(manifest: CharacterManifestV2): CharacterStateDefinitionV2 | undefined {
  return manifest.states.find((state) => state.id === manifest.defaultStateId && state.kind === 'primary');
}

function isProtectedPrimary(manifest: CharacterManifestV2, stateId: string): boolean {
  const state = manifest.states.find((candidate) => candidate.id === stateId);
  const semantic = state ? standardSemantic(state) : null;
  return Boolean(semantic && PROTECTED_PRIMARY_SEMANTICS.has(semantic));
}

type AgentSelection = { valid: true; semantic: CharacterStandardSemantic | null; stateId?: string }
  | { valid: false; semantic: null };

function agentSelection(
  manifest: CharacterManifestV2,
  intent: CharacterAgentBehaviorIntent | undefined
): AgentSelection {
  const stateIntent = intent?.stateIntent;
  if (!stateIntent) return { valid: true, semantic: null };
  if ('stateId' in stateIntent) {
    const state = manifest.states.find((candidate) => candidate.id === stateIntent.stateId);
    return state?.agentInferable
      ? { valid: true, semantic: standardSemantic(state), stateId: state.id }
      : { valid: false, semantic: null };
  }

  const available = manifest.states.some((state) => (
    state.agentInferable && standardSemantic(state) === stateIntent.semantic
  ));
  return available
    ? { valid: true, semantic: stateIntent.semantic }
    : { valid: false, semantic: null };
}

export function createInitialBehaviorState(manifest: CharacterManifestV2): CharacterBehaviorStateSnapshot {
  const primary = defaultPrimary(manifest);
  return {
    revision: 0,
    primaryStateId: primary?.id ?? manifest.defaultStateId,
    modifierStateIds: [],
    activeSignals: [],
    desiredActionSemantic: primary ? standardSemantic(primary) : null
  };
}

export function inferCharacterBehaviorState(
  input: CharacterBehaviorInferenceInput
): CharacterBehaviorStateSnapshot {
  const { manifest, previous, signal, agentIntent } = input;
  const signals = activeSignals(previous, signal);
  const localSemantic = signalSemantic(signal);
  const agent = agentSelection(manifest, agentIntent);
  const currentPrimary = manifest.states.find((state) => state.id === previous.primaryStateId && state.kind === 'primary');
  const previousExited = Boolean(currentPrimary?.exitConditions.some((condition) => conditionMatches(
    condition,
    signals,
    standardSemantic(currentPrimary),
    new Set([currentPrimary.id])
  )));

  const canUseAgent = !localSemantic && agent.valid && !isProtectedPrimary(manifest, previous.primaryStateId);
  const requestedSemantic = localSemantic ?? (canUseAgent ? agent.semantic : null);
  const requestedStateId = !localSemantic && canUseAgent ? agent.stateId : undefined;
  const requestedPrimary = requestedSemantic || requestedStateId
    ? selectPrimaryState(manifest.states, signals, requestedSemantic, requestedStateId)
    : undefined;
  const primary = requestedPrimary
    ?? (!localSemantic && !agent.valid ? undefined : !previousExited ? currentPrimary : undefined)
    ?? defaultPrimary(manifest);

  if (!primary) {
    return {
      revision: previous.revision + 1,
      primaryStateId: manifest.defaultStateId,
      modifierStateIds: [],
      activeSignals: signals,
      desiredActionSemantic: localSemantic ?? (canUseAgent ? agentIntent?.actionSemantic ?? null : null)
    };
  }

  const modifiers = selectModifierStates(manifest, previous, primary, signals);
  return {
    revision: previous.revision + 1,
    primaryStateId: primary.id,
    modifierStateIds: modifiers.map((state) => state.id),
    activeSignals: signals,
    desiredActionSemantic: localSemantic
      ?? (canUseAgent ? agentIntent?.actionSemantic ?? null : null)
      ?? standardSemantic(primary)
  };
}
