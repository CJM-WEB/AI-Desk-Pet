import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';

import type {
  PackageScanResult,
  PackageScanner,
  ScanPackageInput
} from '../ports.js';

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
type Now = () => Date;

const maxJsonTextBytes = 2 * 1024 * 1024;
const maxJsonTextsBytes = 8 * 1024 * 1024;
const maxImageSignalsBytes = 4 * 1024 * 1024;
const maxResponseBytes = 12 * 1024 * 1024;

const scanResponseSchema = z.object({
  code: z.literal('CHARACTER_PACKAGE_SCAN_PASSED'),
  summary: z.object({
    fileCount: z.number().int().min(1).max(500),
    totalUncompressedBytes: z.number().int().min(1).max(300 * 1024 * 1024),
    files: z.array(z.object({
      path: z.string().min(1).max(1024),
      kind: z.enum(['json', 'image']),
      uncompressedBytes: z.number().int().min(1).max(10 * 1024 * 1024),
      sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      mime: z.enum(['image/png', 'image/webp']).optional()
    }).strict()).max(500)
  }).strict(),
  jsonTexts: z.array(z.object({
    path: z.string().min(1).max(1024),
    text: z.string().max(maxJsonTextBytes).refine(
      text => Buffer.byteLength(text, 'utf8') <= maxJsonTextBytes
    )
  }).strict()).max(500),
  imageSignals: z.array(z.object({
    path: z.string().min(1).max(1024),
    provider: z.string().min(1).max(100),
    suggestion: z.enum(['pass', 'review', 'block']),
    labels: z.array(z.string().max(100)).max(50),
    ocrText: z.string().max(maxImageSignalsBytes).optional()
  }).strict()).max(500)
}).strict().superRefine((value, context) => {
  const jsonBytes = value.jsonTexts.reduce(
    (total, item) => total + Buffer.byteLength(item.text, 'utf8'),
    0
  );
  const imageBytes = Buffer.byteLength(
    JSON.stringify(value.imageSignals),
    'utf8'
  );
  if (jsonBytes > maxJsonTextsBytes) {
    context.addIssue({ code: 'custom', message: 'JSON 审核文本总量超限' });
  }
  if (imageBytes > maxImageSignalsBytes) {
    context.addIssue({ code: 'custom', message: '图片审核信号总量超限' });
  }
});

const errorSchema = z.object({
  code: z.string().min(1).max(200)
}).strict();

/** 调用 Task 7 隔离扫描服务，并严格验证其结构化边界。 */
export class ScannerClient implements PackageScanner {
  constructor(
    private readonly scannerUrl: string,
    private readonly secret: string,
    private readonly fetcher: FetchLike = fetch,
    private readonly now: Now = () => new Date()
  ) {}

  async scan(input: ScanPackageInput): Promise<PackageScanResult> {
    const expiresAt = new Date(input.expiresAt);
    if (
      !Number.isFinite(expiresAt.getTime())
      || expiresAt.getTime() <= this.now().getTime()
      || expiresAt.getTime() - this.now().getTime() > 5 * 60 * 1000
    ) {
      throw new Error('SCANNER_SIGNED_URL_INVALID');
    }
    const body = JSON.stringify({
      downloadUrl: input.downloadUrl,
      expiresAt: expiresAt.getTime()
    });
    const timestamp = String(this.now().getTime());
    const digest = createHash('sha256').update(body).digest('hex');
    const signature = createHmac('sha256', this.secret)
      .update(`${timestamp}\n${digest}`)
      .digest('hex');

    let response: Response;
    try {
      response = await this.fetcher(
        `${this.scannerUrl.replace(/\/+$/u, '')}/internal/scan`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-internal-timestamp': timestamp,
            'x-internal-signature': signature
          },
          body,
          signal: AbortSignal.timeout(130_000)
        }
      );
    } catch {
      throw new Error('SCANNER_UNAVAILABLE');
    }

    const payload = await readJson(response);
    if (response.status === 422) {
      const rejected = errorSchema.safeParse(payload);
      if (
        rejected.success
        && rejected.data.code.startsWith('CHARACTER_PACKAGE_')
      ) {
        return {
          complete: true,
          safe: false,
          code: rejected.data.code,
          summary: { fileCount: 0, totalUncompressedBytes: 0 },
          jsonTexts: [],
          imageSignals: []
        };
      }
      throw new Error('SCANNER_RESPONSE_INVALID');
    }
    if (!response.ok) throw new Error('SCANNER_UNAVAILABLE');

    const parsed = scanResponseSchema.safeParse(payload);
    if (!parsed.success) throw new Error('SCANNER_RESPONSE_INVALID');
    return {
      complete: true,
      safe: true,
      code: parsed.data.code,
      summary: {
        fileCount: parsed.data.summary.fileCount,
        totalUncompressedBytes: parsed.data.summary.totalUncompressedBytes
      },
      jsonTexts: parsed.data.jsonTexts,
      imageSignals: parsed.data.imageSignals.map(signal => ({
        path: signal.path,
        suggestion: signal.suggestion === 'pass'
          ? 'Pass'
          : signal.suggestion === 'block'
            ? 'Block'
            : 'Review',
        labels: signal.labels,
        ...(signal.ocrText ? { ocrText: signal.ocrText } : {})
      }))
    };
  }
}

async function readJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('SCANNER_RESPONSE_INVALID');
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      totalBytes += item.value.byteLength;
      if (totalBytes > maxResponseBytes) {
        await reader.cancel();
        throw new Error('SCANNER_RESPONSE_INVALID');
      }
      chunks.push(item.value);
    }
    const text = Buffer.concat(
      chunks.map(chunk => Buffer.from(
        chunk.buffer,
        chunk.byteOffset,
        chunk.byteLength
      )),
      totalBytes
    ).toString('utf8');
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('SCANNER_RESPONSE_INVALID');
  } finally {
    reader.releaseLock();
  }
}
