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

  test('保存前后发现私有父目录身份变化时拒绝成功提交', async () => {
    const directory = await createTemporaryDirectory('ai-pet-habitat-parent-race-');
    const privateDirectory = join(directory, 'private');
    const movedDirectory = join(directory, 'private-moved');
    const file = join(privateDirectory, 'habitat.json');
    let replaced = false;
    const store = new PetHabitatStore(file, {
      onCheckpoint: async checkpoint => {
        if (checkpoint !== 'before-write' || replaced) return;
        replaced = true;
        await rename(privateDirectory, movedDirectory);
        await mkdir(privateDirectory);
      }
    });

    await expect(store.save(folderSnapshot(join(directory, 'target'))))
      .rejects.toThrow('HABITAT_STORAGE_CHANGED');
  });
});
