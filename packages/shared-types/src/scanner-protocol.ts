import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';

export const SCANNER_PROTOCOL_VERSION = '2026-08-15' as const;
export const SCANNER_RULE_VERSION = 'character-package-2026-08-15' as const;
export const SCANNER_MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
export const SCANNER_REQUEST_TIMEOUT_MS = 130_000;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const pathSchema = z.string().min(1).max(1024);
const maxJsonTextBytes = 2 * 1024 * 1024;
const maxJsonTextsBytes = 8 * 1024 * 1024;
const maxImageSignalsBytes = 4 * 1024 * 1024;

export const scannerRequestSchema = z.object({
  protocolVersion: z.literal(SCANNER_PROTOCOL_VERSION),
  submissionId: z.string().uuid(),
  downloadUrl: z.string().url(),
  expiresAt: z.string().datetime({ offset: true })
}).strict();

const scannerFileSchema = z.discriminatedUnion('kind', [
  z.object({
    path: pathSchema,
    kind: z.literal('json'),
    uncompressedBytes: z.number().int().min(1).max(10 * 1024 * 1024),
    sha256: sha256Schema
  }).strict(),
  z.object({
    path: pathSchema,
    kind: z.literal('image'),
    mime: z.enum(['image/png', 'image/webp']),
    uncompressedBytes: z.number().int().min(1).max(10 * 1024 * 1024),
    sha256: sha256Schema
  }).strict()
]);

export const scannerSuccessResponseSchema = z.object({
  protocolVersion: z.literal(SCANNER_PROTOCOL_VERSION),
  ruleVersion: z.literal(SCANNER_RULE_VERSION),
  submissionId: z.string().uuid(),
  code: z.literal('CHARACTER_PACKAGE_SCAN_PASSED'),
  completedAt: z.string().datetime({ offset: true }),
  archive: z.object({
    sizeBytes: z.number().int().positive().max(100 * 1024 * 1024),
    sha256: sha256Schema
  }).strict(),
  summary: z.object({
    fileCount: z.number().int().min(1).max(500),
    totalUncompressedBytes: z.number().int().min(1).max(300 * 1024 * 1024),
    files: z.array(scannerFileSchema).max(500)
  }).strict(),
  jsonTexts: z.array(z.object({
    path: pathSchema,
    text: z.string().max(maxJsonTextBytes).refine(
      text => Buffer.byteLength(text, 'utf8') <= maxJsonTextBytes
    )
  }).strict()).max(500),
  imageSignals: z.array(z.object({
    path: pathSchema,
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
  const imageBytes = Buffer.byteLength(JSON.stringify(value.imageSignals), 'utf8');
  const summarizedBytes = value.summary.files.reduce(
    (total, file) => total + file.uncompressedBytes,
    0
  );
  if (value.summary.fileCount !== value.summary.files.length) {
    context.addIssue({ code: 'custom', message: '文件数量摘要不一致' });
  }
  if (value.summary.totalUncompressedBytes !== summarizedBytes) {
    context.addIssue({ code: 'custom', message: '解压总量摘要不一致' });
  }
  if (jsonBytes > maxJsonTextsBytes) {
    context.addIssue({ code: 'custom', message: 'JSON 审核文本总量超限' });
  }
  if (imageBytes > maxImageSignalsBytes) {
    context.addIssue({ code: 'custom', message: '图片审核信号总量超限' });
  }
  if (
    Buffer.byteLength(JSON.stringify(value), 'utf8')
    > SCANNER_MAX_RESPONSE_BYTES
  ) {
    context.addIssue({ code: 'custom', message: '扫描响应总量超限' });
  }
});

const scannerInvalidDetailCodeSchema = z.enum([
  'CHARACTER_PACKAGE_ARCHIVE_SIZE_REJECTED',
  'CHARACTER_PACKAGE_DUPLICATE_ENTRY',
  'CHARACTER_PACKAGE_ENCRYPTED_REJECTED',
  'CHARACTER_PACKAGE_ENTRY_COUNT_EXCEEDED',
  'CHARACTER_PACKAGE_ENTRY_INVALID',
  'CHARACTER_PACKAGE_ENTRY_SIZE_MISMATCH',
  'CHARACTER_PACKAGE_EXPANSION_LIMIT',
  'CHARACTER_PACKAGE_FILE_COUNT_EXCEEDED',
  'CHARACTER_PACKAGE_FILE_TYPE_REJECTED',
  'CHARACTER_PACKAGE_ID_MISMATCH',
  'CHARACTER_PACKAGE_IMAGE_INVALID',
  'CHARACTER_PACKAGE_JSON_INVALID',
  'CHARACTER_PACKAGE_JSON_REVIEW_BYTES_EXCEEDED',
  'CHARACTER_PACKAGE_JSON_TOO_LARGE',
  'CHARACTER_PACKAGE_LINK_REJECTED',
  'CHARACTER_PACKAGE_MANIFEST_INVALID',
  'CHARACTER_PACKAGE_MULTIDISK_REJECTED',
  'CHARACTER_PACKAGE_PATH_REJECTED',
  'CHARACTER_PACKAGE_PATH_PREFIX_CONFLICT',
  'CHARACTER_PACKAGE_RESOURCE_INVALID',
  'CHARACTER_PACKAGE_RESOURCE_TOO_LARGE',
  'CHARACTER_PACKAGE_SCAN_RESPONSE_TOO_LARGE',
  'CHARACTER_PACKAGE_SIGNATURE_MISMATCH',
  'CHARACTER_PACKAGE_STRUCTURE_INVALID',
  'CHARACTER_PACKAGE_TOTAL_BYTES_EXCEEDED',
  'CHARACTER_PACKAGE_ZIP_INVALID',
  'SCANNER_DOWNLOAD_URL_REJECTED',
  'SCANNER_REQUEST_INVALID',
  'SCANNER_REQUEST_TOO_LARGE'
]);

const protocolError = <Code extends string, Detail extends z.ZodTypeAny>(
  code: Code,
  detailCode: Detail
) => z.object({
  protocolVersion: z.literal(SCANNER_PROTOCOL_VERSION),
  code: z.literal(code),
  detailCode
}).strict();

export const scannerErrorResponseSchema = z.discriminatedUnion('code', [
  protocolError('invalid', scannerInvalidDetailCodeSchema),
  protocolError('dangerous', z.literal('CHARACTER_PACKAGE_MALWARE_DETECTED')),
  protocolError('timeout', z.literal('SCANNER_SCAN_TIMEOUT')),
  protocolError('busy', z.literal('SCANNER_BUSY')),
  protocolError('unauthorized', z.literal('SCANNER_UNAUTHORIZED')),
  protocolError('not_found', z.literal('SCANNER_NOT_FOUND')),
  protocolError('scanner_error', z.literal('SCANNER_UNAVAILABLE'))
]);

export type ScannerRequest = z.infer<typeof scannerRequestSchema>;
export type ScannerSuccessResponse = z.infer<typeof scannerSuccessResponseSchema>;
export type ScannerErrorResponse = z.infer<typeof scannerErrorResponseSchema>;

/** 两端只通过此函数构造协议签名，避免 canonical 输入漂移。 */
export function createScannerSignature(
  protocolVersion: string,
  timestamp: string,
  body: Uint8Array,
  secret: string
): string {
  const digest = createHash('sha256').update(body).digest('hex');
  return createHmac('sha256', secret)
    .update(`${protocolVersion}\n${timestamp}\n${digest}`)
    .digest('hex');
}
