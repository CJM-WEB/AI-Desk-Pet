import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  SCANNER_PROTOCOL_VERSION,
  SCANNER_RULE_VERSION,
  SCANNER_MAX_RESPONSE_BYTES,
  createScannerSignature,
  scannerErrorResponseSchema,
  scannerRequestSchema,
  scannerSuccessResponseSchema
} from '../src/scanner-protocol';

const submissionId = '3d594650-3436-4ad0-a9a8-80ca4388824b';
const archiveSha256 = 'a'.repeat(64);

function successResponse() {
  return {
    protocolVersion: SCANNER_PROTOCOL_VERSION,
    ruleVersion: SCANNER_RULE_VERSION,
    submissionId,
    code: 'CHARACTER_PACKAGE_SCAN_PASSED' as const,
    completedAt: '2026-08-15T02:00:01.000Z',
    archive: { sizeBytes: 128, sha256: archiveSha256 },
    summary: {
      fileCount: 1,
      totalUncompressedBytes: 64,
      files: [{
        path: 'compiled/manifest.json',
        kind: 'json' as const,
        uncompressedBytes: 64,
        sha256: 'b'.repeat(64)
      }]
    },
    jsonTexts: [{ path: 'compiled/manifest.json', text: '{"version":1}' }],
    imageSignals: [{
      path: 'compiled/idle.png',
      provider: 'tencent-ims',
      suggestion: 'pass' as const,
      labels: ['normal']
    }]
  };
}

describe('ScannerProtocol', () => {
  it('只接受带固定版本、投稿身份和短期地址的严格请求', () => {
    const request = {
      protocolVersion: SCANNER_PROTOCOL_VERSION,
      submissionId,
      downloadUrl: 'https://storage.example.test/package.zip?signature=short-lived',
      expiresAt: '2026-08-15T10:00:00+08:00'
    };

    expect(scannerRequestSchema.parse(request)).toEqual(request);
    expect(scannerRequestSchema.safeParse({
      ...request,
      protocolVersion: '2026-08-14'
    }).success).toBe(false);
    expect(scannerRequestSchema.safeParse({
      ...request,
      unexpected: true
    }).success).toBe(false);
  });

  it('成功响应绑定投稿、规则、完整归档身份并保留审核输入', () => {
    const response = successResponse();

    expect(scannerSuccessResponseSchema.parse(response)).toEqual(response);
    expect(scannerSuccessResponseSchema.safeParse({
      ...response,
      archive: { ...response.archive, sha256: 'not-a-digest' }
    }).success).toBe(false);
  });

  it.each([
    ['文件数量', { fileCount: 2 }],
    ['解压总量', { totalUncompressedBytes: 63 }]
  ])('拒绝与 files 矛盾的%s摘要', (_name, summaryOverride) => {
    const response = successResponse();
    expect(scannerSuccessResponseSchema.safeParse({
      ...response,
      summary: { ...response.summary, ...summaryOverride }
    }).success).toBe(false);
  });

  it('整体 JSON 响应只接受至多 12 MiB', () => {
    const response = successResponse();
    const jsonTexts = Array.from({ length: 4 }, (_, index) => ({
      path: `review-${index}.json`,
      text: 'x'.repeat(2 * 1024 * 1024)
    }));
    const withEmptyOcr = {
      ...response,
      jsonTexts,
      imageSignals: [{ ...response.imageSignals[0], ocrText: '' }]
    };
    const paddingBytes = SCANNER_MAX_RESPONSE_BYTES
      - Buffer.byteLength(JSON.stringify(withEmptyOcr), 'utf8');
    const atLimit = {
      ...withEmptyOcr,
      imageSignals: [{
        ...withEmptyOcr.imageSignals[0],
        ocrText: 'y'.repeat(paddingBytes)
      }]
    };
    expect(Buffer.byteLength(JSON.stringify(atLimit), 'utf8'))
      .toBe(SCANNER_MAX_RESPONSE_BYTES);
    expect(scannerSuccessResponseSchema.safeParse(atLimit).success).toBe(true);
    expect(scannerSuccessResponseSchema.safeParse({
      ...atLimit,
      imageSignals: [{
        ...atLimit.imageSignals[0],
        ocrText: `${atLimit.imageSignals[0]?.ocrText}y`
      }]
    }).success).toBe(false);
  });

  it('失败响应只接受共享分类和受限技术码', () => {
    expect(scannerErrorResponseSchema.parse({
      protocolVersion: SCANNER_PROTOCOL_VERSION,
      code: 'invalid',
      detailCode: 'CHARACTER_PACKAGE_PATH_REJECTED'
    })).toEqual({
      protocolVersion: SCANNER_PROTOCOL_VERSION,
      code: 'invalid',
      detailCode: 'CHARACTER_PACKAGE_PATH_REJECTED'
    });
    expect(scannerErrorResponseSchema.safeParse({
      protocolVersion: SCANNER_PROTOCOL_VERSION,
      code: 'invalid',
      detailCode: '内部路径 C:\\private\\package.zip'
    }).success).toBe(false);
  });

  it.each([
    ['dangerous', 'CHARACTER_PACKAGE_PATH_REJECTED'],
    ['invalid', 'CHARACTER_PACKAGE_MALWARE_DETECTED'],
    ['timeout', 'SCANNER_BUSY'],
    ['busy', 'SCANNER_SCAN_TIMEOUT'],
    ['unauthorized', 'SCANNER_NOT_FOUND'],
    ['not_found', 'SCANNER_UNAUTHORIZED'],
    ['scanner_error', 'SCANNER_REQUEST_INVALID']
  ])('拒绝 %s 与 %s 错配', (code, detailCode) => {
    expect(scannerErrorResponseSchema.safeParse({
      protocolVersion: SCANNER_PROTOCOL_VERSION,
      code,
      detailCode
    }).success).toBe(false);
  });

  it('canonical 签名包含协议版本、时间戳和请求体摘要', () => {
    const body = Buffer.from('{"hello":"world"}', 'utf8');
    const timestamp = '1723694400000';
    const digest = createHash('sha256').update(body).digest('hex');
    const expected = createHmac('sha256', 'contract-secret')
      .update(`${SCANNER_PROTOCOL_VERSION}\n${timestamp}\n${digest}`)
      .digest('hex');

    expect(createScannerSignature(
      SCANNER_PROTOCOL_VERSION,
      timestamp,
      body,
      'contract-secret'
    )).toBe(expected);
  });
});
