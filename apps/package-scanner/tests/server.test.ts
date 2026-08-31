import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SCANNER_PROTOCOL_VERSION,
  SCANNER_RULE_VERSION,
  createScannerSignature
} from '@myself/shared-types/scanner-protocol';
import {
  createScannerServer,
  scanRemotePackage
} from '../src/server';
import { validPackageEntries, zipFixture } from './zip-fixture';

const directories: string[] = [];
const TEST_NOW = new Date('2026-07-31T00:00:00.000Z');
const TEST_EXPIRES_AT = TEST_NOW.getTime() + 300_000;
const TEST_SECRET = 'scanner-test-secret';
const TEST_SUBMISSION_ID = '3d594650-3436-4ad0-a9a8-80ca4388824b';
const TEST_ARCHIVE_IDENTITY = {
  sizeBytes: 1,
  sha256: 'a'.repeat(64)
};

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

function signedHeaders(body: string): Record<string, string> {
  const timestamp = String(TEST_NOW.getTime());
  return {
    'content-type': 'application/json',
    'x-internal-timestamp': timestamp,
    'x-internal-signature': createScannerSignature(
      SCANNER_PROTOCOL_VERSION,
      timestamp,
      Buffer.from(body),
      TEST_SECRET
    )
  };
}

async function copyArchive(source: string, destination: string) {
  await copyFile(source, destination);
  const bytes = await readFile(source);
  return {
    sizeBytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex')
  };
}

