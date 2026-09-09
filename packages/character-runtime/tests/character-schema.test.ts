import { describe, expect, test } from 'vitest';
import {
  type CharacterManifestV1,
  type ExtensionStateId,
  characterDraftV1Schema,
  characterManifestV1Schema,
  createExtensionStateId
} from '../src';

const RESOURCE_SHA_256 = {
  thumbnail: 'a'.repeat(64),
  atlas: 'b'.repeat(64)
};

function createValidManifest() {
  return {
    version: 1,
    id: 'character-demo',
    name: '演示角色',
    thumbnailAssetId: 'thumbnail-1',
    compilerVersion: 'compiler-1.0.0',
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
    ],
    states: [
      {
        id: 'idle',
        kind: 'core',
        actions: [
          {
            id: 'idle-breathe',
            name: '呼吸',
            fps: 12,
            loop: true,
            weight: 1,
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
            }
          }
        ]
      },
      {
        id: createExtensionStateId(' 跳舞 '),
        kind: 'extension',
        actions: []
      }
    ]
  };
}

function createIncompleteDraft() {
  const { compilerVersion: _, resources: __, ...draft } = createValidManifest();
  draft.states[0]!.actions[0]!.frames = [];
  return draft;
}

function getIdleAction(manifest: ReturnType<typeof createValidManifest>) {
  return manifest.states[0]!.actions[0]!;
}

function getIdleFrame(manifest: ReturnType<typeof createValidManifest>) {
  return getIdleAction(manifest).frames[0]!;
}

