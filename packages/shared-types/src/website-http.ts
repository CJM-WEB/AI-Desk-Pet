import { z } from 'zod';

import {
  adminActionNameSchema,
  adminActionResultSchema,
  adminActionSchema,
  publicationBasisSchema,
  submissionStatusSchema,
  submissionStatusViewSchema
} from './moderation';

const requestIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u);
const dateTimeSchema = z.string().datetime({ offset: true });
const nullableTextSchema = z.string().nullable();
const structuredRecordSchema = z.record(z.unknown());
const emptyRequestSchema = z.object({}).strict();

export const websiteHttpErrorSchema = z.object({
  code: z.string().min(1).max(128),
  retryAfterSeconds: z.number().int().positive().optional()
}).strict();

/** 成功和错误使用互斥信封，避免 null 占位掩盖 wire 形状错误。 */
export function successEnvelopeSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.object({ requestId: requestIdSchema, data: dataSchema }).strict()
    .superRefine((value, context) => {
      if (
        !Object.prototype.hasOwnProperty.call(value, 'data')
        || value.data === undefined
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['data'],
          message: '成功信封必须包含 data'
        });
      }
    });
}

export const errorEnvelopeSchema = z.object({
  requestId: requestIdSchema,
  error: websiteHttpErrorSchema
}).strict();

/** 合同驱动在 endpoint Schema 解析前先用同一共享边界验证未知 data 信封。 */
export const unknownDataSuccessEnvelopeSchema = successEnvelopeSchema(z.unknown());
export const websiteHttpEnvelopeSchema = z.union([
  unknownDataSuccessEnvelopeSchema,
  errorEnvelopeSchema
]);
export type WebsiteHttpEnvelope = z.infer<typeof websiteHttpEnvelopeSchema>;

const uploadFileSchema = z.object({
  fileName: z.string().min(1),
  sizeBytes: z.number().int().positive(),
  contentType: z.string().min(1)
}).strict();

export const prepareSubmissionRequestSchema = z.object({
  kind: z.literal('shared_package'),
  title: z.string(),
  body: z.string(),
  coverFile: uploadFileSchema.extend({
    contentType: z.enum(['image/png', 'image/webp', 'image/jpeg'])
  }).strict(),
  packageFile: uploadFileSchema.extend({
    contentType: z.literal('application/zip')
  }).strict()
}).strict();

const submissionReceiptBaseSchema = z.object({
  submissionId: z.string().min(1).max(128),
  statusToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  statusPath: z.literal('/submission-status/')
}).strict();

const uploadTargetSchema = z.object({
  path: z.string().min(1),
  url: z.string().url(),
  expiresAt: dateTimeSchema
}).strict();

export const prepareSubmissionResponseSchema = submissionReceiptBaseSchema.extend({
  status: z.literal('uploading'),
  coverUpload: uploadTargetSchema,
  packageUpload: uploadTargetSchema
}).strict();

export const finalizeSubmissionRequestSchema = emptyRequestSchema;
export const finalizeSubmissionResponseSchema = z.object({
  status: z.literal('system_reviewing')
}).strict();

export const feedbackSubmissionRequestSchema = z.object({
  kind: z.enum(['feedback', 'suggestion']),
  authorName: z.string(),
  content: z.string()
}).strict();

export const feedbackSubmissionResponseSchema = submissionReceiptBaseSchema.extend({
  status: z.literal('system_reviewing')
}).strict();

export const submissionStatusRequestSchema = z.object({
  statusToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u)
}).strict();
export const submissionStatusResponseSchema = submissionStatusViewSchema;

export const publicListRequestSchema = z.object({
  limit: z.number().int().min(1).max(100),
  cursor: z.string().optional()
}).strict();
export const publicFeedbackListRequestSchema = publicListRequestSchema.extend({
  kind: z.enum(['feedback', 'suggestion'])
}).strict();
/** 详情 GET 显式建模三段 wire 事实，确保未声明的 query/body 不能被投影丢弃。 */
export const publicDetailRequestSchema = z.object({
  path: z.object({ id: z.string().min(1).max(128) }).strict(),
  query: z.object({}).strict(),
  body: z.object({}).strict()
}).strict();
export const publicLikeRequestSchema = z.object({
  liked: z.boolean(),
  operationId: z.string().uuid().transform(value => value.toLowerCase())
}).strict();
export const publicDownloadRequestSchema = emptyRequestSchema;

const signedUrlSchema = z.object({
  url: z.string().url(),
  expiresAt: dateTimeSchema
}).strict();

export const publicCommunityItemSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string(),
  description: z.string(),
  cover: signedUrlSchema,
  packageFileName: z.string().min(1),
  packageSizeBytes: z.number().int().nonnegative(),
  likeCount: z.number().int().nonnegative(),
  downloadCount: z.number().int().nonnegative(),
  publishedAt: dateTimeSchema,
  publicationBasis: publicationBasisSchema
}).strict();

