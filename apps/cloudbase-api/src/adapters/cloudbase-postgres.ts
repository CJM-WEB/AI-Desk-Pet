import {
  adminActionSchema,
  adminActionResultSchema,
  publicationBasisSchema,
  submissionStatusSchema
} from '@myself/shared-types';
import { z } from 'zod';

import { ApiError } from '../errors.js';
import {
  BoundedJsonResponseError,
  readBoundedJsonResponse
} from './bounded-json-response.js';
import type {
  AdminActionInput,
  AdminActionResult,
  AdminAuditLog,
  AdminModerationResult,
  AdminQueuePage,
  AdminQueueQuery,
  AdminStore,
  AdminSubmissionDetail,
  AdminSubmissionSummary,
  AbuseLimitInput,
  AbuseLimitResult,
  CompleteUploadInput,
  NewSubmission,
  NewTextSubmission,
  PublicDownloadInput,
  PublicDownloadResult,
  PublicContentStore,
  PublicLikeInput,
  PublicLikeResult,
  PublicListQuery,
  PublishedCommunityPage,
  PublishedCommunityRecord,
  PublishedFeedbackPage,
  PublishedFeedbackRecord,
  SecurityStore,
  SubmissionAsset,
  SubmissionRow,
  SubmissionStatusView,
  SubmissionStore,
  TextSubmissionStore,
  CleanupStore,
  MarkPurgedInput,
  SubmissionWithAssets
} from '../ports.js';
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  type KeysetCursorScope
} from './keyset-cursor.js';

export interface RdbError {
  code?: string;
  message: string;
}

export interface RdbResult {
  data: unknown;
  error: RdbError | null;
}

export type CloudBasePostgresRpcName =
  | 'consume_abuse_limit'
  | 'create_text_submission'
  | 'set_public_like'
  | 'record_public_download'
  | 'create_submission'
  | 'complete_submission_upload'
  | 'apply_admin_action'
  | 'claim_cleanup_jobs'
  | 'mark_submission_purged'
  | 'purge_expired_public_interaction_operations'
  | 'list_public_community'
  | 'list_public_feedback'
  | 'list_admin_submissions';

export interface RpcClientOptions {
  timeoutMs: number;
  maxResponseBytes: number;
}

export const DEFAULT_RPC_CLIENT_OPTIONS: RpcClientOptions = {
  timeoutMs: 15_000,
  maxResponseBytes: 4 * 1024 * 1024
};

/** CloudBase PostgreSQL 客户端在本仓储中使用的最小链式查询表面。 */
export interface CloudBaseRdbQuery extends PromiseLike<RdbResult> {
  select(columns?: string): CloudBaseRdbQuery;
  eq(column: string, value: unknown): CloudBaseRdbQuery;
  order(column: string, options: { ascending: boolean }): CloudBaseRdbQuery;
  maybeSingle(): CloudBaseRdbQuery;
}

/** 通过结构类型兼容 CloudBase SDK，并便于测试注入内存替身。 */
export interface CloudBaseRdbClient {
  from(table: string): CloudBaseRdbQuery;
}

export interface CloudBasePostgresRpc {
  rpc(
    name: CloudBasePostgresRpcName,
    params: Record<string, unknown>
  ): Promise<RdbResult>;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** 使用独立 service_role API Key 调用数据库函数，不依赖表查询 SDK 的能力。 */
export class CloudBasePostgresRpcClient implements CloudBasePostgresRpc {
  constructor(
    private readonly envId: string,
    private readonly apiKey: string,
    private readonly options: RpcClientOptions = DEFAULT_RPC_CLIENT_OPTIONS,
    private readonly fetcher: FetchLike = fetch
  ) {}

  async rpc(
    name: CloudBasePostgresRpcName,
    params: Record<string, unknown>
  ): Promise<RdbResult> {
    const url = `https://${this.envId}.api.tcloudbasegateway.com`
      + `/v1/rdb/rest/rpc/${encodeURIComponent(name)}`;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs
    );

