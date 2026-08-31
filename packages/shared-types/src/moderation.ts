import { z } from 'zod';

/** 匿名投稿审核的跨端数据契约。 */
export const submissionStatuses = [
  'uploading',
  'system_reviewing',
  'manual_review_pending',
  'published',
  'auto_rejected',
  'admin_rejected',
  'deleted_quarantined',
  'purged'
] as const;

export const submissionStatusSchema = z.enum(submissionStatuses);
export type SubmissionStatus = z.infer<typeof submissionStatusSchema>;

/** 发布依据独立于技术扫描结论，后到扫描不得改写该事实。 */
export const publicationBasisSchema = z.enum(['standard', 'admin_override']);
export type PublicationBasis = z.infer<typeof publicationBasisSchema>;

export const submissionReceiptSchema = z.object({
  submissionId: z.string().min(1).max(128),
  statusToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  statusPath: z.literal('/submission-status/'),
  status: z.enum(['uploading', 'system_reviewing'])
}).strict();
export type SubmissionReceipt = z.infer<typeof submissionReceiptSchema>;

export const TECHNICAL_SCAN_PROTOCOL_VERSION = '2026-08-15' as const;
export const TECHNICAL_SCAN_RULE_VERSION = 'character-package-2026-08-15' as const;

/** 共享包发布门只信任逐字段绑定当前归档和状态版本的短期扫描证据。 */
export const technicalScanEvidenceSchema = z.object({
  submissionId: z.string().min(1).max(128),
  packageStorageKey: z.string().min(1).max(1024),
  packageSizeBytes: z.number().int().positive().max(100 * 1024 * 1024),
  archiveSizeBytes: z.number().int().positive().max(100 * 1024 * 1024),
  archiveSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  protocolVersion: z.literal(TECHNICAL_SCAN_PROTOCOL_VERSION),
  ruleVersion: z.literal(TECHNICAL_SCAN_RULE_VERSION),
  scanCode: z.literal('CHARACTER_PACKAGE_SCAN_PASSED'),
  completedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  submissionStatusVersion: z.number().int().nonnegative()
}).strict();
export type TechnicalScanEvidence = z.infer<typeof technicalScanEvidenceSchema>;

export const submissionStatusViewSchema = z.object({
  submissionId: z.string().min(1).max(128),
  status: submissionStatusSchema,
  publicReason: z.string().trim().min(1).max(500).nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true })
}).strict();
export type SubmissionStatusView = z.infer<typeof submissionStatusViewSchema>;

const adminActionBase = z.object({
  version: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(8).max(128),
  reason: z.string().trim().min(1).max(500)
}).strict();

const normalAdminActionSchema = adminActionBase.extend({
  action: z.enum(['approve', 'reject', 'move_to_manual', 'delete', 'restore'])
});

export const adminActionSchema = z.discriminatedUnion('action', [
  normalAdminActionSchema,
  adminActionBase.extend({
    action: z.literal('force_publish'),
    riskAcknowledgement: z.literal('ADMIN_OVERRIDE_ACCEPTED')
  })
]);
export type AdminAction = z.infer<typeof adminActionSchema>;
