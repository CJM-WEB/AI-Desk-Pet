import { createHash, createHmac } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createScannerServer,
  scanRemotePackage
} from '../src/server';
import { validPackageEntries, zipFixture } from './zip-fixture';

const directories: string[] = [];
const TEST_NOW = new Date('2026-07-31T00:00:00.000Z');
const TEST_EXPIRES_AT = TEST_NOW.getTime() + 300_000;
const TEST_SECRET = 'scanner-test-secret';

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

function signedHeaders(body: string): Record<string, string> {
  const timestamp = String(TEST_NOW.getTime());
  const bodyHash = createHash('sha256').update(body).digest('hex');
  return {
    'content-type': 'application/json',
    'x-internal-timestamp': timestamp,
    'x-internal-signature': createHmac('sha256', TEST_SECRET)
      .update(`${timestamp}\n${bodyHash}`)
      .digest('hex')
  };
}

async function listen(server: ReturnType<typeof createScannerServer>): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('测试服务未绑定 TCP 端口');
  }
  return address.port;
}

async function close(server: ReturnType<typeof createScannerServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

async function serverDependencies() {
  return {
    secret: TEST_SECRET,
    workRoot: await temporaryDirectory('scanner-work-'),
    replayDirectory: await temporaryDirectory('scanner-replay-'),
    allowedDownloadHosts: new Set(['storage.example.test']),
    requiredDownloadQueryParameters: new Set(['signature']),
    clamav: { scan: async () => ({ infected: false }) },
    imageModerator: {
      review: async ({ path }: { path: string }) => ({
        path,
        provider: 'test',
        suggestion: 'pass' as const,
        labels: []
      })
    },
    now: () => TEST_NOW
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('扫描服务隔离边界', () => {
  it.each([
    ['成功', false],
    ['失败', true]
  ])('扫描%s后都清理请求临时目录', async (_name, shouldFail) => {
    const workRoot = await temporaryDirectory('scanner-work-');
    const sourceArchive = await zipFixture([{ path: 'data.json' }]);
    directories.push(sourceArchive.slice(0, sourceArchive.lastIndexOf('\\')));

    const operation = scanRemotePackage({
      downloadUrl: 'https://storage.example.test/private.zip?signature=short-lived',
      expiresAtMs: TEST_EXPIRES_AT,
      now: TEST_NOW,
      workRoot,
      allowedDownloadHosts: new Set(['storage.example.test']),
      requiredDownloadQueryParameters: new Set(['signature']),
      download: async (_url, destination) => copyFile(sourceArchive, destination),
      scan: async ({ archivePath }) => {
        expect(archivePath.startsWith(`${workRoot}\\`)).toBe(true);
        if (shouldFail) throw new Error('SCANNER_TEST_FAILURE');
        return {
          code: 'CHARACTER_PACKAGE_SCAN_PASSED' as const,
          summary: {
            fileCount: 0,
            totalUncompressedBytes: 0,
            files: []
          },
          jsonTexts: [],
          imageSignals: []
        };
      }
    });

    if (shouldFail) {
      await expect(operation).rejects.toThrow('SCANNER_TEST_FAILURE');
    } else {
      await expect(operation).resolves.toMatchObject({
        code: 'CHARACTER_PACKAGE_SCAN_PASSED'
      });
    }
    expect(await readdir(workRoot)).toEqual([]);
  });

  it('拒绝非 HTTPS、非允许主机和没有短期签名参数的下载地址', async () => {
    const workRoot = await temporaryDirectory('scanner-work-');
    const base = {
      workRoot,
      expiresAtMs: TEST_EXPIRES_AT,
      now: TEST_NOW,
      allowedDownloadHosts: new Set(['storage.example.test']),
      requiredDownloadQueryParameters: new Set(['signature']),
      download: async () => undefined,
      scan: async () => {
        throw new Error('不应进入扫描');
      }
    };

    await expect(scanRemotePackage({
      ...base,
      downloadUrl: 'http://storage.example.test/file.zip?signature=present'
    })).rejects.toThrow('SCANNER_DOWNLOAD_URL_REJECTED');
    await expect(scanRemotePackage({
      ...base,
      downloadUrl: 'https://evil.example.test/file.zip?signature=present'
    })).rejects.toThrow('SCANNER_DOWNLOAD_URL_REJECTED');
    await expect(scanRemotePackage({
      ...base,
      downloadUrl: 'https://storage.example.test/file.zip'
    })).rejects.toThrow('SCANNER_DOWNLOAD_URL_REJECTED');
    await expect(scanRemotePackage({
      ...base,
      downloadUrl: 'https://storage.example.test:8443/file.zip?signature=present'
    })).rejects.toThrow('SCANNER_DOWNLOAD_URL_REJECTED');
    await expect(scanRemotePackage({
      ...base,
      downloadUrl: 'https://storage.example.test/file.zip?x=1'
    })).rejects.toThrow('SCANNER_DOWNLOAD_URL_REJECTED');
    await expect(scanRemotePackage({
      ...base,
      expiresAtMs: TEST_NOW.getTime(),
      downloadUrl: 'https://storage.example.test/file.zip?signature=present'
    })).rejects.toThrow('SCANNER_DOWNLOAD_URL_REJECTED');
    await expect(scanRemotePackage({
      ...base,
      expiresAtMs: TEST_NOW.getTime() + 300_001,
      downloadUrl: 'https://storage.example.test/file.zip?signature=present'
    })).rejects.toThrow('SCANNER_DOWNLOAD_URL_REJECTED');
  });

  it('健康检查返回 200 且不触发扫描', async () => {
    const server = createScannerServer(await serverDependencies());
    const port = await listen(server);

    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ status: 'ok' });
    } finally {
      await close(server);
    }
  });

  it('非法 JSON 只返回稳定请求错误，不泄漏解析器消息', async () => {
    const server = createScannerServer(await serverDependencies());
    const port = await listen(server);
    const body = '{';

    try {
      const response = await fetch(`http://127.0.0.1:${port}/internal/scan`, {
        method: 'POST',
        headers: signedHeaders(body),
        body
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        code: 'SCANNER_REQUEST_INVALID'
      });
    } finally {
      await close(server);
    }
  });

  it('依赖故障只返回 503 稳定错误，不泄漏内部详情', async () => {
    const dependencies = await serverDependencies();
    const server = createScannerServer({
      ...dependencies,
      download: async () => {
        throw new Error('包含私有存储地址的内部错误');
      }
    });
    const port = await listen(server);
    const body = JSON.stringify({
      downloadUrl: 'https://storage.example.test/file.zip?signature=present',
      expiresAt: TEST_EXPIRES_AT
    });

    try {
      const response = await fetch(`http://127.0.0.1:${port}/internal/scan`, {
        method: 'POST',
        headers: signedHeaders(body),
        body
      });
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        code: 'SCANNER_UNAVAILABLE'
      });
    } finally {
      await close(server);
    }
  });

  it('同一实例只处理一个扫描请求', async () => {
    const dependencies = await serverDependencies();
    let releaseDownload!: () => void;
    const downloadStarted = new Promise<void>(resolve => {
      releaseDownload = resolve;
    });
    const server = createScannerServer({
      ...dependencies,
      download: async () => downloadStarted
    });
    const port = await listen(server);
    const firstBody = JSON.stringify({
      downloadUrl: 'https://storage.example.test/first.zip?signature=first',
      expiresAt: TEST_EXPIRES_AT
    });
    const secondBody = JSON.stringify({
      downloadUrl: 'https://storage.example.test/second.zip?signature=second',
      expiresAt: TEST_EXPIRES_AT
    });

    try {
      const firstRequest = fetch(`http://127.0.0.1:${port}/internal/scan`, {
        method: 'POST',
        headers: signedHeaders(firstBody),
        body: firstBody
      });
      await new Promise(resolve => setTimeout(resolve, 20));
      const secondResponse = await fetch(`http://127.0.0.1:${port}/internal/scan`, {
        method: 'POST',
        headers: signedHeaders(secondBody),
        body: secondBody
      });
      expect(secondResponse.status).toBe(503);
      await expect(secondResponse.json()).resolves.toEqual({
        code: 'SCANNER_BUSY'
      });
      releaseDownload();
      await firstRequest;
    } finally {
      releaseDownload();
      await close(server);
    }
  });

  it('整包超时返回稳定错误并释放单任务并发锁', async () => {
    const sourceArchive = await zipFixture(validPackageEntries());
    directories.push(dirname(sourceArchive));
    const dependencies = await serverDependencies();
    let shouldHang = true;
    const server = createScannerServer({
      ...dependencies,
      scanTimeoutMs: 20,
      download: async (_url, destination) => {
        await copyFile(sourceArchive, destination);
      },
      clamav: {
        scan: async ({ signal }: { signal?: AbortSignal }) => {
          if (!shouldHang) return { infected: false };
          shouldHang = false;
          return new Promise((_resolve, reject) => {
            signal?.addEventListener(
              'abort',
              () => reject(new Error('已取消')),
              { once: true }
            );
          });
        }
      }
    });
    const port = await listen(server);
    const firstBody = JSON.stringify({
      downloadUrl: 'https://storage.example.test/first.zip?signature=first',
      expiresAt: TEST_EXPIRES_AT
    });
    const secondBody = JSON.stringify({
      downloadUrl: 'https://storage.example.test/second.zip?signature=second',
      expiresAt: TEST_EXPIRES_AT
    });

    try {
      const firstResponse = await fetch(
        `http://127.0.0.1:${port}/internal/scan`,
        {
          method: 'POST',
          headers: signedHeaders(firstBody),
          body: firstBody
        }
      );
      expect(firstResponse.status).toBe(503);
      await expect(firstResponse.json()).resolves.toEqual({
        code: 'SCANNER_SCAN_TIMEOUT'
      });

      const secondResponse = await fetch(
        `http://127.0.0.1:${port}/internal/scan`,
        {
          method: 'POST',
          headers: signedHeaders(secondBody),
          body: secondBody
        }
      );
      expect(secondResponse.status).toBe(200);
      await expect(secondResponse.json()).resolves.toMatchObject({
        code: 'CHARACTER_PACKAGE_SCAN_PASSED'
      });
    } finally {
      await close(server);
    }
  });
});