    try {
      const response = await this.fetcher(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(params),
        signal: controller.signal
      });
      const payload = await readBoundedJsonResponse(response, {
        maxBytes: this.options.maxResponseBytes,
        signal: controller.signal
      });
      if (response.ok) {
        return { data: payload, error: null };
      }

      const error = asRpcError(payload);
      return {
        data: null,
        error: {
          ...(error.code ? { code: error.code } : {}),
          message: error.message ?? `RPC 请求失败（HTTP ${response.status}）`
        }
      };
    } catch (error) {
      if (controller.signal.aborted) {
        return { data: null, error: { message: 'RPC 请求超时' } };
      }
      if (error instanceof BoundedJsonResponseError) {
        return {
          data: null,
          error: {
            message: error.code === 'RESPONSE_TOO_LARGE'
              ? 'RPC 响应过大'
              : 'RPC 响应格式错误'
          }
        };
      }
      return { data: null, error: { message: 'RPC 请求失败' } };
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * 使用服务端 app.rdb() 的表客户端访问 PostgreSQL。
 * 并发租约和管理员写操作固定下推到数据库函数，避免客户端读改写竞争。
 */
export class CloudBasePostgresStore implements
  SubmissionStore,
  SecurityStore,
  TextSubmissionStore,
  PublicContentStore,
  AdminStore,
  CleanupStore {
  constructor(
    private readonly database: CloudBaseRdbClient,
    private readonly rpcClient: CloudBasePostgresRpc
  ) {}

  async consumeAbuseLimit(input: AbuseLimitInput): Promise<AbuseLimitResult> {
    requireHash(input.fingerprintHash);
    const row = requireRecord(
      requireData(await this.rpcClient.rpc('consume_abuse_limit', {
        p_scope: input.scope,
        p_fingerprint_hash: input.fingerprintHash,
        p_maximum: input.maximum,
        p_window_seconds: input.windowSeconds
      }), '消费限流计数失败'),
      '限流结果'
    );
    return {
      allowed: requireBoolean(row.allowed, 'allowed'),
      retryAfterSeconds: requireNonnegativeInteger(
        row.retry_after_seconds,
        'retry_after_seconds'
      )
    };
  }

  async createTextSubmission(input: NewTextSubmission): Promise<SubmissionRow> {
    requireHash(input.statusTokenHash);
    const result = await this.rpcClient.rpc('create_text_submission', {
      p_submission: {
        id: input.id,
        kind: input.kind,
        title: input.title,
        body: input.body,
        status_token_hash: input.statusTokenHash
      }
    });
    return mapSubmission(requireData(result, '创建文本投稿失败'));
  }

  async setPublicLike(input: PublicLikeInput): Promise<PublicLikeResult> {
    requireHash(input.fingerprintHash);
    const result = await this.rpcClient.rpc('set_public_like', {
      p_submission_id: input.submissionId,
      p_fingerprint_hash: input.fingerprintHash,
      p_desired_liked: input.desiredLiked,
      p_operation_id: input.operationId,
      p_endpoint_kind: input.endpointKind
    });
    const row = requirePublicInteractionRow(result, '设置点赞失败', '点赞结果');
    return {
      liked: requireBoolean(row.liked, 'liked'),
      likeCount: requireNonnegativeInteger(row.like_count, 'like_count')
    };
  }

  async recordPublicDownload(
    input: PublicDownloadInput
  ): Promise<PublicDownloadResult> {
    requireHash(input.fingerprintHash);
    const result = await this.rpcClient.rpc('record_public_download', {
      p_submission_id: input.submissionId,
      p_fingerprint_hash: input.fingerprintHash,
      p_operation_id: input.operationId
    });
    const row = requirePublicInteractionRow(result, '记录下载失败', '下载结果');
    return {
      downloadCount: requireNonnegativeInteger(
        row.download_count,
        'download_count'
      )
    };
  }

  async listPublicCommunity(
    input: PublicListQuery
  ): Promise<PublishedCommunityPage> {
    requireLimit(input.limit);
    const scope = 'community';
    const cursor = decodeOptionalCursor(input.cursor, scope);
    const result = await this.rpcClient.rpc('list_public_community', {
      p_limit: input.limit,
      p_cursor_time: cursor?.sortTime ?? null,
      p_cursor_id: cursor?.id ?? null
    });
    const rows = requireRows(
      requireData(result, '查询公开社区失败'),
      '公开社区'
    );
    return {
      items: mapPublicRows(rows.slice(0, input.limit), mapPublishedCommunity),
      nextCursor: nextCursor(rows, input.limit, scope, 'published_at')
    };
  }

  async findPublicCommunity(
    id: string
  ): Promise<PublishedCommunityRecord | null> {
    const result = await this.database
      .from('submissions')
      .select(publicCommunityColumns)
      .eq('id', id)
      .eq('status', 'published')
      .eq('kind', 'shared_package')
      .maybeSingle();
    const data = requireData(result, '查询公开社区详情失败');
    return data === null ? null : mapPublishedCommunity(data);
  }

  async listPublicFeedback(
    kind: 'feedback' | 'suggestion',
    input: PublicListQuery
  ): Promise<PublishedFeedbackPage> {
    requireLimit(input.limit);
    const scope: KeysetCursorScope = `feedback:${kind}`;
    const cursor = decodeOptionalCursor(input.cursor, scope);
    const result = await this.rpcClient.rpc('list_public_feedback', {
      p_kind: kind,
      p_limit: input.limit,
      p_cursor_time: cursor?.sortTime ?? null,
      p_cursor_id: cursor?.id ?? null
    });
    const rows = requireRows(
      requireData(result, '查询公开反馈失败'),
      '公开反馈'
    );
    return {
      items: mapPublicRows(rows.slice(0, input.limit), mapPublishedFeedback),
      nextCursor: nextCursor(rows, input.limit, scope, 'published_at')
    };
  }

  async createSubmission(input: NewSubmission): Promise<SubmissionRow> {
    requireHash(input.statusTokenHash);
    const result = await this.rpcClient.rpc('create_submission', {
      p_submission: {
        id: input.id,
        kind: input.kind,
        title: input.title,
        body: input.body,
        status_token_hash: input.statusTokenHash
      },
      p_assets: input.assets.map((asset) => ({
        role: asset.role,
        storage_key: asset.storageKey,
        file_name: asset.fileName,
        declared_bytes: asset.declaredBytes,
        content_type: asset.contentType
      }))
    });
    return mapSubmission(requireData(result, '创建投稿失败'));
  }

  async findById(id: string): Promise<SubmissionWithAssets | null> {
    const submission = await this.findSubmissionOrNull(id);
    if (!submission) return null;

    const result = await this.database
      .from('assets')
      .select('object_key,original_name,declared_size,actual_size,mime_type,role')
      .eq('submission_id', id);
    const assets = requireRows(
      requireData(result, '查询投稿资产失败'),
      '投稿资产'
    ).map(mapAsset);
    return { ...submission, assets };
  }

  async completeUpload(input: CompleteUploadInput): Promise<SubmissionRow> {
    const result = await this.rpcClient.rpc('complete_submission_upload', {
      p_submission_id: input.submissionId,
      p_assets: input.assets.map(asset => ({
        role: asset.role,
        storage_key: asset.storageKey,
        actual_bytes: asset.actualBytes,
        content_type: asset.contentType
      }))
    });
    if (result.error?.code === 'P1002') {
      throw new ApiError('UPLOAD_FINALIZE_CONFLICT', 409, result.error.message);
    }
    return mapSubmission(requireData(result, '完成上传失败'));
  }

  async findByStatusTokenHash(hash: string): Promise<SubmissionStatusView | null> {
    requireHash(hash);
    const result = await this.database
      .from('submissions')
      .select('id,status,public_reason,created_at,updated_at')
      .eq('status_token_hash', hash)
      .maybeSingle();
    const data = requireData(result, '查询投稿状态失败');
    if (data === null) return null;

    const row = requireRecord(data, '投稿状态');
    return {
      submissionId: requireString(row.id, 'id'),
      status: submissionStatusSchema.parse(row.status),
      publicReason: optionalString(row.public_reason, 'public_reason'),
      createdAt: requireString(row.created_at, 'created_at'),
      updatedAt: requireString(row.updated_at, 'updated_at')
    };
  }

  async applyAdminAction(input: AdminActionInput): Promise<AdminActionResult> {
    const result = await this.rpcClient.rpc('apply_admin_action', {
      p_submission_id: input.submissionId,
      p_admin_id: input.adminId,
      p_action: input.action,
      p_next_status: input.nextStatus,
      p_expected_version: input.expectedVersion,
      p_idempotency_key: input.idempotencyKey,
      p_reason: input.reason,
      p_risk_acknowledgement: input.riskAcknowledgement ?? null
    });
    if (result.error?.code === '40001') {
      throw new ApiError('VERSION_CONFLICT', 409, result.error.message);
    }
    if (result.error?.code === 'P1001') {
      throw new ApiError('IDEMPOTENCY_CONFLICT', 409, result.error.message);
    }
    if (result.error?.code === 'P1002') {
      throw new ApiError('INVALID_ADMIN_ACTION', 409, result.error.message);
    }
    if (result.error?.code === 'P1003') {
      throw new ApiError('TECHNICAL_SCAN_REQUIRED', 409, result.error.message);
    }
    if (result.error?.code === 'P0002') {
      throw new ApiError('SUBMISSION_NOT_FOUND', 404, result.error.message);
    }

    return mapAdminActionResult(requireData(result, '执行管理员动作失败'));
  }

  async listAdminSubmissions(
    input: AdminQueueQuery
  ): Promise<AdminQueuePage> {
    requireLimit(input.limit);
    const scope: KeysetCursorScope = `admin:${input.status ?? 'all'}`;
    const cursor = decodeOptionalCursor(input.cursor, scope);
    const result = await this.rpcClient.rpc('list_admin_submissions', {
      p_limit: input.limit,
      p_status: input.status ?? null,
      p_cursor_time: cursor?.sortTime ?? null,
      p_cursor_id: cursor?.id ?? null
    });
    const rows = requireRows(
      requireData(result, '查询管理员队列失败'),
      '管理员队列'
    );
    return {
      items: rows.slice(0, input.limit).map(mapAdminSubmission),
      nextCursor: nextCursor(rows, input.limit, scope, 'created_at')
    };
  }

  async findAdminSubmission(
    id: string
  ): Promise<AdminSubmissionDetail | null> {
    const submission = await this.findById(id);
    if (!submission) return null;
    const moderation = await this.database
      .from('moderation_results')
      .select('kind,provider,suggestion,label,score,evidence,created_at')
      .eq('submission_id', id)
      .order('created_at', { ascending: true });
    const audits = await this.database
      .from('admin_audit_logs')
      .select('action,before_status,after_status,reason,created_at')
      .eq('submission_id', id)
      .order('created_at', { ascending: true });
    return {
      ...submission,
      ...mapAdminRiskFields(
        requireRecord(
          await this.database
            .from('submissions')
            .select('risk_summary,auto_rejection_reason')
            .eq('id', id)
            .maybeSingle()
            .then(result => requireData(result, '查询管理员风险摘要失败')),
          '管理员风险摘要'
        )
      ),
      moderationResults: requireRows(
        requireData(moderation, '查询管理员审核证据失败'),
        '管理员审核证据'
      ).map(mapAdminModerationResult),
      auditLogs: requireRows(
        requireData(audits, '查询管理员审计记录失败'),
        '管理员审计记录'
      ).map(mapAdminAuditLog)
    };
  }

  async claimCleanupJobs(
    limit: number,
    leaseUntil: string
  ): Promise<SubmissionWithAssets[]> {
    requireLimit(limit);
    const result = await this.rpcClient.rpc('claim_cleanup_jobs', {
      p_limit: limit,
      p_lease_until: leaseUntil
    });
    return requireRows(
      requireData(result, '领取清理任务失败'),
      '清理任务'
    ).map(mapCleanupSubmission);
  }

  async markPurged(input: MarkPurgedInput): Promise<boolean> {
    const row = requireRecord(
      requireData(await this.rpcClient.rpc('mark_submission_purged', {
        p_submission_id: input.submissionId,
        p_expected_version: input.expectedVersion
      }), '标记永久清理失败'),
      '永久清理结果'
    );
    return requireBoolean(row.applied, 'applied');
  }

  async purgeExpiredPublicInteractionOperations(limit: number): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new ApiError('INVALID_LIMIT', 400);
    }
    return requireNonnegativeInteger(
      requireData(await this.rpcClient.rpc(
        'purge_expired_public_interaction_operations',
        { p_limit: limit }
      ), '清理过期互动账本失败'),
      '过期互动账本清理数'
    );
  }

