import { expect, test } from 'vitest';
import * as runtime from '../src';
import { resourceFields, v3Fixture } from './character-v3-fixture';

test('播放先查当前状态归属，皮肤素材回退不改逻辑 ID', () => {
  expect(runtime).toHaveProperty('resolveCharacterPresentationV3');
  const draft = v3Fixture();
  draft.skins.push({ id: 'night', name: '夜间', presentations: [] });
  draft.states.push({ ...draft.states[0]!, id: 'sad', name: '发呆', actionIds: [] });
  expect(runtime.resolveCharacterPresentationV3(draft, 'night', 'sad', 'breathe')).toBeNull();
  expect(runtime.resolveCharacterPresentationV3(draft, 'night', 'rest', 'breathe')).toMatchObject({
    stateId: 'rest', actionId: 'breathe', skinId: 'base', source: 'default-action'
  });
  expect(runtime.resolveCharacterPresentationV3(draft, 'missing', 'rest', 'breathe')).toBeNull();
});

test('只读播放视图保留原 ID，idle 兜底给出真实目标且不能修改源清单', () => {
  expect(runtime).toHaveProperty('createCharacterPlaybackView');
  const manifest = runtime.characterManifestV3Schema.parse({ ...v3Fixture(), ...resourceFields });
  const view = runtime.createCharacterPlaybackView(manifest, 'base');
  expect(view.idle).toEqual({ stateId: 'rest', actionId: 'breathe' });
  expect(view.states[0]).toMatchObject({ id: 'rest', actionIds: ['breathe'] });
  expect(Object.isFrozen(view)).toBe(true);
  expect(Object.isFrozen(view.states[0]!.actionIds)).toBe(true);
  expect(Object.isFrozen(view.presentations[0]!.presentation.frames)).toBe(true);
  expect(Object.isFrozen(manifest)).toBe(false);
  expect(() => runtime.createCharacterPlaybackView(manifest, 'missing')).toThrow();
});

test('共享动作在严格 IPC 视图只保留一份表现，拒绝伪造归属与资源', () => {
  expect(runtime).toHaveProperty('characterPlaybackViewSchema');
  const draft = v3Fixture();
  draft.states.push({ ...draft.states[0]!, id: 'happy', name: '开心' });
  const view = runtime.createCharacterPlaybackView(runtime.characterManifestV3Schema.parse({ ...draft, ...resourceFields }), 'base');
  expect(view.presentations).toHaveLength(1);
  expect(view.states).toEqual([
    { id: 'rest', name: '中文自定义兜底', actionIds: ['breathe'] },
    { id: 'happy', name: '开心', actionIds: ['breathe'] }
  ]);
  expect(view.actions).toEqual([{ id: 'breathe', loopPolicy: 'presentation' }]);
  expect(runtime.characterPlaybackViewSchema.safeParse(view).success).toBe(true);
  for (const invalid of [
    { ...view, idle: { stateId: 'missing', actionId: 'breathe' } },
    { ...view, states: [{ id: 'rest', name: '静止', actionIds: [] }] },
    { ...view, presentations: [...view.presentations, ...view.presentations] },
    { ...view, resources: [] },
    { ...view, secret: '非法字段' }
  ]) expect(runtime.characterPlaybackViewSchema.safeParse(invalid).success).toBe(false);
});
