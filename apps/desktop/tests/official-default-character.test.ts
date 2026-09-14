import {
  cp,
  stat,
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
import { ensureOfficialDefaultCharacter, ensureOfficialDefaultCharacterInstalled } from '../src/main/characters/official-default-character';
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

  test('从固定快照安装九状态203帧并保留作者字段', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'ai-pet-default-'));
    const store = new CharacterStore(join(temporaryDirectory, 'characters'));
    await ensureOfficialDefaultCharacter(store, resourceDirectory);
    const manifest = await store.getPublishedManifest('builtin-default');
    expect(manifest.name).toBe('AI Pet默认角色');
    expect(manifest.states).toHaveLength(9);
    expect(manifest.skins[0]!.presentations.flatMap(item => item.frames)).toHaveLength(203);
    expect(manifest.states.every(state => state.agentInferable)).toBe(true);
    expect((await store.getActive()).id).toBe('builtin-default');
  }, 15_000);
  test('已有可用默认角色时不重写其运行版本', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'ai-pet-default-'));
    const store = new CharacterStore(join(temporaryDirectory, 'characters'));
    await ensureOfficialDefaultCharacter(store, resourceDirectory);
    const before = await store.getRuntimeManifest('builtin-default');

    await ensureOfficialDefaultCharacter(store, resourceDirectory);

    expect(await store.getRuntimeManifest('builtin-default')).toEqual(before);
  }, 15_000);

  test('非激活安装升级旧默认并保留其他活动角色和旧草稿备份', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'ai-pet-default-upgrade-'));
    const root = join(temporaryDirectory, 'characters');
    const store = new CharacterStore(root);
    await ensureOfficialDefaultCharacter(store, resourceDirectory);
    const draft = await store.getDraft('builtin-default');
    await store.saveDraft('builtin-default', { ...draft, name: '我的旧默认草稿' });
    await store.create({ id: 'other', name: '其他角色' });
    const manifest = await store.getPublishedManifest('builtin-default');
    await store.saveDraft('other', { ...draft, id: 'other', name: '其他角色' });
    await store.publishCompiled('other', { ...manifest, id: 'other', name: '其他角色' },
      Object.fromEntries(await Promise.all(manifest.resources.map(async resource => [
        resource.fileName, await readFile(join(resourceDirectory, 'compiled', resource.fileName))
      ]))));
    await store.setActive('other');
    await rm(join(root, 'builtin-default', 'builtin-revision.json'), { force: true });
    await ensureOfficialDefaultCharacterInstalled(store, resourceDirectory);
    expect((await store.getActive()).id).toBe('other');
    expect((await store.getDraft('builtin-default')).name).toBe('AI Pet默认角色');
    const backups = await readdir(join(root, '.official-default-backups'));
    const drafts = await Promise.all(backups.map(async entry => {
      try { return await readFile(join(root, '.official-default-backups', entry, 'previous', 'draft', 'draft.json'), 'utf8'); }
      catch { return ''; }
    }));
    expect(drafts.some(text => JSON.parse(text || '{}').name === '我的旧默认草稿')).toBe(true);
  }, 30_000);

  test('重复启动不重写草稿或修订，源图损坏后恢复完整安装', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'ai-pet-default-source-'));
    const root = join(temporaryDirectory, 'characters');
    const store = new CharacterStore(root);
    await ensureOfficialDefaultCharacter(store, resourceDirectory);
    const draftFile = join(root, 'builtin-default', 'draft', 'draft.json');
    const before = (await stat(draftFile)).mtimeMs;
    await ensureOfficialDefaultCharacterInstalled(store, resourceDirectory);
    expect((await stat(draftFile)).mtimeMs).toBe(before);
    const catalog = JSON.parse(await readFile(join(root, 'builtin-default', 'source', 'catalog.json'), 'utf8'));
    const sourceFile = `${catalog.sources[0].assetId}.png`;
    await writeFile(join(root, 'builtin-default', 'source', sourceFile), '损坏');
    await ensureOfficialDefaultCharacterInstalled(new CharacterStore(root), resourceDirectory);
    expect((await readFile(join(root, 'builtin-default', 'source', sourceFile)))
      .equals(await readFile(join(resourceDirectory, 'source', sourceFile)))).toBe(true);
  }, 30_000);

  test('源目录丢失草稿引用时重新安装而不信任已有修订', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'ai-pet-default-catalog-'));
    const root = join(temporaryDirectory, 'characters');
    const store = new CharacterStore(root);
    await ensureOfficialDefaultCharacter(store, resourceDirectory);
    const catalogFile = join(root, 'builtin-default', 'source', 'catalog.json');
    await writeFile(catalogFile, JSON.stringify({ version: 1, characterId: 'builtin-default', sources: [] }));
    await ensureOfficialDefaultCharacterInstalled(store, resourceDirectory);
    expect(JSON.parse(await readFile(catalogFile, 'utf8')).sources).toHaveLength(9);
  }, 30_000);
  test.each(['catalog.json', 'draft.next.json', 'publish-transaction.json', 'builtin-revision.json'])(
    '在 %s 写入失败时恢复旧版本并允许重启重试', async failureFile => {
      temporaryDirectory = await mkdtemp(join(tmpdir(), 'ai-pet-default-interrupt-'));
      const root = join(temporaryDirectory, 'characters');
      const store = new CharacterStore(root);
      await ensureOfficialDefaultCharacter(store, resourceDirectory);
      const original = await store.getDraft('builtin-default');
      await store.saveDraft('builtin-default', { ...original, name: '尚未发布的编辑' });
      await rm(join(root, 'builtin-default', 'builtin-revision.json'));
      const failing = new CharacterStore(root, {
        writeText: async (file, text) => {
          if (file.endsWith(failureFile)) throw new Error('模拟磁盘写入失败');
          await atomicWriteText(file, text);
        }
      });
      await expect(ensureOfficialDefaultCharacterInstalled(failing, resourceDirectory)).rejects.toThrow();
      const restarted = new CharacterStore(root);
      expect((await restarted.getDraft('builtin-default')).name).toBe('尚未发布的编辑');
      expect((await restarted.getPublishedManifest('builtin-default')).states).toHaveLength(9);
      await expect(stat(join(root, 'builtin-default', 'builtin-revision.json'))).rejects.toThrow();
      await ensureOfficialDefaultCharacterInstalled(restarted, resourceDirectory);
      expect((await restarted.getDraft('builtin-default')).name).toBe('AI Pet默认角色');
    }, 30_000
  );

  test('重启时即使随包资源不可用也先恢复未完成安装的旧草稿和索引', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'ai-pet-default-restart-'));
    const root = join(temporaryDirectory, 'characters');
    const store = new CharacterStore(root);
    await ensureOfficialDefaultCharacter(store, resourceDirectory);
    const original = await store.getDraft('builtin-default');
    await store.saveDraft('builtin-default', { ...original, name: '重启前未发布草稿' });
    const backupId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const backup = join(root, '.official-default-backups', backupId);
    await cp(join(root, 'builtin-default'), join(backup, 'previous'), { recursive: true });
    const index = JSON.parse(await readFile(join(root, 'index.json'), 'utf8'));
    await writeFile(join(root, '.official-default-installation.json'), JSON.stringify({
      version: 1, backupId, hadPrevious: true, index
    }));
    await writeFile(join(root, 'builtin-default', 'draft', 'draft.json'), JSON.stringify({ ...original, name: '尚未完成的新草稿' }));
    const restarted = new CharacterStore(root);
    await expect(ensureOfficialDefaultCharacterInstalled(restarted, join(temporaryDirectory, 'missing-bundle'))).rejects.toThrow();
    expect((await restarted.getDraft('builtin-default')).name).toBe('重启前未发布草稿');
    expect((await restarted.getActive()).id).toBe('builtin-default');
    await expect(stat(join(root, '.official-default-installation.json'))).rejects.toThrow();
  }, 30_000);
  test('恢复索引失败时拒绝新增，重试先恢复再写入且不丢新角色', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'ai-pet-default-write-gate-'));
    const root = join(temporaryDirectory, 'characters');
    const store = new CharacterStore(root);
    await store.create({ id: 'builtin-default', name: '旧默认' });
    const index = JSON.parse(await readFile(join(root, 'index.json'), 'utf8'));
    const backupId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const backup = join(root, '.official-default-backups', backupId);
    await cp(join(root, 'builtin-default'), join(backup, 'previous'), { recursive: true });
    await writeFile(join(root, '.official-default-installation.json'), JSON.stringify({
      version: 1, backupId, hadPrevious: true, index
    }));
    let failIndex = true;
    const restarted = new CharacterStore(root, {
      writeText: async (file, content) => {
        if (failIndex && file === join(root, 'index.json')) throw new Error('模拟磁盘瞬时故障');
        await atomicWriteText(file, content);
      }
    });
    await expect(restarted.installOfficialDefaultCharacter()).rejects.toThrow('模拟磁盘瞬时故障');
    await expect(restarted.create({ id: 'blocked', name: '失败期间不能创建' })).rejects.toThrow();
    await expect(stat(join(root, 'blocked'))).rejects.toThrow();
    failIndex = false;
    await restarted.create({ id: 'created-after-recovery-failure', name: '恢复后新建角色' });
    await restarted.installOfficialDefaultCharacter();
    expect((await restarted.list()).map(entry => entry.id)).toContain('created-after-recovery-failure');
    await expect(stat(join(root, '.official-default-installation.json'))).rejects.toThrow();
  });
  test('随包源图缺失时拒绝安装且不生成默认索引项', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'ai-pet-default-missing-'));
    const brokenBundle = join(temporaryDirectory, 'bundle');
    await cp(resourceDirectory, brokenBundle, { recursive: true });
    const catalog = JSON.parse(await readFile(join(brokenBundle, 'source', 'catalog.json'), 'utf8'));
    await rm(join(brokenBundle, 'source', `${catalog.sources[0].assetId}.png`));
    const store = new CharacterStore(join(temporaryDirectory, 'characters'));
    await expect(ensureOfficialDefaultCharacterInstalled(store, brokenBundle)).rejects.toThrow();
    expect(await store.list()).toEqual([]);
  }, 30_000);
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
      new Uint8Array(await readFile(join(resourceDirectory, 'compiled', resource.fileName)))
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
      indexRecovered: true,
      packageRecoveryReport: { issues: [] }
    }, {
      validateActiveRuntime: async () => ({ kind: 'missing' }),
      ensureOfficialDefaultCharacter: async () => ({
        activeCharacterId: 'builtin-default'
      }),
      loadFinalIndex: () => restarted.list(),
      getTransactionRecoveryReport: () => restarted.getTransactionRecoveryReport()
    })).resolves.toMatchObject({
      activeCharacterId: 'builtin-default',
      recoverySnapshot: { fallbackErrorCode: 'CHARACTER_INDEX_UNAVAILABLE' }
    });
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
  }, 15_000);

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
