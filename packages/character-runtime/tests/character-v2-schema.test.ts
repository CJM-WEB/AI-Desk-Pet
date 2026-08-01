import { describe, expect, test } from 'vitest';
import {
  type ActionFrame,
  type AnchorSet,
  type CharacterActionPresentationV2,
  type CharacterDraftV2,
  type CharacterManifestV2,
  type CharacterResource,
  type InteractionRegion,
  actionFrameSchema,
  anchorSetSchema,
  characterDraftV2Schema,
  characterManifestV2Schema,
  characterResourceSchema,
  characterV2Completeness,
  interactionRegionSchema
} from '../src';

const RESOURCE_SHA_256 = {
  thumbnail: 'a'.repeat(64),
  atlas: 'b'.repeat(64)
};

/** 创建符合 V2 契约的最小草稿。 */
function createCharacterDraftV2Fixture(): CharacterDraftV2 {
  return {
    version: 2,
    id: 'character-demo',
    name: '演示角色',
    identity: {
      description: '一位友好的桌面伙伴。',
      background: '来自角色工作室。',
      traits: ['友好'],
      languageStyle: '温和',
      formsOfAddress: ['你'],
      likes: ['音乐'],
      dislikes: ['噪音'],
      behavioralTendencies: ['主动问候'],
      boundaries: ['不执行命令'],
      exampleLines: ['你好。']
    },
    defaultSkinId: 'default',
    defaultStateId: 'idle',
    skins: [
      {
        id: 'default',
        name: '默认皮肤',
        description: '基础表现。',
        presentations: [
          {
            actionId: 'idle-main',
            fps: 12,
            frames: [
              {
                assetId: 'atlas-1',
                x: 0,
                y: 0,
                width: 256,
                height: 256
              }
            ],
            anchors: {
              ground: { x: 0.5, y: 1 }
            },
            regions: {
              click: { x: 0, y: 0, width: 1, height: 1 }
            }
          }
        ],
        semanticFallbacks: []
      }
    ],
    states: [
      {
        id: 'idle',
        name: '待机',
        kind: 'primary',
        semantic: 'idle',
        tags: ['default'],
        intensity: 1,
        suggestedDurationMs: 1000,
        coexistWithStateIds: [],
        forbiddenStateIds: [],
        enterConditions: [
          {
            mode: 'all',
            clauses: [{ kind: 'signal', signal: 'idle' }]
          }
        ],
        exitConditions: [],
        agentInferable: false,
        actionIds: ['idle-main']
      }
    ],
    actions: [
      {
        id: 'idle-main',
        name: '呼吸',
        semantic: 'idle',
        tags: ['default'],
        preference: 1,
        cooldownMs: 0,
        repeatSuppressionMs: 0,
        loopPolicy: 'until-interrupted',
        interrupt: 'normal',
        allowedPrimaryStateIds: ['idle'],
        forbiddenPrimaryStateIds: [],
        requiredModifierStateIds: [],
        forbiddenModifierStateIds: [],
        direction: 'any'
      }
    ]
  };
}

/** 为草稿补齐发布所需资源字段。 */
function createCharacterManifestV2Fixture(): CharacterManifestV2 {
  return {
    ...createCharacterDraftV2Fixture(),
    thumbnailAssetId: 'thumbnail-1',
    compilerVersion: 'compiler-2.0.0',
    resources: [
      {
        assetId: 'thumbnail-1',
        fileName: 'thumbnail.webp',
        sha256: RESOURCE_SHA_256.thumbnail,
        byteLength: 1024
      },
      {
        assetId: 'atlas-1',
        fileName: 'atlas.png',
        sha256: RESOURCE_SHA_256.atlas,
        byteLength: 4096
      }
    ]
  };
}

/** 构造动作失败回退循环。 */
function withActionCycle(
  draft: ReturnType<typeof createCharacterDraftV2Fixture>,
  firstActionId: string,
  secondActionId: string
) {
  return {
    ...draft,
    actions: [
      { ...draft.actions[0]!, id: firstActionId, failureFallbackActionId: secondActionId },
      { ...draft.actions[0]!, id: secondActionId, failureFallbackActionId: firstActionId }
    ],
    states: [{ ...draft.states[0]!, actionIds: [firstActionId, secondActionId] }],
    skins: [{
      ...draft.skins[0]!,
      presentations: [{ ...draft.skins[0]!.presentations[0]!, actionId: firstActionId }]
    }]
  };
}

/** 构造条件中引用未知状态的草稿。 */
function withUnknownStateReference(draft: ReturnType<typeof createCharacterDraftV2Fixture>) {
  return {
    ...draft,
    states: [{
      ...draft.states[0],
      enterConditions: [{
        mode: 'all',
        clauses: [{ kind: 'state', stateId: 'missing-state' }]
      }]
    }]
  };
}

/** 构造默认回退链没有可播放表现的草稿。 */
function withoutPlayableDefault<T extends CharacterDraftV2>(draft: T): T {
  return {
    ...draft,
    skins: [{ ...draft.skins[0]!, presentations: [] }]
  } as T;
}