  private async findSubmission(id: string): Promise<SubmissionRow> {
    const submission = await this.findSubmissionOrNull(id);
    if (!submission) throw new ApiError('SUBMISSION_NOT_FOUND', 404);
    return submission;
  }

  private async findSubmissionOrNull(id: string): Promise<SubmissionRow | null> {
    const result = await this.database
      .from('submissions')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    const data = requireData(result, '查询投稿失败');
    return data === null ? null : mapSubmission(data);
  }
}

function mapSubmission(value: unknown): SubmissionRow {
  const row = requireRecord(value, '投稿');
  return {
    id: requireString(row.id, 'id'),
    status: submissionStatusSchema.parse(row.status),
    statusVersion: requireInteger(row.status_version, 'status_version'),
    kind: requireString(row.kind, 'kind'),
    title: optionalString(row.title, 'title'),
    body: optionalString(row.body, 'body'),
    moderationLeaseUntil: optionalString(
      row.moderation_lease_until,
      'moderation_lease_until'
    ),
    ...('moderation_attempts' in row ? {
      moderationAttempts: requireNonnegativeInteger(
        row.moderation_attempts,
        'moderation_attempts'
      )
    } : {}),
    ...('moderation_next_retry_at' in row ? {
      moderationNextRetryAt: optionalString(
        row.moderation_next_retry_at,
        'moderation_next_retry_at'
      )
    } : {}),
    ...('moderation_last_error' in row ? {
      moderationLastError: optionalString(
        row.moderation_last_error,
        'moderation_last_error'
      )
    } : {}),
    ...('moderation_alerted_at' in row ? {
      moderationAlertedAt: optionalString(
        row.moderation_alerted_at,
        'moderation_alerted_at'
      )
    } : {}),
    purgeAfter: optionalString(row.purge_after, 'purge_after'),
    preQuarantineStatus: row.pre_quarantine_status === null
      || row.pre_quarantine_status === undefined
      ? null
      : submissionStatusSchema.parse(row.pre_quarantine_status),
    ...('cleanup_started_at' in row ? {
      cleanupStartedAt: optionalString(
        row.cleanup_started_at,
        'cleanup_started_at'
      )
    } : {}),
    publishedAt: optionalString(row.published_at, 'published_at'),
    publicationBasis: publicationBasisSchema.nullable().parse(
      row.publication_basis
    ),
    createdAt: requireString(row.created_at, 'created_at'),
    updatedAt: requireString(row.updated_at, 'updated_at')
  };
}

