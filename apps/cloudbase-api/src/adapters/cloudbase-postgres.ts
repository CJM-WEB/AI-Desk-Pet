import { submissionStatusSchema } from '@myself/shared-types';

import { ApiError } from '../errors.js';
import type {
  AdminActionInput,
  AdminActionResult,
  CompleteUploadInput,
  ModerationRecord,
  NewSubmission,
  PublicListQuery,
  PublicSubmission,
  PublicSubmissionPage,
  SubmissionRow,
  SubmissionStatusView,
  SubmissionStore
} from '../ports.js';

interface RdbError {
  code?: string;
  message: string;
}

interface RdbResult {
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
  rpc(name: string, params: Record<string, unknown>): PromiseLike<RdbResult>;
}

export interface CloudBaseRdbApp {
  rdb(): CloudBaseRdbClient;
}

/**
 * 使用服务端 app.rdb() 访问 PostgreSQL。
 * 并发租约和管理员写操作固定下推到数据库函数，避免客户端读改写竞争。
 */
export class CloudBasePostgresStore implements SubmissionStore {
  private readonly database: CloudBaseRdbClient;

  constructor(app: CloudBaseRdbApp) {
    this.database = app.rdb();
  }

  async createSubmission(input: NewSubmission): Promise<SubmissionRow> {
    requireHash(input.statusTokenHash);
    await requireSuccess(
      this.database.from('submissions').insert({
        id: input.id,
        status_token_hash: input.statusTokenHash
      }),
      '创建投稿失败'
    );
    return this.findSubmission(input.id);
  }

  async completeUpload(input: CompleteUploadInput): Promise<SubmissionRow> {
    await requireSuccess(
      this.database
        .from('submissions')
        .update({ status: 'system_reviewing' })
        .eq('id', input.submissionId)
        .eq('status', 'uploading'),
      '完成上传失败'
    );
    return this.findSubmission(input.submissionId);
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
    requireLimit(limit);
    const result = await this.database.rpc('claim_moderation_jobs', {
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

  async applyAdminAction(input: AdminActionInput): Promise<AdminActionResult> {
    const result = await this.database.rpc('apply_admin_action', {
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
    if (result.error?.code === '22023') {
      throw new ApiError('IDEMPOTENCY_CONFLICT', 409, result.error.message);
    }

    const row = requireRecord(
      requireData(result, '执行管理员动作失败'),
      '管理员动作结果'
    );
    return {
      submission: mapSubmission(row.submission),
      replayed: requireBoolean(row.replayed, 'replayed')
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

  private async findSubmission(id: string): Promise<SubmissionRow> {
    const result = await this.database
      .from('submissions')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    const data = requireData(result, '查询投稿失败');
    if (data === null) throw new ApiError('SUBMISSION_NOT_FOUND', 404);
    return mapSubmission(data);
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
    purgeAfter: optionalString(row.purge_after, 'purge_after'),
    createdAt: requireString(row.created_at, 'created_at'),
    updatedAt: requireString(row.updated_at, 'updated_at')
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

async function requireSuccess(
  operation: PromiseLike<RdbResult>,
  context: string
): Promise<void> {
  requireData(await operation, context);
}

function requireData(result: RdbResult, context: string): unknown {
  if (result.error) {
    throw new ApiError('DATABASE_ERROR', 500, `${context}：${result.error.message}`);
  }
  return result.data;
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
