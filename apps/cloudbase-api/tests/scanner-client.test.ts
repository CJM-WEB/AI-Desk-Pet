import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  SCANNER_PROTOCOL_VERSION,
  SCANNER_RULE_VERSION
} from '@myself/shared-types/scanner-protocol';

import { ScannerClient } from '../src/adapters/scanner-client.js';

const submissionId = '3d594650-3436-4ad0-a9a8-80ca4388824b';
const completedAt = '2026-07-31T00:00:01.000Z';

function cleanResponse(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: SCANNER_PROTOCOL_VERSION,
    ruleVersion: SCANNER_RULE_VERSION,
    submissionId,
    code: 'CHARACTER_PACKAGE_SCAN_PASSED',
    completedAt,
    archive: { sizeBytes: 128, sha256: 'a'.repeat(64) },
    summary: {
      fileCount: 1,
      totalUncompressedBytes: 10,
      files: [{
        path: 'manifest.json',
        kind: 'json',
        uncompressedBytes: 10,
        sha256: 'b'.repeat(64)
      }]
    },
    jsonTexts: [{ path: 'manifest.json', text: 'AI Pet' }],
    imageSignals: [],
    ...overrides
  };
}

describe('隔离扫描客户端', () => {
  it('按 Task 7 契约签名并解析稳定响应', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(
      cleanResponse()
    ), { status: 200 }));
    const client = new ScannerClient(
      'https://scanner.example.com',
      'scanner-secret',
      fetcher,
      () => new Date('2026-07-31T00:00:00.000Z')
    );

    await expect(client.scan({
      submissionId,
      downloadUrl: 'https://storage.example.com/pet.zip?sig=1',
      expiresAt: '2026-07-31T00:05:00.000Z'
    })).resolves.toEqual(expect.objectContaining({
      complete: true,
      safe: true,
      code: 'CHARACTER_PACKAGE_SCAN_PASSED',
      protocolVersion: SCANNER_PROTOCOL_VERSION,
      ruleVersion: SCANNER_RULE_VERSION,
      submissionId,
      completedAt,
      archive: { sizeBytes: 128, sha256: 'a'.repeat(64) }
    }));

    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    const body = String(init.body);
    const timestamp = String(Date.parse('2026-07-31T00:00:00.000Z'));
    const digest = createHash('sha256').update(body).digest('hex');
    expect(url).toBe('https://scanner.example.com/internal/scan');
    expect(init.headers).toMatchObject({
      'x-internal-timestamp': timestamp,
      'x-internal-signature': createHmac('sha256', 'scanner-secret')
        .update(`${SCANNER_PROTOCOL_VERSION}\n${timestamp}\n${digest}`)
        .digest('hex')
    });
    expect(JSON.parse(body)).toEqual({
      protocolVersion: SCANNER_PROTOCOL_VERSION,
      submissionId,
      downloadUrl: 'https://storage.example.com/pet.zip?sig=1',
      expiresAt: '2026-07-31T00:05:00.000Z'
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('技术拒绝响应转为不安全结论而依赖故障继续抛错', async () => {
    const rejected = new ScannerClient(
      'https://scanner.example.com',
      'secret',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({
        protocolVersion: SCANNER_PROTOCOL_VERSION,
        code: 'invalid',
        detailCode: 'CHARACTER_PACKAGE_PATH_REJECTED'
      }), { status: 422 })),
      () => new Date('2026-07-31T00:00:00.000Z')
    );
    await expect(rejected.scan({
      submissionId,
      downloadUrl: 'https://storage.example.com/pet.zip?sig=1',
      expiresAt: '2026-07-31T00:05:00.000Z'
    })).resolves.toEqual(expect.objectContaining({
      complete: true,
      safe: false,
      code: 'CHARACTER_PACKAGE_PATH_REJECTED'
    }));

    const dangerous = new ScannerClient(
      'https://scanner.example.com',
      'secret',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({
        protocolVersion: SCANNER_PROTOCOL_VERSION,
        code: 'dangerous',
        detailCode: 'CHARACTER_PACKAGE_MALWARE_DETECTED'
      }), { status: 422 })),
      () => new Date('2026-07-31T00:00:00.000Z')
    );
    await expect(dangerous.scan({
      submissionId,
      downloadUrl: 'https://storage.example.com/pet.zip?sig=1',
      expiresAt: '2026-07-31T00:05:00.000Z'
    })).resolves.toEqual(expect.objectContaining({
      complete: true,
      safe: false,
      code: 'CHARACTER_PACKAGE_MALWARE_DETECTED'
    }));

    const unavailable = new ScannerClient(
      'https://scanner.example.com',
      'secret',
      vi.fn().mockResolvedValue(new Response('{}', { status: 503 })),
      () => new Date('2026-07-31T00:00:00.000Z')
    );
    await expect(unavailable.scan({
      submissionId,
      downloadUrl: 'https://storage.example.com/pet.zip?sig=1',
      expiresAt: '2026-07-31T00:05:00.000Z'
    })).rejects.toThrow('SCANNER_UNAVAILABLE');
  });

  it('拒绝结构不稳定或超出边界的成功响应', async () => {
    const client = new ScannerClient(
      'https://scanner.example.com',
      'secret',
      vi.fn().mockResolvedValue(new Response(JSON.stringify(cleanResponse({
        jsonTexts: [{
          path: 'manifest.json',
          text: '你'.repeat(700_000)
        }],
        imageSignals: []
      })), { status: 200 })),
      () => new Date('2026-07-31T00:00:00.000Z')
    );
    await expect(client.scan({
      submissionId,
      downloadUrl: 'https://storage.example.com/pet.zip?sig=1',
      expiresAt: '2026-07-31T00:05:00.000Z'
    })).rejects.toThrow('SCANNER_RESPONSE_INVALID');
  });

  it('拒绝属于其他投稿的结构化成功响应', async () => {
    const client = new ScannerClient(
      'https://scanner.example.com',
      'secret',
      vi.fn().mockResolvedValue(new Response(JSON.stringify(cleanResponse({
        submissionId: '11111111-1111-4111-8111-111111111111'
      })), { status: 200 })),
      () => new Date('2026-07-31T00:00:00.000Z')
    );

    await expect(client.scan({
      submissionId,
      downloadUrl: 'https://storage.example.com/pet.zip?sig=1',
      expiresAt: '2026-07-31T00:05:00.000Z'
    })).rejects.toThrow('SCANNER_RESPONSE_INVALID');
  });

  it('流式响应超过 12 MiB 时立即取消读取', async () => {
    let cancelled = false;
    const chunk = new Uint8Array(7 * 1024 * 1024);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      }
    });
    const client = new ScannerClient(
      'https://scanner.example.com',
      'secret',
      vi.fn().mockResolvedValue(new Response(body, { status: 200 })),
      () => new Date('2026-07-31T00:00:00.000Z')
    );

    await expect(client.scan({
      submissionId,
      downloadUrl: 'https://storage.example.com/pet.zip?sig=1',
      expiresAt: '2026-07-31T00:05:00.000Z'
    })).rejects.toThrow('SCANNER_RESPONSE_INVALID');
    expect(cancelled).toBe(true);
  });
});
