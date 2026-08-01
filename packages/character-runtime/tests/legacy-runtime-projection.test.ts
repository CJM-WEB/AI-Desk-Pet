import { describe, expect, test } from 'vitest';
import {
  type CharacterManifestV2,
  characterManifestV1Schema,
  projectCharacterManifestV2ToLegacy
} from '../src';

const SHA_256 = 'a'.repeat(64);

/** 创建包含核心状态、自定义状态及冲突动作 ID 的 V2 发布清单。 */
function createManifest(): CharacterManifestV2 {
  return {
    version: 2,
    id: 'character-demo', name: '演示角色', thumbnailAssetId: 'thumbnail',
    compilerVersion: 'compiler-2.0.0',
    identity: {
      description: '角色描述', background: '角色背景', traits: [], languageStyle: '自然',
      formsOfAddress: [], likes: [], dislikes: [], behavioralTendencies: [],
      boundaries: [], exampleLines: []
    },
    defaultSkinId: 'default', defaultStateId: 'rest',
    resources: [
      { assetId: 'thumbnail', fileName: 'thumbnail.webp', sha256: SHA_256, byteLength: 1 },
      { assetId: 'atlas', fileName: 'atlas.png', sha256: SHA_256, byteLength: 1 }
    ],
    skins: [{
      id: 'default', name: '默认皮肤',
      semanticFallbacks: [{ semantic: 'listen', actionId: 'listen-fallback' }],
      presentations: ['rest-action', 'listen-fallback', 'rain-action'].map((actionId) => ({
        actionId, fps: 12, frames: [{ assetId: 'atlas', x: 0, y: 0, width: 64, height: 64 }],
        anchors: { ground: { x: 0.5, y: 1 } },
        regions: { click: { x: 0, y: 0, width: 1, height: 1 } }
      }))
    }],
    states: [
      state('rest', 'idle', ['rest-action']),
      state('hearing', 'listen', ['listen-action']),
      state('hearing-more', 'listen', ['listen-repeat']),
      {
        ...state('custom-rain', { kind: 'custom', value: 'custom-rain' }, ['rain-action']),
        enterConditions: [{
          mode: 'any',
          clauses: [
            { kind: 'signal', signal: 'idle' },
            { kind: 'signal', signal: 'user-interaction' },
            { kind: 'semantic', semantic: 'idle' }
          ]
        }]
      }
    ],
    actions: [
      action('rest-action', 'idle', 1, 'until-interrupted'),
      action('listen-action', 'listen', 2, 'never'),
      action('listen-repeat', 'listen', 3, 'presentation'),
      action('listen-fallback', 'listen', 4, 'never'),
      action('rain-action', 'idle', 1, 'never')
    ]
  };
}

/** 创建最小主状态。 */
function state(
  id: string,
  semantic: CharacterManifestV2['states'][number]['semantic'],
  actionIds: string[]
) {
  return {
    id, name: id, kind: 'primary' as const, semantic, tags: [], intensity: 1,
    coexistWithStateIds: [], forbiddenStateIds: [], enterConditions: [], exitConditions: [],
    agentInferable: false, actionIds
  };
}

/** 创建投影所需的最小动作定义。 */
function action(
  id: string,
  semantic: CharacterManifestV2['actions'][number]['semantic'],
  preference: number,
  loopPolicy: CharacterManifestV2['actions'][number]['loopPolicy']
) {
  return {
    id, name: id, semantic, tags: [], preference, cooldownMs: 0,
    repeatSuppressionMs: 0, loopPolicy, interrupt: 'normal' as const,
    allowedPrimaryStateIds: [], forbiddenPrimaryStateIds: [], requiredModifierStateIds: [],
    forbiddenModifierStateIds: [], direction: 'any' as const
  };
}

describe('旧播放器投影', () => {
  test('按语义投影状态、恢复自定义触发器并保持输入不可变', () => {
    const manifest = createManifest();
    const before = structuredClone(manifest);

    const projected = projectCharacterManifestV2ToLegacy(manifest);

    expect(projected.version).toBe(1);
    expect(projected.states.find((state) => state.id === 'listening')?.actions.map((action) => action.id))
      .toEqual(['listen-fallback', 'listen-fallback-2']);
    expect(projected.states.find((state) => state.id === 'listening')?.actions[0]?.weight).toBe(4);
    expect(projected.states.find((state) => state.id === 'listening')?.actions[1]?.loop).toBe(false);
    expect(projected.states.find((state) => state.id === 'custom:rain')).toMatchObject({
      kind: 'extension', triggers: { events: ['idle', 'single_click'] }
    });
    expect(projected.states.find((state) => state.id === 'idle')?.actions[0]?.id).toBe('rest-action');
    expect(manifest).toEqual(before);
    expect(characterManifestV1Schema.parse(projected)).toEqual(projected);
  });
});
