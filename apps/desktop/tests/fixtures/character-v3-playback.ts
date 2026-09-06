import {
  characterPlaybackViewSchema, type CharacterManifestV1, type CharacterPlaybackView
} from '@myself/character-runtime';

/** 测试入口将既有帧夹具装配为严格 V3 播放视图，保留原始状态和动作 ID。 */
export function testPlaybackView(document: CharacterManifestV1): CharacterPlaybackView {
  const actions = document.states.flatMap(state => state.actions);
  return characterPlaybackViewSchema.parse({
    version: 3, id: document.id, skinId: 'default', defaultSkinId: 'default', idleStateId: 'idle',
    resources: document.resources,
    states: document.states.map(state => ({ id: state.id, name: state.id, actionIds: state.actions.map(action => action.id) })),
    actions: actions.map(action => ({ id: action.id, direction: action.direction ?? 'any', loopPolicy: action.loop ? 'presentation' : 'never' })),
    presentations: actions.map(action => ({ actionId: action.id, skinId: 'default', source: 'skin-action', presentation: {
      actionId: action.id, fps: action.fps, frames: action.frames, anchors: action.anchors,
      ...(action.regions ? { regions: action.regions } : {}),
      ...(action.playbackRate === undefined ? {} : { playbackRate: action.playbackRate }),
      ...(action.mirrorX === undefined ? {} : { mirrorX: action.mirrorX }),
      geometry: { visualBounds: { x: 0, y: 0, width: 1, height: 1 }, groundAnchor: action.anchors.ground,
        resourceRevision: [...new Set(action.frames.map(frame => document.resources.find(resource => resource.assetId === frame.assetId)!.sha256))].sort().join('.') }
    } })),
    idle: { stateId: 'idle', actionId: document.states.find(state => state.id === 'idle')!.actions[0]!.id }
  });
}
