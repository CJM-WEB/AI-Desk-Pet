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

/** 审计等只读取动作名的消费者复用联合分支，不另建动作枚举。 */
export const adminActionNameSchema = z.union([
  adminActionSchema.options[0].shape.action,
  adminActionSchema.options[1].shape.action
]);

const adminActionResultCoreSubmissionSchema = z.object({
  id: z.string().min(1).max(128),
  status: submissionStatusSchema,
  statusVersion: z.number().int().nonnegative(),
  publicationBasis: publicationBasisSchema.nullable()
}).strict();

const adminActionResultSafeSubmissionSchema =
  adminActionResultCoreSubmissionSchema.extend({
    kind: z.string().min(1).max(64),
    publicReason: z.string().max(500).nullable(),
    publishedAt: z.string().datetime({ offset: true }).nullable(),
    rejectedAt: z.string().datetime({ offset: true }).nullable(),
    quarantinedAt: z.string().datetime({ offset: true }).nullable(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true })
  }).strict();

/**
 * 新动作及其重放返回完整安全快照；只有旧 purge 恢复的重放可返回四键事实。
 * 两种形状都禁止重新引入投稿正文、令牌、风险或租约字段。
 */
export const adminActionResultSchema = z.discriminatedUnion('replayed', [
  z.object({
    submission: adminActionResultSafeSubmissionSchema,
    replayed: z.literal(false)
  }).strict(),
  z.object({
    submission: z.union([
      adminActionResultSafeSubmissionSchema,
      adminActionResultCoreSubmissionSchema
    ]),
    replayed: z.literal(true)
  }).strict()
]).superRefine((result, context) => {
  const published = result.submission.status === 'published';
  if (published !== (result.submission.publicationBasis !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['submission', 'publicationBasis'],
      message: '发布状态与发布依据不一致'
    });
  }
});
export type AdminActionResult = z.infer<typeof adminActionResultSchema>;
