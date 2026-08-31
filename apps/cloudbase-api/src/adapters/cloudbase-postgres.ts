import {
  adminActionSchema,
  adminActionResultSchema,
  publicationBasisSchema,
  submissionStatusSchema
} from '@myself/shared-types';
import { z } from 'zod';

import { ApiError } from '../errors.js';
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
  ApplyModerationDecisionInput,
  CompleteUploadInput,
  ModerationRecord,
  NewSubmission,
  NewTextSubmission,
  PublicDownloadResult,
  PublicInteractionStore,
  PublicLikeInput,
  PublicLikeResult,
  PublicListQuery,
  PublishedCommunityPage,
  PublishedCommunityRecord,
  PublishedFeedbackPage,
  PublishedFeedbackRecord,
  SecurityStore,
  PublicSubmission,
  PublicSubmissionPage,
  RecordModerationFailureInput,
  SubmissionAsset,
  SubmissionRow,
  SubmissionStatusView,
  SubmissionStore,
  ModerationJobStore,
  CleanupStore,
  MarkPurgedInput,
  SubmissionWithAssets
} from '../ports.js';

export interface RdbError {
  code?: string;
  message: string;
}

export interface RdbResult {
  data: unknown;
  error: RdbError | null;
}

/** CloudBase PostgreSQL 客户端在本仓储中使用的最小链式查询表面。 */
export interface CloudBaseRdbQuery extends PromiseLike<RdbResult> {
  insert(values: unknown): CloudBaseRdbQuery;
  update(values: unknown): CloudBaseRdbQuery;
  upsert(values: unknown, options?: Record<string, unknown>): CloudBaseRdbQuery;
  select(columns?: string): CloudBaseRdbQuery;
  eq(column: string, value: unknown): CloudBaseRdbQuery;
  lte(column: string, value: unknown): CloudBaseRdbQuery;
  not(column: string, operator: string, value: unknown): CloudBaseRdbQuery;
  order(column: string, options: { ascending: boolean }): CloudBaseRdbQuery;
  limit(maximum: number): CloudBaseRdbQuery;
  range(from: number, to: number): CloudBaseRdbQuery;
  single(): CloudBaseRdbQuery;
  maybeSingle(): CloudBaseRdbQuery;
}

/** 通过结构类型兼容 CloudBase SDK，并便于测试注入内存替身。 */
export interface CloudBaseRdbClient {
  from(table: string): CloudBaseRdbQuery;
}

export interface CloudBasePostgresRpc {
  rpc(name: string, params: Record<string, unknown>): Promise<RdbResult>;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** 使用独立 service_role API Key 调用数据库函数，不依赖表查询 SDK 的能力。 */
export class CloudBasePostgresRpcClient implements CloudBasePostgresRpc {
  constructor(
    private readonly envId: string,
    private readonly apiKey: string,
    private readonly fetcher: FetchLike = fetch
  ) {}

  async rpc(name: string, params: Record<string, unknown>): Promise<RdbResult> {
    const url = `https://${this.envId}.api.tcloudbasegateway.com`
      + `/v1/rdb/rest/rpc/${encodeURIComponent(name)}`;

    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(params)
      });
    } catch {
      return {
        data: null,
        error: { message: 'RPC 请求失败' }
      };
    }

    const payload = await readJsonResponse(response);
    if (response.ok) {
      if (payload.parseFailed) {
        return {
          data: null,
          error: { message: 'RPC 响应格式错误' }
        };
      }
      return { data: payload.value, error: null };
    }

    const error = asRpcError(payload.value);
    return {
      data: null,
      error: {
        ...(error.code ? { code: error.code } : {}),
        message: error.message ?? `RPC 请求失败（HTTP ${response.status}）`
      }
    };
  }
}

/**
 * 使用服务端 app.rdb() 的表客户端访问 PostgreSQL。
 * 并发租约和管理员写操作固定下推到数据库函数，避免客户端读改写竞争。
 */
