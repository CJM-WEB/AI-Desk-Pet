import {
  SCANNER_MAX_RESPONSE_BYTES,
  SCANNER_PROTOCOL_VERSION,
  SCANNER_REQUEST_TIMEOUT_MS,
  createScannerSignature,
  scannerErrorResponseSchema,
  scannerRequestSchema,
  scannerSuccessResponseSchema
} from '@myself/shared-types/scanner-protocol';

import type {
  PackageScanResult,
  PackageScanner,
  ScanPackageInput
} from '../ports.js';
import { readBoundedJsonResponse } from './bounded-json-response.js';

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
type Now = () => Date;

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
    const body = JSON.stringify(scannerRequestSchema.parse({
      protocolVersion: SCANNER_PROTOCOL_VERSION,
      submissionId: input.submissionId,
      downloadUrl: input.downloadUrl,
      expiresAt: input.expiresAt
    }));
    const timestamp = String(this.now().getTime());
    const signature = createScannerSignature(
      SCANNER_PROTOCOL_VERSION,
      timestamp,
      Buffer.from(body),
      this.secret
    );

    const signal = AbortSignal.timeout(SCANNER_REQUEST_TIMEOUT_MS);
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
          signal
        }
      );
    } catch {
      throw new Error('SCANNER_UNAVAILABLE');
    }

    let payload: unknown;
    try {
      payload = await readBoundedJsonResponse(response, {
        maxBytes: SCANNER_MAX_RESPONSE_BYTES,
        signal
      });
    } catch {
      throw new Error('SCANNER_RESPONSE_INVALID');
    }
    if (response.status === 422) {
      const rejected = scannerErrorResponseSchema.safeParse(payload);
      if (
        rejected.success
        && ['invalid', 'dangerous'].includes(rejected.data.code)
        && rejected.data.detailCode?.startsWith('CHARACTER_PACKAGE_')
      ) {
        return {
          complete: true,
          safe: false,
          code: rejected.data.detailCode,
          summary: { fileCount: 0, totalUncompressedBytes: 0 },
          jsonTexts: [],
          imageSignals: []
        };
      }
      throw new Error('SCANNER_RESPONSE_INVALID');
    }
    if (!response.ok) throw new Error('SCANNER_UNAVAILABLE');

    const parsed = scannerSuccessResponseSchema.safeParse(payload);
    if (
      !parsed.success
      || parsed.data.submissionId !== input.submissionId
    ) {
      throw new Error('SCANNER_RESPONSE_INVALID');
    }
    return {
      complete: true,
      safe: true,
      code: parsed.data.code,
      protocolVersion: parsed.data.protocolVersion,
      ruleVersion: parsed.data.ruleVersion,
      submissionId: parsed.data.submissionId,
      completedAt: parsed.data.completedAt,
      archive: parsed.data.archive,
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
