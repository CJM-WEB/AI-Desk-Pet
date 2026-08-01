import {
  createExtensionStateId,
  type ActionClip,
  type CharacterManifestV1,
  type CoreCharacterState
} from './character-schema';
import type {
  CharacterActionPresentationV2,
  CharacterManifestV2,
  CharacterStateDefinitionV2
} from './character-v2-schema';
import { resolveCharacterPresentation } from './character-presentation-resolver';

/** V2 标准语义到旧播放器核心状态的固定映射。 */
export const LEGACY_STATE_BY_SEMANTIC = {
  idle: 'idle',
  listen: 'listening',
  think: 'thinking',
  move: 'moving',
  speak: 'acting',
  carry: 'carrying',
  celebrate: 'success',
  fail: 'error'
} as const;

type LegacyState = CharacterManifestV1['states'][number];

const MAX_LEGACY_IDENTIFIER_LENGTH = 120;
const LEGACY_EXTENSION_PREFIX = 'custom:';
const MAX_LEGACY_EXTENSION_NAME_LENGTH = MAX_LEGACY_IDENTIFIER_LENGTH - LEGACY_EXTENSION_PREFIX.length;

/** 为超长安全标识符生成稳定的短哈希，避免简单截断合并不同的源 ID。 */
function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** 在指定上限内保留 ID 前缀并附加稳定短哈希。 */
function truncateWithHash(value: string, maxLength: number, hashInput: string): string {
  if (value.length <= maxLength) return value;

  const suffix = `-${stableHash(hashInput)}`;
  return `${value.slice(0, maxLength - suffix.length)}${suffix}`;
}

/** 将安全的 V2 自定义 ID 还原为旧契约的规范 custom:<id> 形式。 */
function legacyCustomStateId(value: string): ReturnType<typeof createExtensionStateId> {
  const identifier = value.startsWith('custom-') && value.length > 'custom-'.length
    ? value.slice('custom-'.length)
    : value;
  return createExtensionStateId(
    truncateWithHash(identifier, MAX_LEGACY_EXTENSION_NAME_LENGTH, value)
  );
}

/** 在旧契约长度上限内生成稳定且不与已用 ID 冲突的候选标识符。 */
function uniqueBoundedId(id: string, usedIds: Pick<ReadonlySet<string>, 'has'>): string {
  if (!usedIds.has(id)) return id;

  let suffix = 2;
  while (true) {
    const postfix = `-${suffix}`;
    const candidate = `${id.slice(0, MAX_LEGACY_IDENTIFIER_LENGTH - postfix.length)}${postfix}`;
    if (!usedIds.has(candidate)) return candidate;
    suffix += 1;
  }
}

/** 深复制表现帧中的可变嵌套锚点，隔离旧播放器对投影结果的修改。 */
function cloneFrames(presentation: CharacterActionPresentationV2): ActionClip['frames'] {
  return presentation.frames.map((frame) => ({
    ...frame,
    anchors: frame.anchors
      ? Object.fromEntries(Object.entries(frame.anchors).map(([key, value]) => [
          key,
          value ? { ...value } : value
        ]))
      : undefined
  }));
}

/** 将默认皮肤的已解析表现复制为旧播放器可消费的动作片段。 */
function projectAction(
  resolved: Exclude<ReturnType<typeof resolveCharacterPresentation>, null>,
  id: string
): ActionClip {
  return {
    id,
    name: resolved.action.name,
    fps: resolved.presentation.fps,
    loop: resolved.action.loopPolicy !== 'never',
    weight: resolved.action.preference,
    direction: resolved.action.direction,
    anchors: Object.fromEntries(Object.entries(resolved.presentation.anchors).map(([key, value]) => [
      key,
      { ...value }
    ])) as ActionClip['anchors'],
    regions: resolved.presentation.regions
      ? Object.fromEntries(Object.entries(resolved.presentation.regions).map(([key, value]) => [
          key,
          value ? { ...value } : value
        ])) as ActionClip['regions']
      : undefined,
    frames: cloneFrames(resolved.presentation)
  };
}