function scanRequest(downloadUrl: string): string {
  return JSON.stringify({
    protocolVersion: SCANNER_PROTOCOL_VERSION,
    submissionId: TEST_SUBMISSION_ID,
    downloadUrl,
    expiresAt: new Date(TEST_EXPIRES_AT).toISOString()
  });
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
      download: async (_url, destination) => copyArchive(sourceArchive, destination),
      scan: async ({ archivePath }) => {
        expect(archivePath.startsWith(`${workRoot}\\`)).toBe(true);
        if (shouldFail) throw new Error('SCANNER_TEST_FAILURE');
        return {
          code: 'CHARACTER_PACKAGE_SCAN_PASSED' as const,
          archive: { sizeBytes: 1, sha256: 'a'.repeat(64) },
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

  it('下载阶段生成的完整 ZIP 身份原样交给扫描器且不二次读取归档', async () => {
    const workRoot = await temporaryDirectory('scanner-work-');
    const archive = {
      sizeBytes: 321,
      sha256: 'b'.repeat(64)
    };

    await scanRemotePackage({
      downloadUrl: 'https://storage.example.test/private.zip?signature=short-lived',
      expiresAtMs: TEST_EXPIRES_AT,
      now: TEST_NOW,
      workRoot,
      allowedDownloadHosts: new Set(['storage.example.test']),
      requiredDownloadQueryParameters: new Set(['signature']),
      download: (async () => archive) as never,
      scan: async input => {
        expect(input).toMatchObject({ archive });
        return {
          code: 'CHARACTER_PACKAGE_SCAN_PASSED',
          archive,
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
  });

  it('拒绝非 HTTPS、非允许主机和没有短期签名参数的下载地址', async () => {
    const workRoot = await temporaryDirectory('scanner-work-');
    const base = {
      workRoot,
      expiresAtMs: TEST_EXPIRES_AT,
      now: TEST_NOW,
      allowedDownloadHosts: new Set(['storage.example.test']),
      requiredDownloadQueryParameters: new Set(['signature']),
      download: async () => TEST_ARCHIVE_IDENTITY,
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
        protocolVersion: SCANNER_PROTOCOL_VERSION,
        code: 'invalid',
        detailCode: 'SCANNER_REQUEST_INVALID'
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
    const body = scanRequest(
      'https://storage.example.test/file.zip?signature=present'
    );

    try {
      const response = await fetch(`http://127.0.0.1:${port}/internal/scan`, {
        method: 'POST',
        headers: signedHeaders(body),
        body
      });
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        protocolVersion: SCANNER_PROTOCOL_VERSION,
        code: 'scanner_error',
        detailCode: 'SCANNER_UNAVAILABLE'
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
      download: async () => {
        await downloadStarted;
        return TEST_ARCHIVE_IDENTITY;
      }
    });
    const port = await listen(server);
    const firstBody = scanRequest(
      'https://storage.example.test/first.zip?signature=first'
    );
    const secondBody = scanRequest(
      'https://storage.example.test/second.zip?signature=second'
    );

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
        protocolVersion: SCANNER_PROTOCOL_VERSION,
        code: 'busy',
        detailCode: 'SCANNER_BUSY'
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
      // 留出正常扫描窗口，首个挂起扫描仍由整包超时中止。
      scanTimeoutMs: 250,
      download: async (_url, destination) => copyArchive(sourceArchive, destination),
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
    const firstBody = scanRequest(
      'https://storage.example.test/first.zip?signature=first'
    );
    const secondBody = scanRequest(
      'https://storage.example.test/second.zip?signature=second'
    );

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
        protocolVersion: SCANNER_PROTOCOL_VERSION,
        code: 'timeout',
        detailCode: 'SCANNER_SCAN_TIMEOUT'
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
        protocolVersion: SCANNER_PROTOCOL_VERSION,
        ruleVersion: SCANNER_RULE_VERSION,
        submissionId: TEST_SUBMISSION_ID,
        code: 'CHARACTER_PACKAGE_SCAN_PASSED',
        archive: {
          sizeBytes: expect.any(Number),
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
        }
      });
    } finally {
      await close(server);
    }
  });

  it.each([
    ['错误协议版本', 'protocol', 400, 'invalid'],
    ['错误 HMAC', 'signature', 401, 'unauthorized']
  ] as const)('%s 被真实临时 server 拒绝', async (
    _name,
    failure,
    expectedStatus,
    expectedCode
  ) => {
    const server = createScannerServer(await serverDependencies());
    const port = await listen(server);
    const validBody = scanRequest(
      'https://storage.example.test/file.zip?signature=present'
    );
    const body = failure === 'protocol'
      ? JSON.stringify({
          ...JSON.parse(validBody),
          protocolVersion: '2026-08-14'
        })
      : validBody;
    const headers = signedHeaders(body);
    if (failure === 'signature') {
      headers['x-internal-signature'] = '0'.repeat(64);
    }

    try {
      const response = await fetch(`http://127.0.0.1:${port}/internal/scan`, {
        method: 'POST',
        headers,
        body
      });
      expect(response.status).toBe(expectedStatus);
      await expect(response.json()).resolves.toMatchObject({
        protocolVersion: SCANNER_PROTOCOL_VERSION,
        code: expectedCode
      });
    } finally {
      await close(server);
    }
  });

  it.each([
    {
      name: '恶意软件',
      entries: validPackageEntries(),
      infected: true,
      code: 'dangerous',
      detailCode: 'CHARACTER_PACKAGE_MALWARE_DETECTED'
    },
    {
      name: '越界路径',
      entries: [{ path: '../evil.json' }],
      infected: false,
      code: 'invalid',
      detailCode: 'CHARACTER_PACKAGE_PATH_REJECTED'
    }
  ] as const)('真实临时 server 将$name归入 $code', async testCase => {
    const sourceArchive = await zipFixture(testCase.entries);
    directories.push(dirname(sourceArchive));
    const dependencies = await serverDependencies();
    const server = createScannerServer({
      ...dependencies,
      download: async (_url, destination) => copyArchive(sourceArchive, destination),
      clamav: {
        scan: async () => ({ infected: testCase.infected })
      }
    });
    const port = await listen(server);
    const body = scanRequest(
      'https://storage.example.test/file.zip?signature=present'
    );

    try {
      const response = await fetch(`http://127.0.0.1:${port}/internal/scan`, {
        method: 'POST',
        headers: signedHeaders(body),
        body
      });
      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toEqual({
        protocolVersion: SCANNER_PROTOCOL_VERSION,
        code: testCase.code,
        detailCode: testCase.detailCode
      });
    } finally {
      await close(server);
    }
  });
});
