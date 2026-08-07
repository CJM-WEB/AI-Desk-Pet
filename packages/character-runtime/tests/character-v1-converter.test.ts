import { describe, expect, test } from 'vitest';
import {
  type CharacterDraftV1,
  type CharacterManifestV1,
  characterDraftV2Schema,
  characterManifestV2Schema,
  convertCharacterDraftV1ToV2,
  convertCharacterManifestV1ToV2
} from '../src';

const RESOURCE_SHA_256 = {
  thumbnail: 'a'.repeat(64),
  atlas: 'b'.repeat(64)
};

/** 创建包含 V1 资源与待机动作的可发布清单。 */
function createV1Manifest(): CharacterManifestV1 {
  return {
    version: 1,
    id: 'character-demo',
    name: '演示角色',
    thumbnailAssetId: 'thumbnail',
    compilerVersion: 'compiler-1.0.0',
    resources: [
      {
        assetId: 'thumbnail',
        fileName: 'thumbnail.webp',
        sha256: RESOURCE_SHA_256.thumbnail,
        byteLength: 1024
      },
      {
        assetId: 'idle-atlas',
        fileName: 'idle-atlas.png',
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
            id: 'idle-main',
            name: '待机主动作',
            fps: 12,
            loop: true,
            weight: 3,
            direction: 'any',
            anchors: { ground: { x: 0.5, y: 1 } },
            regions: { click: { x: 0, y: 0, width: 1, height: 1 } },
            frames: [
              {
                assetId: 'idle-atlas',
                x: 0,
                y: 0,
                width: 256,
                height: 256
              }
            ]
          }
        ]
      }
    ]
  };
}

/** 创建可复用的 V1 草稿动作。 */
function createV1DraftAction(id: string) {
  return {
    id,
    name: `${id} 动作`,
    fps: 12,
    loop: false,
    weight: 1,
    anchors: { ground: { x: 0.5, y: 1 } },
    frames: [{ assetId: 'idle-atlas', x: 0, y: 0, width: 256, height: 256 }]
  };
}

/** 创建带有重复动作和自定义状态的 V1 草稿。 */
function createV1WithDuplicateActionIds(): CharacterDraftV1 {
  return {
    version: 1,
    id: 'character-demo',
    name: '演示角色',
    states: [
      { id: 'idle', kind: 'core', actions: [createV1DraftAction('wave')] },
      {
        id: 'custom:rain',
        kind: 'extension',
        triggers: {
          events: ['single_click'],
          keywords: ['下雨'],
          emotions: ['calm']
        },
        actions: [createV1DraftAction('wave')]
      }
    ]
  };
}

/** 创建带有重复状态标识符的 V1 草稿。 */
function createV1WithDuplicateStateIds(): CharacterDraftV1 {
  return {
    version: 1,
    id: 'character-demo',
    name: '演示角色',
    states: [
      { id: 'idle', kind: 'core', actions: [createV1DraftAction('idle-first')] },
      { id: 'idle', kind: 'core', actions: [createV1DraftAction('idle-second')] }
    ]
  };
}

/** 创建包含 Unicode 扩展状态标识符的 V1 草稿。 */
function createV1WithUnicodeExtensionState(): CharacterDraftV1 {
  return {
    version: 1,
    id: 'character-demo',
    name: '演示角色',
    states: [
      { id: 'idle', kind: 'core', actions: [] },
      { id: 'custom:跳舞', kind: 'extension', actions: [] }
    ]
  };
}

