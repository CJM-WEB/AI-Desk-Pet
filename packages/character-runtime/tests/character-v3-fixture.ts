import type { CharacterDraftV2 } from '../src';

/** 固定作者数据与资源修订，供 V3 契约、迁移和播放边界测试共用。 */
export function v2Fixture(): CharacterDraftV2 {
  return {
    version: 2, id: 'pet', name: '伙伴', defaultSkinId: 'base', defaultStateId: 'rest',
    identity: { description: '人物描述', background: '背景', traits: ['温和'], languageStyle: '简洁',
      formsOfAddress: [], likes: [], dislikes: [], behavioralTendencies: [], boundaries: [], exampleLines: [] },
    states: [{ id: 'rest', name: '中文自定义兜底', description: '保留状态描述', kind: 'primary', semantic: 'idle',
      tags: [], intensity: 1, coexistWithStateIds: [], forbiddenStateIds: [], enterConditions: [],
      exitConditions: [], agentInferable: false, actionIds: ['breathe'] }],
    actions: [{ id: 'breathe', name: '呼吸', description: '保留动作描述', semantic: 'idle', tags: [],
      preference: 1, cooldownMs: 0, repeatSuppressionMs: 0, loopPolicy: 'presentation', interrupt: 'normal',
      allowedPrimaryStateIds: ['rest'], forbiddenPrimaryStateIds: [], requiredModifierStateIds: [],
      forbiddenModifierStateIds: [], direction: 'any' }],
    skins: [{ id: 'base', name: '默认', description: '保留皮肤描述', semanticFallbacks: [], presentations: [{
      actionId: 'breathe', fps: 12, playbackRate: 1.5, mirrorX: true,
      frames: [{ id: 'f1', assetId: 'atlas', x: 0, y: 0, width: 32, height: 32 }],
      commitFrameId: 'f1', anchors: { ground: { x: 0.5, y: 1 }, mouth: { x: 0.4, y: 0.3 } },
      regions: { click: { x: 0, y: 0, width: 1, height: 1 } },
      geometry: { visualBounds: { x: 0, y: 0, width: 1, height: 1 }, groundAnchor: { x: 0.5, y: 1 }, resourceRevision: 'a'.repeat(64) }
    }] }]
  };
}

export function v3Fixture() {
  const source = v2Fixture();
  const { defaultStateId, ...common } = source;
  return { ...common, version: 3 as const, idleStateId: defaultStateId,
    states: source.states.map(({ kind, semantic, coexistWithStateIds, forbiddenStateIds, ...state }) => ({
      ...state, enterConditions: [], exitConditions: []
    })),
    actions: source.actions.map(({ semantic, allowedPrimaryStateIds, forbiddenPrimaryStateIds,
      requiredModifierStateIds, forbiddenModifierStateIds, ...action }) => action),
    skins: source.skins.map(({ semanticFallbacks, ...skin }) => skin)
  };
}

export const resourceFields = {
  thumbnailAssetId: 'atlas', compilerVersion: 'test',
  resources: [{ assetId: 'atlas', fileName: 'atlas.png', sha256: 'a'.repeat(64), byteLength: 64 }]
};