const adminActionSubmissionCoreSchema = z.object({
  id: z.string().min(1).max(128),
  status: submissionStatusSchema,
  status_version: z.number().int().nonnegative(),
  publication_basis: publicationBasisSchema.nullable()
}).strict();

const adminActionSubmissionSnapshotSchema = adminActionSubmissionCoreSchema
  .extend({
    kind: z.string().min(1).max(64),
    public_reason: z.string().max(500).nullable(),
    published_at: z.string().datetime({ offset: true }).nullable(),
    rejected_at: z.string().datetime({ offset: true }).nullable(),
    quarantined_at: z.string().datetime({ offset: true }).nullable(),
    created_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true })
  })
  .strict();

const adminActionRpcResultSchema = z.union([
  z.object({
    submission: adminActionSubmissionSnapshotSchema,
    replayed: z.boolean()
  }).strict(),
  z.object({
    submission: adminActionSubmissionCoreSchema,
    replayed: z.literal(true)
  }).strict()
]).superRefine((result, context) => {
  const published = result.submission.status === 'published';
  if (published !== (result.submission.publication_basis !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['submission', 'publication_basis'],
      message: '发布状态与发布依据不一致'
    });
  }

});

/** 管理员动作 RPC 只映射稳定裁决事实，额外字段和完整投稿私密行均失败关闭。 */
function mapAdminActionResult(value: unknown): AdminActionResult {
  const parsed = adminActionRpcResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError('DATABASE_ERROR', 500, '管理员动作结果返回格式错误');
  }
  const coreSubmission = {
    id: parsed.data.submission.id,
    status: parsed.data.submission.status,
    statusVersion: parsed.data.submission.status_version,
    publicationBasis: parsed.data.submission.publication_basis
  };
  const mapped = {
    submission: {
      ...coreSubmission,
      ...('kind' in parsed.data.submission ? {
        kind: parsed.data.submission.kind,
        publicReason: parsed.data.submission.public_reason,
        publishedAt: parsed.data.submission.published_at,
        rejectedAt: parsed.data.submission.rejected_at,
        quarantinedAt: parsed.data.submission.quarantined_at,
        createdAt: parsed.data.submission.created_at,
        updatedAt: parsed.data.submission.updated_at
      } : {})
    },
    replayed: parsed.data.replayed
  };
  const result = adminActionResultSchema.safeParse(mapped);
  if (!result.success) {
    throw new ApiError('DATABASE_ERROR', 500, '管理员动作结果返回格式错误');
  }
  return result.data;
}

