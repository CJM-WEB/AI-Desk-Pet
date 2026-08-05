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
  requiredStateId?: string,
  requireAgentInferable = false
): CharacterStateDefinitionV2 | undefined {
  const candidates = eligibleStates(states.filter((state) => (
    state.kind === 'primary'
    && (!requireAgentInferable || state.agentInferable)
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
  signals: readonly TrustedBehaviorSignal[],
  explicitModifierStateId?: string
): CharacterStateDefinitionV2[] {
  const previousModifierIds = new Set(previous.modifierStateIds);
  const selected = [primary];
  const modifiers = manifest.states.filter((state) => state.kind === 'modifier');
  const orderedModifiers = explicitModifierStateId
    ? [
      ...modifiers.filter((state) => state.id === explicitModifierStateId),
      ...modifiers.filter((state) => state.id !== explicitModifierStateId)
    ]
    : modifiers;

  orderedModifiers.forEach((candidate) => {
    const stateIds = new Set([...selected.map((state) => state.id), candidate.id]);
    const existing = previousModifierIds.has(candidate.id);
    const exited = existing && candidate.exitConditions.some((condition) => conditionMatches(
      condition,
      signals,
      standardSemantic(candidate),
      stateIds
    ));
    if (!exited
      && (existing || conditionsMatch(candidate.enterConditions, signals, standardSemantic(candidate), stateIds))
      && isCompatibleModifier(candidate, selected)) {
      selected.push(candidate);
    }
  });

  return selected.slice(1);
}

function defaultPrimary(manifest: CharacterManifestV2): CharacterStateDefinitionV2 | undefined {
  return manifest.states.find((state) => state.id === manifest.defaultStateId && state.kind === 'primary')
    ?? manifest.states.find((state) => state.kind === 'primary');
}

/** 异常清单没有可用主状态时中断，避免将修饰状态伪装为主状态。 */
function requirePrimary(manifest: CharacterManifestV2): CharacterStateDefinitionV2 {
  const primary = defaultPrimary(manifest);
  if (!primary) throw new Error('CHARACTER_BEHAVIOR_PRIMARY_STATE_UNAVAILABLE');
  return primary;
}

function isProtectedPrimary(
  manifest: CharacterManifestV2,
  stateId: string,
  signals: readonly TrustedBehaviorSignal[]
): boolean {
  const state = manifest.states.find((candidate) => candidate.id === stateId);
  const semantic = state ? standardSemantic(state) : null;
  if (!semantic || !PROTECTED_PRIMARY_SEMANTICS.has(semantic)) return false;
  return semantic === 'think'
    ? signals.includes('thinking')
    : semantic === 'move'
      ? signals.includes('move-start')
      : semantic === 'celebrate'
        ? signals.includes('task-success')
        : signals.includes('task-failure');
}

type AgentStateSelection =
  | { kind: 'none' }
  | { kind: 'invalid' }
  | { kind: 'primary-semantic'; semantic: CharacterStandardSemantic }
  | { kind: 'primary-state'; stateId: string }
  | { kind: 'modifier-state'; stateId: string };

function agentStateSelection(
  manifest: CharacterManifestV2,
  intent: CharacterAgentBehaviorIntent | undefined
): AgentStateSelection {
  const stateIntent = intent?.stateIntent;
  if (!stateIntent) return { kind: 'none' };
  if ('stateId' in stateIntent) {
    const state = manifest.states.find((candidate) => candidate.id === stateIntent.stateId);
    if (!state?.agentInferable) return { kind: 'invalid' };
    return state.kind === 'modifier'
      ? { kind: 'modifier-state', stateId: state.id }
      : { kind: 'primary-state', stateId: state.id };
  }

  const available = manifest.states.some((state) => (
    state.kind === 'primary' && state.agentInferable && standardSemantic(state) === stateIntent.semantic
  ));
  return available
    ? { kind: 'primary-semantic', semantic: stateIntent.semantic }
    : { kind: 'invalid' };
}

export function createInitialBehaviorState(manifest: CharacterManifestV2): CharacterBehaviorStateSnapshot {
  const primary = requirePrimary(manifest);
  return {
    revision: 0,
    primaryStateId: primary.id,
    modifierStateIds: [],
    activeSignals: [],
    desiredActionSemantic: standardSemantic(primary)
  };
}

export function inferCharacterBehaviorState(
  input: CharacterBehaviorInferenceInput
): CharacterBehaviorStateSnapshot {
  const { manifest, previous, signal, agentIntent } = input;
  const signals = activeSignals(previous, signal);
  const localSemantic = signalSemantic(signal);
  const agentState = agentStateSelection(manifest, agentIntent);
  const agentActionSemantic = agentIntent?.actionSemantic ?? null;
  const currentPrimary = manifest.states.find((state) => state.id === previous.primaryStateId && state.kind === 'primary');
  const previousExited = Boolean(currentPrimary?.exitConditions.some((condition) => conditionMatches(
    condition,
    signals,
    standardSemantic(currentPrimary),
    new Set([currentPrimary.id])
  )));

  const protectedFromAgent = !localSemantic
    && isProtectedPrimary(manifest, previous.primaryStateId, signals);
  const canUseAgent = !localSemantic && !protectedFromAgent && agentState.kind !== 'invalid';
  // task-start 携带非法状态时仍由本地思考语义收敛，模型不能把主状态打回待机。
  const requestedSemantic = localSemantic
    ?? (agentState.kind === 'invalid' && signal.type === 'task' && signal.phase === 'start'
      ? 'think'
      : agentState.kind === 'primary-semantic' && canUseAgent ? agentState.semantic : null);
  const requestedStateId = agentState.kind === 'primary-state' && canUseAgent ? agentState.stateId : undefined;
  const hasPrimaryRequest = Boolean(localSemantic)
    || agentState.kind === 'invalid'
    || (canUseAgent && (agentState.kind === 'primary-semantic' || agentState.kind === 'primary-state'));
  const requestedPrimary = hasPrimaryRequest && (requestedSemantic || requestedStateId)
    ? selectPrimaryState(
      manifest.states,
      signals,
      requestedSemantic,
      requestedStateId,
      !localSemantic && agentState.kind === 'primary-semantic'
    )
    : undefined;
  const primary = requestedPrimary
    ?? (!hasPrimaryRequest && !previousExited ? currentPrimary : undefined)
    ?? requirePrimary(manifest);

  const modifiers = selectModifierStates(
    manifest,
    previous,
    primary,
    signals,
    canUseAgent && agentState.kind === 'modifier-state' ? agentState.stateId : undefined
  );
  return {
    revision: previous.revision + 1,
    primaryStateId: primary.id,
    modifierStateIds: modifiers.map((state) => state.id),
    activeSignals: signals,
    desiredActionSemantic: localSemantic
      ?? agentActionSemantic
      ?? standardSemantic(primary)
  };
}
