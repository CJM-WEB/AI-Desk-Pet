import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

const fault = vi.hoisted(() => ({
  kind: undefined as 'write' | 'sync' | 'link' | undefined
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      return {
        writeFile: vi.fn(async (...writeArgs: Parameters<typeof handle.writeFile>) => {
          if (fault.kind === 'write') throw new Error('TEST_WRITE_FAILED');
          return handle.writeFile(...writeArgs);
        }),
        sync: vi.fn(async () => {
          if (fault.kind === 'sync') throw new Error('TEST_SYNC_FAILED');
          return handle.sync();
        }),
        close: () => handle.close()
      };
    }),
    link: vi.fn(async (...args: Parameters<typeof actual.link>) => {
      if (fault.kind === 'link') throw new Error('TEST_LINK_FAILED');
      return actual.link(...args);
    }),
    rename: vi.fn(actual.rename),
    copyFile: vi.fn(actual.copyFile)
  };
});

import { atomicWriteFileExclusive } from '../src/main/storage/atomic-file-coordinator';
import { copyFile, rename } from 'node:fs/promises';

describe('atomicWriteFileExclusive', () => {
  let directory: string;

  afterEach(async () => {
    fault.kind = undefined;
    vi.clearAllMocks();
    await rm(directory, { force: true, recursive: true });
  });

  test('32 个并发排他写入只有一个成功且 final 正文完整', async () => {
    directory = await mkdtemp(join(tmpdir(), 'atomic-file-coordinator-'));
    const finalFile = join(directory, 'character.bin');
    const bodies = Array.from({ length: 32 }, (_, index) =>
      Buffer.from(`writer-${index}-${'x'.repeat(4096)}`, 'utf8'));

    const results = await Promise.allSettled(
      bodies.map(bytes => atomicWriteFileExclusive(finalFile, bytes))
    );

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(31);
    expect(bodies).toContainEqual(await readFile(finalFile));
  });

  test('已有 final 时保持原字节且返回 EEXIST', async () => {
    directory = await mkdtemp(join(tmpdir(), 'atomic-file-coordinator-'));
    const finalFile = join(directory, 'character.bin');
    const original = Buffer.from('original-bytes', 'utf8');
    await writeFile(finalFile, original);

    const error = await atomicWriteFileExclusive(finalFile, Buffer.from('replacement'))
      .then(() => undefined, caught => caught as NodeJS.ErrnoException);

    expect(error?.code).toBe('EEXIST');
    expect(await readFile(finalFile)).toEqual(original);
  });

  test('临时文件 write 失败时 final 不出现且清理 temp', async () => {
    directory = await mkdtemp(join(tmpdir(), 'atomic-file-coordinator-'));
    const finalFile = join(directory, 'character.bin');
    fault.kind = 'write';

    await expect(atomicWriteFileExclusive(finalFile, Buffer.from('content')))
      .rejects.toThrow('TEST_WRITE_FAILED');

    expect(await readdir(directory)).toEqual([]);
  });

  test('临时文件 sync 失败时 final 不出现且清理 temp', async () => {
    directory = await mkdtemp(join(tmpdir(), 'atomic-file-coordinator-'));
    const finalFile = join(directory, 'character.bin');
    fault.kind = 'sync';

    await expect(atomicWriteFileExclusive(finalFile, Buffer.from('content')))
      .rejects.toThrow('TEST_SYNC_FAILED');

    expect(await readdir(directory)).toEqual([]);
  });

  test('hard-link 发布失败时不调用 rename 或 copyFile', async () => {
    directory = await mkdtemp(join(tmpdir(), 'atomic-file-coordinator-'));
    const finalFile = join(directory, 'character.bin');
    fault.kind = 'link';

    await expect(atomicWriteFileExclusive(finalFile, Buffer.from('content')))
      .rejects.toThrow('TEST_LINK_FAILED');

    expect(await readdir(directory)).toEqual([]);
    expect(rename).not.toHaveBeenCalled();
    expect(copyFile).not.toHaveBeenCalled();
  });
});
