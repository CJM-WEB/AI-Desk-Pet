import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { migrateCharacterDraftToV3, convertCharacterDraftV1ToV2 } from '@myself/character-runtime';
import { migrateCharacterDocument, prepareCharacterManifestMigration, finalizeCharacterManifestMigration, requirePublishedCharacterMigration } from '../src/main/characters/character-migrations';
import { CharacterStore } from '../src/main/characters/character-store';
import { CharacterBehaviorService, type CharacterBehaviorPlaybackEvent } from '../src/main/characters/character-behavior-service';
import { CharacterBehaviorDirector } from '../src/main/characters/character-behavior-director';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

test('正式草稿迁移接受 V3 并保留自定义状态 ID 和完整人设', () => {
  const draft = migrateCharacterDraftToV3({ version: 1, id: 'demo', name: '角色', states: [] }).document;
  draft.states[0]!.id = 'quiet-afternoon';
  draft.idleStateId = 'quiet-afternoon';
  draft.identity.formsOfAddress = ['朋友'];
  draft.identity.boundaries = ['先征求许可'];
  expect(migrateCharacterDocument(draft).document).toEqual(draft);
});

test('正式存储创建及保存仅输出 V3 草稿', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'character-v3-'));
  directories.push(directory);
  const store = new CharacterStore(directory);
  await store.create({ id: 'demo', name: '角色' });
  const draft = await store.getDraft('demo');
  expect(draft.version).toBe(3);
  expect(draft).toHaveProperty('idleStateId', 'idle');
  expect(draft.states[0]).not.toHaveProperty('semantic');
  expect(draft.states[0]).not.toHaveProperty('kind');
});

// 串联真实 Store 多阶段落盘；仅为全量测试的磁盘竞争留出时间，不改变生产恢复预算。
test('旧规则逐项保留，省略处置不能发布，原文不被后续保存覆盖', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'character-v3-review-'));
  directories.push(directory);
  const store = new CharacterStore(directory);
  await store.create({ id: 'demo', name: '角色' });
  const old = convertCharacterDraftV1ToV2({ version: 1, id: 'demo', name: '角色', states: [] }).document;
  old.states.push({ ...structuredClone(old.states[0]!), id: 'sparkles', kind: 'modifier', semantic: { kind: 'custom', value: 'sparkles' } });
  const original = JSON.stringify(old);
  await writeFile(join(directory, 'demo/draft/draft.json'), original);
  const draft = await store.getDraft('demo');
  const review = await store.getMigrationReview('demo');
  expect(review.issues.some(issue => issue.code === 'modifier-state')).toBe(true);
  await store.saveDraft('demo', draft);
  expect(await store.getMigrationReview('demo')).toEqual(review);
  expect(await readFile(join(directory, 'demo/migration-original-draft.json'), 'utf8')).toBe(original);
  const bytes = new Uint8Array([1]);
  const prepared = prepareCharacterManifestMigration({ version: 1, id: 'demo', name: '角色',
    thumbnailAssetId: 'atlas', compilerVersion: 'test',
    resources: [{ assetId: 'atlas', fileName: 'atlas.png', byteLength: 1, sha256: createHash('sha256').update(bytes).digest('hex') }],
    states: [{ id: 'idle', kind: 'core', actions: [{ id: 'idle-main', name: '待机', fps: 8, loop: true, weight: 1,
      anchors: { ground: { x: .5, y: 1 } }, frames: [{ assetId: 'atlas', x: 0, y: 0, width: 1, height: 1 }] }] }]
  });
  const finalized = await finalizeCharacterManifestMigration(prepared, { 'atlas.png': bytes }, { decodeAlpha: async () => ({ width: 1, height: 1, alpha: new Uint8Array([255]) }) });
  const manifest = requirePublishedCharacterMigration(finalized);
  await expect(store.publishCompiled('demo', manifest, { 'atlas.png': bytes })).rejects.toThrow('CHARACTER_MIGRATION_REVIEW_REQUIRED');
  await store.saveDraft('demo', draft, undefined, review.issues.map(issue => ({ issueId: issue.issueId, decision: 'discarded' })));
  await store.publishCompiled('demo', manifest, { 'atlas.png': bytes });
  expect((await store.getRuntimeManifest('demo')).version).toBe(3);
  await store.setActive('demo');
  const events: CharacterBehaviorPlaybackEvent[] = [];
  const service = new CharacterBehaviorService({ store, now: () => 10,
    motion: { getSnapshot: () => ({ revision: 1, timestampMs: 0, position: { x: 0, y: 0 }, target: { x: 0, y: 0 }, direction: 'right', moving: false, carrying: false }),
      requestIntent: () => null, applyTaskEvent: () => undefined }
  });
  service.subscribe(event => events.push(event));
  await service.initialize();
  expect(events.at(-1)).toMatchObject({ type: 'behavior-action', stateId: manifest.idleStateId, actionId: 'idle-main', playback: { mode: 'loop' } });
  const oldPlayback = events.at(-1);
  await service.handleActiveCharacterChanged();
  const current = service.snapshot();
  if (oldPlayback?.type !== 'behavior-action') throw new Error('未生成播放授权');
  expect(() => service.applyPlaybackFeedback({ playbackToken: oldPlayback.playbackToken, actionId: oldPlayback.actionId, status: 'completed', occurredAtMs: 10 })).toThrow('CHARACTER_PLAYBACK_UNAUTHORIZED');
  expect(service.snapshot()).toEqual(current);
  const requestIntent = vi.fn(() => ({ revision: 1, timestampMs: 10, position: { x: 0, y: 0 }, target: { x: 10, y: 0 }, direction: 'right' as const, moving: true, carrying: false }));
  const director = new CharacterBehaviorDirector({ behavior: service,
    motion: { getSnapshot: () => ({ revision: 1, timestampMs: 10, position: { x: 0, y: 0 }, target: { x: 0, y: 0 }, direction: 'right' as const, moving: false, carrying: false }), requestIntent, stop: () => undefined },
    initialGeneration: 'test', initialSettings: { movementMode: 1, proactivityMode: 'assistive' }, saveMovementMode: async () => undefined });
  director.requestPersistentMovement();
  // 迁移后仅有待机素材不能直接位移；正式模式仍等待合法行走匹配与首帧。
  expect(requestIntent).not.toHaveBeenCalled();
  expect(service.snapshot()).toEqual(current);
  service.close();
}, 15_000);