export class CloudBasePostgresStore implements
  SubmissionStore,
  ModerationJobStore,
  SecurityStore,
  PublicInteractionStore,
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

  async togglePublicLike(input: PublicLikeInput): Promise<PublicLikeResult> {
    requireHash(input.fingerprintHash);
    const result = await this.rpcClient.rpc('toggle_public_like', {
      p_submission_id: input.submissionId,
      p_fingerprint_hash: input.fingerprintHash
    });
    throwPublicNotFound(result);
    const row = requireRecord(requireData(result, '切换点赞失败'), '点赞结果');
    return {
      liked: requireBoolean(row.liked, 'liked'),
      likeCount: requireNonnegativeInteger(row.like_count, 'like_count')
    };
  }

  async recordPublicDownload(
    submissionId: string
  ): Promise<PublicDownloadResult> {
    const result = await this.rpcClient.rpc('record_public_download', {
      p_submission_id: submissionId
    });
    throwPublicNotFound(result);
    const row = requireRecord(requireData(result, '记录下载失败'), '下载结果');
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
    const rows = await this.listPublicRows('shared_package', input, true);
    return {
      items: rows.slice(0, input.limit).map(mapPublishedCommunity),
      nextCursor: rows.length > input.limit
        ? (input.cursor ?? 0) + input.limit
        : null
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
    const rows = await this.listPublicRows(kind, input, false);
    return {
      items: rows.slice(0, input.limit).map(mapPublishedFeedback),
      nextCursor: rows.length > input.limit
        ? (input.cursor ?? 0) + input.limit
        : null
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

  async claimModerationJobs(
    limit: number,
    leaseUntil: string
  ): Promise<SubmissionRow[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 3) {
      throw new ApiError('INVALID_LIMIT', 400);
    }
    const result = await this.rpcClient.rpc('claim_moderation_jobs', {
      p_limit: limit,
      p_lease_until: leaseUntil
    });
    return requireRows(requireData(result, '领取审核任务失败'), '审核任务')
      .map(mapSubmission);
  }

  async recordModerationResult(result: ModerationRecord): Promise<void> {
    await requireSuccess(
      this.database.from('moderation_results').insert({
        submission_id: result.submissionId,
        kind: result.kind,
        provider: result.provider,
        rule_version: result.ruleVersion,
        suggestion: result.suggestion,
        label: result.label,
        score: result.score,
        evidence: result.evidence,
        requested_at: result.requestedAt,
        completed_at: result.completedAt,
        error_message: result.errorMessage
      }),
      '保存审核结果失败'
    );
  }

  async applyModerationDecision(
    input: ApplyModerationDecisionInput
  ): Promise<boolean> {
    const row = requireRecord(
      requireData(await this.rpcClient.rpc('apply_moderation_decision', {
        p_submission_id: input.submissionId,
        p_expected_version: input.expectedVersion,
        p_next_status: input.nextStatus,
        p_results: input.results.map(toModerationRpcRecord),
        p_risk_summary: input.riskSummary,
        p_auto_rejection_reason: input.autoRejectionReason
      }), '应用系统审核决策失败'),
      '系统审核决策结果'
    );
    return requireBoolean(row.applied, 'applied');
  }

  async recordModerationFailure(
    input: RecordModerationFailureInput
  ): Promise<void> {
    requireData(await this.rpcClient.rpc('record_moderation_failure', {
      p_submission_id: input.submissionId,
      p_expected_version: input.expectedVersion,
      p_error_summary: input.errorSummary.slice(0, 200),
      p_results: input.results.map(toModerationRpcRecord)
    }), '记录系统审核失败状态失败');
  }

  async applyAdminAction(input: AdminActionInput): Promise<AdminActionResult> {
    const result = await this.rpcClient.rpc('apply_admin_action', {
      p_submission_id: input.submissionId,
      p_admin_id: input.adminId,
      p_action: input.action,
      p_next_status: input.nextStatus,
      p_expected_version: input.expectedVersion,
      p_idempotency_key: input.idempotencyKey,
      p_reason: input.reason
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
    const offset = input.cursor ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new ApiError('INVALID_CURSOR', 400);
    }
    let query = this.database
      .from('submissions')
      .select('*');
    if (input.status) query = query.eq('status', input.status);
    const result = await query
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + input.limit);
    const rows = requireRows(
      requireData(result, '查询管理员队列失败'),
      '管理员队列'
    );
    return {
      items: rows.slice(0, input.limit).map(mapAdminSubmission),
      nextCursor: rows.length > input.limit ? offset + input.limit : null
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

  async listPublished(input: PublicListQuery): Promise<PublicSubmissionPage> {
    requireLimit(input.limit);
    const offset = input.cursor ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new ApiError('INVALID_CURSOR', 400);
    }

    const result = await this.database
      .from('submissions')
      .select('id,title,body,published_at')
      .eq('status', 'published')
      .order('published_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + input.limit);
    const rows = requireRows(
      requireData(result, '查询公开投稿失败'),
      '公开投稿'
    );
    const hasMore = rows.length > input.limit;
    return {
      items: rows.slice(0, input.limit).map(mapPublicSubmission),
      nextCursor: hasMore ? offset + input.limit : null
    };
  }

  async listPurgeCandidates(now: string, limit: number): Promise<SubmissionRow[]> {
    requireLimit(limit);
    const result = await this.database
      .from('submissions')
      .select('*')
      .lte('purge_after', now)
      .not('status', 'eq', 'purged')
      .order('purge_after', { ascending: true })
      .order('id', { ascending: true })
      .limit(limit);
    return requireRows(
      requireData(result, '查询清理候选失败'),
      '清理候选'
    ).map(mapSubmission);
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

  private async listPublicRows(
    kind: 'shared_package' | 'feedback' | 'suggestion',
    input: PublicListQuery,
    includeAssets: boolean
  ): Promise<unknown[]> {
    requireLimit(input.limit);
    const offset = input.cursor ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new ApiError('INVALID_CURSOR', 400);
    }
    const result = await this.database
      .from('submissions')
      .select(includeAssets ? publicCommunityColumns : publicFeedbackColumns)
      .eq('status', 'published')
      .eq('kind', kind)
      .order('published_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + input.limit);
    return requireRows(requireData(result, '查询公开内容失败'), '公开内容');
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
  'assets(object_key,original_name,actual_size,mime_type,role)',
  'public_engagement(like_count,download_count)'
].join(',');

const publicFeedbackColumns = [
  'id',
  'kind',
  'title',
  'body',
  'created_at',
  'public_engagement(like_count)'
].join(',');

function mapPublishedCommunity(value: unknown): PublishedCommunityRecord {
  const row = requireRecord(value, '公开社区记录');
  const engagement = requireRelationRecord(
    row.public_engagement,
    '公开互动'
  );
  const assets = requireRows(row.assets, '公开资产').map(value => {
    const asset = requireRecord(value, '公开资产');
    const role = requireString(asset.role, 'role');
    if (role !== 'cover' && role !== 'package') {
      throw new ApiError('DATABASE_ERROR', 500, '公开资产角色错误');
    }
    const publicRole: 'cover' | 'package' = role;
    return {
      role: publicRole,
      storageKey: requireString(asset.object_key, 'object_key'),
      fileName: requireString(asset.original_name, 'original_name'),
      sizeBytes: requireNonnegativeInteger(asset.actual_size, 'actual_size'),
      contentType: requireString(asset.mime_type, 'mime_type')
    };
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
    publishedAt: requireString(row.published_at, 'published_at')
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

function toModerationRpcRecord(result: ModerationRecord): Record<string, unknown> {
  return {
    kind: result.kind,
    provider: result.provider,
    rule_version: result.ruleVersion,
    suggestion: result.suggestion,
    label: result.label,
    score: result.score,
    evidence: result.evidence,
    requested_at: result.requestedAt,
    completed_at: result.completedAt,
    error_message: result.errorMessage
  };
}

function mapPublicSubmission(value: unknown): PublicSubmission {
  const row = requireRecord(value, '公开投稿');
  return {
    id: requireString(row.id, 'id'),
    title: optionalString(row.title, 'title'),
    body: optionalString(row.body, 'body'),
    publishedAt: requireString(row.published_at, 'published_at')
  };
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

async function requireSuccess(
  operation: PromiseLike<RdbResult>,
  context: string
): Promise<void> {
  requireData(await operation, context);
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

async function readJsonResponse(response: Response): Promise<{
  parseFailed: boolean;
  value: unknown;
}> {
  const text = await response.text();
  if (!text) return { parseFailed: false, value: null };

  try {
    return { parseFailed: false, value: JSON.parse(text) as unknown };
  } catch {
    return { parseFailed: true, value: null };
  }
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
