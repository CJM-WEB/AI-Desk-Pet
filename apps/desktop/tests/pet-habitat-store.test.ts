import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  DEFAULT_HABITAT_SNAPSHOT,
  PetHabitatStore,
  projectHabitatSnapshot,
  type HabitatDirectoryRecord,
  type PetHabitatSnapshot
} from '../src/main/habitat/pet-habitat-store';
import { atomicWriteText } from '../src/main/storage/atomic-file-coordinator';

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), name));
  temporaryDirectories.push(directory);
  return directory;
}

function directoryRecord(absolutePath: string): HabitatDirectoryRecord {
  return {
    id: 'directory-1',
    displayName: '项目空间',
    pathHint: 'project',
    absolutePath,
    identity: { dev: 12, ino: 34 },
    enabled: true
  };
}

function folderSnapshot(absolutePath: string): PetHabitatSnapshot {
  return {
    version: 1,
    preferences: {
      enabled: true,
      autoHideEnabled: true,
      idleDelayMs: 45_000
    },
    directories: [directoryRecord(absolutePath)],
    location: {
      kind: 'folder',
      directoryId: 'directory-1',
      enteredAt: '2026-08-08T08:00:00.000Z',
      previousDesktopPosition: { x: 120, y: 240 },
      localOffset: { x: 16, y: 24 }
    }
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('PetHabitatStore', () => {
  test('缺失文件的功能总开关默认关闭', async () => {
    const directory = await createTemporaryDirectory('ai-pet-habitat-enabled-default-');
    const store = new PetHabitatStore(join(directory, 'private', 'habitat.json'));

    expect((await store.load()).preferences.enabled).toBe(false);
  });

  test('缺少总开关字段的旧版 v1 记录按关闭状态恢复', async () => {
    const directory = await createTemporaryDirectory('ai-pet-habitat-enabled-legacy-');
    const privateDirectory = join(directory, 'private');
    const file = join(privateDirectory, 'habitat.json');
    const legacySnapshot = folderSnapshot(join(directory, 'project'));
    delete legacySnapshot.preferences.enabled;
    await mkdir(privateDirectory);
    await writeFile(file, JSON.stringify(legacySnapshot), 'utf8');

    const restored = await new PetHabitatStore(file).load();

    expect(restored.preferences.enabled).toBe(false);
    expect(restored.location).toEqual(legacySnapshot.location);
    expect(await readdir(privateDirectory)).toEqual(['habitat.json']);
  });

  test('功能总开关与其他偏好一同持久化', async () => {
    const directory = await createTemporaryDirectory('ai-pet-habitat-enabled-save-');
    const file = join(directory, 'private', 'habitat.json');
    const snapshot = folderSnapshot(join(directory, 'project')) as PetHabitatSnapshot & {
      preferences: PetHabitatSnapshot['preferences'] & { enabled: boolean };
    };
    snapshot.preferences.enabled = true;

    await new PetHabitatStore(file).save(snapshot);

    await expect(new PetHabitatStore(file).load()).resolves.toMatchObject({
      preferences: {
        enabled: true,
        autoHideEnabled: true,
        idleDelayMs: 45_000
      }
    });
  });

  test('偏好原子更新保留其他实例并发提交的目录路径与当前位置', async () => {
    const directory = await createTemporaryDirectory('ai-pet-habitat-preferences-race-');
    const file = join(directory, 'private', 'habitat.json');
    const initial = folderSnapshot(join(directory, 'project-old'));
    initial.location = { kind: 'desktop', position: { x: 10, y: 20 } };
    await new PetHabitatStore(file).save(initial);

    const preferencesWrite = new PetHabitatStore(file).updatePreferences({
      enabled: false,
      autoHideEnabled: true,
      idleDelayMs: 75_000
    });
    const pathWrite = new PetHabitatStore(file).updateDirectoryPath({
      directoryId: 'directory-1',
      expectedIdentity: { dev: 12, ino: 34 },
      expectedAbsolutePath: join(directory, 'project-old'),
      absolutePath: join(directory, 'project-new')
    });
    await Promise.all([preferencesWrite, pathWrite]);
    const beforeLocation = await new PetHabitatStore(file).load();
    await new PetHabitatStore(file).updateLocation({
      expected: beforeLocation.location,
      expectedDirectory: beforeLocation.directories[0]!,
      location: {
        kind: 'folder',
        directoryId: 'directory-1',
        enteredAt: '2026-08-09T01:00:00.000Z',
        previousDesktopPosition: { x: 10, y: 20 },
        localOffset: { x: 3, y: 4 }
      }
    });

    const restored = await new PetHabitatStore(file).load();
    expect(restored.preferences).toEqual({
      enabled: false,
      autoHideEnabled: true,
      idleDelayMs: 75_000
    });
    expect(restored.directories[0]?.absolutePath).toBe(join(directory, 'project-new'));
    expect(restored.location).toMatchObject({
      kind: 'folder',
      directoryId: 'directory-1'
    });
  });

  test('目录增删与启用原子更新保留并发偏好和其他目录最新字段', async () => {
    const directory = await createTemporaryDirectory('ai-pet-habitat-directory-settings-race-');
    const file = join(directory, 'private', 'habitat.json');
    const initial = folderSnapshot(join(directory, 'first'));
    initial.location = { kind: 'desktop', position: null };
    initial.directories.push({
      ...directoryRecord(join(directory, 'second-old')),
      id: 'directory-2',
      displayName: '第二空间',
      pathHint: 'second',
      identity: { dev: 56, ino: 78 }
    });
    await new PetHabitatStore(file).save(initial);

    await Promise.all([
      new PetHabitatStore(file).updatePreferences({
        enabled: true,
        autoHideEnabled: true,
        idleDelayMs: 60_000
      }),
      new PetHabitatStore(file).setDirectoryEnabled('directory-1', false),
      new PetHabitatStore(file).updateDirectoryPath({
        directoryId: 'directory-2',
        expectedIdentity: { dev: 56, ino: 78 },
        expectedAbsolutePath: join(directory, 'second-old'),
        absolutePath: join(directory, 'second-new')
      }),
      new PetHabitatStore(file).addDirectory({
        ...directoryRecord(join(directory, 'third')),
        id: 'directory-3',
        displayName: '第三空间',
        pathHint: 'third',
        identity: { dev: 90, ino: 91 }
      })
    ]);
    await new PetHabitatStore(file).removeDirectory('directory-1');

    const restored = await new PetHabitatStore(file).load();
    expect(restored.preferences).toEqual({
      enabled: true,
      autoHideEnabled: true,
      idleDelayMs: 60_000
    });
    expect(restored.directories).toEqual([
      expect.objectContaining({
        id: 'directory-2',
        absolutePath: join(directory, 'second-new')
      }),
      expect.objectContaining({ id: 'directory-3' })
    ]);
  });

  test('缺失文件返回关闭自动藏身的安全默认值', async () => {
    const directory = await createTemporaryDirectory('ai-pet-habitat-default-');
    const store = new PetHabitatStore(join(directory, 'private', 'habitat.json'));

    await expect(store.load()).resolves.toEqual(DEFAULT_HABITAT_SNAPSHOT);
    expect(await readdir(directory)).toEqual([]);
  });

  test('损坏文件只隔离 HabitatStore 自身且不触碰配置目标目录', async () => {
    const directory = await createTemporaryDirectory('ai-pet-habitat-corrupt-');
    const privateDirectory = join(directory, 'private');
    const targetDirectory = join(directory, 'target');
    const file = join(privateDirectory, 'habitat.json');
    const marker = join(targetDirectory, 'marker.txt');
    await mkdir(privateDirectory);
    await mkdir(targetDirectory);
    await writeFile(file, '{损坏', 'utf8');
    await writeFile(marker, '不可修改', 'utf8');

    await expect(new PetHabitatStore(file).load()).resolves.toEqual(DEFAULT_HABITAT_SNAPSHOT);

    expect(await readFile(marker, 'utf8')).toBe('不可修改');
    expect((await readdir(privateDirectory)).filter(name => (
      /^habitat\.json\.corrupt-/u.test(name)
    ))).toHaveLength(1);
    expect(await readdir(targetDirectory)).toEqual(['marker.txt']);
  });

  test.each([
    'folder/name',
    'folder\\name',
    'C:secret',
    '.',
    '..'
  ])('磁盘中的恶意 pathHint %s 被隔离且不会进入公开投影', async pathHint => {
    const directory = await createTemporaryDirectory('ai-pet-habitat-path-hint-');
    const privateDirectory = join(directory, 'private');
    const file = join(privateDirectory, 'habitat.json');
    const privatePath = 'C:\\Users\\Alice\\Secret\\project';
    const snapshot = folderSnapshot(privatePath);
    snapshot.directories[0]!.pathHint = pathHint;
    await mkdir(privateDirectory);
    await writeFile(file, JSON.stringify(snapshot), 'utf8');

    const restored = await new PetHabitatStore(file).load();

    expect(restored).toEqual(DEFAULT_HABITAT_SNAPSHOT);
    expect(JSON.stringify(projectHabitatSnapshot(restored))).not.toContain(pathHint);
    expect((await readdir(privateDirectory)).filter(name => (
      /^habitat\.json\.corrupt-/u.test(name)
    ))).toHaveLength(1);
  });

  test.each([
    'bad：name',
    'folder／name',
    'folder＼name'
  ])('直接保存拒绝 NFKC 后含保留字符的 pathHint %s', async pathHint => {
    const directory = await createTemporaryDirectory('ai-pet-habitat-path-hint-save-');
    const file = join(directory, 'private', 'habitat.json');
    const snapshot = folderSnapshot(join(directory, 'project'));
    snapshot.directories[0]!.pathHint = pathHint;
    const store = new PetHabitatStore(file);

    await expect(store.save(snapshot)).rejects.toThrow();

    const restored = await store.load();
    expect(restored).toEqual(DEFAULT_HABITAT_SNAPSHOT);
    expect(JSON.stringify(projectHabitatSnapshot(restored))).not.toContain(pathHint);
    expect(await readdir(directory)).toEqual([]);
  });

  test.each([
    'bad：name',
    'folder／name',
    'folder＼name'
  ])('磁盘中的全角恶意 pathHint %s 被隔离且不会进入公开投影', async pathHint => {
    const directory = await createTemporaryDirectory('ai-pet-habitat-fullwidth-path-hint-');
    const privateDirectory = join(directory, 'private');
    const file = join(privateDirectory, 'habitat.json');
    const snapshot = folderSnapshot('C:\\Users\\Alice\\Secret\\project');
    snapshot.directories[0]!.pathHint = pathHint;
    await mkdir(privateDirectory);
    await writeFile(file, JSON.stringify(snapshot), 'utf8');

    const restored = await new PetHabitatStore(file).load();

    expect(restored).toEqual(DEFAULT_HABITAT_SNAPSHOT);
    expect(JSON.stringify(projectHabitatSnapshot(restored))).not.toContain(pathHint);
    expect((await readdir(privateDirectory)).filter(name => (
      /^habitat\.json\.corrupt-/u.test(name)
    ))).toHaveLength(1);
  });

  test('直接保存合法兼容字符时落盘和投影统一使用 NFKC 形式', async () => {
    const directory = await createTemporaryDirectory('ai-pet-habitat-normalized-name-');
    const file = join(directory, 'private', 'habitat.json');
    const snapshot = folderSnapshot(join(directory, 'project'));
    snapshot.directories[0]!.displayName = 'Ｐｒｏｊｅｃｔ';
    snapshot.directories[0]!.pathHint = 'Ｐｒｏｊｅｃｔ';
    const store = new PetHabitatStore(file);

    await store.save(snapshot);

    const restored = await store.load();
    expect(restored.directories[0]).toMatchObject({
      displayName: 'Project',
      pathHint: 'Project'
    });
    expect(projectHabitatSnapshot(restored).directories[0]).toMatchObject({
      displayName: 'Project',
      pathHint: 'Project'
    });
    expect(await readFile(file, 'utf8')).not.toContain('Ｐｒｏｊｅｃｔ');
  });

  test('NFKC 新引入的首尾空白在落盘和投影前统一清除', async () => {
    const directory = await createTemporaryDirectory('ai-pet-habitat-normalized-space-');
    const file = join(directory, 'private', 'habitat.json');
    const snapshot = folderSnapshot(join(directory, 'project'));
    snapshot.directories[0]!.displayName = '¨Project';
    snapshot.directories[0]!.pathHint = '¨Project';
    const store = new PetHabitatStore(file);

    await store.save(snapshot);

    const restored = await store.load();
    expect(restored.directories[0]).toMatchObject({
      displayName: '\u0308Project',
      pathHint: '\u0308Project'
    });
    expect(projectHabitatSnapshot(restored).directories[0]).toMatchObject({
      displayName: '\u0308Project',
      pathHint: '\u0308Project'
    });
    const persisted = await readFile(file, 'utf8');
    expect(persisted).toContain('"displayName": "\u0308Project"');
    expect(persisted).toContain('"pathHint": "\u0308Project"');
  });

  test('原子写失败保留上一版本且后续写入仍可继续', async () => {
    const directory = await createTemporaryDirectory('ai-pet-habitat-write-');
    const file = join(directory, 'private', 'habitat.json');
    let armed = false;
    const store = new PetHabitatStore(file, {
      writeText: async (target, content) => {
        if (armed) {
          armed = false;
          throw new Error('TEST_WRITE_FAILED');
        }
        await atomicWriteText(target, content);
      }
    });
    const first = folderSnapshot(join(directory, 'target'));
    const second = {
      ...first,
      preferences: { ...first.preferences, idleDelayMs: 60_000 }
    };
    await store.save(first);
    const firstBytes = await readFile(file, 'utf8');
    armed = true;

    await expect(store.save(second)).rejects.toThrow('HABITAT_STORAGE_FAILED');
    expect(await readFile(file, 'utf8')).toBe(firstBytes);

    await expect(store.save(second)).resolves.toBeUndefined();
    await expect(store.load()).resolves.toEqual(second);
  });

  test('同一文件的并发写按调用顺序提交', async () => {
    const directory = await createTemporaryDirectory('ai-pet-habitat-queue-');
    const file = join(directory, 'private', 'habitat.json');
    const first = folderSnapshot(join(directory, 'first'));
    const second = {
      ...first,
      preferences: { ...first.preferences, idleDelayMs: 75_000 }
    };
    const third = {
      ...first,
      preferences: { ...first.preferences, idleDelayMs: 90_000 }
    };

    await Promise.all([
      new PetHabitatStore(file).save(first),
      new PetHabitatStore(file).save(second),
      new PetHabitatStore(file).save(third)
    ]);

    await expect(new PetHabitatStore(file).load()).resolves.toEqual(third);
  });

  test('重启恢复 folder 状态、进入前桌面坐标与目录身份', async () => {
    const directory = await createTemporaryDirectory('ai-pet-habitat-restart-');
    const file = join(directory, 'private', 'habitat.json');
    const snapshot = folderSnapshot(join(directory, 'project'));
    await new PetHabitatStore(file).save(snapshot);

    const restored = await new PetHabitatStore(file).load();

    expect(restored).toEqual(snapshot);
    expect(restored.location).toEqual({
      kind: 'folder',
      directoryId: 'directory-1',
      enteredAt: '2026-08-08T08:00:00.000Z',
      previousDesktopPosition: { x: 120, y: 240 },
      localOffset: { x: 16, y: 24 }
    });
    expect(restored.directories[0]?.identity).toEqual({ dev: 12, ino: 34 });
  });

  test('目录公开名称与 pathHint 按 Unicode 码点允许 41 个 emoji', async () => {
    const directory = await createTemporaryDirectory('ai-pet-habitat-unicode-');
    const file = join(directory, 'private', 'habitat.json');
    const snapshot = folderSnapshot(join(directory, 'project'));
    const emojiName = '😀'.repeat(41);
    snapshot.directories[0]!.displayName = emojiName;
    snapshot.directories[0]!.pathHint = emojiName;

    await new PetHabitatStore(file).save(snapshot);

    await expect(new PetHabitatStore(file).load()).resolves.toEqual(snapshot);
  });

  test('Renderer 投影不含绝对路径、目录身份或进入前桌面坐标', () => {
    const privatePath = 'C:\\Users\\Alice\\Secret\\project';
    const projected = projectHabitatSnapshot(
      folderSnapshot(privatePath),
      new Map([['directory-1', 'available']])
    );
    const serialized = JSON.stringify(projected);

    expect(projected).toEqual({
      enabled: true,
      autoHideEnabled: true,
      idleDelayMs: 45_000,
      directories: [{
        id: 'directory-1',
        displayName: '项目空间',
        pathHint: 'project',
        enabled: true,
        availability: 'available'
      }],
      location: { kind: 'folder', directoryId: 'directory-1' }
    });
    expect(serialized).not.toContain(privatePath);
    expect(serialized).not.toContain('absolutePath');
    expect(serialized).not.toContain('previousDesktopPosition');
    expect(serialized).not.toMatch(/\b(?:dev|ino)\b/u);
  });

  test('清除本地数据只重置 HabitatStore 记录且不触碰目标目录', async () => {
    const directory = await createTemporaryDirectory('ai-pet-habitat-clear-');
    const file = join(directory, 'private', 'habitat.json');
    const targetDirectory = join(directory, 'target');
    const marker = join(targetDirectory, 'marker.txt');
    await mkdir(targetDirectory);
    await writeFile(marker, '保留', 'utf8');
    const store = new PetHabitatStore(file);
    await store.save(folderSnapshot(targetDirectory));

    await store.clear();

    await expect(store.load()).resolves.toEqual(DEFAULT_HABITAT_SNAPSHOT);
    expect(await readFile(marker, 'utf8')).toBe('保留');
    expect(await readdir(targetDirectory)).toEqual(['marker.txt']);
  });

  test('私有父目录被替换时失败保存不覆盖无关文件且保留上一版本', async () => {
    const directory = await createTemporaryDirectory('ai-pet-habitat-parent-race-');
    const privateDirectory = join(directory, 'private');
    const movedDirectory = join(directory, 'private-moved');
    const file = join(privateDirectory, 'habitat.json');
    const first = folderSnapshot(join(directory, 'first-target'));
    const second = {
      ...first,
      preferences: { ...first.preferences, idleDelayMs: 60_000 }
    };
    await new PetHabitatStore(file).save(first);
    const firstBytes = await readFile(file, 'utf8');
    const unrelatedBytes = '{"owner":"unrelated"}\n';
    let replaced = false;
    const store = new PetHabitatStore(file, {
      onCheckpoint: async checkpoint => {
        if (checkpoint !== 'before-commit' || replaced) return;
        replaced = true;
        await rename(privateDirectory, movedDirectory);
        await mkdir(privateDirectory);
        await writeFile(file, unrelatedBytes, 'utf8');
      }
    });

    await expect(store.save(second))
      .rejects.toThrow('HABITAT_STORAGE_CHANGED');
    expect(await readFile(file, 'utf8')).toBe(unrelatedBytes);
    expect(await readFile(join(movedDirectory, 'habitat.json'), 'utf8')).toBe(firstBytes);
  });

  test.each(['ENOENT', 'ENOTDIR'] as const)(
    '提交前父路径发生 %s 命名空间变化时稳定报告 STORAGE_CHANGED',
    async failureCode => {
      const directory = await createTemporaryDirectory('ai-pet-habitat-parent-missing-');
      const privateRoot = join(directory, 'private');
      const privateDirectory = join(privateRoot, 'nested');
      const movedRoot = join(directory, 'private-moved');
      const file = join(privateDirectory, 'habitat.json');
      const first = folderSnapshot(join(directory, 'first-target'));
      const second = {
        ...first,
        preferences: { ...first.preferences, idleDelayMs: 60_000 }
      };
      await new PetHabitatStore(file).save(first);
      const firstBytes = await readFile(file, 'utf8');
      let replaced = false;
      const store = new PetHabitatStore(file, {
        onCheckpoint: async checkpoint => {
          if (checkpoint !== 'before-commit' || replaced) return;
          replaced = true;
          await rename(privateRoot, movedRoot);
          if (failureCode === 'ENOTDIR') await writeFile(privateRoot, '替代文件', 'utf8');
        }
      });

      await expect(store.save(second))
        .rejects.toThrow('HABITAT_STORAGE_CHANGED');
      expect(await readFile(join(movedRoot, 'nested', 'habitat.json'), 'utf8'))
        .toBe(firstBytes);
    }
  );

  test('location 条件更新在同一文件队列中保留先提交的偏好与目录路径', async () => {
    const directory = await createTemporaryDirectory('ai-pet-habitat-location-cas-');
    const file = join(directory, 'private', 'habitat.json');
    const initial = folderSnapshot(join(directory, 'old-project'));
    const latest = {
      ...initial,
      preferences: { ...initial.preferences, idleDelayMs: 90_000 },
      directories: [{
        ...initial.directories[0]!,
        absolutePath: join(directory, 'moved-project')
      }]
    };
    const store = new PetHabitatStore(file);
    await store.save(initial);

    const settingsWrite = new PetHabitatStore(file).save(latest);
    const locationWrite = new PetHabitatStore(file).updateLocation({
      expected: initial.location,
      location: { kind: 'desktop', position: { x: 120, y: 240 } }
    });
    await settingsWrite;

    await expect(locationWrite).resolves.toMatchObject({ status: 'updated' });
    await expect(store.load()).resolves.toEqual({
      ...latest,
      location: { kind: 'desktop', position: { x: 120, y: 240 } }
    });
  });

  test('进入 folder 的条件更新在队列内复核目录仍启用且身份路径未变化', async () => {
    const directory = await createTemporaryDirectory('ai-pet-habitat-location-enter-');
    const file = join(directory, 'private', 'habitat.json');
    const initial = folderSnapshot(join(directory, 'project'));
    initial.location = { kind: 'desktop', position: { x: 120, y: 240 } };
    const disabled = structuredClone(initial);
    disabled.directories[0]!.enabled = false;
    const store = new PetHabitatStore(file);
    await store.save(initial);

    const settingsWrite = new PetHabitatStore(file).save(disabled);
    const locationWrite = new PetHabitatStore(file).updateLocation({
      expected: initial.location,
      expectedDirectory: initial.directories[0]!,
      location: {
        kind: 'folder',
        directoryId: 'directory-1',
        enteredAt: '2026-08-08T09:00:00.000Z',
        previousDesktopPosition: { x: 120, y: 240 },
        localOffset: { x: 16, y: 24 }
      }
    });
    await settingsWrite;

    await expect(locationWrite).resolves.toMatchObject({ status: 'conflict' });
    await expect(store.load()).resolves.toEqual(disabled);
  });

  test('并发方已写入同一 folder 时 unchanged 也不能绕过目录停用复核', async () => {
    const directory = await createTemporaryDirectory('ai-pet-habitat-location-unchanged-');
    const file = join(directory, 'private', 'habitat.json');
    const desktop = folderSnapshot(join(directory, 'project'));
    desktop.location = { kind: 'desktop', position: { x: 120, y: 240 } };
    const concurrentFolder = folderSnapshot(join(directory, 'project'));
    concurrentFolder.directories[0]!.enabled = false;
    const store = new PetHabitatStore(file);
    await store.save(desktop);

    const concurrentWrite = new PetHabitatStore(file).save(concurrentFolder);
    const locationWrite = new PetHabitatStore(file).updateLocation({
      expected: desktop.location,
      expectedDirectory: desktop.directories[0]!,
      location: folderSnapshot(join(directory, 'project')).location
    });
    await concurrentWrite;

    await expect(locationWrite).resolves.toMatchObject({ status: 'conflict' });
    await expect(store.load()).resolves.toEqual(concurrentFolder);
  });

  test('location 条件更新拒绝同一 folder 的 ABA 稳定位置替换', async () => {
    const directory = await createTemporaryDirectory('ai-pet-habitat-location-folder-aba-');
    const file = join(directory, 'private', 'habitat.json');
    const first = folderSnapshot(join(directory, 'project'));
    const replacement = structuredClone(first);
    replacement.location = {
      kind: 'folder',
      directoryId: 'directory-1',
      enteredAt: '2026-08-08T10:00:00.000Z',
      previousDesktopPosition: { x: 300, y: 400 },
      localOffset: { x: 40, y: 50 }
    };
    const store = new PetHabitatStore(file);
    await store.save(first);

    const replacementWrite = new PetHabitatStore(file).save(replacement);
    const delayedRecall = new PetHabitatStore(file).updateLocation({
      expected: first.location,
      location: { kind: 'desktop', position: { x: 120, y: 240 } }
    });
    await replacementWrite;

    await expect(delayedRecall).resolves.toMatchObject({ status: 'conflict' });
    await expect(store.load()).resolves.toEqual(replacement);
  });

  test('location 条件更新严格比较 desktop position，拒绝同槽位 ABA', async () => {
    const directory = await createTemporaryDirectory('ai-pet-habitat-location-desktop-aba-');
    const file = join(directory, 'private', 'habitat.json');
    const first = folderSnapshot(join(directory, 'project'));
    first.location = { kind: 'desktop', position: { x: 120, y: 240 } };
    const replacement = structuredClone(first);
    replacement.location = { kind: 'desktop', position: { x: 300, y: 400 } };
    const store = new PetHabitatStore(file);
    await store.save(first);

    const replacementWrite = new PetHabitatStore(file).save(replacement);
    const delayedEnter = new PetHabitatStore(file).updateLocation({
      expected: first.location,
      expectedDirectory: first.directories[0]!,
      location: folderSnapshot(join(directory, 'project')).location
    });
    await replacementWrite;

    await expect(delayedEnter).resolves.toMatchObject({ status: 'conflict' });
    await expect(store.load()).resolves.toEqual(replacement);
  });
});
