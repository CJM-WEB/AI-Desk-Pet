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

test('多页大帧表现和重复裁片可发布，几何必须绑定所有使用的页', () => {
  const manifest = structuredClone({ ...v3Fixture(), ...resourceFields });
  const presentation = manifest.skins[0]!.presentations[0]!;
  const first = manifest.resources[0]!;
  const second = { ...first, assetId: 'atlas-page-2', fileName: 'atlas-page-2.png', sha256: 'b'.repeat(64) };
  manifest.resources.push(second);
  presentation.frames = Array.from({ length: 17 }, (_, index) => ({
    ...presentation.frames[0]!, id: `frame-${index}`,
    assetId: index < 16 ? first.assetId : second.assetId,
    x: index < 16 ? index % 4 * 1024 : 0,
    y: index < 16 ? Math.floor(index / 4) * 1024 : 0,
    width: 1024, height: 1024
  }));
  presentation.geometry!.resourceRevision = [first.sha256, second.sha256].sort().join('.');
  presentation.commitFrameId = 'frame-0';
  expect(runtime.preparedCharacterManifestV3Schema.safeParse(manifest).success).toBe(true);
  expect(runtime.characterManifestV3Schema.safeParse(manifest).success).toBe(true);
  presentation.frames.push({ ...presentation.frames[0]!, id: 'repeated-frame' });
  expect(runtime.characterManifestV3Schema.safeParse(manifest).success).toBe(true);
  presentation.geometry!.resourceRevision = first.sha256;
  expect(runtime.characterManifestV3Schema.safeParse(manifest).success).toBe(false);
});

test.each(['x', 'y'] as const)('发布帧 %s 坐标不得越过图集页边界，草稿保留源图坐标', axis => {
  const manifest = structuredClone({ ...v3Fixture(), ...resourceFields });
  manifest.skins[0]!.presentations[0]!.frames[0]![axis] = 4096;
  expect(runtime.preparedCharacterManifestV3Schema.safeParse(manifest).success).toBe(false);
  expect(runtime.characterManifestV3Schema.safeParse(manifest).success).toBe(false);
  const draft = v3Fixture();
  draft.skins[0]!.presentations[0]!.frames[0]![axis] = 8192;
  expect(runtime.characterDraftV3Schema.safeParse(draft).success).toBe(true);
});