export const publicCommunityPageSchema = z.object({
  items: z.array(publicCommunityItemSchema),
  nextCursor: z.string().min(1).max(512).nullable()
}).strict();

export const publicFeedbackItemSchema = z.object({
  id: z.string().min(1).max(128),
  kind: z.enum(['feedback', 'suggestion']),
  authorName: z.string(),
  content: z.string(),
  likeCount: z.number().int().nonnegative(),
  createdAt: dateTimeSchema
}).strict();

export const publicFeedbackPageSchema = z.object({
  items: z.array(publicFeedbackItemSchema),
  nextCursor: z.string().min(1).max(512).nullable()
}).strict();

export const publicLikeResponseSchema = z.object({
  liked: z.boolean(),
  likeCount: z.number().int().nonnegative()
}).strict();

export const publicDownloadResponseSchema = signedUrlSchema.extend({
  publicationBasis: publicationBasisSchema
}).strict();

export const adminQueueRequestSchema = z.object({
  limit: z.number().int().min(1).max(100),
  cursor: z.string().optional(),
  status: submissionStatusSchema.optional()
}).strict();
export const adminDetailRequestSchema = publicDetailRequestSchema;
export const adminActionRequestSchema = adminActionSchema;

const adminSubmissionBaseSchema = z.object({
  id: z.string().min(1).max(128),
  status: submissionStatusSchema,
  statusVersion: z.number().int().nonnegative(),
  kind: z.string().min(1).max(64),
  title: nullableTextSchema,
  body: nullableTextSchema,
  moderationLeaseUntil: nullableTextSchema,
  moderationAttempts: z.number().int().nonnegative().optional(),
  moderationNextRetryAt: nullableTextSchema.optional(),
  moderationLastError: nullableTextSchema.optional(),
  moderationAlertedAt: nullableTextSchema.optional(),
  purgeAfter: nullableTextSchema,
  preQuarantineStatus: submissionStatusSchema.nullable(),
  cleanupStartedAt: nullableTextSchema.optional(),
  publishedAt: nullableTextSchema,
  publicationBasis: publicationBasisSchema.nullable(),
  createdAt: dateTimeSchema,
  updatedAt: dateTimeSchema
}).strict();

export const adminSubmissionSummarySchema = adminSubmissionBaseSchema.extend({
  riskSummary: structuredRecordSchema,
  autoRejectionReason: nullableTextSchema
}).strict();

const adminAssetSchema = z.object({
  role: z.enum(['cover', 'package', 'derived']),
  storageKey: z.string().min(1),
  fileName: z.string().min(1),
  declaredBytes: z.number().int().nonnegative(),
  contentType: z.string().min(1),
  actualBytes: z.number().int().nonnegative().nullable()
}).strict();

const adminModerationResultSchema = z.object({
  kind: z.string().min(1),
  provider: z.string().min(1),
  suggestion: z.enum(['Pass', 'Review', 'Block']),
  label: z.string(),
  score: z.number().nullable(),
  evidence: structuredRecordSchema,
  createdAt: dateTimeSchema
}).strict();

const adminAuditLogSchema = z.object({
  action: adminActionNameSchema,
  beforeStatus: submissionStatusSchema,
  afterStatus: submissionStatusSchema,
  reason: z.string(),
  createdAt: dateTimeSchema
}).strict();

export const adminDetailResponseSchema = adminSubmissionSummarySchema.extend({
  coverPreview: signedUrlSchema.nullable(),
  assets: z.array(adminAssetSchema),
  moderationResults: z.array(adminModerationResultSchema),
  auditLogs: z.array(adminAuditLogSchema)
}).strict();

export const adminQueueResponseSchema = z.object({
  items: z.array(adminSubmissionSummarySchema),
  nextCursor: z.string().min(1).max(512).nullable()
}).strict();

export const adminActionResponseSchema = adminActionResultSchema;

export type PrepareSubmissionRequest = z.infer<typeof prepareSubmissionRequestSchema>;
export type PrepareSubmissionResponse = z.infer<typeof prepareSubmissionResponseSchema>;
export type FeedbackSubmissionRequest = z.infer<typeof feedbackSubmissionRequestSchema>;
export type PublicCommunityItem = z.infer<typeof publicCommunityItemSchema>;
export type PublicCommunityPage = z.infer<typeof publicCommunityPageSchema>;
export type PublicFeedbackPage = z.infer<typeof publicFeedbackPageSchema>;
export type PublicDownloadResponse = z.infer<typeof publicDownloadResponseSchema>;
export type AdminSubmissionSummary = z.infer<typeof adminSubmissionSummarySchema>;
export type AdminSubmissionDetail = z.infer<typeof adminDetailResponseSchema>;
export type AdminQueueResponse = z.infer<typeof adminQueueResponseSchema>;
