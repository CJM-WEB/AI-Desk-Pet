import { expect, test } from 'vitest';
import * as runtime from '../src';
import { resourceFields, v3Fixture } from './character-v3-fixture';

test('中文名称不改变稳定 ID，旧语义字段被严格拒绝', () => {
  expect(runtime).toHaveProperty('characterDraftV3Schema');
  const schema = runtime.characterDraftV3Schema;
  const draft = v3Fixture();
  expect(schema.parse(draft).idleStateId).toBe('rest');
  expect(schema.safeParse({ ...draft, defaultStateId: 'rest' }).success).toBe(false);
  expect(schema.safeParse({ ...draft, states: [{ ...draft.states[0], semantic: 'idle' }] }).success).toBe(false);
  expect(schema.safeParse({ ...draft, actions: [{ ...draft.actions[0], allowedPrimaryStateIds: [] }] }).success).toBe(false);
  expect(schema.safeParse({ ...draft, skins: [{ ...draft.skins[0], semanticFallbacks: [] }] }).success).toBe(false);
});

test('发布要求有效 idle、资源引用和绑定当前资源及锚点的几何，Prepared 不伪装正式清单', () => {
  expect(runtime).toHaveProperty('characterManifestV3Schema');
  const manifest = { ...v3Fixture(), ...resourceFields };
  expect(runtime.characterManifestV3Schema.safeParse(manifest).success).toBe(true);
  const noGeometry = structuredClone(manifest);
  delete noGeometry.skins[0]!.presentations[0]!.geometry;
  expect(runtime.preparedCharacterManifestV3Schema.safeParse(noGeometry).success).toBe(true);
  expect(runtime.characterManifestV3Schema.safeParse(noGeometry).success).toBe(false);
  expect(runtime.characterDraftV3Schema.safeParse({ ...v3Fixture(), idleStateId: null }).success).toBe(true);
  expect(runtime.preparedCharacterManifestV3Schema.safeParse({ ...manifest, idleStateId: null }).success).toBe(false);
  for (const mutate of [
    (m: typeof manifest) => { m.skins[0]!.presentations[0]!.geometry!.resourceRevision = 'b'.repeat(64); },
    (m: typeof manifest) => { m.skins[0]!.presentations[0]!.geometry!.groundAnchor.x = 0; },
    (m: typeof manifest) => { m.resources = []; },
    (m: typeof manifest) => { m.states[0]!.actionIds = []; },
    (m: typeof manifest) => { m.skins[0]!.presentations[0]!.frames[0]!.width = 4097; }
  ]) {
    const invalid = structuredClone(manifest); mutate(invalid);
    expect(runtime.characterManifestV3Schema.safeParse(invalid).success).toBe(false);
  }
});

test('拒绝悬空引用、重复 ID、回退循环和不受支持条件', () => {
  expect(runtime).toHaveProperty('characterDraftV3Schema');
  const draft = v3Fixture();
  for (const invalid of [
    { ...draft, idleStateId: 'missing' },
    { ...draft, states: [...draft.states, ...draft.states] },
    { ...draft, states: [{ ...draft.states[0], actionIds: ['missing'] }] },
    { ...draft, actions: [{ ...draft.actions[0], failureFallbackActionId: 'breathe' }] },
    { ...draft, states: [{ ...draft.states[0], enterConditions: [{ mode: 'any', clauses: [{ kind: 'event', event: 'idle' }] }] }] }
  ]) expect(runtime.characterDraftV3Schema.safeParse(invalid).success).toBe(false);
  expect(runtime.characterDraftV3Schema.safeParse({ ...draft, states: [{ ...draft.states[0], enterConditions: [
    { mode: 'any', clauses: [{ kind: 'event', event: 'task-finished' }] }
  ] }] }).success).toBe(true);
});
