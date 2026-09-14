import { describe, expect, expectTypeOf, test } from 'vitest';
import {
  type ActionFrame,
  type AnchorSet,
  type CharacterActionPresentationV2,
  type CharacterDraftV2,
  type CharacterManifestV2,
  type PreparedCharacterManifestV2,
  type PresentationGeometryV2,
  type CharacterResource,
  type InteractionRegion,
  actionFrameSchema,
  anchorSetSchema,
  characterDraftV2Schema,
  characterManifestV2Schema,
  preparedCharacterManifestV2Schema,
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
  const draft = createCharacterDraftV2Fixture();
  draft.skins[0]!.presentations[0]!.geometry = {
    visualBounds: { x: 0.1, y: 0.2, width: 0.8, height: 0.8 },
    groundAnchor: { x: 0.5, y: 1 },
    resourceRevision: RESOURCE_SHA_256.atlas
  };
  return characterManifestV2Schema.parse({
    ...draft,
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
  });
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
  test('正式清单与迁移准备态在静态类型上区分表现几何', () => {
    expectTypeOf<CharacterManifestV2['skins'][number]['presentations'][number]['geometry']>()
      .toEqualTypeOf<PresentationGeometryV2>();
    expectTypeOf<PreparedCharacterManifestV2['skins'][number]['presentations'][number]['geometry']>()
      .toEqualTypeOf<PresentationGeometryV2 | undefined>();
  });

  test('表现提交帧必须引用同一表现内的唯一稳定帧标识', () => {
    const draft = createCharacterDraftV2Fixture();
    const presentation = draft.skins[0]!.presentations[0]!;
    presentation.frames = [
      { ...presentation.frames[0]!, id: 'carry-start' },
      { ...presentation.frames[0]!, id: 'carry-commit', x: 256 }
    ];
    presentation.commitFrameId = 'carry-commit';

    expect(characterDraftV2Schema.parse(draft).skins[0]!.presentations[0]!.commitFrameId)
      .toBe('carry-commit');

    const dangling = structuredClone(draft);
    dangling.skins[0]!.presentations[0]!.commitFrameId = 'missing-frame';
    expect(() => characterDraftV2Schema.parse(dangling)).toThrow(/提交帧/u);

    const duplicate = structuredClone(draft);
    duplicate.skins[0]!.presentations[0]!.frames[1]!.id = 'carry-start';
    duplicate.skins[0]!.presentations[0]!.commitFrameId = 'carry-start';
    expect(() => characterDraftV2Schema.parse(duplicate)).toThrow(/提交帧.*唯一.*帧标识/u);
  });

  test('表现提交帧拒绝未知字段', () => {
    const draft = createCharacterDraftV2Fixture();
    Object.assign(draft.skins[0]!.presentations[0]!, {
      commitFrameId: 'frame-1',
      commitCommand: 'trash'
    });
    draft.skins[0]!.presentations[0]!.frames[0]!.id = 'frame-1';

    expect(() => characterDraftV2Schema.parse(draft)).toThrow();
  });

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

  test.each([0.25, 2])('V2 表现接受边界内的播放速率：%s', (playbackRate) => {
    const draft = createCharacterDraftV2Fixture();
    draft.skins[0]!.presentations[0]!.playbackRate = playbackRate;

    expect(characterDraftV2Schema.parse(draft).skins[0]!.presentations[0]!.playbackRate)
      .toBe(playbackRate);
  });

  test('V2 表现允许省略播放参数', () => {
    const draft = createCharacterDraftV2Fixture();

    expect(characterDraftV2Schema.parse(draft).skins[0]!.presentations[0]!.playbackRate)
      .toBeUndefined();
  });

  test.each([true, false])('V2 表现接受布尔镜像值：%s', (mirrorX) => {
    const draft = createCharacterDraftV2Fixture();
    draft.skins[0]!.presentations[0]!.mirrorX = mirrorX;

    expect(characterDraftV2Schema.parse(draft).skins[0]!.presentations[0]!.mirrorX).toBe(mirrorX);
  });

  test.each(['true', 1, null])('V2 表现拒绝非布尔镜像值：%s', (mirrorX) => {
    const draft = createCharacterDraftV2Fixture();
    (draft.skins[0]!.presentations[0]! as Record<string, unknown>).mirrorX = mirrorX;

    expect(() => characterDraftV2Schema.parse(draft)).toThrow();
  });

  test.each([0.24, 2.01, Number.NaN])('V2 表现拒绝越界或非有限播放速率：%s', (playbackRate) => {
    const draft = createCharacterDraftV2Fixture();
    draft.skins[0]!.presentations[0]!.playbackRate = playbackRate;

    expect(() => characterDraftV2Schema.parse(draft)).toThrow();
  });

  test('草稿接受合法的 V2 纯数据结构', () => {
    const draft = createCharacterDraftV2Fixture();

    expect(characterDraftV2Schema.parse(draft)).toEqual(draft);
  });

  test('状态与动作详细描述可选且原样进入草稿和正式清单', () => {
    const draft = createCharacterDraftV2Fixture();
    Object.assign(draft.states[0]!, { description: '安静陪伴用户的基础状态。' });
    Object.assign(draft.actions[0]!, { description: '缓慢呼吸并保持放松。' });

    const parsedDraft = characterDraftV2Schema.parse(draft);
    expect(parsedDraft.states[0]).toMatchObject({ description: '安静陪伴用户的基础状态。' });
    expect(parsedDraft.actions[0]).toMatchObject({ description: '缓慢呼吸并保持放松。' });

    const manifest = createCharacterManifestV2Fixture();
    Object.assign(manifest.states[0]!, { description: '发布后的状态描述。' });
    Object.assign(manifest.actions[0]!, { description: '发布后的动作描述。' });
    const parsedManifest = characterManifestV2Schema.parse(manifest);
    expect(parsedManifest.states[0]).toMatchObject({ description: '发布后的状态描述。' });
    expect(parsedManifest.actions[0]).toMatchObject({ description: '发布后的动作描述。' });
  });

  test('旧 V2 草稿和正式清单省略状态与动作描述时继续合法', () => {
    const draft = createCharacterDraftV2Fixture();
    const manifest = createCharacterManifestV2Fixture();

    expect(characterDraftV2Schema.parse(draft)).toEqual(draft);
    expect(characterManifestV2Schema.parse(manifest)).toEqual(manifest);
  });

  test.each(['state', 'action'] as const)('%s 详细描述拒绝超过 2000 字符', target => {
    const draft = createCharacterDraftV2Fixture();
    Object.assign(target === 'state' ? draft.states[0]! : draft.actions[0]!, {
      description: '描'.repeat(2_001)
    });

    expect(() => characterDraftV2Schema.parse(draft)).toThrow();
  });

  test('正式清单要求不可拆分的表现几何并绑定所引用资源修订', () => {
    const manifest = createCharacterManifestV2Fixture();
    const presentation = manifest.skins[0]!.presentations[0]!;

    const missing = structuredClone(manifest);
    Reflect.deleteProperty(missing.skins[0]!.presentations[0]!, 'geometry');
    expect(() => characterManifestV2Schema.parse(missing)).toThrow(/几何/u);

    for (const geometry of [
      { ...presentation.geometry!, visualBounds: { x: 0, y: 0, width: 0, height: 1 } },
      { ...presentation.geometry!, visualBounds: { x: 0.5, y: 0, width: 0.6, height: 1 } },
      { ...presentation.geometry!, groundAnchor: { x: Number.NaN, y: 1 } },
      { ...presentation.geometry!, resourceRevision: RESOURCE_SHA_256.thumbnail }
    ]) {
      const invalid = structuredClone(manifest);
      invalid.skins[0]!.presentations[0]!.geometry = geometry;
      expect(() => characterManifestV2Schema.parse(invalid)).toThrow();
    }
  });

  test.each([
    {
      name: '501 帧',
      mutate(manifest: ReturnType<typeof createCharacterManifestV2Fixture>) {
        const frame = manifest.skins[0]!.presentations[0]!.frames[0]!;
        manifest.skins[0]!.presentations[0]!.frames = Array.from(
          { length: 501 },
          (_, index) => ({ ...frame, id: `frame-${index}` })
        );
      }
    },
    {
      name: '单帧尺寸超过上限',
      mutate(manifest: ReturnType<typeof createCharacterManifestV2Fixture>) {
        manifest.skins[0]!.presentations[0]!.frames[0]!.width = 4097;
      }
    },
    {
      name: '帧矩形超出单页边界',
      mutate(manifest: ReturnType<typeof createCharacterManifestV2Fixture>) {
        const frame = manifest.skins[0]!.presentations[0]!.frames[0]!;
        manifest.skins[0]!.presentations[0]!.frames = [
          { ...frame, id: 'frame-a', x: 4096, width: 1, height: 1 }
        ];
      }
    },
    {
      name: '空表现',
      mutate(manifest: ReturnType<typeof createCharacterManifestV2Fixture>) {
        const emptyPresentation = structuredClone(
          manifest.skins[0]!.presentations[0]!
        );
        emptyPresentation.frames = [];
        manifest.skins.push({
          ...structuredClone(manifest.skins[0]!),
          id: 'winter',
          presentations: [emptyPresentation]
        });
      }
    }
  ])('prepared 与正式清单均拒绝$name', ({ mutate }) => {
    const manifest = createCharacterManifestV2Fixture();
    mutate(manifest);

    expect(() => preparedCharacterManifestV2Schema.parse(manifest)).toThrow();
    expect(() => characterManifestV2Schema.parse(manifest)).toThrow();
  });

  test.each(['hide', 'emerge'])('草稿拒绝已退出标准动作集合的目录表现语义：%s', (semantic) => {
    const draft = createCharacterDraftV2Fixture();
    (draft.actions[0] as Record<string, unknown>).semantic = semantic;

    expect(() => characterDraftV2Schema.parse(draft)).toThrow();
  });

  test.each([
    'habitat-enter',
    'habitat-found',
    'habitat-hidden',
    'habitat-lost'
  ])('草稿状态条件拒绝已退出运行时的目录空间信号：%s', (signal) => {
    const draft = createCharacterDraftV2Fixture();
    (draft.states[0]!.enterConditions[0]!.clauses[0] as Record<string, unknown>).signal = signal;

    expect(() => characterDraftV2Schema.parse(draft)).toThrow();
  });

  test('草稿继续接受普通语义回退与搬运条件信号', () => {
    const draft = createCharacterDraftV2Fixture();
    draft.skins[0]!.semanticFallbacks = [{ semantic: 'idle', actionId: 'idle-main' }];
    draft.states[0]!.enterConditions[0]!.clauses[0] = { kind: 'signal', signal: 'carry-start' };

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
