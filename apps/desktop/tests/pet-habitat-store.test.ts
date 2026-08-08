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
});
