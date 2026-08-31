import {
  adminActionNameSchema,
  adminActionResultSchema,
  adminActionSchema,
  publicationBasisSchema,
  submissionStatusSchema,
  type AdminAction,
  type AdminActionResult,
  type SubmissionStatus
} from '@myself/shared-types';
import { z } from 'zod';

import { ApiClient, ApiClientError } from './api-client';

const nullableText = z.string().nullable();
const dateTime = z.string().datetime({ offset: true });
const structuredRecord = z.record(z.unknown());

const adminSubmissionBaseSchema = z.object({
  id: z.string().min(1).max(128),
  status: submissionStatusSchema,
  statusVersion: z.number().int().nonnegative(),
  kind: z.string().min(1).max(64),
  title: nullableText,
  body: nullableText,
  moderationLeaseUntil: nullableText,
  moderationAttempts: z.number().int().nonnegative().optional(),
  moderationNextRetryAt: nullableText.optional(),
  moderationLastError: nullableText.optional(),
  moderationAlertedAt: nullableText.optional(),
  purgeAfter: nullableText,
  preQuarantineStatus: submissionStatusSchema.nullable(),
  cleanupStartedAt: nullableText.optional(),
  publishedAt: nullableText,
  publicationBasis: publicationBasisSchema.nullable(),
  createdAt: dateTime,
  updatedAt: dateTime
}).strict();

const adminSubmissionSummarySchema = adminSubmissionBaseSchema.extend({
  riskSummary: structuredRecord,
  autoRejectionReason: nullableText
}).strict();

const assetSchema = z.object({
  role: z.enum(['cover', 'package', 'derived']),
  storageKey: z.string().min(1),
  fileName: z.string().min(1),
  declaredBytes: z.number().int().nonnegative(),
  contentType: z.string().min(1),
  actualBytes: z.number().int().nonnegative().nullable()
}).strict();

const moderationResultSchema = z.object({
  kind: z.string().min(1),
  provider: z.string().min(1),
  suggestion: z.enum(['Pass', 'Review', 'Block']),
  label: z.string(),
  score: z.number().nullable(),
  evidence: structuredRecord,
  createdAt: dateTime
}).strict();

const auditLogSchema = z.object({
  action: adminActionNameSchema,
  beforeStatus: submissionStatusSchema,
  afterStatus: submissionStatusSchema,
  reason: z.string(),
  createdAt: dateTime
}).strict();

const adminSubmissionDetailSchema = adminSubmissionSummarySchema.extend({
  coverPreview: z.object({
    url: z.string().url(),
    expiresAt: dateTime
  }).strict().nullable(),
  assets: z.array(assetSchema),
  moderationResults: z.array(moderationResultSchema),
  auditLogs: z.array(auditLogSchema)
}).strict();

const adminQueuePageSchema = z.object({
  items: z.array(adminSubmissionSummarySchema),
  nextCursor: z.number().int().nonnegative().nullable()
}).strict();

export type AdminSubmissionSummary = z.infer<typeof adminSubmissionSummarySchema>;
export type AdminSubmissionDetail = z.infer<typeof adminSubmissionDetailSchema>;
export type AdminQueuePage = z.infer<typeof adminQueuePageSchema>;
export type { AdminActionResult } from '@myself/shared-types';

export interface AdminApi {
  listQueue(
    accessToken: string,
    status: SubmissionStatus,
    cursor?: number,
    signal?: AbortSignal
  ): Promise<AdminQueuePage>;
  getDetail(
    accessToken: string,
    id: string,
    signal?: AbortSignal
  ): Promise<AdminSubmissionDetail>;
  applyAction(
    accessToken: string,
    id: string,
    action: AdminAction
  ): Promise<AdminActionResult>;
}

/** 管理员客户端复用公开 ApiClient 的错误信封，并用专用头避开 CloudBase 网关认证。 */
export class AdminApiClient implements AdminApi {
  constructor(private readonly api: ApiClient) {}

  async listQueue(
    accessToken: string,
    status: SubmissionStatus,
    cursor?: number,
    signal?: AbortSignal
  ): Promise<AdminQueuePage> {
    const query = new URLSearchParams({ limit: '20', status });
    if (cursor !== undefined) query.set('cursor', String(cursor));
    const value = await this.api.request<unknown>(
      `/admin/submissions?${query.toString()}`,
      requestInit(accessToken, signal)
    );
    return parseResponse(adminQueuePageSchema, value);
  }

  async getDetail(
    accessToken: string,
    id: string,
    signal?: AbortSignal
  ): Promise<AdminSubmissionDetail> {
    const value = await this.api.request<unknown>(
      `/admin/submissions/${encodeURIComponent(id)}`,
      requestInit(accessToken, signal)
    );
    return parseResponse(adminSubmissionDetailSchema, value);
  }

  async applyAction(
    accessToken: string,
    id: string,
    action: AdminAction
  ): Promise<AdminActionResult> {
    const body = adminActionSchema.parse(action);
    const value = await this.api.request<unknown>(
      `/admin/submissions/${encodeURIComponent(id)}/actions`,
      {
        ...requestInit(accessToken),
        method: 'POST',
        body: JSON.stringify(body)
      }
    );
    return parseResponse(adminActionResultSchema, value);
  }
}

function requestInit(accessToken: string, signal?: AbortSignal): RequestInit {
  return {
    headers: { 'x-ai-pet-admin-token': accessToken },
    ...(signal ? { signal } : {})
  };
}

function parseResponse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiClientError('INVALID_RESPONSE', 200);
  return result.data;
}
