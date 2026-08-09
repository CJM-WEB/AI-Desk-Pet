import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  FolderIdentityResolver,
  type FolderIdentityResolverDependencies,
  type FolderIdentityStat
} from '../src/main/habitat/folder-identity-resolver';
import {
  PetHabitatStore,
  type PetHabitatSnapshot
} from '../src/main/habitat/pet-habitat-store';

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(name: string): Promise<string> {
  const directory = await mkdtemp(join(process.cwd(), `.${name}`));
  temporaryDirectories.push(directory);
  return directory;
}

function snapshot(
  absolutePath: string,
  identity = { dev: '12', ino: '34' }
): PetHabitatSnapshot {
  return {
    version: 1,
    preferences: { autoHideEnabled: true, idleDelayMs: 30_000 },
    directories: [{
      id: 'directory-1',
      displayName: '项目空间',
      pathHint: 'project',
      absolutePath,
      identity,
      enabled: true
    }],
    location: { kind: 'desktop', position: null }
  };
}

function fakeStats(
  identity: { dev: bigint; ino: bigint },
  options: { symbolicLink?: boolean; directory?: boolean } = {}
): FolderIdentityStat {
  return {
    dev: identity.dev,
    ino: identity.ino,
    isSymbolicLink: () => options.symbolicLink ?? false,
    isDirectory: () => options.directory ?? true
  };
}