function mapAdminSubmission(value: unknown): AdminSubmissionSummary {
  const row = requireRecord(value, '管理员队列');
  return {
    ...mapSubmission(row),
    ...mapAdminRiskFields(row)
  };
}

/** 只映射管理员界面所需的现有风险字段，避免泄漏到公开响应。 */
function mapAdminRiskFields(row: Record<string, unknown>): {
  riskSummary: Record<string, unknown>;
  autoRejectionReason: string | null;
} {
  return {
    riskSummary: requireRecord(row.risk_summary, 'risk_summary'),
    autoRejectionReason: optionalString(
      row.auto_rejection_reason,
      'auto_rejection_reason'
    )
  };
}

function mapCleanupSubmission(value: unknown): SubmissionWithAssets {
  const row = requireRecord(value, '清理任务');
  return {
    ...mapSubmission(row),
    assets: requireRows(row.assets, '清理任务资产').map(mapAsset)
  };
}

function mapAdminModerationResult(value: unknown): AdminModerationResult {
  const row = requireRecord(value, '管理员审核证据');
  return {
    kind: requireString(row.kind, 'kind'),
    provider: requireString(row.provider, 'provider'),
    suggestion: requireSuggestion(row.suggestion),
    label: requireString(row.label, 'label'),
    score: optionalNumber(row.score, 'score'),
    evidence: requireRecord(row.evidence, 'evidence'),
    createdAt: requireString(row.created_at, 'created_at')
  };
}

