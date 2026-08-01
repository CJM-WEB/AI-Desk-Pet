import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { ScannerClient } from '../src/adapters/scanner-client.js';

describe('隔离扫描客户端', () => {
  it('按 Task 7 契约签名并解析稳定响应', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 'CHARACTER_PACKAGE_SCAN_PASSED',
      summary: {
        fileCount: 1,
        totalUncompressedBytes: 10,
        files: []
      },
      jsonTexts: [{ path: 'manifest.json', text: 'AI Pet' }],
      imageSignals: []
    }), { status: 200 }));
    const client = new ScannerClient(
      'https://scanner.example.com',
      'scanner-secret',
      fetcher,
      () => new Date('2026-07-31T00:00:00.000Z')
    );

    await expect(client.scan({
      submissionId: 'submission-1',
      downloadUrl: 'https://storage.example.com/pet.zip?sig=1',
      expiresAt: '2026-07-31T00:05:00.000Z'
    })).resolves.toEqual(expect.objectContaining({
      complete: true,
      safe: true,
      code: 'CHARACTER_PACKAGE_SCAN_PASSED'
    }));

    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    const body = String(init.body);
    const timestamp = String(Date.parse('2026-07-31T00:00:00.000Z'));
    const digest = createHash('sha256').update(body).digest('hex');
    expect(url).toBe('https://scanner.example.com/internal/scan');
    expect(init.headers).toMatchObject({
      'x-internal-timestamp': timestamp,
      'x-internal-signature': createHmac('sha256', 'scanner-secret')
        .update(`${timestamp}\n${digest}`)
        .digest('hex')
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('技术拒绝响应转为不安全结论而依赖故障继续抛错', async () => {
    const rejected = new ScannerClient(
      'https://scanner.example.com',
      'secret',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({
        code: 'CHARACTER_PACKAGE_PATH_REJECTED'
      }), { status: 422 })),
      () => new Date('2026-07-31T00:00:00.000Z')
    );
    await expect(rejected.scan({
      submissionId: 'submission-1',
      downloadUrl: 'https://storage.example.com/pet.zip?sig=1',
      expiresAt: '2026-07-31T00:05:00.000Z'
    })).resolves.toEqual(expect.objectContaining({
      complete: true,
      safe: false,
      code: 'CHARACTER_PACKAGE_PATH_REJECTED'
    }));

    const unavailable = new ScannerClient(
      'https://scanner.example.com',
      'secret',
      vi.fn().mockResolvedValue(new Response('{}', { status: 503 })),
      () => new Date('2026-07-31T00:00:00.000Z')
    );
    await expect(unavailable.scan({
      submissionId: 'submission-1',
      downloadUrl: 'https://storage.example.com/pet.zip?sig=1',
      expiresAt: '2026-07-31T00:05:00.000Z'
    })).rejects.toThrow('SCANNER_UNAVAILABLE');
  });

  it('拒绝结构不稳定或超出边界的成功响应', async () => {
    const client = new ScannerClient(
      'https://scanner.example.com',
      'secret',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({
        code: 'CHARACTER_PACKAGE_SCAN_PASSED',
        summary: { fileCount: 1, totalUncompressedBytes: 10, files: [] },
        jsonTexts: [{
          path: 'manifest.json',
          text: '你'.repeat(700_000)
        }],
        imageSignals: []
      }), { status: 200 })),
      () => new Date('2026-07-31T00:00:00.000Z')
    );
    await expect(client.scan({
      submissionId: 'submission-1',
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
      submissionId: 'submission-1',
      downloadUrl: 'https://storage.example.com/pet.zip?sig=1',
      expiresAt: '2026-07-31T00:05:00.000Z'
    })).rejects.toThrow('SCANNER_RESPONSE_INVALID');
    expect(cancelled).toBe(true);
  });
});