describe('角色清单协议', () => {
  test('从包入口解析的清单可赋值给公开类型', () => {
    const manifest: CharacterManifestV1 = characterManifestV1Schema.parse(createValidManifest());
    const extensionState = manifest.states[1];

    expect(extensionState?.kind).toBe('extension');
    if (extensionState?.kind === 'extension') {
      const extensionStateId: ExtensionStateId = extensionState.id;
      expect(extensionStateId).toBe('custom:跳舞');
    }
  });

  test('接受包含编译器版本、资源校验和扩展状态的完整清单', () => {
    const manifest = characterManifestV1Schema.parse(createValidManifest());

    expect(manifest.compilerVersion).toBe('compiler-1.0.0');
    expect(manifest.resources).toHaveLength(2);
    expect(manifest.states[1]?.id).toBe('custom:跳舞');
  });

  test('发布清单拒绝零帧待机动作', () => {
    const manifest = createValidManifest();
    getIdleAction(manifest).frames = [];

    expect(() => characterManifestV1Schema.parse(manifest)).toThrow();
  });

  test('草稿允许零帧未完成动作', () => {
    const draft = characterDraftV1Schema.parse(createIncompleteDraft());

    expect(draft.states[0]?.actions[0]?.frames).toEqual([]);
  });

  test('动作帧稳定标识向后兼容且仍受安全标识规则约束', () => {
    const legacy = characterManifestV1Schema.parse(createValidManifest());
    expect(legacy.states[0]?.actions[0]?.frames[0]?.id).toBeUndefined();

    const identified = createValidManifest();
    (getIdleFrame(identified) as Record<string, unknown>).id = 'frame-idle-01';
    expect(characterManifestV1Schema.parse(identified)
      .states[0]?.actions[0]?.frames[0]?.id).toBe('frame-idle-01');

    const unsafe = createValidManifest();
    (getIdleFrame(unsafe) as Record<string, unknown>).id = '../frame';
    expect(() => characterManifestV1Schema.parse(unsafe)).toThrow();
  });

  test('同一动作中的显式帧标识必须唯一', () => {
    const manifest = createValidManifest();
    const first = getIdleFrame(manifest);
    (first as Record<string, unknown>).id = 'frame-duplicate';
    getIdleAction(manifest).frames.push({
      ...first,
      x: first.x + first.width,
      id: 'frame-duplicate'
    } as typeof first);

    expect(() => characterManifestV1Schema.parse(manifest)).toThrow(
      '动作内的帧标识必须唯一'
    );
  });

  test.each([
    ['缺少编译器版本', (manifest: Record<string, unknown>) => delete manifest.compilerVersion],
    ['编译器版本仅含空白', (manifest: Record<string, unknown>) => { manifest.compilerVersion = '   '; }],
    ['缺少资源清单', (manifest: Record<string, unknown>) => delete manifest.resources]
  ])('发布清单拒绝%s', (_, changeManifest) => {
    const manifest = createValidManifest();
    changeManifest(manifest);

    expect(() => characterManifestV1Schema.parse(manifest)).toThrow();
  });

  test.each([
    ['编译器版本', (draft: Record<string, unknown>) => { draft.compilerVersion = 'compiler-1.0.0'; }],
    ['资源清单', (draft: Record<string, unknown>) => { draft.resources = []; }]
  ])('草稿拒绝发布字段：%s', (_, addPublishField) => {
    const draft = createIncompleteDraft();
    addPublishField(draft);

    expect(() => characterDraftV1Schema.parse(draft)).toThrow();
  });

  test.each([
    ['重复资源标识符', (manifest: ReturnType<typeof createValidManifest>) => { manifest.resources[1]!.assetId = 'thumbnail-1'; }],
    ['不安全的资源标识符', (manifest: ReturnType<typeof createValidManifest>) => { manifest.resources[1]!.assetId = '../atlas'; }],
    ['包含目录的资源文件名', (manifest: ReturnType<typeof createValidManifest>) => { manifest.resources[1]!.fileName = 'assets/atlas.png'; }],
    ['不支持的资源文件扩展名', (manifest: ReturnType<typeof createValidManifest>) => { manifest.resources[1]!.fileName = 'atlas.jpg'; }],
    ['非小写十六进制资源校验值', (manifest: ReturnType<typeof createValidManifest>) => { manifest.resources[1]!.sha256 = 'A'.repeat(64); }],
    ['超出上限的资源字节数', (manifest: ReturnType<typeof createValidManifest>) => { manifest.resources[1]!.byteLength = 536_870_913; }],
    ['非安全整数的资源字节数', (manifest: ReturnType<typeof createValidManifest>) => { manifest.resources[1]!.byteLength = Number.MAX_SAFE_INTEGER + 1; }]
  ])('发布清单拒绝%s', (_, changeManifest) => {
    const manifest = createValidManifest();
    changeManifest(manifest);

    expect(() => characterManifestV1Schema.parse(manifest)).toThrow();
  });

  test.each([
    ['缩略图引用不存在的资源', (manifest: ReturnType<typeof createValidManifest>) => { manifest.thumbnailAssetId = 'missing-thumbnail'; }],
    ['动作帧引用不存在的资源', (manifest: ReturnType<typeof createValidManifest>) => { getIdleFrame(manifest).assetId = 'missing-atlas'; }]
  ])('发布清单拒绝%s', (_, changeManifest) => {
    const manifest = createValidManifest();
    changeManifest(manifest);

    expect(() => characterManifestV1Schema.parse(manifest)).toThrow();
  });

  test.each([
    ['帧率低于下限', (manifest: ReturnType<typeof createValidManifest>) => { getIdleAction(manifest).fps = 0; }],
    ['帧率高于上限', (manifest: ReturnType<typeof createValidManifest>) => { getIdleAction(manifest).fps = 61; }],
    ['权重低于下限', (manifest: ReturnType<typeof createValidManifest>) => { getIdleAction(manifest).weight = 0; }],
    ['权重高于上限', (manifest: ReturnType<typeof createValidManifest>) => { getIdleAction(manifest).weight = 101; }],
    ['锚点横坐标越界', (manifest: ReturnType<typeof createValidManifest>) => { getIdleAction(manifest).anchors.ground.x = -0.01; }],
    ['锚点纵坐标越界', (manifest: ReturnType<typeof createValidManifest>) => { getIdleAction(manifest).anchors.ground.y = 1.01; }],
    ['帧矩形横坐标为负数', (manifest: ReturnType<typeof createValidManifest>) => { getIdleFrame(manifest).x = -1; }],
    ['帧矩形宽度为零', (manifest: ReturnType<typeof createValidManifest>) => { getIdleFrame(manifest).width = 0; }],
    ['帧矩形高度为小数', (manifest: ReturnType<typeof createValidManifest>) => { getIdleFrame(manifest).height = 1.5; }]
  ])('发布清单拒绝%s', (_, changeManifest) => {
    const manifest = createValidManifest();
    changeManifest(manifest);

    expect(() => characterManifestV1Schema.parse(manifest)).toThrow();
  });

  test('发布清单接受帧率、权重和锚点边界值', () => {
    const manifest = createValidManifest();
    const action = getIdleAction(manifest);
    action.fps = 60;
    action.weight = 100;
    action.anchors.ground = { x: 0, y: 1 };

    expect(characterManifestV1Schema.parse(manifest).states[0]?.actions[0]?.fps).toBe(60);
  });

  test.each([
    ['播放速率低于下限', (action: Record<string, unknown>) => { action.playbackRate = 0.24; }],
    ['播放速率高于上限', (action: Record<string, unknown>) => { action.playbackRate = 2.01; }],
    ['播放速率为 NaN', (action: Record<string, unknown>) => { action.playbackRate = Number.NaN; }],
    ['镜像值不是布尔值', (action: Record<string, unknown>) => { action.mirrorX = 'true'; }]
  ])('发布清单拒绝非法动作播放参数：%s', (_, changeAction) => {
    const manifest = createValidManifest();
    changeAction(getIdleAction(manifest) as Record<string, unknown>);

    expect(() => characterManifestV1Schema.parse(manifest)).toThrow();
  });

  test('发布清单拒绝超出画布的命中区域', () => {
    const manifest = createValidManifest();
    const action = getIdleAction(manifest) as ReturnType<typeof getIdleAction> & {
      regions: { click: { x: number; y: number; width: number; height: number } };
    };
    action.regions = {
      click: { x: 0.5, y: 0, width: 0.6, height: 1 }
    };

    expect(() => characterManifestV1Schema.parse(manifest)).toThrow();
  });

  test('发布清单拒绝嵌套未知字段', () => {
    const manifest = createValidManifest();
    (manifest.resources[0] as Record<string, unknown>).script = 'run.exe';

    expect(() => characterManifestV1Schema.parse(manifest)).toThrow();
  });

  test('将不规范扩展状态标识符报告为校验失败', () => {
    const manifest = createValidManifest();
    manifest.states[1]!.id = 'custom:目录/跳舞';

    expect(characterManifestV1Schema.safeParse(manifest).success).toBe(false);
  });

  test('发布清单拒绝根未知字段', () => {
    const manifest = createValidManifest();
    (manifest as Record<string, unknown>).script = 'run.exe';

    expect(() => characterManifestV1Schema.parse(manifest)).toThrow();
  });

  test('发布清单拒绝缺失待机动作', () => {
    expect(() => characterManifestV1Schema.parse({
      ...createValidManifest(),
      states: []
    })).toThrow();
  });
});
