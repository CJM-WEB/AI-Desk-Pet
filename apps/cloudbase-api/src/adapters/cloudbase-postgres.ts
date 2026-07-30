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
  SubmissionAsset,
  SubmissionRow,
  SubmissionStatusView,
  SubmissionStore,
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

/** 补齐 3.18.3 运行时已有但公开声明遗漏的 rdb 表客户端。 */
declare module '@cloudbase/node-sdk' {
  interface CloudBase {
    rdb(options?: {
      instance?: string;
      database?: string;
    }): CloudBaseRdbClient;
  }
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
export class CloudBasePostgresStore implements SubmissionStore {
  constructor(
    private readonly database: CloudBaseRdbClient,
    private readonly rpcClient: CloudBasePostgresRpc
  ) {}

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

function optionalInteger(value: unknown, field: string): number | null {
  if (value === null) return null;
  return requireInteger(value, field);
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