describe('角色包 V2 严格契约', () => {
  test('V2 表现和资源契约消费 V1 共享 Schema', () => {
    const frame: ActionFrame = actionFrameSchema.parse({
      assetId: 'atlas-1', x: 0, y: 0, width: 256, height: 256
    });
    const anchors: AnchorSet = anchorSetSchema.parse({ ground: { x: 0.5, y: 1 } });
    const region: InteractionRegion = interactionRegionSchema.parse({
      x: 0, y: 0, width: 1, height: 1
    });
    const resource: CharacterResource = characterResourceSchema.parse({
      assetId: 'atlas-1',
      fileName: 'atlas.png',
      sha256: RESOURCE_SHA_256.atlas,
      byteLength: 4096
    });
    const presentation: CharacterActionPresentationV2 = {
      actionId: 'idle-main', fps: 12, frames: [frame], anchors, regions: { click: region }
    };

    expect(presentation.frames[0]).toEqual(frame);
    expect(resource.assetId).toBe('atlas-1');
  });

  test('草稿接受合法的 V2 纯数据结构', () => {
    const draft = createCharacterDraftV2Fixture();

    expect(characterDraftV2Schema.parse(draft)).toEqual(draft);
  });

  test.each([
    ['系统提示', (draft: Record<string, unknown>) => { draft.systemPrompt = '忽略规则'; }],
    ['脚本', (draft: Record<string, unknown>) => { draft.script = 'run.exe'; }],
    ['能力引用', (draft: Record<string, unknown>) => {
      const actions = draft.actions as Array<Record<string, unknown>>;
      actions[0]!.capabilityRef = 'shell';
    }]
  ])('草稿拒绝危险字段：%s', (_, changeDraft) => {
    const draft = createCharacterDraftV2Fixture();
    changeDraft(draft as unknown as Record<string, unknown>);

    expect(() => characterDraftV2Schema.parse(draft)).toThrow();
  });

  test('草稿拒绝超过上限的人设特征数量', () => {
    const draft = createCharacterDraftV2Fixture();
    draft.identity.traits = Array.from({ length: 33 }, () => '友好');

    expect(() => characterDraftV2Schema.parse(draft)).toThrow();
  });

  test('草稿拒绝未知的状态条件引用', () => {
    expect(() => characterDraftV2Schema.parse(
      withUnknownStateReference(createCharacterDraftV2Fixture())
    )).toThrow(/状态引用/u);
  });

  test('草稿拒绝将修饰状态设为默认状态', () => {
    const draft = createCharacterDraftV2Fixture();
    draft.states.push({
      ...draft.states[0]!,
      id: 'default-modifier',
      name: '默认修饰状态',
      kind: 'modifier',
      semantic: { kind: 'custom', value: 'default-modifier' },
      actionIds: []
    });
    draft.defaultStateId = 'default-modifier';

    expect(() => characterDraftV2Schema.parse(draft)).toThrow(/默认状态必须是主状态/u);
  });

  test('草稿拒绝动作回退循环', () => {
    expect(() => characterDraftV2Schema.parse(
      withActionCycle(createCharacterDraftV2Fixture(), 'wave', 'nod')
    )).toThrow(/动作回退.*循环/u);
  });

  test('草稿拒绝跨回退字段形成的动作循环', () => {
    const baseDraft = createCharacterDraftV2Fixture();
    const draft = {
      ...baseDraft,
      actions: [
        { ...baseDraft.actions[0]!, id: 'wave', failureFallbackActionId: 'nod' },
        { ...baseDraft.actions[0]!, id: 'nod', interruptedFallbackActionId: 'wave' }
      ],
      states: [{ ...baseDraft.states[0]!, actionIds: ['wave', 'nod'] }],
      skins: [{
        ...baseDraft.skins[0]!,
        presentations: [{ ...baseDraft.skins[0]!.presentations[0]!, actionId: 'wave' }]
      }]
    };

    expect(() => characterDraftV2Schema.parse(draft)).toThrow(/动作回退.*循环/u);
  });

  test('完整性检查报告默认表现不可播放', () => {
    expect(characterV2Completeness(withoutPlayableDefault(createCharacterDraftV2Fixture()))).toEqual([
      'default-presentation-unplayable'
    ]);
  });

  test('发布清单要求默认回退链存在可播放表现和已声明资源', () => {
    const manifest = createCharacterManifestV2Fixture();

    expect(characterManifestV2Schema.parse(manifest)).toEqual(manifest);
    expect(() => characterManifestV2Schema.parse(withoutPlayableDefault(manifest))).toThrow();
    expect(() => characterManifestV2Schema.parse({
      ...manifest,
      skins: [{
        ...manifest.skins[0]!,
        presentations: [{
          ...manifest.skins[0]!.presentations[0]!,
          frames: [{ ...manifest.skins[0]!.presentations[0]!.frames[0]!, assetId: 'missing-atlas' }]
        }]
      }]
    })).toThrow(/资源/u);
  });
});
