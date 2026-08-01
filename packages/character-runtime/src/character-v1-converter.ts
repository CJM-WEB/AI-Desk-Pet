import type {
  CharacterDraftV1,
  CharacterManifestV1
} from './character-schema';
import type {
  CharacterActionDefinitionV2,
  CharacterActionPresentationV2,
  CharacterDraftV2,
  CharacterManifestV2,
  CharacterStateDefinitionV2
} from './character-v2-schema';

/** V1 内置状态与 V2 标准语义的一一对应关系。 */
export const V1_STATE_SEMANTICS = {
  idle: 'idle',
  listening: 'listen',
  thinking: 'think',
  moving: 'move',
  acting: 'speak',
  carrying: 'carry',
  success: 'celebrate',
  error: 'fail'
} as const;

type V1State = CharacterDraftV1['states'][number] | CharacterManifestV1['states'][number];
type V1Action = V1State['actions'][number];

export type CharacterV1ConversionMap = {
  stateIds: Record<string, string[]>;
  actionIds: Record<string, string[]>;
};

export type CharacterV1ConversionResult<T> = {
  document: T;
  map: CharacterV1ConversionMap;
};

const V1_EVENT_SIGNALS = {
  idle: 'idle',
  single_click: 'user-interaction',
  double_click: 'user-interaction',
  context_menu: 'user-interaction'
} as const;

/** 按源数组顺序生成稳定且不覆盖已有对象的标识符。 */
function uniqueId(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;

  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

/** 将 V1 扩展状态规范化为符合 V2 安全标识符约束的形式。 */
function normalizeStateId(stateId: string): string {
  return stateId.startsWith('custom:')
    ? `custom-${stateId.slice('custom:'.length)}`
    : stateId;
}

/** 复制表现数据，避免调用方修改转换结果时回写 V1 输入。 */
function clonePresentation(actionId: string, action: V1Action): CharacterActionPresentationV2 {
  return {
    actionId,
    fps: action.fps,
    frames: action.frames.map((frame) => ({
      ...frame,
      anchors: frame.anchors
        ? Object.fromEntries(Object.entries(frame.anchors).map(([key, value]) => [
          key,
          value ? { ...value } : value
        ]))
        : undefined
    })),
    anchors: Object.fromEntries(Object.entries(action.anchors).map(([key, value]) => [
      key,
      { ...value }
    ])) as CharacterActionPresentationV2['anchors'],
    regions: action.regions
      ? Object.fromEntries(Object.entries(action.regions).map(([key, value]) => [
        key,
        value ? { ...value } : value
      ])) as CharacterActionPresentationV2['regions']
      : undefined
  };
}

/** 将 V1 仅有的事件触发映射为 V2 单层可信信号条件。 */
function convertEnterConditions(state: V1State): CharacterStateDefinitionV2['enterConditions'] {
  if (state.kind !== 'extension' || !state.triggers?.events.length) return [];

  return [{
    mode: 'any',
    clauses: state.triggers.events.map((event) => ({
      kind: 'signal' as const,
      signal: V1_EVENT_SIGNALS[event]
    }))
  }];
}

/** 自定义状态没有可推断的动作语义，统一降级为待机语义。 */
function actionSemanticForState(state: V1State): CharacterActionDefinitionV2['semantic'] {
  return state.kind === 'core' ? V1_STATE_SEMANTICS[state.id] : 'idle';
}

/** 构造 V2 必填但 V1 中不存在的纯数据身份默认值。 */
function defaultIdentity(name: string): CharacterDraftV2['identity'] {
  return {
    description: name,
    background: '由 V1 角色数据转换。',
    traits: [],
    languageStyle: '未指定',
    formsOfAddress: [],
    likes: [],
    dislikes: [],
    behavioralTendencies: [],
    boundaries: [],
    exampleLines: []
  };
}

function convertDocument(input: CharacterDraftV1 | CharacterManifestV1): CharacterV1ConversionResult<
  CharacterDraftV2 | CharacterManifestV2
> {
  const map: CharacterV1ConversionMap = { stateIds: {}, actionIds: {} };
  const usedStateIds = new Set<string>();
  const usedActionIds = new Set<string>();
  const states: CharacterStateDefinitionV2[] = [];
  const actions: CharacterActionDefinitionV2[] = [];
  const presentations: CharacterActionPresentationV2[] = [];

  input.states.forEach((state) => {
    const sourceStateId = state.id;
    const stateId = uniqueId(normalizeStateId(sourceStateId), usedStateIds);
    usedStateIds.add(stateId);
    (map.stateIds[sourceStateId] ??= []).push(stateId);

    const stateActionIds = state.actions.map((action) => {
      const actionId = uniqueId(action.id, usedActionIds);
      usedActionIds.add(actionId);
      (map.actionIds[action.id] ??= []).push(actionId);

      actions.push({
        id: actionId,
        name: action.name,
        semantic: actionSemanticForState(state),
        tags: [],
        preference: action.weight,
        cooldownMs: 0,
        repeatSuppressionMs: 0,
        loopPolicy: action.loop ? 'until-interrupted' : 'never',
        interrupt: 'normal',
        allowedPrimaryStateIds: [stateId],
        forbiddenPrimaryStateIds: [],
        requiredModifierStateIds: [],
        forbiddenModifierStateIds: [],
        direction: action.direction ?? 'any'
      });
      presentations.push(clonePresentation(actionId, action));
      return actionId;
    });

    states.push({
      id: stateId,
      name: sourceStateId,
      kind: 'primary',
      semantic: state.kind === 'core'
        ? V1_STATE_SEMANTICS[state.id]
        : { kind: 'custom', value: normalizeStateId(sourceStateId) },
      tags: [],
      intensity: 1,
      coexistWithStateIds: [],
      forbiddenStateIds: [],
      enterConditions: convertEnterConditions(state),
      exitConditions: [],
      agentInferable: false,
      actionIds: stateActionIds
    });
  });

  const draft: CharacterDraftV2 = {
    version: 2,
    id: input.id,
    name: input.name,
    thumbnailAssetId: input.thumbnailAssetId,
    identity: defaultIdentity(input.name),
    defaultSkinId: 'default',
    defaultStateId: 'idle',
    skins: [{
      id: 'default',
      name: '默认皮肤',
      presentations,
      semanticFallbacks: []
    }],
    states,
    actions
  };

  if (!('resources' in input)) return { document: draft, map };

  return {
    document: {
      ...draft,
      thumbnailAssetId: input.thumbnailAssetId,
      compilerVersion: input.compilerVersion,
      resources: input.resources.map((resource) => ({ ...resource }))
    },
    map
  };
}

/** 将 V1 草稿转换为不会修改输入的确定性 V2 草稿。 */
export function convertCharacterDraftV1ToV2(
  input: CharacterDraftV1
): CharacterV1ConversionResult<CharacterDraftV2> {
  return convertDocument(input) as CharacterV1ConversionResult<CharacterDraftV2>;
}

/** 将 V1 发布清单转换为不会复制素材文件的确定性 V2 清单。 */
export function convertCharacterManifestV1ToV2(
  input: CharacterManifestV1
): CharacterV1ConversionResult<CharacterManifestV2> {
  return convertDocument(input) as CharacterV1ConversionResult<CharacterManifestV2>;
}