function mapAdminAuditLog(value: unknown): AdminAuditLog {
  const row = requireRecord(value, '管理员审计记录');
  return {
    action: requireAdminAction(row.action),
    beforeStatus: submissionStatusSchema.parse(row.before_status),
    afterStatus: submissionStatusSchema.parse(row.after_status),
    reason: requireString(row.reason, 'reason'),
    createdAt: requireString(row.created_at, 'created_at')
  };
}

const publicCommunityColumns = [
  'id',
  'title',
  'body',
  'published_at',
  'publication_basis',
  'assets(object_key,original_name,actual_size,mime_type,role)',
  'public_engagement(like_count,download_count)'
].join(',');

function mapPublishedCommunity(value: unknown): PublishedCommunityRecord {
  const row = requireRecord(value, '公开社区记录');
  const engagement = requireRelationRecord(
    row.public_engagement,
    '公开互动'
  );
  const assets = requireRows(row.assets, '公开资产').flatMap(value => {
    const asset = requireRecord(value, '公开资产');
    const role = requireString(asset.role, 'role');
    // 详情查询会读回合法派生资产，公开 DTO 只保留封面与包。
    if (role === 'derived') return [];
    if (role !== 'cover' && role !== 'package') {
      throw new ApiError('DATABASE_ERROR', 500, '公开资产角色错误');
    }
    const publicRole: 'cover' | 'package' = role;
    return [{
      role: publicRole,
      storageKey: requireString(asset.object_key, 'object_key'),
      fileName: requireString(asset.original_name, 'original_name'),
      sizeBytes: requireNonnegativeInteger(asset.actual_size, 'actual_size'),
      contentType: requireString(asset.mime_type, 'mime_type')
    }];
  });
  return {
    id: requireString(row.id, 'id'),
    title: requireString(row.title, 'title'),
    body: requireString(row.body, 'body'),
    assets,
    likeCount: requireNonnegativeInteger(engagement.like_count, 'like_count'),
    downloadCount: requireNonnegativeInteger(
      engagement.download_count,
      'download_count'
    ),
    publishedAt: requireString(row.published_at, 'published_at'),
    publicationBasis: publicationBasisSchema.parse(row.publication_basis)
  };
}