/** 仅将可逆的受信号条件恢复为旧扩展状态可表达的闲置或单击触发器。 */
function legacyTriggerEvents(state: CharacterStateDefinitionV2): Array<'idle' | 'single_click'> {
  const events: Array<'idle' | 'single_click'> = [];

  state.enterConditions.forEach((condition) => {
    const signals = condition.clauses.filter((clause) => clause.kind === 'signal');
    const canRestore = condition.mode === 'any' || (
      condition.mode === 'all' && signals.length === 1 && condition.clauses.length === 1
    );
    if (!canRestore) return;

    signals.forEach((signal) => {
      const event = signal.signal === 'idle'
        ? 'idle'
        : signal.signal === 'user-interaction'
          ? 'single_click'
          : undefined;
      if (event && !events.includes(event)) events.push(event);
    });
  });

  return events;
}

/** 依状态语义创建或取得旧播放器状态；同一核心状态按源顺序合并。 */
function legacyStateFor(
  state: CharacterStateDefinitionV2,
  statesById: Map<string, LegacyState>,
  states: LegacyState[],
  customStateIdsBySemantic: Map<string, ReturnType<typeof createExtensionStateId>>
): LegacyState {
  if (typeof state.semantic === 'string') {
    const stateId = LEGACY_STATE_BY_SEMANTIC[state.semantic];
    const existing = statesById.get(stateId);
    if (existing) return existing;

    const next: LegacyState = { id: stateId as CoreCharacterState, kind: 'core', actions: [] };
    statesById.set(stateId, next);
    states.push(next);
    return next;
  }

  const semanticValue = state.semantic.value;
  const stateId = customStateIdsBySemantic.get(semanticValue) ?? (() => {
    const baseId = legacyCustomStateId(semanticValue);
    const uniqueId = uniqueBoundedId(baseId, statesById);
    const nextId = createExtensionStateId(uniqueId.slice(LEGACY_EXTENSION_PREFIX.length));
    customStateIdsBySemantic.set(semanticValue, nextId);
    return nextId;
  })();
  const existing = statesById.get(stateId);
  if (existing) return existing;
  const next: LegacyState = {
    id: stateId,
    kind: 'extension',
    triggers: { events: legacyTriggerEvents(state), keywords: [], emotions: [] },
    actions: []
  };
  statesById.set(stateId, next);
  states.push(next);
  return next;
}

/** 将一个 V2 状态的可播放动作按默认皮肤表现投影并追加到目标旧状态。 */
function appendProjectedActions(
  manifest: CharacterManifestV2,
  state: CharacterStateDefinitionV2,
  target: LegacyState,
  usedIds: Set<string>
): void {
  state.actionIds.forEach((actionId) => {
    const resolved = resolveCharacterPresentation(manifest, manifest.defaultSkinId, actionId);
    if (!resolved) return;

    const legacyActionId = uniqueBoundedId(resolved.action.id, usedIds);
    usedIds.add(legacyActionId);
    target.actions.push(projectAction(resolved, legacyActionId));
  });
}

/**
 * 将 V2 发布清单投影为旧播放器清单。投影仅读取 V2 数据，且只消费默认皮肤解析结果；
 * 默认状态会额外落入 legacy idle，确保旧契约要求的待机回退始终存在。
 */
export function projectCharacterManifestV2ToLegacy(
  manifest: CharacterManifestV2
): CharacterManifestV1 {
  const states: LegacyState[] = [];
  const statesById = new Map<string, LegacyState>();
  const usedActionIdsByState = new Map<LegacyState, Set<string>>();
  const customStateIdsBySemantic = new Map<string, ReturnType<typeof createExtensionStateId>>();

  const append = (state: CharacterStateDefinitionV2, target: LegacyState): void => {
    const usedIds = usedActionIdsByState.get(target) ?? new Set<string>();
    usedActionIdsByState.set(target, usedIds);
    appendProjectedActions(manifest, state, target, usedIds);
  };

  manifest.states.forEach((state) => append(
    state,
    legacyStateFor(state, statesById, states, customStateIdsBySemantic)
  ));

  const defaultState = manifest.states.find((state) => state.id === manifest.defaultStateId);
  if (
    defaultState
    && statesById.get('idle')
      !== legacyStateFor(defaultState, statesById, states, customStateIdsBySemantic)
  ) {
    append(defaultState, legacyStateFor(
      { ...defaultState, semantic: 'idle' },
      statesById,
      states,
      customStateIdsBySemantic
    ));
  }

  return {
    version: 1,
    id: manifest.id,
    name: manifest.name,
    thumbnailAssetId: manifest.thumbnailAssetId,
    compilerVersion: manifest.compilerVersion,
    resources: manifest.resources.map((resource) => ({ ...resource })),
    states
  };
}
