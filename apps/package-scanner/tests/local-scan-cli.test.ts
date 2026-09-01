import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  copyFile,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  truncate,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { ClamAvScanner } from '../src/scan-package';
import { scanPackage } from '../src/scan-package';
import * as localScanCli from '../src/local-scan-cli';
import { validPackageEntries, zipFixture } from './zip-fixture';

const { runLocalScanCli } = localScanCli;

const archiveDirectories: string[] = [];
const cleanClamav: ClamAvScanner = {
  scan: async () => ({ infected: false })
};

function completedResult(
  input: Parameters<typeof scanPackage>[0]
): Awaited<ReturnType<typeof scanPackage>> {
  return {
    code: 'CHARACTER_PACKAGE_LOCAL_SCAN_COMPLETED',
    manualReviewRequired: true,
    archive: input.archive,
    summary: {
      fileCount: 0,
      totalUncompressedBytes: 0,
      files: []
    },
    jsonTexts: [],
    imageSignals: []
  };
}

async function createArchive(
  entries: Parameters<typeof zipFixture>[0]
): Promise<string> {
  const archivePath = await zipFixture(entries);
  archiveDirectories.push(dirname(archivePath));
  return archivePath;
}

async function createFile(bytes: Buffer): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'package-scanner-cli-test-'));
  archiveDirectories.push(directory);
  const path = join(directory, 'input.zip');
  await writeFile(path, bytes);
  return path;
}

function captureOutput(
  clamav: ClamAvScanner,
  overrides: Record<string, unknown> = {}
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    dependencies: {
      clamav,
      writeStdout: (value: string) => stdout.push(value),
      writeStderr: (value: string) => stderr.push(value),
      ...overrides
    },
    stdout,
    stderr
  };
}