function fakeDependencies(input: {
  physicalPath: string;
  identity?: { dev: bigint; ino: bigint };
  symbolicLink?: boolean;
  onCheckpoint?: FolderIdentityResolverDependencies['onCheckpoint'];
}): FolderIdentityResolverDependencies {
  const identity = input.identity ?? { dev: 12n, ino: 34n };
  const dependencies: FolderIdentityResolverDependencies = {
    realpathPath: vi.fn(async () => input.physicalPath),
    lstatPath: vi.fn(async () => fakeStats(
      identity,
      input.symbolicLink === undefined ? {} : { symbolicLink: input.symbolicLink }
    )),
    statPath: vi.fn(async () => fakeStats(identity))
  };
  if (input.onCheckpoint !== undefined) dependencies.onCheckpoint = input.onCheckpoint;
  return dependencies;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('FolderIdentityResolver', () => {
  test.each([
    ['上级目录', 'C:\\work', { dev: 12n, ino: 33n }],
    ['同名目录', 'D:\\other\\project', { dev: 99n, ino: 34n }],
    ['路径前缀', 'C:\\workspace\\project-copy', { dev: 12n, ino: 35n }]
  ] as const)('%s 不能仅凭路径文本命中', async (_name, physicalPath, identity) => {
    const directory = await createTemporaryDirectory('ai-pet-folder-identity-negative-');
    const store = new PetHabitatStore(join(directory, 'private', 'habitat.json'));
    await store.save(snapshot('C:\\workspace\\project'));
    const resolver = new FolderIdentityResolver(store, fakeDependencies({ physicalPath, identity }));

    await expect(resolver.resolve(physicalPath)).resolves.toEqual({ status: 'hidden' });
  });

  test.each([
    ['大小写变化', 'c:\\WORKSPACE\\PROJECT'],
    ['短路径', 'C:\\WORKSP~1\\PROJECT']
  ])('%s 仍须经真实路径和身份双采样后命中', async (_name, candidatePath) => {
    const directory = await createTemporaryDirectory('ai-pet-folder-identity-alias-');
    const file = join(directory, 'private', 'habitat.json');
    const store = new PetHabitatStore(file);
    await store.save(snapshot('C:\\workspace\\project'));
    const dependencies = fakeDependencies({ physicalPath: 'C:\\workspace\\project' });
    const resolver = new FolderIdentityResolver(store, dependencies);

    await expect(resolver.resolve(candidatePath)).resolves.toEqual({
      status: 'matched',
      directoryId: 'directory-1'
    });
    expect(dependencies.realpathPath).toHaveBeenCalledTimes(2);
    expect(dependencies.lstatPath).toHaveBeenCalledTimes(2);
    expect(dependencies.statPath).toHaveBeenCalledTimes(2);
  });

  test('规范路径直接匹配也重新检查身份，目录被替代后不匹配', async () => {
    const directory = await createTemporaryDirectory('ai-pet-folder-identity-replaced-');
    const file = join(directory, 'private', 'habitat.json');
    const originalPath = 'C:\\workspace\\project';
    const store = new PetHabitatStore(file);
    await store.save(snapshot(originalPath));
    const dependencies = fakeDependencies({
      physicalPath: originalPath,
      identity: { dev: 12n, ino: 99n }
    });

    await expect(new FolderIdentityResolver(store, dependencies).resolve(originalPath))
      .resolves.toEqual({ status: 'hidden' });
    expect(dependencies.statPath).toHaveBeenCalledTimes(2);
    expect((await store.load()).directories[0]?.absolutePath).toBe(originalPath);
  });

  test('链接入口即使指向已授权身份也失败关闭', async () => {
    const directory = await createTemporaryDirectory('ai-pet-folder-identity-link-');
    const store = new PetHabitatStore(join(directory, 'private', 'habitat.json'));
    await store.save(snapshot('C:\\workspace\\project'));
    const resolver = new FolderIdentityResolver(store, fakeDependencies({
      physicalPath: 'C:\\workspace\\project',
      symbolicLink: true
    }));

    await expect(resolver.resolve('C:\\workspace\\linked-project'))
      .resolves.toEqual({ status: 'hidden' });
  });

  test('同卷重命名或移动按身份命中，并通过 Store 原子更新新路径', async () => {
    const directory = await createTemporaryDirectory('ai-pet-folder-identity-rename-');
    const file = join(directory, 'private', 'habitat.json');
    const store = new PetHabitatStore(file);
    await store.save(snapshot('C:\\workspace\\old-name'));
    const resolver = new FolderIdentityResolver(store, fakeDependencies({
      physicalPath: 'C:\\workspace\\new-name'
    }));

    await expect(resolver.resolve('C:\\workspace\\new-name')).resolves.toEqual({
      status: 'matched',
      directoryId: 'directory-1'
    });
    expect((await store.load()).directories[0]?.absolutePath).toBe('C:\\workspace\\new-name');
  });

  test('身份采样之间发生替换时隐藏且不更新记录', async () => {
    const directory = await createTemporaryDirectory('ai-pet-folder-identity-race-');
    const file = join(directory, 'private', 'habitat.json');
    const store = new PetHabitatStore(file);
    const oldPath = 'C:\\workspace\\old-name';
    await store.save(snapshot(oldPath));
    let sample = 0;
    const resolver = new FolderIdentityResolver(store, {
      realpathPath: async () => 'C:\\workspace\\new-name',
      lstatPath: async () => fakeStats(sample++ === 0 ? { dev: 12n, ino: 34n } : { dev: 12n, ino: 35n }),
      statPath: async () => fakeStats(sample <= 1 ? { dev: 12n, ino: 34n } : { dev: 12n, ino: 35n })
    });

    await expect(resolver.resolve('C:\\workspace\\new-name'))
      .resolves.toEqual({ status: 'hidden' });
    expect((await store.load()).directories[0]?.absolutePath).toBe(oldPath);
  });

  test.each(['ENOENT', 'EACCES'] as const)(
    '目录暂时不可访问或永久删除（%s）都只检查原路径且返回稳定隐藏结果',
    async errorCode => {
      const directory = await createTemporaryDirectory('ai-pet-folder-identity-unavailable-');
      const privatePath = 'C:\\private\\secret-project';
      const store = new PetHabitatStore(join(directory, 'private', 'habitat.json'));
      await store.save(snapshot(privatePath));
      const realpathPath = vi.fn(async (candidatePath: string) => {
        throw Object.assign(new Error('不可访问'), { code: errorCode, candidatePath });
      });
      const resolver = new FolderIdentityResolver(store, {
        realpathPath,
        lstatPath: vi.fn(),
        statPath: vi.fn()
      });

      const result = await resolver.resolve(privatePath);

      expect(result).toEqual({ status: 'hidden' });
      expect(JSON.stringify(result)).not.toContain(privatePath);
      expect(realpathPath).toHaveBeenCalledTimes(1);
      expect(realpathPath).toHaveBeenCalledWith(privatePath);
    }
  );

  test('路径续接与并发保存共享 Store 队列，不会覆盖并发偏好更新', async () => {
    const directory = await createTemporaryDirectory('ai-pet-folder-identity-concurrent-');
    const file = join(directory, 'private', 'habitat.json');
    const store = new PetHabitatStore(file);
    const initial = snapshot('C:\\workspace\\old-name');
    await store.save(initial);
    let resumeInspection: (() => void) | undefined;
    const inspectionPaused = new Promise<void>(resolve => { resumeInspection = resolve; });
    let inspected = false;
    const resolver = new FolderIdentityResolver(store, fakeDependencies({
      physicalPath: 'C:\\workspace\\new-name',
      onCheckpoint: async () => {
        if (inspected) return;
        inspected = true;
        await inspectionPaused;
      }
    }));
    const resolving = resolver.resolve('C:\\workspace\\new-name');
    await vi.waitFor(() => expect(inspected).toBe(true));
    await new PetHabitatStore(file).save({
      ...initial,
      preferences: { ...initial.preferences, idleDelayMs: 90_000 }
    });
    resumeInspection?.();

    await expect(resolving).resolves.toMatchObject({ status: 'matched' });
    const restored = await new PetHabitatStore(file).load();
    expect(restored.preferences.idleDelayMs).toBe(90_000);
    expect(restored.directories[0]?.absolutePath).toBe('C:\\workspace\\new-name');
    expect(await readFile(file, 'utf8')).toContain('C:\\\\workspace\\\\new-name');
  });

  test('较新路径续接提交后，迟到解析不得以同一身份覆盖新路径', async () => {
    const directory = await createTemporaryDirectory('ai-pet-folder-identity-stale-update-');
    const file = join(directory, 'private', 'habitat.json');
    const initialPath = 'C:\\workspace\\original';
    await new PetHabitatStore(file).save(snapshot(initialPath));
    let releaseStaleLoad: (() => void) | undefined;
    const staleLoadPaused = new Promise<void>(resolve => { releaseStaleLoad = resolve; });
    let staleLoaded = false;

    class PausingHabitatStore extends PetHabitatStore {
      override async load(): Promise<PetHabitatSnapshot> {
        const loaded = await super.load();
        staleLoaded = true;
        await staleLoadPaused;
        return loaded;
      }
    }

    const staleResolver = new FolderIdentityResolver(
      new PausingHabitatStore(file),
      fakeDependencies({ physicalPath: 'C:\\workspace\\stale-a' })
    );
    const staleResolution = staleResolver.resolve('C:\\workspace\\stale-a');
    await vi.waitFor(() => expect(staleLoaded).toBe(true));

    const freshResolver = new FolderIdentityResolver(
      new PetHabitatStore(file),
      fakeDependencies({ physicalPath: 'C:\\workspace\\fresh-b' })
    );
    await expect(freshResolver.resolve('C:\\workspace\\fresh-b')).resolves.toEqual({
      status: 'matched',
      directoryId: 'directory-1'
    });
    releaseStaleLoad?.();

    await expect(staleResolution).resolves.toEqual({ status: 'hidden' });
    expect((await new PetHabitatStore(file).load()).directories[0]?.absolutePath)
      .toBe('C:\\workspace\\fresh-b');
  });

  test('Store 条件更新拒绝已禁用目录，撤销授权优先于身份续接', async () => {
    const directory = await createTemporaryDirectory('ai-pet-folder-identity-disabled-');
    const file = join(directory, 'private', 'habitat.json');
    const store = new PetHabitatStore(file);
    const disabled = snapshot('C:\\workspace\\old-name');
    disabled.directories[0]!.enabled = false;
    await store.save(disabled);

    await expect(store.updateDirectoryPath({
      directoryId: 'directory-1',
      expectedIdentity: { dev: '12', ino: '34' },
      expectedAbsolutePath: 'C:\\workspace\\old-name',
      absolutePath: 'C:\\workspace\\new-name'
    })).resolves.toBe('missing');
    expect((await store.load()).directories[0]?.absolutePath).toBe('C:\\workspace\\old-name');
  });

  test('禁用目录与重复身份记录均失败关闭', async () => {
    const directory = await createTemporaryDirectory('ai-pet-folder-identity-conflict-');
    const file = join(directory, 'private', 'habitat.json');
    const store = new PetHabitatStore(file);
    const conflicted = snapshot('C:\\workspace\\first');
    conflicted.directories[0]!.enabled = false;
    conflicted.directories.push({
      ...conflicted.directories[0]!,
      id: 'directory-2',
      absolutePath: 'C:\\workspace\\second',
      enabled: true
    });
    await store.save(conflicted);
    const resolver = new FolderIdentityResolver(store, fakeDependencies({
      physicalPath: 'C:\\workspace\\second'
    }));

    await expect(resolver.resolve('C:\\workspace\\second'))
      .resolves.toEqual({ status: 'hidden' });
  });
});