function mapPublishedFeedback(value: unknown): PublishedFeedbackRecord {
  const row = requireRecord(value, '公开反馈记录');
  const engagement = requireRelationRecord(
    row.public_engagement,
    '公开互动'
  );
  const kind = requireString(row.kind, 'kind');
  if (kind !== 'feedback' && kind !== 'suggestion') {
    throw new ApiError('DATABASE_ERROR', 500, '反馈类型错误');
  }
  return {
    id: requireString(row.id, 'id'),
    kind,
    title: requireString(row.title, 'title'),
    body: requireString(row.body, 'body'),
    likeCount: requireNonnegativeInteger(engagement.like_count, 'like_count'),
    createdAt: requireString(row.created_at, 'created_at')
  };
}

/** 公开列表按原始候选逐行隔离格式损坏，游标仍由调用方使用原始行生成。 */
function mapPublicRows<T>(
  rows: unknown[],
  mapRow: (value: unknown) => T
): T[] {
  const items: T[] = [];
  for (const row of rows) {
    try {
      items.push(mapRow(row));
    } catch (error) {
      if (!(error instanceof ApiError) && !(error instanceof z.ZodError)) {
        throw error;
      }
    }
  }
  return items;
}

function requireRelationRecord(
  value: unknown,
  context: string
): Record<string, unknown> {
  if (Array.isArray(value)) {
    if (value.length !== 1) {
      throw new ApiError('DATABASE_ERROR', 500, `${context}关系数量错误`);
    }
    return requireRecord(value[0], context);
  }
  return requireRecord(value, context);
}

function mapAsset(value: unknown): SubmissionAsset {
  const row = requireRecord(value, '投稿资产');
  const role = requireString(row.role, 'role');
  if (role !== 'cover' && role !== 'package' && role !== 'derived') {
    throw new ApiError('DATABASE_ERROR', 500, 'role字段格式错误');
  }
  return {
    role,
    storageKey: requireString(row.object_key, 'object_key'),
    fileName: requireString(row.original_name, 'original_name'),
    declaredBytes: requireInteger(row.declared_size, 'declared_size'),
    actualBytes: optionalInteger(row.actual_size, 'actual_size'),
    contentType: requireString(row.mime_type, 'mime_type')
  };
}

function requireData(result: RdbResult, context: string): unknown {
  if (result.error) {
    console.error('[cloudbase-rdb]', {
      code: diagnosticCode(result.error.code),
      message: diagnosticMessage(result.error.message)
    });
    throw new ApiError('DATABASE_ERROR', 500, `${context}：${result.error.message}`);
  }
  return result.data;
}

/** 只保留排障所需字段，并遮蔽可能被上游错误信息带出的凭据。 */
function diagnosticMessage(value: string): string {
  return value
    .replace(/Bearer\s+\S+/giu, 'Bearer [REDACTED]')
    .replace(
      /\b(secret|token|password|api[-_ ]?key)\b\s*[:=]\s*\S+/giu,
      '$1=[REDACTED]'
    )
    .slice(0, 500);
}

