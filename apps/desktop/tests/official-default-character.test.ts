import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { CharacterStore } from '../src/main/characters/character-store';
import { ensureOfficialDefaultCharacter } from '../src/main/characters/official-default-character';
import { prepareCharacterStartup } from '../src/main/characters/character-startup';
import { atomicWriteText } from '../src/main/storage/atomic-file-coordinator';

let temporaryDirectory = '';

afterEach(async () => {
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

describe('官方默认角色安装', () => {
  const resourceDirectory = fileURLToPath(new URL(
    '../resources/characters/default',
    import.meta.url
  ));

  test('从打包资源安装八个核心状态并设为活动角色', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'ai-pet-default-'));
    const store = new CharacterStore(join(temporaryDirectory, 'characters'));

    await ensureOfficialDefaultCharacter(
      store,
      resourceDirectory
    );

    const manifest = await store.getActive();
    const publishedManifest = await store.getPublishedManifest('builtin-default');
    expect(manifest.version).toBe(1);
    expect(publishedManifest.version).toBe(2);
    expect(manifest.id).toBe('builtin-default');
    expect(manifest.states.map(state => state.id)).toEqual([
      'idle',
      'listening',
      'thinking',
      'moving',
      'acting',
      'carrying',
      'success',
      'error'
    ]);
    const carrying = publishedManifest.skins[0]!.presentations.find(
      presentation => presentation.actionId === 'carrying-main'
    );
    expect(carrying?.commitFrameId).toBe('carrying-frame-3');
    expect(carrying?.frames.findIndex(frame => frame.id === carrying.commitFrameId))
      .toBe(2);
  });

  test('已有可用默认角色时不重写其运行版本', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'ai-pet-default-'));
    const store = new CharacterStore(join(temporaryDirectory, 'characters'));
    await ensureOfficialDefaultCharacter(store, resourceDirectory);
    const before = await store.getRuntimeManifest('builtin-default');

    await ensureOfficialDefaultCharacter(store, resourceDirectory);

    expect(await store.getRuntimeManifest('builtin-default')).toEqual(before);
  });

  test('损坏索引后重建可写索引并保留有效用户角色、草稿与损坏证据', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'ai-pet-default-recovery-'));
    const charactersDirectory = join(temporaryDirectory, 'characters');
    const store = new CharacterStore(charactersDirectory);
    await ensureOfficialDefaultCharacter(store, resourceDirectory);

    const defaultDraft = await store.getDraft('builtin-default');
    const defaultManifest = await store.getPublishedManifest('builtin-default');
    await store.create({ id: 'user-pet', name: '用户角色' });
    await store.saveDraft('user-pet', {
      ...defaultDraft,
      id: 'user-pet',
      name: '用户角色'
    });
    await store.publishCompiled('user-pet', {
      ...defaultManifest,
      id: 'user-pet',
      name: '用户角色'
    }, Object.fromEntries(await Promise.all(defaultManifest.resources.map(async resource => [
      resource.fileName,
      new Uint8Array(await readFile(join(resourceDirectory, resource.fileName)))
    ]))));
    const userDraftBefore = await readFile(
      join(charactersDirectory, 'user-pet', 'draft', 'draft.json'),
      'utf8'
    );
    await writeFile(join(charactersDirectory, 'index.json'), '{损坏索引', 'utf8');

    const restarted = new CharacterStore(charactersDirectory);
    await expect(restarted.recoverCorruptIndex()).resolves.toMatchObject({
      recovered: true,
      recoveredCharacterIds: ['builtin-default', 'user-pet'],
      skipped: [],
      warnings: []
    });
    await expect(prepareCharacterStartup({
      loadIndex: () => restarted.list(),
      validateActiveRuntime: async () => null
    })).resolves.toEqual({ kind: 'fallback', errorCode: null });
    await expect(ensureOfficialDefaultCharacter(restarted, resourceDirectory))
      .resolves.toBeUndefined();

    expect((await restarted.list()).map(character => character.id)).toEqual([
      'builtin-default',
      'user-pet'
    ]);
    expect((await restarted.getActive()).id).toBe('builtin-default');
    expect(await readFile(
      join(charactersDirectory, 'user-pet', 'draft', 'draft.json'),
      'utf8'
    )).toBe(userDraftBefore);
    const rootEntries = await readdir(charactersDirectory);
    expect(rootEntries.some(name => /^index\.json\.corrupt-/u.test(name))).toBe(true);
    expect(rootEntries.some(name => /^index-recovery-/u.test(name))).toBe(true);
  });

  test('候选目录在扫描后消失时隔离跳过且不阻止默认角色启动', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'ai-pet-recovery-race-'));
    const charactersDirectory = join(temporaryDirectory, 'characters');
    const original = new CharacterStore(charactersDirectory);
    await ensureOfficialDefaultCharacter(original, resourceDirectory);
    await mkdir(join(charactersDirectory, 'vanishing-pet'), { recursive: true });
    await writeFile(join(charactersDirectory, 'index.json'), '{损坏', 'utf8');

    const restarted = new CharacterStore(charactersDirectory, {
      onRecoveryDirectoryCandidate: async (characterId, directory) => {
        if (characterId === 'vanishing-pet') {
          await rm(directory, { recursive: true, force: true });
        }
      }
    });
    const recovery = await restarted.recoverCorruptIndex();

    expect(recovery).toMatchObject({
      recovered: true,
      skipped: [{
        characterId: 'vanishing-pet',
        reason: 'CHARACTER_RECOVERY_DIRECTORY_SKIPPED'
      }]
    });
    await expect(ensureOfficialDefaultCharacter(restarted, resourceDirectory))
      .resolves.toBeUndefined();
    expect((await restarted.getActive()).id).toBe('builtin-default');
  });

  test('恢复扫描跳过目录链接且不读取或修改链接目标', async ({ skip }) => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'ai-pet-recovery-link-'));
    const charactersDirectory = join(temporaryDirectory, 'characters');
    const outsideDirectory = join(temporaryDirectory, 'outside-character');
    const markerFile = join(outsideDirectory, 'marker.txt');
    await mkdir(charactersDirectory, { recursive: true });
    await mkdir(outsideDirectory, { recursive: true });
    await writeFile(markerFile, '不可修改', 'utf8');

    try {
      await symlink(
        outsideDirectory,
        join(charactersDirectory, 'linked-pet'),
        process.platform === 'win32' ? 'junction' : 'dir'
      );
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : '';
      if (code === 'EPERM' || code === 'EACCES') {
        skip();
        return;
      }
      throw error;
    }
    await writeFile(join(charactersDirectory, 'index.json'), '{损坏', 'utf8');

    const restarted = new CharacterStore(charactersDirectory);
    const recovery = await restarted.recoverCorruptIndex();

    expect(recovery.skipped).toContainEqual({
      characterId: 'linked-pet',
      reason: 'CHARACTER_RECOVERY_DIRECTORY_SKIPPED'
    });
    await expect(ensureOfficialDefaultCharacter(restarted, resourceDirectory))
      .resolves.toBeUndefined();
    expect((await restarted.getActive()).id).toBe('builtin-default');
    expect(await readFile(markerFile, 'utf8')).toBe('不可修改');
  });

  test('恢复记录写失败仅返回警告且新索引和默认角色仍可用', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'ai-pet-recovery-warning-'));
    const charactersDirectory = join(temporaryDirectory, 'characters');
    await mkdir(charactersDirectory, { recursive: true });
    await writeFile(join(charactersDirectory, 'index.json'), '{损坏', 'utf8');
    const restarted = new CharacterStore(charactersDirectory, {
      writeText: async (file, content) => {
        if (file.includes('index-recovery-')) {
          throw new Error('RECOVERY_RECORD_WRITE_FAILED');
        }
        await atomicWriteText(file, content);
      }
    });

    const recovery = await restarted.recoverCorruptIndex();

    expect(recovery).toMatchObject({
      recovered: true,
      warnings: ['CHARACTER_RECOVERY_RECORD_WRITE_FAILED']
    });
    await expect(ensureOfficialDefaultCharacter(restarted, resourceDirectory))
      .resolves.toBeUndefined();
    expect((await restarted.getActive()).id).toBe('builtin-default');
    expect((await readdir(charactersDirectory))
      .some(name => /^index\.json\.corrupt-/u.test(name))).toBe(true);
  });
});