afterEach(async () => {
  await Promise.all(archiveDirectories.splice(0).map(directory => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('本地包扫描 CLI', () => {
  it('只接受一个 ZIP 路径参数', async () => {
    const capture = captureOutput(cleanClamav);

    await expect(runLocalScanCli([], capture.dependencies)).resolves.toBe(2);
    await expect(runLocalScanCli(['a.zip', 'b.zip'], capture.dependencies))
      .resolves.toBe(2);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr).toHaveLength(2);
  });

  it.each([
    ['目录', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'package-scanner-cli-directory-'));
      archiveDirectories.push(directory);
      return directory;
    }],
    ['空文件', async () => createFile(Buffer.alloc(0))],
    ['超过 100 MiB 的稀疏文件', async () => {
      const path = await createFile(Buffer.from('x'));
      await truncate(path, 100 * 1024 * 1024 + 1);
      return path;
    }]
  ])('%s 在读取内容前被拒绝', async (_name, createInput) => {
    const inputPath = await createInput();
    const capture = captureOutput(cleanClamav);

    await expect(runLocalScanCli([inputPath], capture.dependencies as never))
      .resolves.toBe(1);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr.join('')).toContain(
      'CHARACTER_PACKAGE_ARCHIVE_SIZE_REJECTED'
    );
  });

  it('复制期间增长超过预算时立即拒绝快照', async () => {
    const sourcePath = await createFile(Buffer.from('abc'));
    const destinationPath = await createFile(Buffer.alloc(0));
    const source = await open(sourcePath, 'r');
    const destination = await open(destinationPath, 'w');
    try {
      await writeFile(sourcePath, Buffer.from('def'), { flag: 'a' });
      const copyOpenedArchiveToSnapshot = Reflect.get(
        localScanCli,
        'copyOpenedArchiveToSnapshot'
      );
      expect(copyOpenedArchiveToSnapshot).toBeTypeOf('function');
      await expect(copyOpenedArchiveToSnapshot({
        source,
        destination,
        maxArchiveBytes: 4
      })).rejects.toThrow('CHARACTER_PACKAGE_ARCHIVE_SIZE_REJECTED');
    } finally {
      await source.close();
      await destination.close();
    }
  });

  it('扫描只使用同一份私有快照，原路径换包不改变 identity 或内容', async () => {
    const archivePath = await createArchive(validPackageEntries());
    const replacementPath = await createArchive([{
      path: 'run.js',
      bytes: Buffer.from('alert(1)')
    }]);
    let snapshotPath: string | undefined;
    const capture = captureOutput(cleanClamav, {
      scan: async (input: Parameters<typeof scanPackage>[0]) => {
        snapshotPath = input.archivePath;
        expect(snapshotPath).not.toBe(resolve(archivePath));
        await copyFile(replacementPath, archivePath);
        const snapshotBytes = await readFile(snapshotPath);
        expect(input.archive).toEqual({
          sizeBytes: snapshotBytes.byteLength,
          sha256: createHash('sha256').update(snapshotBytes).digest('hex')
        });
        return scanPackage(input);
      }
    });

    await expect(runLocalScanCli([archivePath], capture.dependencies as never))
      .resolves.toBe(0);
    expect(snapshotPath).toBeDefined();
    await expect(stat(snapshotPath as string)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('扫描失败后仍清理私有快照', async () => {
    const archivePath = await createArchive(validPackageEntries());
    let snapshotPath: string | undefined;
    const capture = captureOutput(cleanClamav, {
      scan: async (input: Parameters<typeof scanPackage>[0]) => {
        snapshotPath = input.archivePath;
        throw new Error('SCANNER_CLAMAV_UNAVAILABLE');
      }
    });

    await expect(runLocalScanCli([archivePath], capture.dependencies as never))
      .resolves.toBe(1);
    expect(snapshotPath).toBeDefined();
    await expect(stat(snapshotPath as string)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('源文件关闭失败时仍清理尚未交给扫描器的私有快照', async () => {
    const archivePath = await createArchive(validPackageEntries());
    const snapshotPrefix = 'package-scanner-cli-';
    const snapshotsBefore = new Set(
      (await readdir(tmpdir())).filter(name => name.startsWith(snapshotPrefix))
    );
    const capture = captureOutput(cleanClamav, {
      closeSource: async (source: Awaited<ReturnType<typeof open>>) => {
        await source.close();
        throw new Error('SOURCE_CLOSE_FAILED');
      }
    });

    try {
      await expect(runLocalScanCli([archivePath], capture.dependencies as never))
        .resolves.toBe(1);
      const leakedSnapshots = (await readdir(tmpdir())).filter(name => (
        name.startsWith(snapshotPrefix) && !snapshotsBefore.has(name)
      ));
      expect(leakedSnapshots).toEqual([]);
    } finally {
      const leakedSnapshots = (await readdir(tmpdir())).filter(name => (
        name.startsWith(snapshotPrefix) && !snapshotsBefore.has(name)
      ));
      await Promise.all(leakedSnapshots.map(name => (
        rm(join(tmpdir(), name), { recursive: true, force: true })
      )));
    }
  });

  it('整包截止会取消扫描并以稳定超时语义清理快照', async () => {
    const archivePath = await createArchive(validPackageEntries());
    const signalSource = new EventEmitter();
    let snapshotPath: string | undefined;
    let scanSignal: AbortSignal | undefined;
    const capture = captureOutput(cleanClamav, {
      scanTimeoutMs: 100,
      signalSource,
      scan: async (input: Parameters<typeof scanPackage>[0]) => {
        snapshotPath = input.archivePath;
        scanSignal = input.signal;
        return new Promise<never>(() => undefined);
      }
    });

    try {
      const didNotSettle = Symbol('did-not-settle');
      const outcome = await Promise.race([
        runLocalScanCli([archivePath], capture.dependencies as never),
        delay(500).then(() => didNotSettle)
      ]);
      expect(outcome).toBe(1);
      expect(scanSignal?.aborted).toBe(true);
      expect(capture.stderr.join('')).toContain('SCANNER_SCAN_TIMEOUT');
      await expect(stat(snapshotPath as string)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      signalSource.removeAllListeners();
      if (snapshotPath) {
        await rm(dirname(snapshotPath), { recursive: true, force: true });
      }
    }
  });

  it.each(['SIGINT', 'SIGTERM'] as const)(
    '%s 会取消扫描并移除信号监听与快照',
    async signalName => {
      const archivePath = await createArchive(validPackageEntries());
      const signalSource = new EventEmitter();
      let snapshotPath: string | undefined;
      let markScanStarted: (() => void) | undefined;
      const scanStarted = new Promise<void>(resolveStarted => {
        markScanStarted = resolveStarted;
      });
      const capture = captureOutput(cleanClamav, {
        scanTimeoutMs: 1_000,
        signalSource,
        scan: async (input: Parameters<typeof scanPackage>[0]) => {
          snapshotPath = input.archivePath;
          markScanStarted?.();
          await delay(50);
          return completedResult(input);
        }
      });

      const operation = runLocalScanCli(
        [archivePath],
        capture.dependencies as never
      );
      await scanStarted;
      signalSource.emit(signalName);

      await expect(operation).resolves.toBe(1);
      expect(capture.stderr.join('')).toContain('SCANNER_SCAN_TIMEOUT');
      expect(signalSource.listenerCount('SIGINT')).toBe(0);
      expect(signalSource.listenerCount('SIGTERM')).toBe(0);
      await expect(stat(snapshotPath as string)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  );

  it('扫描完成后清理 timer 和信号监听，不产生迟到取消', async () => {
    const archivePath = await createArchive(validPackageEntries());
    const signalSource = new EventEmitter();
    let scanSignal: AbortSignal | undefined;
    const capture = captureOutput(cleanClamav, {
      scanTimeoutMs: 10,
      signalSource,
      scan: async (input: Parameters<typeof scanPackage>[0]) => {
        scanSignal = input.signal;
        return completedResult(input);
      }
    });

    await expect(runLocalScanCli([archivePath], capture.dependencies as never))
      .resolves.toBe(0);
    await delay(20);
    expect(scanSignal?.aborted).toBe(false);
    expect(signalSource.listenerCount('SIGINT')).toBe(0);
    expect(signalSource.listenerCount('SIGTERM')).toBe(0);
  });

  it('默认整包截止固定为 120000ms', () => {
    expect(Reflect.get(localScanCli, 'DEFAULT_SCAN_TIMEOUT_MS')).toBe(120_000);
  });

  it('干净包输出本地扫描结果并明确要求人工审核图片', async () => {
    const archivePath = await createArchive(validPackageEntries());
    const capture = captureOutput(cleanClamav);

    await expect(runLocalScanCli([archivePath], capture.dependencies))
      .resolves.toBe(0);

    expect(capture.stderr).toEqual([]);
    expect(capture.stdout).toHaveLength(1);
    const result = JSON.parse(capture.stdout[0] ?? '{}');
    expect(result).toMatchObject({
      code: 'CHARACTER_PACKAGE_LOCAL_SCAN_COMPLETED',
      manualReviewRequired: true
    });
    expect(result.imageSignals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: 'local-manual-review',
        suggestion: 'review',
        labels: ['manual-review-required']
      })
    ]));
  });

  it('ClamAV 命中时不输出成功报告并以非零状态结束', async () => {
    const archivePath = await createArchive(validPackageEntries());
    const capture = captureOutput({
      scan: async () => ({
        infected: true,
        signature: 'Eicar-Signature'
      })
    });

    await expect(runLocalScanCli([archivePath], capture.dependencies))
      .resolves.toBe(1);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr.join('')).toContain('CHARACTER_PACKAGE_MALWARE_DETECTED');
  });

  it('非法包不输出成功报告并以非零状态结束', async () => {
    const archivePath = await createArchive([{
      path: 'run.js',
      bytes: Buffer.from('alert(1)')
    }]);
    const capture = captureOutput(cleanClamav);

    await expect(runLocalScanCli([archivePath], capture.dependencies))
      .resolves.toBe(1);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr.join('')).toContain('CHARACTER_PACKAGE_FILE_TYPE_REJECTED');
  });
});