describe('V1 角色数据转换器', () => {
  test('将发布清单的字段和素材引用映射到默认皮肤', () => {
    const result = convertCharacterManifestV1ToV2(createV1Manifest());

    expect(result.document).toMatchObject({
      version: 2,
      defaultSkinId: 'default',
      defaultStateId: 'idle',
      actions: [expect.objectContaining({ id: 'idle-main', preference: 3 })]
    });
    expect(result.document.skins[0]?.presentations[0]?.frames[0]?.assetId)
      .toBe('idle-atlas');
    expect(result.document.resources).toEqual(createV1Manifest().resources);
    expect(characterManifestV2Schema.parse(result.document)).toEqual(result.document);
  });

  test('V1 搬运动作只映射 carry 语义，不伪造精确任务提交帧', () => {
    const source = createV1Manifest();
    source.states[0] = { ...source.states[0]!, id: 'carrying' };

    const result = convertCharacterManifestV1ToV2(source);
    const presentation = result.document.skins[0]?.presentations[0];

    expect(result.document.actions[0]?.semantic).toBe('carry');
    expect(presentation).not.toHaveProperty('commitFrameId');
  });

  test('按源顺序重命名重复动作并保持结果确定', () => {
    const first = convertCharacterDraftV1ToV2(createV1WithDuplicateActionIds());
    const second = convertCharacterDraftV1ToV2(createV1WithDuplicateActionIds());

    expect(first).toEqual(second);
    expect(first.map.actionIds.wave).toEqual(['wave', 'wave-2']);
    expect(first.document.actions.map((action) => action.id)).toEqual(['wave', 'wave-2']);
  });

  test('将自定义状态规范化并仅映射可信事件触发', () => {
    const result = convertCharacterDraftV1ToV2(createV1WithDuplicateActionIds());
    const state = result.document.states.find((candidate) => candidate.id === 'custom-rain');

    expect(result.map.stateIds['custom:rain']).toEqual(['custom-rain']);
    expect(state?.semantic).toEqual({ kind: 'custom', value: 'custom-rain' });
    expect(state?.enterConditions).toEqual([{
      mode: 'any',
      clauses: [{ kind: 'signal', signal: 'user-interaction' }]
    }]);
  });

  test('将 Unicode 扩展状态转换为可校验的 ASCII 标识符', () => {
    const result = convertCharacterDraftV1ToV2(createV1WithUnicodeExtensionState());
    const state = result.document.states.find((candidate) => candidate.id === 'custom-u8df3-u821e');

    expect(result.map.stateIds['custom:跳舞']).toEqual(['custom-u8df3-u821e']);
    expect(state?.semantic).toEqual({ kind: 'custom', value: 'custom-u8df3-u821e' });
    expect(characterDraftV2Schema.parse(result.document)).toEqual(result.document);
  });

  test('为没有 idle 的草稿选择现有状态并为空草稿补建最小待机状态', () => {
    const withoutIdle: CharacterDraftV1 = {
      version: 1,
      id: 'character-demo',
      name: '演示角色',
      states: [{ id: 'custom:rain', kind: 'extension', actions: [] }]
    };
    const empty: CharacterDraftV1 = {
      version: 1,
      id: 'character-empty',
      name: '空角色',
      states: []
    };

    const convertedWithoutIdle = convertCharacterDraftV1ToV2(withoutIdle);
    const convertedEmpty = convertCharacterDraftV1ToV2(empty);

    expect(convertedWithoutIdle.document.defaultStateId).toBe('custom-rain');
    expect(characterDraftV2Schema.parse(convertedWithoutIdle.document))
      .toEqual(convertedWithoutIdle.document);
    expect(convertedEmpty.document.defaultStateId).toBe('idle');
    expect(convertedEmpty.document.states).toMatchObject([{
      id: 'idle', semantic: 'idle', actionIds: []
    }]);
    expect(characterDraftV2Schema.parse(convertedEmpty.document)).toEqual(convertedEmpty.document);
  });

  test('为超长 Unicode 重复状态分配长度受限的唯一 ASCII 标识符', () => {
    const sourceStateId = `custom:${'跳'.repeat(58)}` as `custom:${string}`;
    const draft: CharacterDraftV1 = {
      version: 1,
      id: 'character-demo',
      name: '演示角色',
      states: [
        { id: sourceStateId, kind: 'extension', actions: [] },
        { id: sourceStateId, kind: 'extension', actions: [] }
      ]
    };

    const result = convertCharacterDraftV1ToV2(draft);
    const convertedIds = result.map.stateIds[sourceStateId]!;

    expect(convertedIds).toHaveLength(2);
    expect(new Set(convertedIds).size).toBe(2);
    expect(convertedIds.every((id) => /^[a-z0-9][a-z0-9_-]{0,119}$/u.test(id))).toBe(true);
    expect(characterDraftV2Schema.parse(result.document)).toEqual(result.document);
  });

  test('按源顺序重命名重复状态标识符', () => {
    const result = convertCharacterDraftV1ToV2(createV1WithDuplicateStateIds());

    expect(result.map.stateIds.idle).toEqual(['idle', 'idle-2']);
    expect(result.document.states.map((state) => state.id)).toEqual(['idle', 'idle-2']);
  });

  test('转换草稿时不修改输入数据', () => {
    const draft = createV1WithDuplicateActionIds();
    const before = structuredClone(draft);

    convertCharacterDraftV1ToV2(draft);

    expect(draft).toEqual(before);
  });
});
