import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  mkdtemp,
  open,
  rm,
  type FileHandle
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClamAvCommandScanner } from './clamav-command-scanner.js';
import {
  scanPackage,
  MAX_ARCHIVE_BYTES,
  type ArchiveIdentity,
  type ClamAvScanner,
  type ImageContentModerator
} from './scan-package.js';

export const DEFAULT_SCAN_TIMEOUT_MS = 120_000;

type SignalSource = {
  once(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  removeListener(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
};

type LocalScanCliDependencies = {
  clamav?: ClamAvScanner;
  closeSource?: (source: FileHandle) => Promise<void>;
  scan?: typeof scanPackage;
  scanTimeoutMs?: number;
  signalSource?: SignalSource;
  writeStdout?: (value: string) => void;
  writeStderr?: (value: string) => void;
};

type ArchiveSnapshot = {
  directory: string;
  path: string;
  archive: ArchiveIdentity;
};

const localImageModerator: ImageContentModerator = {
  review: async ({ path }) => ({
    path,
    provider: 'local-manual-review',
    suggestion: 'review',
    labels: ['manual-review-required']
  })
};

function archiveError(): Error {
  return new Error('CHARACTER_PACKAGE_ARCHIVE_SIZE_REJECTED');
}

function assertRegularArchive(
  information: Awaited<ReturnType<typeof lstat>>,
  maxArchiveBytes: number
): void {
  if (
    !information.isFile()
    || information.size <= 0
    || information.size > maxArchiveBytes
  ) {
    throw archiveError();
  }
}

/**
 * 对已经打开的普通文件边复制边校验预算，确保摘要与后续扫描读取同一份不可变快照。
 */
export async function copyOpenedArchiveToSnapshot(input: {
  source: FileHandle;
  destination: FileHandle;
  maxArchiveBytes?: number;
  signal?: AbortSignal;
}): Promise<ArchiveIdentity> {
  const maxArchiveBytes = input.maxArchiveBytes ?? MAX_ARCHIVE_BYTES;
  const digest = createHash('sha256');
  let sizeBytes = 0;
  let readPosition = 0;
  const buffer = Buffer.allocUnsafe(64 * 1024);

  while (true) {
    if (input.signal?.aborted) throw new Error('SCANNER_SCAN_TIMEOUT');
    const { bytesRead } = await input.source.read(
      buffer,
      0,
      buffer.byteLength,
      readPosition
    );
    if (bytesRead === 0) break;
    sizeBytes += bytesRead;
    if (sizeBytes > maxArchiveBytes) throw archiveError();

    const bytes = buffer.subarray(0, bytesRead);
    let written = 0;
    while (written < bytesRead) {
      const result = await input.destination.write(
        bytes,
        written,
        bytesRead - written,
        readPosition + written
      );
      written += result.bytesWritten;
    }
    digest.update(bytes);
    readPosition += bytesRead;
  }
  if (sizeBytes === 0) throw archiveError();
  if (input.signal?.aborted) throw new Error('SCANNER_SCAN_TIMEOUT');
  return {
    sizeBytes,
    sha256: digest.digest('hex')
  };
}

async function createArchiveSnapshot(
  archivePath: string,
  signal?: AbortSignal,
  closeSource = (source: FileHandle) => source.close()
): Promise<ArchiveSnapshot> {
  const pathInformation = await lstat(archivePath);
  assertRegularArchive(pathInformation, MAX_ARCHIVE_BYTES);

  const openFlags = fsConstants.O_RDONLY
    | fsConstants.O_NONBLOCK
    | fsConstants.O_NOFOLLOW;
  const source = await open(archivePath, openFlags);
  let directory: string | undefined;
  try {
    const openedInformation = await source.stat();
    assertRegularArchive(openedInformation, MAX_ARCHIVE_BYTES);
    if (
      openedInformation.dev !== pathInformation.dev
      || openedInformation.ino !== pathInformation.ino
    ) {
      throw archiveError();
    }

    directory = await mkdtemp(join(tmpdir(), 'package-scanner-cli-'));
    const snapshotPath = join(directory, 'package.zip');
    const destination = await open(snapshotPath, 'wx', 0o600);
    try {
      const archive = await copyOpenedArchiveToSnapshot({
        source,
        destination,
        ...(signal ? { signal } : {})
      });
      return {
        directory,
        path: snapshotPath,
        archive
      };
    } finally {
      await destination.close();
    }
  } catch (error) {
    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
    throw error;
  } finally {
    try {
      await closeSource(source);
    } catch (error) {
      if (directory) {
        await rm(directory, { recursive: true, force: true });
      }
      throw error;
    }
  }
}

function publicErrorCode(error: unknown): string {
  if (
    error instanceof Error
    && /^(?:CHARACTER_PACKAGE|SCANNER)_[A-Z0-9_]+$/u.test(error.message)
  ) {
    return error.message;
  }
  return 'LOCAL_SCAN_FAILED';
}

/**
 * 本地 CLI 只读取一个 ZIP 并输出本地报告；它不连接数据库、对象存储或远端审核服务。
 */
export async function runLocalScanCli(
  args: readonly string[],
  dependencies: LocalScanCliDependencies = {}
): Promise<number> {
  const writeStdout = dependencies.writeStdout
    ?? ((value: string) => process.stdout.write(value));
  const writeStderr = dependencies.writeStderr
    ?? ((value: string) => process.stderr.write(value));
  if (args.length !== 1 || !args[0]?.trim()) {
    writeStderr(`${JSON.stringify({
      code: 'LOCAL_SCAN_USAGE_ERROR',
      usage: 'local-scan-cli <package.zip>'
    })}\n`);
    return 2;
  }

  let snapshot: ArchiveSnapshot | undefined;
  let result: Awaited<ReturnType<typeof scanPackage>> | undefined;
  let failure: unknown;
  const controller = new AbortController();
  const signalSource = dependencies.signalSource ?? process;
  const abortScan = () => {
    if (!controller.signal.aborted) {
      controller.abort(new Error('SCANNER_SCAN_TIMEOUT'));
    }
  };
  signalSource.once('SIGINT', abortScan);
  signalSource.once('SIGTERM', abortScan);
  const timeout = setTimeout(
    abortScan,
    dependencies.scanTimeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS
  );
  try {
    const archivePath = resolve(args[0]);
    snapshot = await createArchiveSnapshot(
      archivePath,
      controller.signal,
      dependencies.closeSource
    );
    let rejectAbortedScan: (() => void) | undefined;
    const abortedScan = new Promise<never>((_resolve, reject) => {
      rejectAbortedScan = () => reject(new Error('SCANNER_SCAN_TIMEOUT'));
      controller.signal.addEventListener('abort', rejectAbortedScan, {
        once: true
      });
      if (controller.signal.aborted) rejectAbortedScan();
    });
    try {
      result = await Promise.race([
        (dependencies.scan ?? scanPackage)({
          archivePath: snapshot.path,
          archive: snapshot.archive,
          clamav: dependencies.clamav ?? new ClamAvCommandScanner(),
          imageModerator: localImageModerator,
          signal: controller.signal
        }),
        abortedScan
      ]);
    } finally {
      if (rejectAbortedScan) {
        controller.signal.removeEventListener('abort', rejectAbortedScan);
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(timeout);
    signalSource.removeListener('SIGINT', abortScan);
    signalSource.removeListener('SIGTERM', abortScan);
    if (snapshot) {
      try {
        await rm(snapshot.directory, { recursive: true, force: true });
      } catch (error) {
        failure ??= error;
      }
    }
  }
  if (failure || !result) {
    writeStderr(`${JSON.stringify({
      code: 'LOCAL_SCAN_FAILED',
      detailCode: publicErrorCode(failure)
    })}\n`);
    return 1;
  }
  writeStdout(`${JSON.stringify(result)}\n`);
  return 0;
}

if (
  process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runLocalScanCli(process.argv.slice(2));
}
