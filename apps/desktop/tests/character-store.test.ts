import { createHash } from 'node:crypto';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CharacterDraftV1,
  CharacterDraftV2,
  CharacterManifestV1,
  CharacterManifestV2
} from '@myself/character-runtime';
import {
  convertCharacterDraftV1ToV2,
  convertCharacterManifestV1ToV2,
  projectCharacterManifestV2ToLegacy
} from '@myself/character-runtime';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import electronViteConfig from '../electron.vite.config';
import desktopPackage from '../package.json';
import { CharacterStore } from '../src/main/characters/character-store';
import {
  migrateCharacterDocument,
  migrateCharacterManifest
} from '../src/main/characters/character-migrations';
import { atomicWriteText } from '../src/main/storage/atomic-file-coordinator';

const CORE_STATES = [
  'idle',
  'listening',
  'thinking',
  'moving',
  'acting',
  'carrying',
  'success',
  'error'
] as const;

const GROUND_ANCHOR = { ground: { x: 0.5, y: 1 } } as const;

function checksum(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function createDraftV1(id = 'demo', name = '演示角色'): CharacterDraftV1 {
  return {
    version: 1,
    id,
    name,
    thumbnailAssetId: 'thumb',
    states: CORE_STATES.map((stateId) => ({
      id: stateId,
      kind: 'core' as const,
      actions: stateId === 'idle'
        ? [{
            id: 'idle-main',
            name: '待机',
            fps: 8,
            loop: true,
            weight: 1,
            frames: [],
            anchors: GROUND_ANCHOR
          }]
        : []
    }))
  };
}

function createDraft(id = 'demo', name = '演示角色'): CharacterDraftV2 {
  return convertCharacterDraftV1ToV2(createDraftV1(id, name)).document;
}

function createDraftV2(id = 'demo', name = '演示角色'): CharacterDraftV2 {
  return {
    version: 2,
    id,
    name,
    thumbnailAssetId: 'thumb',
    identity: {
      description: name,
      background: '测试背景',
      traits: [],
      languageStyle: '简洁',
      formsOfAddress: [],
      likes: [],
      dislikes: [],
      behavioralTendencies: [],
      boundaries: [],
      exampleLines: []
    },
    defaultSkinId: 'default',
    defaultStateId: 'idle',
    skins: [{
      id: 'default',
      name: '默认皮肤',
      presentations: [],
      semanticFallbacks: []
    }],
    states: [{
      id: 'idle',
      name: '待机',
      kind: 'primary',
      semantic: 'idle',
      tags: [],
      intensity: 1,
      coexistWithStateIds: [],
      forbiddenStateIds: [],
      enterConditions: [],
      exitConditions: [],
      agentInferable: false,
      actionIds: []
    }],
    actions: []
  };
}

function createRuntimeV1(
  id = 'demo',
  name = '演示角色',
  atlasBytes = new Uint8Array([1, 2, 3]),
  thumbnailBytes = new Uint8Array([4, 5, 6])
): {
  manifest: CharacterManifestV1;
  assets: Readonly<Record<string, Uint8Array>>;
} {
  return {
    manifest: {
      version: 1,
      id,
      name,
      thumbnailAssetId: 'thumb',
      compilerVersion: '1.0.0',
      resources: [{
        assetId: 'atlas',
        fileName: 'atlas.png',
        sha256: checksum(atlasBytes),
        byteLength: atlasBytes.byteLength
      }, {
        assetId: 'thumb',
        fileName: 'thumbnail.webp',
        sha256: checksum(thumbnailBytes),
        byteLength: thumbnailBytes.byteLength
      }],
      states: CORE_STATES.map((stateId) => ({
        id: stateId,
        kind: 'core' as const,
        actions: stateId === 'idle'
          ? [{
              id: 'idle-main',
              name: '待机',
              fps: 8,
              loop: true,
              weight: 1,
              frames: [{
                assetId: 'atlas',
                x: 0,
                y: 0,
                width: 32,
                height: 32
              }],
              anchors: GROUND_ANCHOR
            }]
          : []
      }))
    },
    assets: {
      'atlas.png': atlasBytes,
      'thumbnail.webp': thumbnailBytes
    }
  };
}

function createRuntime(
  id = 'demo',
  name = '演示角色',
  atlasBytes = new Uint8Array([1, 2, 3]),
  thumbnailBytes = new Uint8Array([4, 5, 6])
): {
  manifest: CharacterManifestV2;
  assets: Readonly<Record<string, Uint8Array>>;
} {
  const runtime = createRuntimeV1(id, name, atlasBytes, thumbnailBytes);
  return {
    manifest: convertCharacterManifestV1ToV2(runtime.manifest).document,
    assets: runtime.assets
  };
}

function createCompleteRuntime(
  id = 'complete',
  name = '完整角色'
): ReturnType<typeof createRuntime> {
  const runtime = createRuntimeV1(id, name);
  const completeManifest: CharacterManifestV1 = {
    ...runtime.manifest,
    states: runtime.manifest.states.map(state => ({
      ...state,
      actions: state.actions.length > 0
        ? state.actions
        : [{
            id: `${state.id}-main`,
            name: `${state.id} 动作`,
            fps: 8,
            loop: true,
            weight: 1,
            frames: [{
              assetId: 'atlas',
              x: 0,
              y: 0,
              width: 32,
              height: 32
            }],
            anchors: GROUND_ANCHOR
          }]
    }))
  };
  return {
    manifest: convertCharacterManifestV1ToV2(completeManifest).document,
    assets: runtime.assets
  };
}

function runtimeView(manifest: CharacterManifestV2): CharacterManifestV1 {
  return projectCharacterManifestV2ToLegacy(manifest);
}

async function writeRuntimeDirectory(
  directory: string,
  runtime: {
    manifest: CharacterManifestV1 | CharacterManifestV2;
    assets: Readonly<Record<string, Uint8Array>>;
  }
): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'manifest.json'),
    `${JSON.stringify(runtime.manifest, null, 2)}\n`,
    'utf8'
  );
  await Promise.all(Object.entries(runtime.assets).map(([fileName, bytes]) => (
    writeFile(join(directory, fileName), bytes)
  )));
}

function failingIndexWriter(failures = 1): {
  writeText: typeof atomicWriteText;
  arm(): void;
} {
  let armed = false;
  let remaining = failures;
  return {
    arm() {
      armed = true;
    },
    async writeText(file, content) {
      if (armed && file.endsWith('index.json') && remaining > 0) {
        remaining -= 1;
        throw new Error('TEST_INDEX_WRITE_FAILED');
      }
      await atomicWriteText(file, content);
    }
  };
}

function failingDraftNextWriter(): {
  writeText: typeof atomicWriteText;
  arm(): void;
} {
  let armed = false;
  return {
    arm() {
      armed = true;
    },
    async writeText(file, content) {
      if (armed && file.endsWith('draft.next.json')) {
        armed = false;
        throw new Error('TEST_DRAFT_NEXT_WRITE_FAILED');
      }
      await atomicWriteText(file, content);
    }
  };
}

function failingDraftBackupInstaller(): {
  renamePath: typeof rename;
  arm(): void;
} {
  let armed = false;
  return {
    arm() {
      armed = true;
    },
    async renamePath(source, destination) {
      if (
        armed
        && source.toString().endsWith('draft.json')
        && destination.toString().endsWith('draft.backup.json')
      ) {
        armed = false;
        throw new Error('TEST_DRAFT_BACKUP_RENAME_FAILED');
      }
      await rename(source, destination);
    }
  };
}

function failingBackupRestoreRenamer(backupName: string, currentName: string): {
  renamePath: typeof rename;
  arm(): void;
} {
  let armed = false;
  return {
    arm() {
      armed = true;
    },
    async renamePath(source, destination) {
      const sourcePath = source.toString();
      const destinationPath = destination.toString();
      if (
        armed
        && sourcePath.endsWith(backupName)
        && destinationPath.endsWith(currentName)
      ) {
        armed = false;
        throw new Error('TEST_BACKUP_RENAME_FAILED');
      }
      await rename(source, destination);
    }
  };
}

