import { describe, expect, test } from 'vitest';
import {
  type CharacterDraftV2,
  resolveCharacterPresentation
} from '../src';

/** 创建覆盖四级皮肤表现回退链的最小 V2 草稿。 */
function createDraft(): CharacterDraftV2 {
  return {
    version: 2,
    id: 'character-demo',
    name: '演示角色',
    identity: {
      description: '角色描述', background: '角色背景', traits: [], languageStyle: '自然',
      formsOfAddress: [], likes: [], dislikes: [], behavioralTendencies: [],
      boundaries: [], exampleLines: []
    },
    defaultSkinId: 'default',
    defaultStateId: 'idle',
    skins: [
      {
        id: 'default', name: '默认皮肤', semanticFallbacks: [],
        presentations: [
          presentation('idle-main'),
          presentation('wave')
        ]
      },
      {
        id: 'winter', name: '冬季皮肤',
        semanticFallbacks: [{ semantic: 'speak', actionId: 'talk-winter' }],
        presentations: [presentation('wave'), presentation('talk-winter')]
      }
    ],
    states: [state('idle', 'idle', ['idle-main'])],
    actions: [
      action('idle-main', 'idle'),
      action('wave', 'speak'),
      action('talk-winter', 'speak')
    ]
  };
}

/** 创建带可播放单帧的皮肤表现。 */
function presentation(actionId: string) {
  return {
    actionId,
    fps: 12,
    frames: [{ assetId: 'atlas', x: 0, y: 0, width: 64, height: 64 }],
    anchors: { ground: { x: 0.5, y: 1 } }
  };
}

/** 创建满足 V2 必填约束的动作。 */
function action(id: string, semantic: CharacterDraftV2['actions'][number]['semantic']) {
  return {
    id, name: id, semantic, tags: [], preference: 1, cooldownMs: 0,
    repeatSuppressionMs: 0, loopPolicy: 'never' as const, interrupt: 'normal' as const,
    allowedPrimaryStateIds: [], forbiddenPrimaryStateIds: [], requiredModifierStateIds: [],
    forbiddenModifierStateIds: [], direction: 'any' as const
  };
}

/** 创建最小主状态。 */
function state(
  id: string,
  semantic: CharacterDraftV2['states'][number]['semantic'],
  actionIds: string[]
) {
  return {
    id, name: id, kind: 'primary' as const, semantic, tags: [], intensity: 1,
    coexistWithStateIds: [], forbiddenStateIds: [], enterConditions: [], exitConditions: [],
    agentInferable: false, actionIds
  };
}

describe('皮肤表现解析器', () => {
  test('按固定四级顺序解析可播放表现且不修改输入', () => {
    const draft = createDraft();
    const before = structuredClone(draft);

    expect(resolveCharacterPresentation(draft, 'winter', 'wave')?.source).toBe('skin-action');
    expect(resolveCharacterPresentation({
      ...draft,
      skins: draft.skins.map((skin) => skin.id === 'winter'
        ? { ...skin, presentations: skin.presentations.filter((item) => item.actionId !== 'wave') }
        : skin)
    }, 'winter', 'wave')?.source).toBe('skin-semantic');
    expect(resolveCharacterPresentation({
      ...draft,
      skins: draft.skins.map((skin) => skin.id === 'winter'
        ? {
            ...skin,
            presentations: skin.presentations.filter((item) => item.actionId !== 'wave'),
            semanticFallbacks: []
          }
        : skin)
    }, 'winter', 'wave')?.source).toBe('default-action');
    expect(resolveCharacterPresentation({
      ...draft,
      skins: draft.skins.map((skin) => skin.id === 'default'
        ? { ...skin, presentations: [presentation('idle-main')] }
        : {
            ...skin,
            presentations: skin.presentations.filter((item) => item.actionId !== 'wave'),
            semanticFallbacks: []
          })
    }, 'winter', 'wave')?.source).toBe('default-state');
    expect(resolveCharacterPresentation({
      ...draft,
      skins: draft.skins.map((skin) => ({ ...skin, presentations: [] }))
    }, 'winter', 'wave')).toBeNull();
    expect(draft).toEqual(before);
  });

  test('拒绝不存在的皮肤、默认皮肤或动作', () => {
    const draft = createDraft();

    expect(resolveCharacterPresentation(draft, 'missing', 'wave')).toBeNull();
    expect(resolveCharacterPresentation({ ...draft, defaultSkinId: 'missing' }, 'winter', 'wave')).toBeNull();
    expect(resolveCharacterPresentation(draft, 'winter', 'missing')).toBeNull();
  });
});
