import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { link } from 'node:fs/promises';
import { basename, dirname, join, normalize, resolve } from 'node:path';

const fileQueues = new Map<string, Promise<void>>();

export function canonicalFilePath(file: string): string {
  const absolute = normalize(resolve(file));
  let existingCandidate = absolute;
  const missingSegments: string[] = [];

  while (true) {
    try {
      const physicalParent = realpathSync.native(existingCandidate);
      return normalize(join(physicalParent, ...missingSegments));
    } catch (error) {
      if (
        !(error instanceof Error)
        || !('code' in error)
        || (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')
      ) {
        throw error;
      }
      const parent = dirname(existingCandidate);
      if (parent === existingCandidate) return absolute;
      missingSegments.unshift(basename(existingCandidate));
      existingCandidate = parent;
    }
  }
}

function queueKey(file: string): string {
  const canonical = canonicalFilePath(file);
  return process.platform === 'win32' ? canonical.toLocaleLowerCase('en-US') : canonical;
}

/**
 * Electron Main 内同一规范路径的所有读改写操作共享一个队列。
 */
export function enqueueFileOperation<T>(
  file: string,
  operation: () => Promise<T>
): Promise<T> {
  const key = queueKey(file);
  const previous = fileQueues.get(key) ?? Promise.resolve();
  const transaction = previous.then(operation);
  const settled = transaction.then(() => undefined, () => undefined);
  fileQueues.set(key, settled);
  void settled.then(() => {
    if (fileQueues.get(key) === settled) fileQueues.delete(key);
  });
  return transaction;
}

export async function atomicWriteText(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporaryFile = `${file}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryFile, 'wx');
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryFile, file);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryFile, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * 以同目录临时文件完成持久化后用硬链接发布，确保已有目标不会被覆盖。
 */
export async function atomicWriteFileExclusive(
  file: string,
  content: Uint8Array
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporaryFile = `${file}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryFile, 'wx', 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporaryFile, file);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryFile, { force: true }).catch(() => undefined);
  }
}

export function uniqueCorruptFile(file: string, now = Date.now()): string {
  return `${file}.corrupt-${now}-${randomUUID()}`;
}
