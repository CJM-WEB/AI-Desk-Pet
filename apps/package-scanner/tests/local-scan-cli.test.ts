import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ClamAvScanner } from '../src/scan-package';
import { runLocalScanCli } from '../src/local-scan-cli';
import { validPackageEntries, zipFixture } from './zip-fixture';

const archiveDirectories: string[] = [];
const cleanClamav: ClamAvScanner = {
  scan: async () => ({ infected: false })
};

async function createArchive(
  entries: Parameters<typeof zipFixture>[0]
): Promise<string> {
  const archivePath = await zipFixture(entries);
  archiveDirectories.push(dirname(archivePath));
  return archivePath;
}

function captureOutput(clamav: ClamAvScanner) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    dependencies: {
      clamav,
      writeStdout: (value: string) => stdout.push(value),
      writeStderr: (value: string) => stderr.push(value)
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
