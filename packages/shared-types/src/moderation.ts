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

export const submissionReceiptSchema = z.object({
  submissionId: z.string().min(1).max(128),
  statusToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  statusPath: z.literal('/submission-status/'),
  status: z.enum(['uploading', 'system_reviewing'])
}).strict();
export type SubmissionReceipt = z.infer<typeof submissionReceiptSchema>;

export const submissionStatusViewSchema = z.object({
  submissionId: z.string().min(1).max(128),
  status: submissionStatusSchema,
  publicReason: z.string().trim().min(1).max(500).nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true })
}).strict();
export type SubmissionStatusView = z.infer<typeof submissionStatusViewSchema>;

export const adminActionSchema = z.object({
  action: z.enum(['approve', 'reject', 'move_to_manual', 'delete', 'restore']),
  version: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(8).max(128),
  reason: z.string().trim().min(1).max(500)
}).strict();
export type AdminAction = z.infer<typeof adminActionSchema>;