function diagnosticCode(value: string | undefined): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,64}$/u.test(value)
    ? value
    : null;
}

function requireRows(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ApiError('DATABASE_ERROR', 500, `${context}返回格式错误`);
  }
  return value;
}

function requireRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ApiError('DATABASE_ERROR', 500, `${context}返回格式错误`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new ApiError('DATABASE_ERROR', 500, `${field}字段格式错误`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return requireString(value, field);
}

function requireInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new ApiError('DATABASE_ERROR', 500, `${field}字段格式错误`);
  }
  return value;
}

function requireNonnegativeInteger(value: unknown, field: string): number {
  const integer = requireInteger(value, field);
  if (integer < 0) {
    throw new ApiError('DATABASE_ERROR', 500, `${field}字段不能为负数`);
  }
  return integer;
}

function optionalInteger(value: unknown, field: string): number | null {
  if (value === null) return null;
  return requireInteger(value, field);
}

function optionalNumber(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ApiError('DATABASE_ERROR', 500, `${field}字段格式错误`);
  }
  return value;
}

function requireSuggestion(
  value: unknown
): AdminModerationResult['suggestion'] {
  if (value === 'Pass' || value === 'Review' || value === 'Block') {
    return value;
  }
  throw new ApiError('DATABASE_ERROR', 500, 'suggestion字段格式错误');
}

function requireAdminAction(value: unknown): AdminAuditLog['action'] {
  for (const option of adminActionSchema.options) {
    const result = option.shape.action.safeParse(value);
    if (result.success) return result.data;
  }
  throw new ApiError('DATABASE_ERROR', 500, 'action字段格式错误');
}

function decodeOptionalCursor(
  cursor: string | null | undefined,
  scope: KeysetCursorScope
): { sortTime: string; id: string } | null {
  return cursor === undefined || cursor === null
    ? null
    : decodeKeysetCursor(cursor, scope);
}

function nextCursor(
  rows: unknown[],
  limit: number,
  scope: KeysetCursorScope,
  sortColumn: 'published_at' | 'created_at'
): string | null {
  if (rows.length <= limit) return null;
  const boundary = requireRecord(rows[limit - 1], '列表游标边界');
  return encodeKeysetCursor(
    scope,
    requireString(boundary[sortColumn], sortColumn),
    requireString(boundary.id, 'id')
  );
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ApiError('DATABASE_ERROR', 500, `${field}字段格式错误`);
  }
  return value;
}

function requireHash(value: string): void {
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new ApiError('INVALID_STATUS_TOKEN_HASH', 400);
  }
}

function requireLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new ApiError('INVALID_LIMIT', 400);
  }
}

function throwPublicNotFound(result: RdbResult): void {
  if (result.error?.code === 'P0002') {
    throw new ApiError('NOT_FOUND', 404);
  }
}

/** 点赞与下载共享互动 RPC 错误协议，动作结果字段仍分别解析。 */
function requirePublicInteractionRow(
  result: RdbResult,
  errorContext: string,
  resultContext: string
): Record<string, unknown> {
  throwPublicNotFound(result);
  if (result.error?.code === 'P1001') {
    throw new ApiError('IDEMPOTENCY_CONFLICT', 409, result.error.message);
  }
  const row = requireRecord(requireData(result, errorContext), resultContext);
  if (row.rate_limited === true) {
    const retryAfterSeconds = requireNonnegativeInteger(
      row.retry_after_seconds,
      'retry_after_seconds'
    );
    if (retryAfterSeconds < 1) {
      throw new ApiError('DATABASE_ERROR', 500, 'retry_after_seconds字段必须为正数');
    }
    throw new ApiError(
      'RATE_LIMITED',
      429,
      '请求超过固定窗口限制',
      retryAfterSeconds
    );
  }
  if (row.not_found === true) {
    throw new ApiError('NOT_FOUND', 404, '公开投稿不存在');
  }
  return row;
}

function asRpcError(value: unknown): {
  code?: string;
  message?: string;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }

  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.code === 'string' ? { code: record.code } : {}),
    ...(typeof record.message === 'string' ? { message: record.message } : {})
  };
}