function partiallyFailingTombstoneRemover(): {
  removePath: typeof rm;
  arm(): void;
} {
  let armed = false;
  return {
    arm() {
      armed = true;
    },
    async removePath(path, options) {
      const target = path.toString();
      if (armed && target.endsWith('.delete-tombstone')) {
        try {
          await lstat(target);
        } catch {
          await rm(path, options);
          return;
        }
        armed = false;
        await rm(join(target, 'draft'), { recursive: true, force: true });
        throw new Error('TEST_TOMBSTONE_PARTIAL_REMOVE_FAILED');
      }
      await rm(path, options);
    }
  };
}

function failingPersistentBackupRemover(backupName: string): {
  removePath: typeof rm;
  arm(): void;
} {
  let armed = false;
  return {
    arm() {
      armed = true;
    },
    async removePath(path, options) {
      if (armed && path.toString().endsWith(backupName)) {
        armed = false;
        throw new Error('TEST_PERSISTENT_BACKUP_REMOVE_FAILED');
      }
      await rm(path, options);
    }
  };
}

describe('CharacterStore', () => {
  let testDirectory: string;
  let charactersDirectory: string;

  beforeEach(async () => {
    testDirectory = await mkdtemp(join(tmpdir(), 'ai-pet-character-store-'));
    charactersDirectory = join(testDirectory, 'characters');
  });

  afterEach(async () => {
    await rm(testDirectory, { recursive: true, force: true });
  });

  test('创建角色时建立固定目录并保存不完整草稿', async () => {
    const store = new CharacterStore(charactersDirectory);

    await store.create({ id: 'demo', name: '演示角色' });

    await expect(store.getDraft('demo')).resolves.toMatchObject({
      version: 2,
      id: 'demo',
      name: '演示角色'
    });
    await expect(access(join(charactersDirectory, 'demo', 'source'))).resolves.toBeUndefined();
    await expect(access(join(charactersDirectory, 'demo', 'draft'))).resolves.toBeUndefined();
    await expect(access(join(charactersDirectory, 'demo', 'compiled'))).resolves.toBeUndefined();
  });

  test('角色包导入所有权令牌允许重启后只回滚本次创建的角色', async () => {
    const transactionId = '11111111-1111-4111-8111-111111111111';
    const store = new CharacterStore(charactersDirectory);
    await store.create(
      { id: 'demo', name: '导入中的角色' },
      { importTransactionId: transactionId }
    );

    await expect(new CharacterStore(charactersDirectory)
      .rollbackImportedCharacter('demo', '22222222-2222-4222-8222-222222222222'))
      .resolves.toBe(false);
    await expect(new CharacterStore(charactersDirectory)
      .rollbackImportedCharacter('demo', transactionId))
      .resolves.toBe(true);
    await expect(store.list()).resolves.toEqual([]);
    await expect(access(join(charactersDirectory, 'demo'))).rejects.toThrow();
  });

  test('角色包回滚读取令牌后同 ID 目录被替换时保留替代角色', async () => {
    const transactionId = '11111111-1111-4111-8111-111111111111';
    const replacementStore = new CharacterStore(charactersDirectory);
    const rollbackStore = new CharacterStore(charactersDirectory, {
      async onImportRollbackCheckpoint(checkpoint) {
        if (checkpoint !== 'before-rename') return;
        await replacementStore.delete('demo');
        await replacementStore.create({ id: 'demo', name: '替代角色' });
      }
    });
    await replacementStore.create(
      { id: 'demo', name: '导入中的角色' },
      { importTransactionId: transactionId }
    );

    await expect(rollbackStore.rollbackImportedCharacter('demo', transactionId))
      .resolves.toBe(false);
    await expect(replacementStore.getDraft('demo')).resolves.toMatchObject({
      id: 'demo',
      name: '替代角色'
    });
  });

  test('拒绝路径穿越标识和草稿角色不一致', async () => {
    const store = new CharacterStore(charactersDirectory);
    await expect(store.create({ id: '../escape', name: '越界角色' }))
      .rejects.toThrow('CHARACTER_INVALID_ID');

    await store.create({ id: 'demo', name: '演示角色' });
    await expect(store.saveDraft('demo', createDraft('other')))
      .rejects.toThrow('CHARACTER_ID_MISMATCH');
    await expect(access(join(testDirectory, 'escape'))).rejects.toThrow();
  });

  test('同一实例的并发保存按调用顺序完成且不留下半截文件', async () => {
    const store = new CharacterStore(charactersDirectory);
    await store.create({ id: 'demo', name: '演示角色' });
    const first = createDraft('demo', '第一版');
    const second = createDraft('demo', '第二版');

    await Promise.all([
      store.saveDraft('demo', first),
      store.saveDraft('demo', second)
    ]);

    await expect(store.getDraft('demo')).resolves.toEqual(second);
    const draftDirectory = join(charactersDirectory, 'demo', 'draft');
    expect(await readdir(draftDirectory)).toEqual(['draft.json']);
    expect(JSON.parse(await readFile(join(draftDirectory, 'draft.json'), 'utf8'))).toEqual(second);
  });

  test('并发保存中首次索引写失败会回滚且后续排队保存仍可提交', async () => {
    const writer = failingIndexWriter();
    const store = new CharacterStore(charactersDirectory, { writeText: writer.writeText });
    await store.create({ id: 'demo', name: '原始角色' });
    writer.arm();

    const results = await Promise.allSettled([
      store.saveDraft('demo', createDraft('demo', '失败版本')),
      store.saveDraft('demo', createDraft('demo', '成功版本'))
    ]);

    expect(results[0]).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: 'TEST_INDEX_WRITE_FAILED' })
    });
    expect(results[1]).toMatchObject({ status: 'fulfilled' });
    await expect(store.getDraft('demo')).resolves.toMatchObject({ name: '成功版本' });
    expect(JSON.parse(await readFile(
      join(charactersDirectory, 'index.json'),
      'utf8'
    )).characters[0].name).toBe('成功版本');
    expect(await readdir(join(charactersDirectory, 'demo', 'draft')))
      .toEqual(['draft.json']);
  });

  test('保存草稿的索引写失败会用固定备份回滚草稿和索引元数据', async () => {
    const writer = failingIndexWriter();
    const store = new CharacterStore(charactersDirectory, { writeText: writer.writeText });
    await store.create({ id: 'demo', name: '原始角色' });
    writer.arm();

    await expect(store.saveDraft('demo', createDraft('demo', '失败版本')))
      .rejects.toThrow('TEST_INDEX_WRITE_FAILED');

    await expect(store.getDraft('demo')).resolves.toMatchObject({ name: '原始角色' });
    expect(JSON.parse(await readFile(
      join(charactersDirectory, 'index.json'),
      'utf8'
    )).characters[0].name).toBe('原始角色');
    expect(await readdir(join(charactersDirectory, 'demo', 'draft')))
      .toEqual(['draft.json']);
  });

  test('草稿提交与回滚索引连续失败时重启仍恢复旧草稿和元数据', async () => {
    const writer = failingIndexWriter(2);
    const store = new CharacterStore(charactersDirectory, { writeText: writer.writeText });
    await store.create({ id: 'demo', name: '原始角色' });
    writer.arm();

    await expect(store.saveDraft('demo', createDraft('demo', '失败版本')))
      .rejects.toThrow('TEST_INDEX_WRITE_FAILED');

    const restartedStore = new CharacterStore(charactersDirectory);
    await expect(restartedStore.getDraft('demo')).resolves.toMatchObject({ name: '原始角色' });
    expect(JSON.parse(await readFile(
      join(charactersDirectory, 'index.json'),
      'utf8'
    )).characters[0].name).toBe('原始角色');
    expect(await readdir(join(charactersDirectory, 'demo', 'draft')))
      .toEqual(['draft.json']);
  });

  test('草稿回滚删除 current 后重命名 backup 失败时重启继续恢复', async () => {
    const writer = failingIndexWriter();
    const renamer = failingBackupRestoreRenamer('draft.backup.json', 'draft.json');
    const store = new CharacterStore(charactersDirectory, {
      writeText: writer.writeText,
      renamePath: renamer.renamePath
    });
    await store.create({ id: 'demo', name: '原始角色' });
    writer.arm();
    renamer.arm();

    await expect(store.saveDraft('demo', createDraft('demo', '失败版本')))
      .rejects.toThrow('TEST_INDEX_WRITE_FAILED');

    const draftDirectory = join(charactersDirectory, 'demo', 'draft');
    await expect(access(join(draftDirectory, 'draft.json'))).rejects.toThrow();
    await expect(access(join(draftDirectory, 'draft.backup.json'))).resolves.toBeUndefined();
    expect(JSON.parse(await readFile(
      join(draftDirectory, 'draft-transaction.json'),
      'utf8'
    )).phase).toBe('rolling-back');

    const restartedStore = new CharacterStore(charactersDirectory);
    await expect(restartedStore.getDraft('demo')).resolves.toMatchObject({ name: '原始角色' });
    expect(await readdir(draftDirectory)).toEqual(['draft.json']);
  });

  test('草稿事务为 installed 但 current 缺失时从有效 backup 恢复', async () => {
    const store = new CharacterStore(charactersDirectory);
    await store.create({ id: 'demo', name: '原始角色' });
    const draftDirectory = join(charactersDirectory, 'demo', 'draft');
    await rename(
      join(draftDirectory, 'draft.json'),
      join(draftDirectory, 'draft.backup.json')
    );
    await writeFile(
      join(draftDirectory, 'draft-transaction.json'),
      JSON.stringify({
        version: 1,
        phase: 'installed',
        previousEntry: { id: 'demo', name: '原始角色', thumbnailAssetId: null },
        nextEntry: { id: 'demo', name: '未完成版本', thumbnailAssetId: 'thumb' }
      }),
      'utf8'
    );

    const restartedStore = new CharacterStore(charactersDirectory);

    await expect(restartedStore.getDraft('demo')).resolves.toMatchObject({ name: '原始角色' });
    expect(JSON.parse(await readFile(
      join(charactersDirectory, 'index.json'),
      'utf8'
    )).characters[0].name).toBe('原始角色');
    expect(await readdir(draftDirectory)).toEqual(['draft.json']);
  });

  test('保存草稿不会修改既有运行版本', async () => {
    const store = new CharacterStore(charactersDirectory);
    const runtime = createRuntime();
    await store.create({ id: 'demo', name: '演示角色' });
    await store.publishCompiled('demo', runtime.manifest, runtime.assets);

    const changedDraft = createDraft('demo', '草稿新名称');
    await store.saveDraft('demo', changedDraft);

    await expect(store.getRuntimeManifest('demo')).resolves.toEqual(runtimeView(runtime.manifest));
    await expect(store.getDraft('demo')).resolves.toEqual(changedDraft);
  });

  test('资源哈希或长度不匹配时回滚发布并保留旧运行版本', async () => {
    const store = new CharacterStore(charactersDirectory);
    const original = createRuntime();
    const changed = createRuntime(
      'demo',
      '新运行版本',
      new Uint8Array([7, 8, 9]),
      new Uint8Array([10, 11, 12])
    );
    await store.create({ id: 'demo', name: '演示角色' });
    await store.publishCompiled('demo', original.manifest, original.assets);

    await expect(store.publishCompiled('demo', changed.manifest, {
      ...changed.assets,
      'atlas.png': new Uint8Array([99])
    })).rejects.toThrow('CHARACTER_RESOURCE_INTEGRITY_FAILED');

    await expect(store.getRuntimeManifest('demo')).resolves.toEqual(runtimeView(original.manifest));
    expect([...new Uint8Array(
      await readFile(join(charactersDirectory, 'demo', 'compiled', 'atlas.png'))
    )]).toEqual([1, 2, 3]);
    expect((await readdir(join(charactersDirectory, 'demo')))
      .some((name) => name.includes('publish') || name.includes('backup'))).toBe(false);
  });

  test('拒绝缺失、多余或带路径的发布资源', async () => {
    const store = new CharacterStore(charactersDirectory);
    const runtime = createRuntime();
    await store.create({ id: 'demo', name: '演示角色' });

    await expect(store.publishCompiled('demo', runtime.manifest, {
      'atlas.png': runtime.assets['atlas.png']!
    })).rejects.toThrow('CHARACTER_RESOURCE_INTEGRITY_FAILED');
    await expect(store.publishCompiled('demo', runtime.manifest, {
      ...runtime.assets,
      'extra.png': new Uint8Array([1])
    })).rejects.toThrow('CHARACTER_RESOURCE_INTEGRITY_FAILED');

    const unsafeManifest = structuredClone(runtime.manifest);
    unsafeManifest.resources[0]!.fileName = '../atlas.png';
    await expect(store.publishCompiled('demo', unsafeManifest, runtime.assets))
      .rejects.toThrow('CHARACTER_MANIFEST_INVALID');
  });

  test('发布后从磁盘重新解析清单并在重启后恢复', async () => {
    const firstStore = new CharacterStore(charactersDirectory);
    const runtime = createRuntime();
    await firstStore.create({ id: 'demo', name: '演示角色' });
    await firstStore.saveDraft('demo', createDraft());
    await firstStore.publishCompiled('demo', runtime.manifest, runtime.assets);
    await firstStore.setActive('demo', true);

    const restartedStore = new CharacterStore(charactersDirectory);

    await expect(restartedStore.getDraft('demo')).resolves.toEqual(createDraft());
    await expect(restartedStore.getRuntimeManifest('demo'))
      .resolves.toEqual(runtimeView(runtime.manifest));
    await expect(restartedStore.getActive()).resolves.toEqual(runtimeView(runtime.manifest));
  });

  test('运行时资源只按当前活动角色 manifest 的资源标识读取', async () => {
    const store = new CharacterStore(charactersDirectory);
    const first = createRuntime(
      'first',
      '第一个角色',
      new Uint8Array([1, 1, 1])
    );
    const second = createRuntime(
      'second',
      '第二个角色',
      new Uint8Array([2, 2, 2])
    );
    await store.create({ id: 'first', name: '第一个角色' });
    await store.create({ id: 'second', name: '第二个角色' });
    await store.publishCompiled('first', first.manifest, first.assets);
    await store.publishCompiled('second', second.manifest, second.assets);

    await store.setActive('first', true);
    await expect(store.readActiveRuntimeAsset('atlas'))
      .resolves.toEqual(new Uint8Array([1, 1, 1]));
    await store.setActive('second', true);
    await expect(store.readActiveRuntimeAsset('atlas'))
      .resolves.toEqual(new Uint8Array([2, 2, 2]));

    await expect(store.readActiveRuntimeAsset('atlas.png'))
      .rejects.toThrow('CHARACTER_INVALID_ID');
    await expect(store.readActiveRuntimeAsset('not-declared'))
      .rejects.toThrow('CHARACTER_RESOURCE_NOT_FOUND');
  });

  test('运行时 manifest 路径在句柄打开后被替换时拒绝继续读取', async () => {
    let armed = false;
    const store = new CharacterStore(charactersDirectory, {
      onRuntimeReadCheckpoint: async (
        checkpoint: string,
        targetPath: string
      ): Promise<void> => {
        if (!armed || checkpoint !== 'runtime:manifest-after-open') {
          return;
        }

        armed = false;
        const original = await readFile(targetPath);
        await rename(targetPath, `${targetPath}.replaced`);
        await writeFile(targetPath, original);
      }
    });
    const runtime = createRuntime();
    await store.create({ id: 'demo', name: '演示角色' });
    await store.publishCompiled('demo', runtime.manifest, runtime.assets);
    await store.setActive('demo', true);
    armed = true;

    const error = await store.readActiveRuntimeAsset('atlas').catch((caught) => caught);

    expect(error).toMatchObject({ message: 'CHARACTER_RUNTIME_UNAVAILABLE' });
    expect(String(error)).not.toContain(charactersDirectory);
  });

  test('运行时资源路径在句柄打开后被替换时拒绝提交读取结果', async () => {
    let armed = false;
    const store = new CharacterStore(charactersDirectory, {
      onRuntimeReadCheckpoint: async (
        checkpoint: string,
        targetPath: string
      ): Promise<void> => {
        if (!armed || checkpoint !== 'runtime:resource-after-open') {
          return;
        }

        armed = false;
        const original = await readFile(targetPath);
        await rename(targetPath, `${targetPath}.replaced`);
        await writeFile(targetPath, original);
      }
    });
    const runtime = createRuntime();
    await store.create({ id: 'demo', name: '演示角色' });
    await store.publishCompiled('demo', runtime.manifest, runtime.assets);
    await store.setActive('demo', true);
    armed = true;

    const error = await store.readActiveRuntimeAsset('atlas').catch((caught) => caught);

    expect(error).toMatchObject({ message: 'CHARACTER_RUNTIME_UNAVAILABLE' });
    expect(String(error)).not.toContain(charactersDirectory);
  });

  test('启动时恢复 compiled 重命名中断并清理固定事务文件', async () => {
    const store = new CharacterStore(charactersDirectory);
    const oldRuntime = createRuntime('demo', '旧版本');
    const newRuntime = createRuntime(
      'demo',
      '新版本',
      new Uint8Array([7, 8, 9]),
      new Uint8Array([10, 11, 12])
    );
    await store.create({ id: 'demo', name: '旧版本' });
    await store.publishCompiled('demo', oldRuntime.manifest, oldRuntime.assets);

    const characterDirectory = join(charactersDirectory, 'demo');
    await writeRuntimeDirectory(join(characterDirectory, 'compiled.next'), newRuntime);
    await writeFile(
      join(characterDirectory, 'publish-transaction.json'),
      JSON.stringify({
        version: 1,
        phase: 'prepared',
        previousEntry: { id: 'demo', name: '旧版本', thumbnailAssetId: 'thumb' },
        nextEntry: { id: 'demo', name: '新版本', thumbnailAssetId: 'thumb' }
      }),
      'utf8'
    );
    await rename(
      join(characterDirectory, 'compiled'),
      join(characterDirectory, 'compiled.backup')
    );

    const restartedStore = new CharacterStore(charactersDirectory);
    await expect(restartedStore.getRuntimeManifest('demo'))
      .resolves.toEqual(runtimeView(oldRuntime.manifest));
    expect(JSON.parse(await readFile(
      join(charactersDirectory, 'index.json'),
      'utf8'
    )).characters[0].name).toBe('旧版本');
    await expect(access(join(characterDirectory, 'compiled.next'))).rejects.toThrow();
    await expect(access(join(characterDirectory, 'compiled.backup'))).rejects.toThrow();
    await expect(access(join(characterDirectory, 'publish-transaction.json'))).rejects.toThrow();
  });

  test('首次发布移动空 compiled 后中断时回滚为空运行目录且保留草稿可用', async () => {
    const store = new CharacterStore(charactersDirectory);
    const runtime = createRuntime('demo', '首次发布');
    await store.create({ id: 'demo', name: '首次发布' });

    const characterDirectory = join(charactersDirectory, 'demo');
    await writeRuntimeDirectory(join(characterDirectory, 'compiled.next'), runtime);
    await writeFile(
      join(characterDirectory, 'publish-transaction.json'),
      JSON.stringify({
        version: 2,
        phase: 'prepared',
        hadPreviousRuntime: false,
        previousEntry: { id: 'demo', name: '首次发布', thumbnailAssetId: null },
        nextEntry: { id: 'demo', name: '首次发布', thumbnailAssetId: 'thumb' }
      }),
      'utf8'
    );
    await rename(
      join(characterDirectory, 'compiled'),
      join(characterDirectory, 'compiled.backup')
    );

    const restartedStore = new CharacterStore(charactersDirectory);
    await expect(restartedStore.list()).resolves.toMatchObject([{
      id: 'demo',
      name: '首次发布',
      completeness: 'incomplete'
    }]);
    await expect(restartedStore.getDraft('demo')).resolves.toMatchObject({
      id: 'demo',
      name: '首次发布'
    });
    await expect(restartedStore.getRuntimeManifest('demo'))
      .rejects.toThrow('CHARACTER_RUNTIME_UNAVAILABLE');
    await expect(access(join(characterDirectory, 'compiled'))).resolves.toBeUndefined();
    await expect(access(join(characterDirectory, 'compiled.next'))).rejects.toThrow();
    await expect(access(join(characterDirectory, 'compiled.backup'))).rejects.toThrow();
    await expect(access(join(characterDirectory, 'publish-transaction.json'))).rejects.toThrow();
  });

  test('启动时完成已安装发布并同步索引元数据后清理备份', async () => {
    const store = new CharacterStore(charactersDirectory);
    const oldRuntime = createRuntime('demo', '旧版本');
    const newRuntime = createRuntime(
      'demo',
      '新版本',
      new Uint8Array([7, 8, 9]),
      new Uint8Array([10, 11, 12])
    );
    await store.create({ id: 'demo', name: '旧版本' });
    await store.publishCompiled('demo', oldRuntime.manifest, oldRuntime.assets);

    const characterDirectory = join(charactersDirectory, 'demo');
    await rename(
      join(characterDirectory, 'compiled'),
      join(characterDirectory, 'compiled.backup')
    );
    await writeRuntimeDirectory(join(characterDirectory, 'compiled'), newRuntime);
    await writeFile(
      join(characterDirectory, 'publish-transaction.json'),
      JSON.stringify({
        version: 1,
        phase: 'installed',
        previousEntry: { id: 'demo', name: '旧版本', thumbnailAssetId: 'thumb' },
        nextEntry: { id: 'demo', name: '新版本', thumbnailAssetId: 'thumb' }
      }),
      'utf8'
    );

    const restartedStore = new CharacterStore(charactersDirectory);
    await expect(restartedStore.getRuntimeManifest('demo'))
      .resolves.toEqual(runtimeView(newRuntime.manifest));
    expect(JSON.parse(await readFile(
      join(charactersDirectory, 'index.json'),
      'utf8'
    )).characters[0].name).toBe('新版本');
    await expect(access(join(characterDirectory, 'compiled.backup'))).rejects.toThrow();
    await expect(access(join(characterDirectory, 'publish-transaction.json'))).rejects.toThrow();
  });

  test('发布提交与回滚索引连续失败时重启仍恢复旧运行版本', async () => {
    const writer = failingIndexWriter(2);
    const store = new CharacterStore(charactersDirectory, { writeText: writer.writeText });
    const oldRuntime = createRuntime('demo', '旧版本');
    const newRuntime = createRuntime(
      'demo',
      '失败版本',
      new Uint8Array([7, 8, 9]),
      new Uint8Array([10, 11, 12])
    );
    await store.create({ id: 'demo', name: '旧版本' });
    await store.publishCompiled('demo', oldRuntime.manifest, oldRuntime.assets);
    writer.arm();

    await expect(store.publishCompiled('demo', newRuntime.manifest, newRuntime.assets))
      .rejects.toThrow('TEST_INDEX_WRITE_FAILED');

    const restartedStore = new CharacterStore(charactersDirectory);
    await expect(restartedStore.getRuntimeManifest('demo'))
      .resolves.toEqual(runtimeView(oldRuntime.manifest));
    expect(JSON.parse(await readFile(
      join(charactersDirectory, 'index.json'),
      'utf8'
    )).characters[0].name).toBe('旧版本');
    expect((await readdir(join(charactersDirectory, 'demo')))
      .some(name => name.includes('backup') || name.includes('next') || name.includes('transaction')))
      .toBe(false);
  });

  test('发布回滚删除 current 后重命名 backup 失败时重启继续恢复', async () => {
    const writer = failingIndexWriter();
    const renamer = failingBackupRestoreRenamer('compiled.backup', 'compiled');
    const store = new CharacterStore(charactersDirectory, {
      writeText: writer.writeText,
      renamePath: renamer.renamePath
    });
    const oldRuntime = createRuntime('demo', '旧版本');
    const newRuntime = createRuntime(
      'demo',
      '失败版本',
      new Uint8Array([7, 8, 9]),
      new Uint8Array([10, 11, 12])
    );
    await store.create({ id: 'demo', name: '旧版本' });
    await store.publishCompiled('demo', oldRuntime.manifest, oldRuntime.assets);
    writer.arm();
    renamer.arm();

    await expect(store.publishCompiled('demo', newRuntime.manifest, newRuntime.assets))
      .rejects.toThrow('TEST_INDEX_WRITE_FAILED');

    const characterDirectory = join(charactersDirectory, 'demo');
    await expect(access(join(characterDirectory, 'compiled'))).rejects.toThrow();
    await expect(access(join(characterDirectory, 'compiled.backup'))).resolves.toBeUndefined();
    expect(JSON.parse(await readFile(
      join(characterDirectory, 'publish-transaction.json'),
      'utf8'
    )).phase).toBe('rolling-back');

    const restartedStore = new CharacterStore(charactersDirectory);
    await expect(restartedStore.getRuntimeManifest('demo'))
      .resolves.toEqual(runtimeView(oldRuntime.manifest));
    expect((await readdir(characterDirectory))
      .some(name => name.includes('backup') || name.includes('next') || name.includes('transaction')))
      .toBe(false);
  });

  test('发布事务为 installed 但 current 缺失时从有效 backup 恢复', async () => {
    const store = new CharacterStore(charactersDirectory);
    const oldRuntime = createRuntime('demo', '旧版本');
    await store.create({ id: 'demo', name: '旧版本' });
    await store.publishCompiled('demo', oldRuntime.manifest, oldRuntime.assets);
    const characterDirectory = join(charactersDirectory, 'demo');
    await rename(
      join(characterDirectory, 'compiled'),
      join(characterDirectory, 'compiled.backup')
    );
    await writeFile(
      join(characterDirectory, 'publish-transaction.json'),
      JSON.stringify({
        version: 1,
        phase: 'installed',
        previousEntry: { id: 'demo', name: '旧版本', thumbnailAssetId: 'thumb' },
        nextEntry: { id: 'demo', name: '未完成版本', thumbnailAssetId: 'thumb' }
      }),
      'utf8'
    );

    const restartedStore = new CharacterStore(charactersDirectory);

    await expect(restartedStore.getRuntimeManifest('demo'))
      .resolves.toEqual(runtimeView(oldRuntime.manifest));
    expect(JSON.parse(await readFile(
      join(charactersDirectory, 'index.json'),
      'utf8'
    )).characters[0].name).toBe('旧版本');
    await expect(access(join(characterDirectory, 'compiled.backup'))).rejects.toThrow();
    await expect(access(join(characterDirectory, 'publish-transaction.json'))).rejects.toThrow();
  });

  test('活动角色资源损坏时返回稳定错误且不删除数据', async () => {
    const store = new CharacterStore(charactersDirectory);
    const runtime = createRuntime();
    await store.create({ id: 'demo', name: '演示角色' });
    await store.publishCompiled('demo', runtime.manifest, runtime.assets);
    await store.setActive('demo', true);
    await unlink(join(charactersDirectory, 'demo', 'compiled', 'atlas.png'));

    await expect(store.getActive()).rejects.toThrow('CHARACTER_RUNTIME_UNAVAILABLE');
    await expect(access(join(charactersDirectory, 'demo', 'draft', 'draft.json')))
      .resolves.toBeUndefined();
  });

  test('运行清单角色标识与目录不一致时视为不可用', async () => {
    const store = new CharacterStore(charactersDirectory);
    const runtime = createRuntime();
    await store.create({ id: 'demo', name: '演示角色' });
    await store.publishCompiled('demo', runtime.manifest, runtime.assets);
    await writeFile(
      join(charactersDirectory, 'demo', 'compiled', 'manifest.json'),
      JSON.stringify({ ...runtime.manifest, id: 'other' }),
      'utf8'
    );

    await expect(store.getRuntimeManifest('demo'))
      .rejects.toThrow('CHARACTER_RUNTIME_UNAVAILABLE');
  });

  test('未发布或损坏的角色不能设为活动角色', async () => {
    const store = new CharacterStore(charactersDirectory);
    await store.create({ id: 'demo', name: '演示角色' });

    await expect(store.setActive('demo')).rejects.toThrow('CHARACTER_RUNTIME_UNAVAILABLE');
  });

  test('V2 完整性不再要求八个旧核心状态且可直接启用', async () => {
    const store = new CharacterStore(charactersDirectory);
    const runtime = createRuntime();
    const incompleteManifest = {
      ...runtime.manifest,
      states: runtime.manifest.states.filter(state => state.id === 'idle')
    };
    await store.create({ id: 'demo', name: '演示角色' });
    await store.publishCompiled('demo', incompleteManifest, runtime.assets);

    await expect(store.setActive('demo')).resolves.toBeUndefined();
    await expect(store.list()).resolves.toEqual([
      expect.objectContaining({
        id: 'demo',
        activationConfirmationRequired: false
      })
    ]);

    const restartedStore = new CharacterStore(charactersDirectory);
    await expect(restartedStore.setActive('demo')).resolves.toBeUndefined();
  });

  test('完整角色保持旧单参数启用调用兼容且不创建确认要求', async () => {
    const store = new CharacterStore(charactersDirectory);
    const runtime = createCompleteRuntime('complete', '完整角色');
    await store.create({ id: 'complete', name: '完整角色' });
    await store.publishCompiled('complete', runtime.manifest, runtime.assets);

    await expect(store.setActive('complete')).resolves.toBeUndefined();
    await expect(store.list()).resolves.toEqual([
      expect.objectContaining({
        id: 'complete',
        active: true,
        completeness: 'complete',
        activationConfirmationRequired: false
      })
    ]);
  });

  test('重复发布满足 V2 完整性的清单后仍可直接启用', async () => {
    const store = new CharacterStore(charactersDirectory);
    const incomplete = createRuntime();
    const complete = createCompleteRuntime('demo', '演示角色');
    await store.create({ id: 'demo', name: '演示角色' });
    await store.publishCompiled('demo', incomplete.manifest, incomplete.assets);
    await store.setActive('demo', true);

    await store.publishCompiled('demo', complete.manifest, complete.assets);
    await store.publishCompiled('demo', incomplete.manifest, incomplete.assets);

    await expect(store.setActive('demo')).resolves.toBeUndefined();
  });

  test('发布回滚会保留原 V2 运行版本和活动状态', async () => {
    const writer = failingIndexWriter();
    const store = new CharacterStore(charactersDirectory, {
      writeText: writer.writeText
    });
    const incomplete = createRuntime();
    const complete = createCompleteRuntime('demo', '演示角色');
    await store.create({ id: 'demo', name: '演示角色' });
    await store.publishCompiled('demo', incomplete.manifest, incomplete.assets);
    await store.setActive('demo', true);
    writer.arm();

    await expect(store.publishCompiled('demo', complete.manifest, complete.assets))
      .rejects.toThrow('TEST_INDEX_WRITE_FAILED');

    const restartedStore = new CharacterStore(charactersDirectory);
    await expect(restartedStore.setActive('demo')).resolves.toBeUndefined();
    await expect(restartedStore.getRuntimeManifest('demo'))
      .resolves.toEqual(runtimeView(incomplete.manifest));
  });

  test('官方默认角色始终不可删除', async () => {
    const store = new CharacterStore(charactersDirectory);

    await expect(store.delete('builtin-default'))
      .rejects.toThrow('CHARACTER_DEFAULT_DELETE_REJECTED');
  });

  test('活动角色不可删除且普通角色删除后从索引移除', async () => {
    const store = new CharacterStore(charactersDirectory);
    const activeRuntime = createRuntime('active', '活动角色');
    await store.create({ id: 'active', name: '活动角色' });
    await store.publishCompiled('active', activeRuntime.manifest, activeRuntime.assets);
    await store.setActive('active', true);
    await store.create({ id: 'removable', name: '可删除角色' });

    await expect(store.delete('active')).rejects.toThrow('CHARACTER_ACTIVE_DELETE_REJECTED');
    await store.delete('removable');

    await expect(store.list()).resolves.toEqual([
      expect.objectContaining({ id: 'active', active: true })
    ]);
    await expect(access(join(charactersDirectory, 'removable'))).rejects.toThrow();
  });

  test('删除时索引写失败会用固定墓碑恢复角色目录', async () => {
    const writer = failingIndexWriter();
    const store = new CharacterStore(charactersDirectory, { writeText: writer.writeText });
    await store.create({ id: 'demo', name: '可恢复角色' });
    writer.arm();

    await expect(store.delete('demo')).rejects.toThrow('TEST_INDEX_WRITE_FAILED');

    await expect(store.getDraft('demo')).resolves.toMatchObject({ name: '可恢复角色' });
    await expect(lstat(join(charactersDirectory, 'demo'))).resolves.toBeDefined();
    await expect(access(join(charactersDirectory, 'demo.delete-tombstone'))).rejects.toThrow();
  });

  test('索引提交后墓碑部分清理失败仍逻辑成功并由重启清理', async () => {
    const remover = partiallyFailingTombstoneRemover();
    const store = new CharacterStore(charactersDirectory, {
      removePath: remover.removePath
    });
    await store.create({ id: 'demo', name: '待删除角色' });
    remover.arm();

    await expect(store.delete('demo')).resolves.toBeUndefined();

    await expect(access(join(charactersDirectory, 'demo'))).rejects.toThrow();
    await expect(access(join(charactersDirectory, 'demo.delete-tombstone')))
      .resolves.toBeUndefined();
    expect(JSON.parse(await readFile(
      join(charactersDirectory, 'index.json'),
      'utf8'
    )).characters).toEqual([]);

    const restartedStore = new CharacterStore(charactersDirectory);
    await expect(restartedStore.list()).resolves.toEqual([]);
    await expect(access(join(charactersDirectory, 'demo.delete-tombstone')))
      .rejects.toThrow();
  });

  test('摘要按 V2 默认回退链区分完整、不完整和损坏', async () => {
    const store = new CharacterStore(charactersDirectory);
    const completeRuntime = createCompleteRuntime('complete', '完整角色');
    const publishedIncomplete = createRuntime('published-incomplete', '已发布但不完整');
    const brokenRuntime = createRuntime('broken', '损坏角色');
    await store.create({ id: 'complete', name: '完整角色' });
    await store.publishCompiled('complete', completeRuntime.manifest, completeRuntime.assets);
    await store.create({ id: 'published-incomplete', name: '已发布但不完整' });
    await store.publishCompiled(
      'published-incomplete',
      publishedIncomplete.manifest,
      publishedIncomplete.assets
    );
    await store.create({ id: 'incomplete', name: '未完成角色' });
    await store.saveDraft('incomplete', createDraft('incomplete', '未完成角色'));
    await store.create({ id: 'broken', name: '损坏角色' });
    await store.publishCompiled('broken', brokenRuntime.manifest, brokenRuntime.assets);
    await writeFile(
      join(charactersDirectory, 'broken', 'compiled', 'manifest.json'),
      '{损坏',
      'utf8'
    );

    await expect(store.list()).resolves.toEqual([
      expect.objectContaining({
        id: 'broken',
        completeness: 'broken',
        missingRequirements: []
      }),
      expect.objectContaining({
        id: 'complete',
        completeness: 'complete',
        missingRequirements: []
      }),
      expect.objectContaining({
        id: 'incomplete',
        completeness: 'incomplete',
        missingRequirements: ['default-presentation-unplayable']
      }),
      expect.objectContaining({
        id: 'published-incomplete',
        completeness: 'complete',
        missingRequirements: []
      })
    ]);
  });

  test('清单迁移失败时摘要保留目录并提供稳定错误码和重试入口', async () => {
    const store = new CharacterStore(charactersDirectory);
    const runtime = createRuntime();
    await store.create({ id: 'demo', name: '演示角色' });
    await store.publishCompiled('demo', runtime.manifest, runtime.assets);
    const manifestFile = join(charactersDirectory, 'demo', 'compiled', 'manifest.json');
    const validManifestText = await readFile(manifestFile, 'utf8');
    await writeFile(manifestFile, '{损坏清单', 'utf8');

    await expect(store.list()).resolves.toEqual([
      expect.objectContaining({
        id: 'demo',
        completeness: 'broken',
        migrationErrorCode: 'CHARACTER_MIGRATION_FAILED',
        migrationRecoveryAvailable: true
      })
    ]);
    await expect(access(join(charactersDirectory, 'demo'))).resolves.toBeUndefined();

    await writeFile(manifestFile, validManifestText, 'utf8');
    await expect(store.getPublishedManifest('demo')).resolves.toMatchObject({ version: 2 });
  });

  test('损坏索引保留原内容并创建隔离副本且只返回内存空视图', async () => {
    await mkdir(charactersDirectory, { recursive: true });
    const legacyBytes = '{"version":0,"characters":[{"id":"legacy"}]}';
    await writeFile(join(charactersDirectory, 'index.json'), legacyBytes, 'utf8');
    const store = new CharacterStore(charactersDirectory);

    await expect(store.list()).resolves.toEqual([]);

    const files = await readdir(charactersDirectory);
    const corruptName = files.find((name) => /^index\.json\.corrupt-/u.test(name));
    expect(corruptName).toBeDefined();
    expect(await readFile(join(charactersDirectory, corruptName!), 'utf8')).toBe(legacyBytes);
    expect(await readFile(join(charactersDirectory, 'index.json'), 'utf8')).toBe(legacyBytes);
    await expect(store.list()).resolves.toEqual([]);
    expect((await readdir(charactersDirectory))
      .filter(name => /^index\.json\.corrupt-/u.test(name))).toHaveLength(1);
  });

  test.each([
    {
      name: '重复角色标识',
      index: {
        version: 1,
        activeCharacterId: null,
        characters: [
          { id: 'demo', name: '甲', thumbnailAssetId: null },
          { id: 'demo', name: '乙', thumbnailAssetId: null }
        ]
      }
    },
    {
      name: '活动角色引用不存在',
      index: {
        version: 1,
        activeCharacterId: 'missing',
        characters: [
          { id: 'demo', name: '甲', thumbnailAssetId: null }
        ]
      }
    }
  ])('索引包含$name时隔离并返回空视图', async ({ index }) => {
    await mkdir(charactersDirectory, { recursive: true });
    const source = JSON.stringify(index);
    await writeFile(join(charactersDirectory, 'index.json'), source, 'utf8');

    const store = new CharacterStore(charactersDirectory);

    await expect(store.list()).resolves.toEqual([]);
    expect(await readFile(join(charactersDirectory, 'index.json'), 'utf8')).toBe(source);
    expect((await readdir(charactersDirectory))
      .some(name => /^index\.json\.corrupt-/u.test(name))).toBe(true);
  });

  test('迁移器把版本一草稿转换为版本二并原样接受版本二', () => {
    expect(migrateCharacterDocument(createDraftV1())).toMatchObject({
      sourceVersion: 1,
      document: { version: 2, defaultSkinId: 'default' }
    });
    expect(migrateCharacterDocument(createDraftV2())).toEqual({
      sourceVersion: 2,
      document: createDraftV2()
    });
    expect(() => migrateCharacterDocument({ version: 3 }))
      .toThrow('CHARACTER_VERSION_UNSUPPORTED');
    expect(() => migrateCharacterDocument({ ...createDraftV1(), script: 'run.exe' }))
      .toThrow('CHARACTER_MIGRATION_FAILED');
  });

  test('迁移器把版本一发布清单转换为版本二并拒绝未知版本', () => {
    expect(migrateCharacterManifest(createRuntimeV1().manifest)).toMatchObject({
      sourceVersion: 1,
      document: { version: 2, defaultSkinId: 'default' }
    });
    expect(() => migrateCharacterManifest({ version: 3 }))
      .toThrow('CHARACTER_VERSION_UNSUPPORTED');
  });

  test('首次读取版本一草稿原子安装版本二并保留一次恢复备份', async () => {
    const store = new CharacterStore(charactersDirectory);
    await store.create({ id: 'demo', name: '演示角色' });
    const draftDirectory = join(charactersDirectory, 'demo', 'draft');
    const legacyDraft = { ...createDraftV1(), thumbnailAssetId: undefined };
    await writeFile(
      join(draftDirectory, 'draft.json'),
      `${JSON.stringify(legacyDraft, null, 2)}\n`,
      'utf8'
    );

    await expect(store.getDraft('demo')).resolves.toMatchObject({ version: 2, id: 'demo' });
    expect(JSON.parse(await readFile(join(draftDirectory, 'draft.json'), 'utf8')))
      .toMatchObject({ version: 2 });
    expect(JSON.parse(await readFile(join(draftDirectory, 'draft.backup.json'), 'utf8')))
      .toMatchObject({ version: 1 });
    expect(JSON.parse(await readFile(join(charactersDirectory, 'index.json'), 'utf8')))
      .toMatchObject({ characters: [{ id: 'demo', draftVersion: 2 }] });
  });

  test('首次读取版本一清单原子安装版本二且运行接口仍返回版本一投影', async () => {
    const store = new CharacterStore(charactersDirectory);
    const legacyRuntime = createRuntimeV1();
    await store.create({ id: 'demo', name: '演示角色' });
    await writeRuntimeDirectory(
      join(charactersDirectory, 'demo', 'compiled'),
      legacyRuntime
    );

    await expect(store.getRuntimeManifest('demo')).resolves.toMatchObject({ version: 1 });
    await expect(store.getPublishedManifest('demo')).resolves.toMatchObject({ version: 2 });
    expect(JSON.parse(await readFile(
      join(charactersDirectory, 'demo', 'compiled', 'manifest.json'),
      'utf8'
    ))).toMatchObject({ version: 2 });
    expect(JSON.parse(await readFile(
      join(charactersDirectory, 'demo', 'compiled.backup', 'manifest.json'),
      'utf8'
    ))).toMatchObject({ version: 1 });
  });

  test('清单迁移提交后重启读取不会因保留的版本一备份重复写索引', async () => {
    const firstStore = new CharacterStore(charactersDirectory);
    const legacyRuntime = createRuntimeV1();
    await firstStore.create({ id: 'demo', name: '演示角色' });
    await writeRuntimeDirectory(
      join(charactersDirectory, 'demo', 'compiled'),
      legacyRuntime
    );
    await firstStore.getPublishedManifest('demo');

    const writer = failingIndexWriter();
    const restarted = new CharacterStore(charactersDirectory, { writeText: writer.writeText });
    writer.arm();

    await expect(restarted.getPublishedManifest('demo'))
      .resolves.toMatchObject({ version: 2 });
  });

  test('草稿迁移索引提交失败时恢复版本一原文并允许新实例重试', async () => {
    const writer = failingIndexWriter();
    const store = new CharacterStore(charactersDirectory, { writeText: writer.writeText });
    await store.create({ id: 'demo', name: '演示角色' });
    const draftFile = join(charactersDirectory, 'demo', 'draft', 'draft.json');
    const legacyText = `${JSON.stringify({
      ...createDraftV1(),
      thumbnailAssetId: undefined
    }, null, 2)}\n`;
    await writeFile(draftFile, legacyText, 'utf8');
    writer.arm();

    await expect(store.getDraft('demo')).rejects.toThrow('TEST_INDEX_WRITE_FAILED');
    expect(await readFile(draftFile, 'utf8')).toBe(legacyText);
    await expect(new CharacterStore(charactersDirectory).getDraft('demo'))
      .resolves.toMatchObject({ version: 2 });
  });

  test('草稿迁移写入 next 失败时不改动版本一原文且不留下事务文件', async () => {
    const writer = failingDraftNextWriter();
    const store = new CharacterStore(charactersDirectory, { writeText: writer.writeText });
    await store.create({ id: 'demo', name: '演示角色' });
    const draftDirectory = join(charactersDirectory, 'demo', 'draft');
    const draftFile = join(draftDirectory, 'draft.json');
    const legacyText = `${JSON.stringify({
      ...createDraftV1(),
      thumbnailAssetId: undefined
    }, null, 2)}\n`;
    await writeFile(draftFile, legacyText, 'utf8');
    writer.arm();

    await expect(store.getDraft('demo')).rejects.toThrow('TEST_DRAFT_NEXT_WRITE_FAILED');
    expect(await readFile(draftFile, 'utf8')).toBe(legacyText);
    expect(await readdir(draftDirectory)).toEqual(['draft.json']);
  });

  test('草稿迁移改名 backup 失败时回滚并保留版本一原文', async () => {
    const renamer = failingDraftBackupInstaller();
    const store = new CharacterStore(charactersDirectory, { renamePath: renamer.renamePath });
    await store.create({ id: 'demo', name: '演示角色' });
    const draftDirectory = join(charactersDirectory, 'demo', 'draft');
    const draftFile = join(draftDirectory, 'draft.json');
    const legacyText = `${JSON.stringify({
      ...createDraftV1(),
      thumbnailAssetId: undefined
    }, null, 2)}\n`;
    await writeFile(draftFile, legacyText, 'utf8');
    renamer.arm();

    await expect(store.getDraft('demo')).rejects.toThrow('TEST_DRAFT_BACKUP_RENAME_FAILED');
    expect(await readFile(draftFile, 'utf8')).toBe(legacyText);
    expect(await readdir(draftDirectory)).toEqual(['draft.json']);
  });

  test('重启完成已安装的草稿迁移并继续保留版本一恢复备份', async () => {
    const store = new CharacterStore(charactersDirectory);
    await store.create({ id: 'demo', name: '演示角色' });
    const draftDirectory = join(charactersDirectory, 'demo', 'draft');
    const legacyDraft = { ...createDraftV1(), thumbnailAssetId: undefined };
    const migratedDraft = convertCharacterDraftV1ToV2(legacyDraft).document;
    await writeFile(
      join(draftDirectory, 'draft.backup.json'),
      `${JSON.stringify(legacyDraft, null, 2)}\n`,
      'utf8'
    );
    await writeFile(
      join(draftDirectory, 'draft.json'),
      `${JSON.stringify(migratedDraft, null, 2)}\n`,
      'utf8'
    );
    await writeFile(
      join(draftDirectory, 'draft-transaction.json'),
      JSON.stringify({
        version: 1,
        phase: 'installed',
        keepBackup: true,
        previousEntry: { id: 'demo', name: '演示角色', thumbnailAssetId: null },
        nextEntry: {
          id: 'demo',
          name: '演示角色',
          thumbnailAssetId: null,
          draftVersion: 2
        }
      }),
      'utf8'
    );

    const restarted = new CharacterStore(charactersDirectory);
    await expect(restarted.getDraft('demo')).resolves.toMatchObject({ version: 2 });
    expect(JSON.parse(await readFile(join(draftDirectory, 'draft.backup.json'), 'utf8')))
      .toMatchObject({ version: 1 });
    await expect(access(join(draftDirectory, 'draft-transaction.json'))).rejects.toThrow();
  });

  test('审查修复：草稿永久恢复点清理失败时不把旧版本一误作本次回滚备份', async () => {
    const firstStore = new CharacterStore(charactersDirectory);
    await firstStore.create({ id: 'demo', name: '演示角色' });
    const draftDirectory = join(charactersDirectory, 'demo', 'draft');
    await writeFile(
      join(draftDirectory, 'draft.json'),
      `${JSON.stringify({ ...createDraftV1(), thumbnailAssetId: undefined }, null, 2)}\n`,
      'utf8'
    );
    const migrated = await firstStore.getDraft('demo');
    const remover = failingPersistentBackupRemover('draft.backup.json');
    const store = new CharacterStore(charactersDirectory, { removePath: remover.removePath });
    const changed = structuredClone(migrated);
    changed.identity.background = '不应提交的新背景';
    remover.arm();

    await expect(store.saveDraft('demo', changed))
      .rejects.toThrow('TEST_PERSISTENT_BACKUP_REMOVE_FAILED');
    expect(JSON.parse(await readFile(join(draftDirectory, 'draft.json'), 'utf8')))
      .toMatchObject({ version: 2, identity: { background: migrated.identity.background } });
    await expect(new CharacterStore(charactersDirectory).getDraft('demo'))
      .resolves.toMatchObject({
        version: 2,
        identity: { background: migrated.identity.background }
      });
  });

  test('审查修复：发布永久恢复点清理失败时不把旧版本一误作本次回滚备份', async () => {
    const firstStore = new CharacterStore(charactersDirectory);
    const legacyRuntime = createRuntimeV1();
    await firstStore.create({ id: 'demo', name: '演示角色' });
    await writeRuntimeDirectory(
      join(charactersDirectory, 'demo', 'compiled'),
      legacyRuntime
    );
    const migrated = await firstStore.getPublishedManifest('demo');
    const remover = failingPersistentBackupRemover('compiled.backup');
    const store = new CharacterStore(charactersDirectory, { removePath: remover.removePath });
    const changed = { ...migrated, compilerVersion: '2.0.0' };
    remover.arm();

    await expect(store.publishCompiled('demo', changed, legacyRuntime.assets))
      .rejects.toThrow('TEST_PERSISTENT_BACKUP_REMOVE_FAILED');
    expect(JSON.parse(await readFile(
      join(charactersDirectory, 'demo', 'compiled', 'manifest.json'),
      'utf8'
    ))).toMatchObject({ version: 2, compilerVersion: migrated.compilerVersion });
    await expect(new CharacterStore(charactersDirectory).getPublishedManifest('demo'))
      .resolves.toMatchObject({ version: 2, compilerVersion: migrated.compilerVersion });
  });

  test('审查修复：列表迁移索引失败后不以污染的内存索引二次写盘', async () => {
    const writer = failingIndexWriter();
    const store = new CharacterStore(charactersDirectory, { writeText: writer.writeText });
    await store.create({ id: 'demo', name: '演示角色' });
    const draftFile = join(charactersDirectory, 'demo', 'draft', 'draft.json');
    await writeFile(
      draftFile,
      `${JSON.stringify({ ...createDraftV1(), thumbnailAssetId: undefined }, null, 2)}\n`,
      'utf8'
    );
    const indexFile = join(charactersDirectory, 'index.json');
    const originalIndex = JSON.parse(await readFile(indexFile, 'utf8'));
    delete originalIndex.characters[0].draftVersion;
    await writeFile(indexFile, `${JSON.stringify(originalIndex, null, 2)}\n`, 'utf8');
    writer.arm();

    await expect(store.list()).resolves.toHaveLength(1);
    expect(JSON.parse(await readFile(draftFile, 'utf8'))).toMatchObject({ version: 1 });
    expect(JSON.parse(await readFile(indexFile, 'utf8')).characters[0])
      .not.toHaveProperty('draftVersion');
  });

  test('审查修复：当前草稿有效时损坏的可选永久恢复点不阻断读取', async () => {
    const store = new CharacterStore(charactersDirectory);
    await store.create({ id: 'demo', name: '演示角色' });
    const draftDirectory = join(charactersDirectory, 'demo', 'draft');
    await writeFile(join(draftDirectory, 'draft.backup.json'), '{损坏恢复点', 'utf8');

    await expect(new CharacterStore(charactersDirectory).getDraft('demo'))
      .resolves.toMatchObject({ version: 2, id: 'demo' });
    expect(JSON.parse(await readFile(join(draftDirectory, 'draft.json'), 'utf8')))
      .toMatchObject({ version: 2, id: 'demo' });
  });

  test('审查修复：当前发布目录有效时损坏的可选永久恢复点不阻断读取', async () => {
    const store = new CharacterStore(charactersDirectory);
    const runtime = createRuntime();
    await store.create({ id: 'demo', name: '演示角色' });
    await store.publishCompiled('demo', runtime.manifest, runtime.assets);
    const backupDirectory = join(charactersDirectory, 'demo', 'compiled.backup');
    await mkdir(backupDirectory);
    await writeFile(join(backupDirectory, 'manifest.json'), '{损坏恢复点', 'utf8');

    await expect(new CharacterStore(charactersDirectory).getPublishedManifest('demo'))
      .resolves.toMatchObject({ version: 2, id: 'demo' });
  });

  test('损坏草稿保留原文件并创建隔离副本', async () => {
    const store = new CharacterStore(charactersDirectory);
    await store.create({ id: 'demo', name: '演示角色' });
    const draftFile = join(charactersDirectory, 'demo', 'draft', 'draft.json');
    const brokenBytes = '{"version":2,"id":"demo"}';
    await writeFile(draftFile, brokenBytes, 'utf8');

    await expect(store.getDraft('demo')).rejects.toThrow('CHARACTER_MIGRATION_FAILED');

    const files = await readdir(join(charactersDirectory, 'demo', 'draft'));
    const corruptName = files.find(name => /^draft\.json\.corrupt-/u.test(name));
    expect(corruptName).toBeDefined();
    expect(await readFile(draftFile, 'utf8')).toBe(brokenBytes);
    expect(await readFile(
      join(charactersDirectory, 'demo', 'draft', corruptName!),
      'utf8'
    )).toBe(brokenBytes);
  });

  test('角色目录经过符号链接或 Junction 时拒绝读取', async () => {
    const store = new CharacterStore(charactersDirectory);
    await store.create({ id: 'demo', name: '演示角色' });
    const characterDirectory = join(charactersDirectory, 'demo');
    const physicalDirectory = join(charactersDirectory, 'demo-physical');
    await rename(characterDirectory, physicalDirectory);
    await symlink(physicalDirectory, characterDirectory, 'junction');

    await expect(store.getDraft('demo')).rejects.toThrow('CHARACTER_PATH_UNSAFE');
  });

  test('事务中间目录为 Junction 时拒绝恢复且不触碰链接目标', async () => {
    const store = new CharacterStore(charactersDirectory);
    const runtime = createRuntime();
    await store.create({ id: 'demo', name: '演示角色' });
    await store.publishCompiled('demo', runtime.manifest, runtime.assets);
    const outsideDirectory = join(testDirectory, 'outside-transaction');
    await mkdir(outsideDirectory);
    await writeFile(join(outsideDirectory, 'sentinel.txt'), '保留', 'utf8');
    await symlink(
      outsideDirectory,
      join(charactersDirectory, 'demo', 'compiled.next'),
      'junction'
    );

    const restartedStore = new CharacterStore(charactersDirectory);

    await expect(restartedStore.getRuntimeManifest('demo'))
      .rejects.toThrow('CHARACTER_PATH_UNSAFE');
    await expect(readFile(join(outsideDirectory, 'sentinel.txt'), 'utf8'))
      .resolves.toBe('保留');
  });

  test('公开写入方法不修改调用方对象或字节', async () => {
    const store = new CharacterStore(charactersDirectory);
    const draft = createDraft();
    const runtime = createRuntime();
    const originalDraft = structuredClone(draft);
    const originalManifest = structuredClone(runtime.manifest);
    const originalAtlas = runtime.assets['atlas.png']!.slice();
    await store.create({ id: 'demo', name: '演示角色' });

    await store.saveDraft('demo', draft);
    await store.publishCompiled('demo', runtime.manifest, runtime.assets);

    expect(draft).toEqual(originalDraft);
    expect(runtime.manifest).toEqual(originalManifest);
    expect(runtime.assets['atlas.png']).toEqual(originalAtlas);
  });
});

describe('角色存储 workspace 接入', () => {
  test('桌面端声明并内联角色素材包', () => {
    expect(desktopPackage.dependencies['@myself/character-assets']).toBe('workspace:*');
    if (typeof electronViteConfig === 'function' || electronViteConfig instanceof Promise) {
      throw new Error('测试要求 electron-vite 配置为静态对象');
    }
    const externalizeDeps = electronViteConfig.main?.build?.externalizeDeps;
    if (typeof externalizeDeps !== 'object') {
      throw new Error('测试要求 Main 外部依赖配置为对象');
    }
    expect(externalizeDeps.exclude).toContain('@myself/character-assets');
  });
});
