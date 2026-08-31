import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import {
  CloudBasePostgresRpcClient,
  CloudBasePostgresStore
} from '../src/adapters/cloudbase-postgres.js';
import { SubmissionService } from '../src/services/submission-service.js';
import type {
  CloudBaseRdbClient
} from '../src/adapters/cloudbase-postgres.js';

const migrationPath = fileURLToPath(
  new URL('../../../cloudbase/migrations/20260730000000_moderation.sql', import.meta.url)
);
const keysetMigrationPath = fileURLToPath(
  new URL('../../../cloudbase/migrations/20260831030000_keyset_pagination.sql', import.meta.url)
);
describe('CloudBase PostgreSQL 迁移', () => {
  it('三条列表 RPC 使用真实键集列且不构造通用排序列', () => {
    const sql = readFileSync(keysetMigrationPath, 'utf8');

    expect(sql).toContain('CREATE FUNCTION list_public_community(');
    expect(sql).toContain('CREATE FUNCTION list_public_feedback(');
    expect(sql).toContain('CREATE FUNCTION list_admin_submissions(');
    expect(sql.match(/SECURITY DEFINER/g)).toHaveLength(3);
    expect(sql).toContain('(submission.published_at, submission.id) < (p_cursor_time, p_cursor_id)');
    expect(sql).toContain('(submission.created_at, submission.id) < (p_cursor_time, p_cursor_id)');
    expect(sql).not.toContain('sort_time');
  });
  it('迁移包含必要表、状态约束和版本条件更新', () => {
    const sql = readFileSync(migrationPath, 'utf8');

    for (const table of [
      'submissions',
      'assets',
      'moderation_results',
      'admin_audit_logs',
      'public_engagement',
      'captcha_replays',
      'abuse_counters',
      'engagement_votes'
    ]) {
      expect(sql).toContain(`CREATE TABLE ${table}`);
    }

    expect(sql).toContain('status_version');
    expect(sql).toContain('purge_after');
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain(
      'declared_size bigint NOT NULL CHECK (declared_size > 0)'
    );
    expect(sql).toContain("now() + interval '3 days'");
  });

  it('状态约束精确包含八种共享状态', () => {
    const sql = readFileSync(migrationPath, 'utf8');
    const statusCheck = sql.match(/CHECK\s*\(status IN\s*\(([^)]+)\)\)/)?.[1];

    expect(statusCheck?.match(/'[^']+'/g)).toEqual([
      "'uploading'",
      "'system_reviewing'",
      "'manual_review_pending'",
      "'published'",
      "'auto_rejected'",
      "'admin_rejected'",
      "'deleted_quarantined'",
      "'purged'"
    ]);
  });

  it('只保存唯一的状态查询令牌哈希', () => {
    const sql = readFileSync(migrationPath, 'utf8');

    expect(sql).toContain('status_token_hash char(64) NOT NULL UNIQUE');
    expect(sql).not.toMatch(/\bstatus_token\b(?!_hash)/);
  });

  it('业务表启用强制 RLS 且只授权 service_role', () => {
    const sql = readFileSync(migrationPath, 'utf8');

    for (const table of [
      'submissions',
      'assets',
      'moderation_results',
      'admin_audit_logs',
      'public_engagement',
      'captcha_replays',
      'abuse_counters',
      'engagement_votes'
    ]) {
      expect(sql).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      expect(sql).toContain(`REVOKE ALL ON TABLE ${table} FROM anon, authenticated`);
      expect(sql).toContain(`GRANT ALL ON TABLE ${table} TO service_role`);
    }
  });

  it('特权数据库函数显式校验 service_role 并收回公开执行权', () => {
    const sql = readFileSync(migrationPath, 'utf8');

    expect(sql.match(/SECURITY DEFINER/g)).toHaveLength(13);
    expect(sql.match(/request\.jwt\.claims/g)).toHaveLength(13);
    expect(sql.match(/<> 'service_role'/g)).toHaveLength(13);
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION create_submission(jsonb, jsonb) FROM PUBLIC, anon, authenticated'
    );
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION claim_moderation_jobs(integer, timestamptz) FROM PUBLIC, anon, authenticated'
    );
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION complete_submission_upload(text, jsonb) FROM PUBLIC, anon, authenticated'
    );
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION apply_admin_action(text, text, text, text, bigint, text, text) FROM PUBLIC, anon, authenticated'
    );
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION claim_cleanup_jobs(integer, timestamptz) FROM PUBLIC, anon, authenticated'
    );
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION mark_submission_purged(text, bigint) FROM PUBLIC, anon, authenticated'
    );
    for (const name of [
      'consume_captcha_ticket',
      'consume_abuse_limit',
      'create_text_submission',
      'toggle_public_like',
      'record_public_download'
    ]) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION ${name}`);
    }
  });

  it('系统审核使用数据库持久化重试和原子决策函数', () => {
    const sql = readFileSync(migrationPath, 'utf8');

    expect(sql).toContain('moderation_attempts integer NOT NULL DEFAULT 0');
    expect(sql).toContain('moderation_next_retry_at timestamptz');
    expect(sql).toContain('moderation_last_error varchar(200)');
    expect(sql).toContain('moderation_alerted_at timestamptz');
    expect(sql).toContain('CREATE FUNCTION apply_moderation_decision(');
    expect(sql).toContain('CREATE FUNCTION record_moderation_failure(');
    expect(sql).toContain('status_version = p_expected_version');
    expect(sql).toContain('moderation_attempts >= 4');
    expect(sql).toContain('moderation_attempts < 5');
    expect(sql).toContain('p_limit < 1 OR p_limit > 3');
    expect(sql).toContain("interval '10 minutes 5 seconds'");
    expect(sql).toContain(
      'status_version = submission.status_version + 1'
    );
    expect(sql.match(/jsonb_array_length\(p_results\) > 2500/g))
      .toHaveLength(2);
  });

  it('安全状态只保存哈希并由数据库原子消费', () => {
    const sql = readFileSync(migrationPath, 'utf8');

    expect(sql).toContain('ticket_hash char(64) PRIMARY KEY');
    expect(sql).toContain('fingerprint_hash char(64)');
    expect(sql).toContain('PRIMARY KEY (scope, fingerprint_hash, window_start)');
    expect(sql).toContain('PRIMARY KEY (submission_id, fingerprint_hash)');
    expect(sql).toContain('ON CONFLICT (ticket_hash) DO NOTHING');
    expect(sql).toContain('ON CONFLICT (scope, fingerprint_hash, window_start)');
    expect(sql).not.toMatch(/\buser_ip\b|\buser_agent\b/);
  });

  it('管理员动作同时具备版本条件更新和幂等请求保护', () => {
    const sql = readFileSync(migrationPath, 'utf8');

    expect(sql).toContain('idempotency_key text NOT NULL UNIQUE');
    expect(sql).toContain('AND status_version = p_expected_version');
    expect(sql).toContain('status_version = status_version + 1');
    expect(sql).toContain("'replayed', true");
    expect(sql).toContain("AND result.kind = 'package_scan'");
    expect(sql).toContain("AND result.suggestion = 'Pass'");
    expect(sql).toContain(
      "result.evidence ->> 'packageStorageKey' = asset.object_key"
    );
    expect(sql).toContain(
      "result.evidence ->> 'packageSizeBytes' = asset.actual_size::text"
    );
    expect(sql).toContain("USING ERRCODE = 'P1001'");
    expect(sql).toContain("USING ERRCODE = 'P1002'");
    expect(sql).toContain("USING ERRCODE = 'P1003'");
  });

  it('清理任务使用租约并覆盖三天隔离与一小时残缺上传', () => {
    const sql = readFileSync(migrationPath, 'utf8');

    expect(sql).toContain('CREATE FUNCTION claim_cleanup_jobs(');
    expect(sql).toContain('cleanup_started_at timestamptz');
    expect(sql).toContain('cleanup_started_at = COALESCE');
    expect(sql).toContain("status = 'uploading'");
    expect(sql).toContain("interval '1 hour'");
    expect(sql).toContain('submission.updated_at <=');
    expect(sql).not.toContain("submission.created_at <= now() - interval '1 hour'");
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain('CREATE FUNCTION mark_submission_purged(');
    expect(sql).toContain('DELETE FROM assets WHERE submission_id');
    expect(sql).toContain("status = 'purged'");
    expect(sql).toContain("evidence = '{}'::jsonb");
    expect(sql).toContain('v_cleanup_started_at IS NOT NULL');
  });

  it('发布动作写入发布时间且租约必须指向未来', () => {
    const sql = readFileSync(migrationPath, 'utf8');

    expect(sql).toContain(
      "WHEN p_next_status = 'published' THEN COALESCE(published_at, now())"
    );
    expect(sql).toMatch(
      /IF p_lease_until <= now\(\)\s+OR p_lease_until > now\(\) \+ interval '10 minutes 5 seconds' THEN/u
    );
    expect(sql).toMatch(
      /IF p_next_status = 'published' THEN\s+INSERT INTO public_engagement \(submission_id\)/u
    );
  });

  it('创建仅服务端可访问的私有对象存储桶', () => {
    const sql = readFileSync(migrationPath, 'utf8');

    expect(sql).toContain('INSERT INTO storage.buckets');
    expect(sql).toContain("'ai-pet-private', 'ai-pet-private', false");
    expect(sql).not.toMatch(
      /CREATE POLICY[\s\S]*bucket_id\s*=\s*'ai-pet-private'[\s\S]*TO\s+(?:anon|authenticated)/
    );
  });
});

interface MemorySubmission {
  id: string;
  kind: string;
  title: string | null;
  body: string | null;
  status: string;
  status_version: number;
  status_token_hash: string;
  public_reason: string | null;
  risk_summary: Record<string, unknown>;
  auto_rejection_reason: string | null;
  moderation_lease_until: string | null;
  cleanup_lease_until: string | null;
  cleanup_started_at: string | null;
  published_at: string | null;
  publication_basis: 'standard' | 'admin_override' | null;
  purge_after: string | null;
  created_at: string;
  updated_at: string;
}

interface MemoryAsset {
  submission_id: string;
  object_key: string;
  original_name: string;
  declared_size: number;
  actual_size: number | null;
  mime_type: string;
  role: string;
}

interface MemoryAudit {
  request: Record<string, unknown>;
  result: Record<string, unknown>;
}

interface QueryResult {
  data: unknown;
  error: { code?: string; message: string } | null;
}

/** 模拟 PostgreSQL JSONB ->>：只接受字符串或有限数值标量。 */
function jsonScalarText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/** 只模拟仓储使用到的 PostgREST 查询语义，并保存可观察的数据库状态。 */
class MemoryRdb {
  readonly submissions: MemorySubmission[] = [];
  readonly assets: MemoryAsset[] = [];
  rejectAssetCreation = false;
  readonly moderationResults: Array<Record<string, unknown>> = [];
  readonly audits = new Map<string, MemoryAudit>();
  readonly fromCalls: string[] = [];

  from(table: string): MemoryQuery {
    this.fromCalls.push(table);
    return new MemoryQuery(this, table);
  }

  async rpc(name: string, params: Record<string, unknown>): Promise<QueryResult> {
    if (name === 'list_admin_submissions') {
      return {
        data: this.keysetRows(
          this.submissions.filter(row =>
            params.p_status === null || row.status === params.p_status
          ),
          'created_at',
          params
        ),
        error: null
      };
    }

    if (name === 'list_public_community' || name === 'list_public_feedback') {
      const kind = name === 'list_public_community'
        ? 'shared_package'
        : params.p_kind;
      const rows = this.keysetRows(
        this.submissions.filter(row =>
          row.status === 'published' && row.kind === kind
        ),
        'published_at',
        params
      ).map(row => ({
        ...row,
        assets: this.assets
          .filter(asset => asset.submission_id === row.id)
          .map(asset => ({
            object_key: asset.object_key,
            original_name: asset.original_name,
            actual_size: asset.actual_size,
            mime_type: asset.mime_type,
            role: asset.role
          })),
        public_engagement: { like_count: 0, download_count: 0 }
      }));
      return { data: rows, error: null };
    }

    if (name === 'create_submission') {
      if (this.rejectAssetCreation) {
        return { data: null, error: { message: '资产写入失败' } };
      }

      const submission = params.p_submission as Record<string, unknown>;
      const assets = params.p_assets as Array<Record<string, unknown>>;
      const row = makeSubmission({
        id: submission.id as string,
        kind: submission.kind as string,
        title: submission.title as string,
        body: submission.body as string,
        status_token_hash: submission.status_token_hash as string,
        purge_after: '2026-08-03T00:00:00.000Z'
      });
      const assetRows = assets.map((asset) => ({
        submission_id: row.id,
        object_key: asset.storage_key as string,
        original_name: asset.file_name as string,
        declared_size: asset.declared_bytes as number,
        actual_size: null,
        mime_type: asset.content_type as string,
        role: asset.role as string
      }));
      this.submissions.push(row);
      this.assets.push(...assetRows);
      return { data: structuredClone(row), error: null };
    }

    if (name === 'claim_moderation_jobs') {
      const limit = params.p_limit as number;
      const leaseUntil = params.p_lease_until as string;
      const now = '2026-07-31T00:00:00.000Z';
      const claimed = this.submissions
        .filter((row) =>
          row.status === 'system_reviewing'
          && (row.moderation_lease_until === null || row.moderation_lease_until <= now)
        )
        .sort((left, right) =>
          left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id)
        )
        .slice(0, limit);

      for (const row of claimed) {
        row.moderation_lease_until = leaseUntil;
        row.updated_at = now;
      }

      return { data: structuredClone(claimed), error: null };
    }

    if (name === 'complete_submission_upload') {
      const row = this.submissions.find(
        candidate => candidate.id === params.p_submission_id
      );
      if (
        !row
        || row.status !== 'uploading'
        || row.cleanup_started_at !== null
      ) {
        return {
          data: null,
          error: { code: 'P1002', message: 'upload cannot be finalized' }
        };
      }
      const completedAssets = params.p_assets as Array<Record<string, unknown>>;
      for (const completed of completedAssets) {
        const asset = this.assets.find(candidate =>
          candidate.submission_id === row.id
          && candidate.role === completed.role
          && candidate.object_key === completed.storage_key
        );
        if (asset) asset.actual_size = completed.actual_bytes as number;
      }
      row.status = 'system_reviewing';
      row.status_version += 1;
      row.purge_after = null;
      row.updated_at = '2026-07-31T00:00:00.000Z';
      return { data: structuredClone(row), error: null };
    }

    if (name === 'apply_admin_action') {
      const idempotencyKey = params.p_idempotency_key as string;
      const request = structuredClone(params);
      const previous = this.audits.get(idempotencyKey);
      const fenced = this.submissions.find(
        candidate => candidate.id === params.p_submission_id
      );
      if (fenced && fenced.cleanup_started_at !== null) {
        return {
          data: null,
          error: { code: '40001', message: 'cleanup already started' }
        };
      }

      if (previous) {
        if (JSON.stringify(previous.request) !== JSON.stringify(request)) {
          return {
            data: null,
            error: { code: 'P1001', message: 'idempotency key reused' }
          };
        }

        return {
          data: { ...structuredClone(previous.result), replayed: true },
          error: null
        };
      }

      const row = this.submissions.find(
        (candidate) => candidate.id === params.p_submission_id
      );
      if (!row || row.status_version !== params.p_expected_version) {
        return {
          data: null,
          error: { code: '40001', message: 'submission version conflict' }
        };
      }

      const hasCurrentPackageScanEvidence = this.moderationResults.some((result) => {
        const evidence = result.evidence;
        if (
          result.submission_id !== row.id
          || result.kind !== 'package_scan'
          || result.provider !== 'isolated-scanner'
          || result.suggestion !== 'Pass'
          || typeof evidence !== 'object'
          || evidence === null
          || Array.isArray(evidence)
        ) {
          return false;
        }
        const evidenceRecord = evidence as Record<string, unknown>;
        const completedAt = new Date(String(evidenceRecord.completedAt)).getTime();
        const expiresAt = new Date(String(evidenceRecord.expiresAt)).getTime();
        return this.assets.some((asset) =>
          asset.submission_id === row.id
          && asset.role === 'package'
          && asset.actual_size !== null
          && evidenceRecord.submissionId === row.id
          && evidenceRecord.packageStorageKey === asset.object_key
          && jsonScalarText(evidenceRecord.packageSizeBytes) === String(asset.actual_size)
          && jsonScalarText(evidenceRecord.archiveSizeBytes) === String(asset.actual_size)
          && typeof evidenceRecord.archiveSha256 === 'string'
          && /^[a-f0-9]{64}$/u.test(evidenceRecord.archiveSha256)
          && evidenceRecord.protocolVersion === '2026-08-15'
          && evidenceRecord.ruleVersion === 'character-package-2026-08-15'
          && jsonScalarText(evidenceRecord.submissionStatusVersion)
            === String(params.p_expected_version)
          && evidenceRecord.scanCode === 'CHARACTER_PACKAGE_SCAN_PASSED'
          && Number.isFinite(completedAt)
          && expiresAt - completedAt === 24 * 60 * 60 * 1_000
          && expiresAt > new Date('2026-07-31T00:00:00.000Z').getTime()
        );
      });
      if (
        params.p_action === 'approve'
        && row.status !== 'published'
        && row.kind === 'shared_package'
        && !hasCurrentPackageScanEvidence
      ) {
        return {
          data: null,
          error: { code: 'P1003', message: 'technical scan required' }
        };
      }

      row.status = params.p_next_status as string;
      row.status_version += 1;
      const result = {
        submission: {
          id: row.id,
          kind: row.kind,
          status: row.status,
          status_version: row.status_version,
          publication_basis: row.status === 'published'
            ? (params.p_action === 'force_publish' ? 'admin_override' : 'standard')
            : null,
          public_reason: row.public_reason,
          published_at: row.published_at,
          rejected_at: null,
          quarantined_at: null,
          created_at: row.created_at,
          updated_at: row.updated_at
        },
        replayed: false
      };
      this.audits.set(idempotencyKey, { request, result });
      return { data: structuredClone(result), error: null };
    }

    return { data: null, error: { message: `未知 RPC：${name}` } };
  }

  /** 测试替身独立模拟 PostgreSQL tuple 比较，不调用生产游标 codec。 */
  private keysetRows(
    rows: MemorySubmission[],
    sortColumn: 'published_at' | 'created_at',
    params: Record<string, unknown>
  ): MemorySubmission[] {
    const cursorTime = params.p_cursor_time;
    const cursorId = params.p_cursor_id;
    return rows
      .filter(row => {
        if (cursorTime === null || cursorTime === undefined) return true;
        const time = String(row[sortColumn] ?? '');
        return time < cursorTime
          || (time === cursorTime && row.id < String(cursorId));
      })
      .sort((left, right) => {
        const time = String(right[sortColumn] ?? '')
          .localeCompare(String(left[sortColumn] ?? ''));
        return time || right.id.localeCompare(left.id);
      })
      .slice(0, Number(params.p_limit) + 1)
      .map(row => structuredClone(row));
  }
}

type Filter =
  | { operator: 'eq' | 'lte' | 'not-eq'; column: string; value: unknown };

/** 支持链式调用和 await，行为与仓储使用的 SDK 子集一致。 */
class MemoryQuery implements PromiseLike<QueryResult> {
  private operation: 'select' | 'insert' | 'update' | 'upsert' = 'select';
  private values: Record<string, unknown> | Array<Record<string, unknown>> | null = null;
  private selectedColumns = '*';
  private readonly filters: Filter[] = [];
  private readonly orderings: Array<{ column: string; ascending: boolean }> = [];
  private maximum: number | null = null;
  private singleMode: 'none' | 'single' | 'maybeSingle' = 'none';

  constructor(
    private readonly database: MemoryRdb,
    private readonly table: string
  ) {}

  insert(values: Record<string, unknown> | Array<Record<string, unknown>>): this {
    this.operation = 'insert';
    this.values = values;
    return this;
  }

  update(values: Record<string, unknown>): this {
    this.operation = 'update';
    this.values = values;
    return this;
  }

  upsert(values: Record<string, unknown>): this {
    this.operation = 'upsert';
    this.values = values;
    return this;
  }

  select(columns = '*'): this {
    this.selectedColumns = columns;
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push({ operator: 'eq', column, value });
    return this;
  }

  lte(column: string, value: unknown): this {
    this.filters.push({ operator: 'lte', column, value });
    return this;
  }

  not(column: string, operator: string, value: unknown): this {
    if (operator !== 'eq') throw new Error(`不支持的 not 运算符：${operator}`);
    this.filters.push({ operator: 'not-eq', column, value });
    return this;
  }

  order(column: string, options: { ascending: boolean }): this {
    this.orderings.push({ column, ascending: options.ascending });
    return this;
  }

  limit(maximum: number): this {
    this.maximum = maximum;
    return this;
  }

  single(): this {
    this.singleMode = 'single';
    return this;
  }

  maybeSingle(): this {
    this.singleMode = 'maybeSingle';
    return this;
  }

  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private async execute(): Promise<QueryResult> {
    if (this.table === 'moderation_results' && this.operation === 'insert') {
      const values = Array.isArray(this.values) ? this.values : [this.values ?? {}];
      this.database.moderationResults.push(...structuredClone(values));
      return { data: null, error: null };
    }

    if (this.table === 'assets') {
      if (this.operation === 'insert') {
        const values = Array.isArray(this.values) ? this.values : [this.values ?? {}];
        this.database.assets.push(...values.map((value) => ({
          ...structuredClone(value),
          actual_size: null
        })) as unknown as MemoryAsset[]);
        return { data: null, error: null };
      }

      const rows = this.database.assets.filter((row) =>
        this.filters.every((filter) => {
          const value = row[filter.column as keyof MemoryAsset];
          if (filter.operator === 'eq') return value === filter.value;
          if (filter.operator === 'not-eq') return value !== filter.value;
          return String(value) <= String(filter.value);
        })
      );
      return {
        data: rows.map((row) => Object.fromEntries(
          this.selectedColumns === '*'
            ? Object.entries(structuredClone(row))
            : this.selectedColumns.split(',').map((column) => {
              const normalized = column.trim();
              return [normalized, row[normalized as keyof MemoryAsset]];
            })
        )),
        error: null
      };
    }

    if (this.table !== 'submissions') {
      return { data: null, error: { message: `未知数据表：${this.table}` } };
    }

    if (this.operation === 'insert') {
      const value = Array.isArray(this.values) ? this.values[0] : this.values;
      if (!value) return { data: null, error: { message: '缺少插入数据' } };
      const row = makeSubmission({
        id: value.id as string,
        status_token_hash: value.status_token_hash as string,
        kind: value.kind as string,
        title: value.title as string,
        body: value.body as string
      });
      this.database.submissions.push(row);
    } else if (this.operation === 'update') {
      for (const row of this.filteredRows()) {
        Object.assign(row, this.values);
      }
    } else if (this.operation === 'upsert') {
      const value = this.values as Record<string, unknown>;
      const existing = this.database.submissions.find((row) => row.id === value.id);
      if (existing) Object.assign(existing, value);
      else if (typeof value.id === 'string') {
        this.database.submissions.push(makeSubmission({ id: value.id }));
      } else {
        return { data: null, error: { message: '缺少投稿 ID' } };
      }
    }

    const rows = this.filteredRows();
    for (const ordering of [...this.orderings].reverse()) {
      rows.sort((left, right) => {
        const comparison = String(left[ordering.column as keyof MemorySubmission] ?? '')
          .localeCompare(String(right[ordering.column as keyof MemorySubmission] ?? ''));
        return ordering.ascending ? comparison : -comparison;
      });
    }

    const sliced = rows.slice(0, this.maximum ?? undefined);
    const selected = sliced.map((row) => this.pickColumns(row));

    if (this.singleMode === 'single') {
      return selected.length === 1
        ? { data: selected[0], error: null }
        : { data: null, error: { code: 'PGRST116', message: '应返回一行' } };
    }
    if (this.singleMode === 'maybeSingle') {
      return selected.length <= 1
        ? { data: selected[0] ?? null, error: null }
        : { data: null, error: { code: 'PGRST116', message: '返回多行' } };
    }
    return { data: selected, error: null };
  }

  private filteredRows(): MemorySubmission[] {
    return this.database.submissions.filter((row) =>
      this.filters.every((filter) => {
        const value = row[filter.column as keyof MemorySubmission];
        if (filter.operator === 'eq') return value === filter.value;
        if (filter.operator === 'not-eq') return value !== filter.value;
        return String(value) <= String(filter.value);
      })
    );
  }

  private pickColumns(row: MemorySubmission): Record<string, unknown> {
    if (this.selectedColumns === '*') {
      return Object.fromEntries(Object.entries(structuredClone(row)));
    }
    return Object.fromEntries(
      this.selectedColumns.split(',').map((column) => {
        const normalized = column.trim();
        return [normalized, row[normalized as keyof MemorySubmission]];
      })
    );
  }
}

function makeSubmission(
  input: Partial<MemorySubmission> & Pick<MemorySubmission, 'id'>
): MemorySubmission {
  return {
    id: input.id,
    kind: input.kind ?? 'resource',
    title: input.title ?? null,
    body: input.body ?? null,
    status: input.status ?? 'uploading',
    status_version: input.status_version ?? 0,
    status_token_hash: input.status_token_hash ?? 'a'.repeat(64),
    public_reason: input.public_reason ?? null,
    risk_summary: input.risk_summary ?? {},
    auto_rejection_reason: input.auto_rejection_reason ?? null,
    moderation_lease_until: input.moderation_lease_until ?? null,
    cleanup_lease_until: input.cleanup_lease_until ?? null,
    cleanup_started_at: input.cleanup_started_at ?? null,
    published_at: input.published_at ?? null,
    publication_basis: input.publication_basis ?? null,
    purge_after: input.purge_after ?? null,
    created_at: input.created_at ?? '2026-07-30T00:00:00.000Z',
    updated_at: input.updated_at ?? '2026-07-30T00:00:00.000Z'
  };
}

function createStore(database = new MemoryRdb()): {
  database: MemoryRdb;
  store: CloudBasePostgresStore;
} {
  return {
    database,
    store: new CloudBasePostgresStore(database, database)
  };
}

function completedAssets(submissionId: string) {
  return [
    {
      role: 'cover' as const,
      storageKey: `submissions/${submissionId}/cover.webp`,
      actualBytes: 512,
      contentType: 'image/webp'
    },
    {
      role: 'package' as const,
      storageKey: `submissions/${submissionId}/package.zip`,
      actualBytes: 1024,
      contentType: 'application/zip'
    }
  ];
}

function newSubmission(id: string): {
  id: string;
  kind: 'shared_package';
  title: string;
  body: string;
  statusTokenHash: string;
  assets: Array<{
    role: 'cover' | 'package';
    storageKey: string;
    fileName: string;
    declaredBytes: number;
    contentType: string;
  }>;
} {
  return {
    id,
    kind: 'shared_package',
    title: '测试投稿',
    body: '测试正文',
    statusTokenHash: 'b'.repeat(64),
    assets: [
      {
        role: 'cover',
        storageKey: `submissions/${id}/cover.webp`,
        fileName: 'cover.webp',
        declaredBytes: 512,
        contentType: 'image/webp'
      },
      {
        role: 'package',
        storageKey: `submissions/${id}/package.zip`,
        fileName: 'pet.zip',
        declaredBytes: 1024,
        contentType: 'application/zip'
      }
    ]
  };
}

describe('CloudBase PostgreSQL RPC 客户端', () => {
  it('真实 Node SDK 的 rdb 返回值可作为仅表查询客户端', () => {
    expectTypeOf<CloudBaseRdbClient>().not.toHaveProperty('rpc');
  });

  it('使用 service_role API Key 调用指定环境的 RPC 端点', async () => {
    const fetcher = vi.fn(async () => new Response(
      JSON.stringify([{ id: 'submission-1' }]),
      {
        status: 200,
        headers: { 'content-type': 'application/json' }
      }
    ));
    const client = new CloudBasePostgresRpcClient(
      'env-test',
      'service-role-key',
      undefined,
      fetcher
    );

    await expect(client.rpc('claim_moderation_jobs', {
      p_limit: 1,
      p_lease_until: '2026-07-31T01:00:00.000Z'
    })).resolves.toEqual({
      data: [{ id: 'submission-1' }],
      error: null
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
      'https://env-test.api.tcloudbasegateway.com/v1/rdb/rest/rpc/claim_moderation_jobs',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer service-role-key',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          p_limit: 1,
          p_lease_until: '2026-07-31T01:00:00.000Z'
        }),
        signal: expect.any(AbortSignal)
      }
    );
  });

  it('归一化 PostgREST RPC 错误而不抛出响应正文', async () => {
    const fetcher = vi.fn(async () => new Response(
      JSON.stringify({
        code: '40001',
        message: 'submission version conflict'
      }),
      {
        status: 409,
        headers: { 'content-type': 'application/json' }
      }
    ));
    const client = new CloudBasePostgresRpcClient(
      'env-test',
      'service-role-key',
      undefined,
      fetcher
    );

    await expect(client.rpc('apply_admin_action', {})).resolves.toEqual({
      data: null,
      error: {
        code: '40001',
        message: 'submission version conflict'
      }
    });
  });
});

describe('CloudBase PostgreSQL 安全与公开互动存储', () => {
  it('通过具名 RPC 原子消费验证码和限流计数', async () => {
    const rpc = {
      rpc: vi.fn()
        .mockResolvedValueOnce({
          data: { allowed: false, retry_after_seconds: 37 },
          error: null
        })
    };
    const store = new CloudBasePostgresStore({ from: vi.fn() } as never, rpc);

    await expect(store.consumeAbuseLimit({
      scope: 'status_query',
      fingerprintHash: 'b'.repeat(64),
      maximum: 30,
      windowSeconds: 60
    })).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 37
    });
    expect(rpc.rpc).toHaveBeenNthCalledWith(1, 'consume_abuse_limit', {
      p_scope: 'status_query',
      p_fingerprint_hash: 'b'.repeat(64),
      p_maximum: 30,
      p_window_seconds: 60
    });
  });

  it('文本投稿、点赞和下载只调用数据库原子函数', async () => {
    const rpc = {
      rpc: vi.fn()
        .mockResolvedValueOnce({
          data: {
            id: 'feedback-1',
            status: 'system_reviewing',
            status_version: 0,
            kind: 'feedback',
            title: '匿名用户',
            body: '建议正文',
            moderation_lease_until: null,
            purge_after: null,
            published_at: null,
            publication_basis: null,
            created_at: '2026-07-31T00:00:00.000Z',
            updated_at: '2026-07-31T00:00:00.000Z'
          },
          error: null
        })
        .mockResolvedValueOnce({
          data: { liked: true, like_count: 2 },
          error: null
        })
        .mockResolvedValueOnce({
          data: { download_count: 4 },
          error: null
        })
    };
    const store = new CloudBasePostgresStore({ from: vi.fn() } as never, rpc);

    await expect(store.createTextSubmission({
      id: 'feedback-1',
      kind: 'feedback',
      title: '匿名用户',
      body: '建议正文',
      statusTokenHash: 'c'.repeat(64)
    })).resolves.toMatchObject({
      id: 'feedback-1',
      status: 'system_reviewing'
    });
    await expect(store.togglePublicLike({
      submissionId: 'community-1',
      fingerprintHash: 'd'.repeat(64)
    })).resolves.toEqual({ liked: true, likeCount: 2 });
    await expect(store.recordPublicDownload('community-1'))
      .resolves.toEqual({ downloadCount: 4 });
    expect(rpc.rpc.mock.calls.map(([name]) => name)).toEqual([
      'create_text_submission',
      'toggle_public_like',
      'record_public_download'
    ]);
  });

  it('公开社区关系结果映射为不含内部字段的具名记录', async () => {
    const result = {
      data: [{
        id: 'community-1',
        title: '共享名称',
        body: '共享说明',
        published_at: '2026-07-31T00:00:00.000Z',
        publication_basis: 'admin_override',
        assets: [
          {
            object_key: 'submissions/community-1/cover.webp',
            original_name: 'cover.webp',
            actual_size: 512,
            mime_type: 'image/webp',
            role: 'cover'
          },
          {
            object_key: 'submissions/community-1/package.zip',
            original_name: 'pet.zip',
            actual_size: 1024,
            mime_type: 'application/zip',
            role: 'package'
          }
        ],
        public_engagement: {
          like_count: 2,
          download_count: 3
        },
        status_token_hash: '不得返回'
      }],
      error: null
    };
    const rpc = { rpc: vi.fn().mockResolvedValue(result) };
    const store = new CloudBasePostgresStore(
      { from: vi.fn() } as never,
      rpc
    );

    await expect(store.listPublicCommunity({ limit: 20 })).resolves.toEqual({
      items: [{
        id: 'community-1',
        title: '共享名称',
        body: '共享说明',
        assets: [
          {
            role: 'cover',
            storageKey: 'submissions/community-1/cover.webp',
            fileName: 'cover.webp',
            sizeBytes: 512,
            contentType: 'image/webp'
          },
          {
            role: 'package',
            storageKey: 'submissions/community-1/package.zip',
            fileName: 'pet.zip',
            sizeBytes: 1024,
            contentType: 'application/zip'
          }
        ],
        likeCount: 2,
        downloadCount: 3,
        publishedAt: '2026-07-31T00:00:00.000Z',
        publicationBasis: 'admin_override'
      }],
      nextCursor: null
    });
    expect(rpc.rpc).toHaveBeenCalledWith('list_public_community', {
      p_limit: 20,
      p_cursor_time: null,
      p_cursor_id: null
    });
  });

  it('公开社区详情只披露发布依据枚举而不泄漏管理员与扫描字段', async () => {
    const detail = {
      id: 'community-detail',
      title: '人工放行资源',
      body: '公开说明',
      published_at: '2026-08-31T00:00:00.000Z',
      publication_basis: 'admin_override',
      assets: [{
        object_key: 'submissions/community-detail/package.zip',
        original_name: 'pet.zip',
        actual_size: 1024,
        mime_type: 'application/zip',
        role: 'package'
      }],
      public_engagement: { like_count: 0, download_count: 0 },
      admin_id: '不得公开',
      reason: '不得公开',
      risk_summary: { internal: true }
    };
    const query: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const method of ['select', 'eq']) {
      query[method] = vi.fn(() => query);
    }
    query.maybeSingle = vi.fn(async () => ({ data: detail, error: null }));
    const store = new CloudBasePostgresStore(
      { from: vi.fn(() => query) } as never,
      { rpc: vi.fn() }
    );

    await expect(store.findPublicCommunity('community-detail')).resolves.toEqual({
      id: 'community-detail',
      title: '人工放行资源',
      body: '公开说明',
      assets: [{
        role: 'package',
        storageKey: 'submissions/community-detail/package.zip',
        fileName: 'pet.zip',
        sizeBytes: 1024,
        contentType: 'application/zip'
      }],
      likeCount: 0,
      downloadCount: 0,
      publishedAt: '2026-08-31T00:00:00.000Z',
      publicationBasis: 'admin_override'
    });
  });
});

describe('CloudBase PostgreSQL RPC 远程边界', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('等待响应头达到总 deadline 时返回稳定超时错误', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn((_input: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      }));
    const client = new CloudBasePostgresRpcClient(
      'env-test',
      'service-role-key',
      { timeoutMs: 25, maxResponseBytes: 1024 },
      fetcher
    );

    const pending = client.rpc('claim_moderation_jobs', {});
    await vi.advanceTimersByTimeAsync(25);

    await expect(pending).resolves.toEqual({
      data: null,
      error: { message: 'RPC 请求超时' }
    });
  });

  it('响应头返回后正文挂起仍由同一个总 deadline 终止', async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{'));
      },
      cancel() {
        cancelled = true;
      }
    });
    const client = new CloudBasePostgresRpcClient(
      'env-test',
      'service-role-key',
      { timeoutMs: 25, maxResponseBytes: 1024 },
      vi.fn(() => new Promise<Response>(resolve => {
        setTimeout(() => resolve(new Response(body, { status: 200 })), 15);
      }))
    );

    const pending = client.rpc('claim_moderation_jobs', {});
    await vi.advanceTimersByTimeAsync(15);
    await vi.advanceTimersByTimeAsync(10);

    await expect(pending).resolves.toEqual({
      data: null,
      error: { message: 'RPC 请求超时' }
    });
    expect(cancelled).toBe(true);
  });

  it('默认拒绝超过 4 MiB 的 RPC 响应', async () => {
    const client = new CloudBasePostgresRpcClient(
      'env-test',
      'service-role-key',
      undefined,
      vi.fn().mockResolvedValue(new Response('{}', {
        status: 200,
        headers: { 'content-length': String(4 * 1024 * 1024 + 1) }
      }))
    );

    await expect(client.rpc('claim_moderation_jobs', {})).resolves.toEqual({
      data: null,
      error: { message: 'RPC 响应过大' }
    });
  });
});

describe('CloudBase PostgreSQL 仓储', () => {
  it('管理员队列以最后一项 created_at/id 生成游标且拒绝跨 status 复用', async () => {
    const createdAt = '2026-08-31T03:00:00.000Z';
    const rpc = {
      rpc: vi.fn()
        .mockResolvedValueOnce({
          data: ['c', 'b', 'a'].map(id => makeSubmission({
            id: `admin-${id}`,
            status: 'system_reviewing',
            created_at: createdAt
          })),
          error: null
        })
        .mockResolvedValueOnce({
          data: [makeSubmission({
            id: 'admin-a',
            status: 'system_reviewing',
            created_at: createdAt
          })],
          error: null
        })
    };
    const store = new CloudBasePostgresStore({ from: vi.fn() } as never, rpc);

    const first = await store.listAdminSubmissions({
      limit: 2,
      status: 'system_reviewing'
    });
    expect(first.items.map(item => item.id)).toEqual(['admin-c', 'admin-b']);
    expect(first.nextCursor).toMatch(/^v1\.[A-Za-z0-9_-]+$/u);

    await store.listAdminSubmissions({
      limit: 2,
      status: 'system_reviewing',
      cursor: first.nextCursor
    });
    expect(rpc.rpc).toHaveBeenNthCalledWith(2, 'list_admin_submissions', {
      p_limit: 2,
      p_status: 'system_reviewing',
      p_cursor_time: createdAt,
      p_cursor_id: 'admin-b'
    });
    await expect(store.listAdminSubmissions({
      limit: 2,
      status: 'manual_review_pending',
      cursor: first.nextCursor
    })).rejects.toMatchObject({ code: 'INVALID_CURSOR', statusCode: 400 });
    expect(rpc.rpc).toHaveBeenCalledTimes(2);
  });

  it('管理员队列返回现有风险摘要且不混入公开映射', async () => {
    const database = new MemoryRdb();
    database.submissions.push(makeSubmission({
      id: 'review-risk',
      status: 'auto_rejected',
      publication_basis: null,
      risk_summary: { labels: ['politics'], summary: '命中政治内容规则' },
      auto_rejection_reason: '系统检测到禁止内容'
    }));
    const { store } = createStore(database);

    const page = await store.listAdminSubmissions({
      limit: 20,
      status: 'auto_rejected'
    });

    expect(page.items[0]?.riskSummary).toEqual({
      labels: ['politics'],
      summary: '命中政治内容规则'
    });
    expect(page.items[0]?.autoRejectionReason).toBe('系统检测到禁止内容');
    expect(page.items[0]?.publicationBasis).toBeNull();
    expect(page.nextCursor).toBeNull();
  });

  it('管理员详情保留投稿发布依据与原始审核结果', async () => {
    const row = makeSubmission({
      id: 'admin-detail-override',
      kind: 'shared_package',
      status: 'published',
      status_version: 4,
      publication_basis: 'admin_override',
      published_at: '2026-08-31T00:00:00.000Z'
    });
    const tableCalls = new Map<string, number>();
    const database = {
      from: vi.fn((table: string) => {
        const call = tableCalls.get(table) ?? 0;
        tableCalls.set(table, call + 1);
        const data = table === 'submissions'
          ? (call === 0 ? row : {
              risk_summary: { blocked: true },
              auto_rejection_reason: '技术检查：恶意文件'
            })
          : table === 'moderation_results'
            ? [{
                kind: 'package_scan',
                provider: 'isolated-scanner',
                suggestion: 'Block',
                label: '技术检查：恶意文件',
                score: null,
                evidence: { scanCode: 'MALWARE_DETECTED' },
                created_at: '2026-08-31T00:01:00.000Z'
              }]
            : [];
        const query: Record<string, ReturnType<typeof vi.fn> | ((...args: never[]) => never)> = {};
        for (const method of ['select', 'eq', 'order']) {
          query[method] = vi.fn(() => query);
        }
        query.maybeSingle = vi.fn(async () => ({ data, error: null }));
        query.then = (resolve: (value: unknown) => unknown) => Promise.resolve({
          data,
          error: null
        }).then(resolve) as never;
        return query;
      })
    };
    const store = new CloudBasePostgresStore(database as never, { rpc: vi.fn() });

    await expect(store.findAdminSubmission('admin-detail-override'))
      .resolves.toMatchObject({
        id: 'admin-detail-override',
        publicationBasis: 'admin_override',
        moderationResults: [{
          suggestion: 'Block',
          evidence: { scanCode: 'MALWARE_DETECTED' }
        }]
      });
  });

  it('创建投稿后只能用令牌哈希查询裁剪状态', async () => {
    const { store } = createStore();
    await store.createSubmission(newSubmission('submission-1'));

    await expect(store.findByStatusTokenHash('b'.repeat(64))).resolves.toEqual({
      submissionId: 'submission-1',
      status: 'uploading',
      publicReason: null,
      createdAt: '2026-07-30T00:00:00.000Z',
      updatedAt: '2026-07-30T00:00:00.000Z'
    });
    await expect(store.findByStatusTokenHash('c'.repeat(64))).resolves.toBeNull();
  });

  it('完成上传只把 uploading 投稿推进到系统审核', async () => {
    const { database, store } = createStore();
    await store.createSubmission(newSubmission('submission-1'));
    await expect(store.findById('submission-1')).resolves.toMatchObject({
      purgeAfter: '2026-08-03T00:00:00.000Z'
    });

    await expect(store.completeUpload({
      submissionId: 'submission-1',
      assets: completedAssets('submission-1')
    }))
      .resolves.toMatchObject({
        id: 'submission-1',
        status: 'system_reviewing',
        purgeAfter: null
      });
    expect(database.submissions[0]).toMatchObject({
      status: 'system_reviewing',
      purge_after: null
    });
  });

  it('清理栅栏建立后不能重新完成残缺上传', async () => {
    const database = new MemoryRdb();
    database.submissions.push(makeSubmission({
      id: 'cleanup-started',
      status: 'uploading',
      cleanup_started_at: '2026-07-31T00:00:00.000Z'
    }));
    const { store } = createStore(database);

    await expect(store.completeUpload({
      submissionId: 'cleanup-started',
      assets: completedAssets('cleanup-started')
    }))
      .rejects.toMatchObject({
        code: 'UPLOAD_FINALIZE_CONFLICT',
        statusCode: 409
      });
  });

  it('创建共享包时持久化两项资产声明并可按 ID 回读', async () => {
    const { database, store } = createStore();
    const input = newSubmission('submission-assets');

    await store.createSubmission(input);

    expect(database.submissions).toContainEqual(
      expect.objectContaining({
        id: 'submission-assets',
        kind: 'shared_package',
        title: '测试投稿',
        body: '测试正文'
      })
    );
    expect(database.assets).toEqual([
      expect.objectContaining({
        submission_id: 'submission-assets',
        object_key: 'submissions/submission-assets/cover.webp',
        original_name: 'cover.webp',
        declared_size: 512,
        mime_type: 'image/webp',
        role: 'cover'
      }),
      expect.objectContaining({
        submission_id: 'submission-assets',
        object_key: 'submissions/submission-assets/package.zip',
        original_name: 'pet.zip',
        declared_size: 1024,
        mime_type: 'application/zip',
        role: 'package'
      })
    ]);
    await expect(store.findById('submission-assets')).resolves.toMatchObject({
      id: 'submission-assets',
      status: 'uploading',
      assets: [
        {
          role: 'cover',
          storageKey: 'submissions/submission-assets/cover.webp',
          fileName: 'cover.webp',
          declaredBytes: 512,
          contentType: 'image/webp'
        },
        {
          role: 'package',
          storageKey: 'submissions/submission-assets/package.zip',
          fileName: 'pet.zip',
          declaredBytes: 1024,
          contentType: 'application/zip'
        }
      ]
    });
  });

  it('资产写入失败时创建投稿整体回滚', async () => {
    const database = new MemoryRdb();
    database.rejectAssetCreation = true;
    const { store } = createStore(database);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(store.createSubmission(newSubmission('rollback-submission')))
      .rejects.toMatchObject({ code: 'DATABASE_ERROR' });
    expect(errorLog).toHaveBeenCalledWith('[cloudbase-rdb]', {
      code: null,
      message: '资产写入失败'
    });
    expect(database.submissions).toEqual([]);
    expect(database.assets).toEqual([]);
    errorLog.mockRestore();
  });

  it('未完成上传的投稿到期后进入清理候选', async () => {
    const { store } = createStore();
    await store.createSubmission(newSubmission('abandoned-upload'));

    await expect(
      store.listPurgeCandidates('2026-08-03T00:00:00.000Z', 10)
    ).resolves.toEqual([
      expect.objectContaining({
        id: 'abandoned-upload',
        status: 'uploading',
        purgeAfter: '2026-08-03T00:00:00.000Z'
      })
    ]);
  });

  it('上传签名失败的隐藏投稿仍可按期限清理', async () => {
    const { store } = createStore();
    const service = new SubmissionService(
      store,
      {
        async createSignedUploadUrl(): Promise<never> {
          throw Object.assign(new Error('签名失败'), { code: 'STORAGE_ERROR' });
        },
        async info(): Promise<never> {
          throw new Error('本测试不会读取对象信息');
        },
        async createSignedUrl(): Promise<never> {
          throw new Error('本测试不会签发下载地址');
        },
        async delete(): Promise<void> {}
      },
      { sharedPackageSubmissionsEnabled: true },
      () => 'failed-signature'
    );

    await expect(service.prepare({
      kind: 'shared_package',
      title: '待清理投稿',
      body: '签名失败后保持隐藏。',
      packageFile: {
        fileName: 'pet.zip',
        sizeBytes: 1024,
        contentType: 'application/zip'
      },
      coverFile: {
        fileName: 'cover.webp',
        sizeBytes: 512,
        contentType: 'image/webp'
      }
    }, { ip: '203.0.113.8' })).rejects.toMatchObject({
      code: 'STORAGE_ERROR'
    });
    await expect(
      store.listPurgeCandidates('2026-08-03T00:00:00.000Z', 10)
    ).resolves.toEqual([
      expect.objectContaining({
        id: 'failed-signature',
        status: 'uploading',
        purgeAfter: '2026-08-03T00:00:00.000Z'
      })
    ]);
  });

  it('审核任务领取跳过有效租约并写入新租约', async () => {
    const database = new MemoryRdb();
    database.submissions.push(
      makeSubmission({
        id: 'expired',
        status: 'system_reviewing',
        moderation_lease_until: '2026-07-30T23:59:00.000Z'
      }),
      makeSubmission({
        id: 'leased',
        status: 'system_reviewing',
        moderation_lease_until: '2026-07-31T00:30:00.000Z'
      })
    );
    const { store } = createStore(database);

    await expect(
      store.claimModerationJobs(3, '2026-07-31T00:10:00.000Z')
    ).resolves.toEqual([
      expect.objectContaining({ id: 'expired', status: 'system_reviewing' })
    ]);
    expect(database.submissions.find((row) => row.id === 'expired'))
      .toMatchObject({ moderation_lease_until: '2026-07-31T00:10:00.000Z' });
  });

  it('审核任务和管理员动作只使用独立 RPC 客户端', async () => {
    const tableDatabase = new MemoryRdb();
    const rpcDatabase = new MemoryRdb();
    rpcDatabase.submissions.push(
      makeSubmission({
        id: 'rpc-submission',
        status: 'system_reviewing',
        moderation_lease_until: '2026-07-30T23:59:00.000Z'
      }),
      makeSubmission({
        id: 'rpc-admin-submission',
        status: 'manual_review_pending',
        status_version: 0
      })
    );
    const store = new CloudBasePostgresStore(tableDatabase, rpcDatabase);

    await expect(
      store.claimModerationJobs(1, '2026-07-31T00:10:00.000Z')
    ).resolves.toEqual([
      expect.objectContaining({ id: 'rpc-submission' })
    ]);
    await expect(store.applyAdminAction({
      submissionId: 'rpc-admin-submission',
      adminId: 'admin-1',
      action: 'approve',
      nextStatus: 'published',
      expectedVersion: 0,
      idempotencyKey: 'rpc-admin-action-1',
      reason: '审核通过'
    })).resolves.toMatchObject({
      submission: {
        id: 'rpc-admin-submission',
        status: 'published',
        statusVersion: 1
      }
    });
    expect(tableDatabase.submissions).toEqual([]);
  });

  it('审核结果写入独立结果表', async () => {
    const { database, store } = createStore();

    await store.recordModerationResult({
      submissionId: 'submission-1',
      kind: 'text',
      provider: 'tencent',
      ruleVersion: '2026-07',
      suggestion: 'Review',
      label: 'possible-risk',
      score: 0.7,
      evidence: { rule: 'r-1' },
      requestedAt: '2026-07-31T00:00:00.000Z',
      completedAt: '2026-07-31T00:00:01.000Z',
      errorMessage: null
    });

    expect(database.moderationResults).toEqual([
      expect.objectContaining({
        submission_id: 'submission-1',
        rule_version: '2026-07',
        suggestion: 'Review'
      })
    ]);
  });

  it('管理员动作对重复幂等键返回原结果且只更新一次', async () => {
    const database = new MemoryRdb();
    database.submissions.push(
      makeSubmission({
        id: 'submission-1',
        status: 'manual_review_pending',
        status_version: 3
      })
    );
    const { store } = createStore(database);
    const input = {
      submissionId: 'submission-1',
      adminId: 'admin-1',
      action: 'approve' as const,
      nextStatus: 'published' as const,
      expectedVersion: 3,
      idempotencyKey: 'admin-action-0001',
      reason: '审核通过'
    };

    await expect(store.applyAdminAction(input)).resolves.toMatchObject({
      submission: { id: 'submission-1', status: 'published', statusVersion: 4 },
      replayed: false
    });
    await expect(store.applyAdminAction(input)).resolves.toMatchObject({
      submission: { id: 'submission-1', status: 'published', statusVersion: 4 },
      replayed: true
    });
    expect(database.audits).toHaveLength(1);
  });

  it('下载前读取的投稿元数据映射不可变发布依据', async () => {
    const database = new MemoryRdb();
    database.submissions.push(makeSubmission({
      id: 'override-download',
      kind: 'shared_package',
      status: 'published',
      status_version: 4,
      publication_basis: 'admin_override',
      published_at: '2026-08-31T00:00:00.000Z'
    }));
    database.assets.push({
      submission_id: 'override-download',
      object_key: 'submissions/override-download/package.zip',
      original_name: 'pet.zip',
      declared_size: 1024,
      actual_size: 1024,
      mime_type: 'application/zip',
      role: 'package'
    });
    const { store } = createStore(database);

    await expect(store.findById('override-download')).resolves.toMatchObject({
      id: 'override-download',
      status: 'published',
      publicationBasis: 'admin_override'
    });
  });

  it.each([false, true])(
    '管理员动作安全 RPC 快照可映射首次与重放结果（replayed=%s）',
    async (replayed) => {
      const rpcClient = {
        rpc: vi.fn(async () => ({
          data: {
            submission: {
              id: 'safe-admin-result',
              kind: 'shared_package',
              status: 'published',
              status_version: 4,
              publication_basis: 'admin_override',
              public_reason: null,
              published_at: '2026-08-31T00:00:00.000Z',
              rejected_at: null,
              quarantined_at: null,
              created_at: '2026-08-30T00:00:00.000Z',
              updated_at: '2026-08-31T00:00:00.000Z'
            },
            replayed
          },
          error: null
        }))
      };
      const store = new CloudBasePostgresStore(new MemoryRdb(), rpcClient);

      await expect(store.applyAdminAction({
        submissionId: 'safe-admin-result',
        adminId: 'admin-1',
        action: 'force_publish',
        nextStatus: 'published',
        expectedVersion: 3,
        idempotencyKey: 'safe-admin-result-key',
        reason: '安全响应映射',
        riskAcknowledgement: 'ADMIN_OVERRIDE_ACCEPTED'
      })).resolves.toEqual({
        submission: {
          id: 'safe-admin-result',
          kind: 'shared_package',
          status: 'published',
          statusVersion: 4,
          publicationBasis: 'admin_override',
          publicReason: null,
          publishedAt: '2026-08-31T00:00:00.000Z',
          rejectedAt: null,
          quarantinedAt: null,
          createdAt: '2026-08-30T00:00:00.000Z',
          updatedAt: '2026-08-31T00:00:00.000Z'
        },
        replayed
      });
      expect(rpcClient.rpc).toHaveBeenCalledWith('apply_admin_action', {
        p_submission_id: 'safe-admin-result',
        p_admin_id: 'admin-1',
        p_action: 'force_publish',
        p_next_status: 'published',
        p_expected_version: 3,
        p_idempotency_key: 'safe-admin-result-key',
        p_reason: '安全响应映射',
        p_risk_acknowledgement: 'ADMIN_OVERRIDE_ACCEPTED'
      });
    }
  );

  it('后到扫描端口复用原子审核 RPC 并只返回 applied 事实', async () => {
    const rpcClient = {
      rpc: vi.fn(async () => ({
        data: { applied: true, lateResult: true },
        error: null
      }))
    };
    const store = new CloudBasePostgresStore(new MemoryRdb(), rpcClient);
    const input = {
      submissionId: 'late-result',
      expectedVersion: 2,
      nextStatus: 'auto_rejected' as const,
      results: [{
        submissionId: 'late-result',
        kind: 'package_scan',
        provider: 'isolated-scanner',
        ruleVersion: 'character-package-2026-08-15',
        suggestion: 'Block' as const,
        label: '技术检查：CHARACTER_PACKAGE_MALWARE_DETECTED',
        score: null,
        evidence: { scanCode: 'CHARACTER_PACKAGE_MALWARE_DETECTED' },
        requestedAt: '2026-08-31T00:00:00.000Z',
        completedAt: '2026-08-31T00:00:01.000Z',
        errorMessage: null
      }],
      riskSummary: {
        blocked: true,
        signalCount: 1,
        blockedLabels: ['技术检查：CHARACTER_PACKAGE_MALWARE_DETECTED']
      },
      autoRejectionReason: '技术检查：CHARACTER_PACKAGE_MALWARE_DETECTED'
    };

    await expect(store.recordLateModerationResult(input)).resolves.toBe(true);
    expect(rpcClient.rpc).toHaveBeenCalledWith('apply_moderation_decision', {
      p_submission_id: 'late-result',
      p_expected_version: 2,
      p_next_status: 'auto_rejected',
      p_results: [expect.objectContaining({
        kind: 'package_scan',
        provider: 'isolated-scanner'
      })],
      p_risk_summary: input.riskSummary,
      p_auto_rejection_reason: '技术检查：CHARACTER_PACKAGE_MALWARE_DETECTED'
    });
  });

  it('并发强制发布时把混合审核结果原样交给原子 RPC 裁决', async () => {
    const rpcClient = {
      rpc: vi.fn(async () => ({
        data: { applied: true, lateResult: true },
        error: null
      }))
    };
    const store = new CloudBasePostgresStore(new MemoryRdb(), rpcClient);
    const technical = {
      submissionId: 'late-mixed-result',
      kind: 'package_scan',
      provider: 'isolated-scanner',
      ruleVersion: 'character-package-2026-08-15',
      suggestion: 'Pass' as const,
      label: '技术检查：CHARACTER_PACKAGE_SCAN_PASSED',
      score: null,
      evidence: { scanCode: 'CHARACTER_PACKAGE_SCAN_PASSED' },
      requestedAt: '2026-08-31T00:00:00.000Z',
      completedAt: '2026-08-31T00:00:01.000Z',
      errorMessage: null
    };
    const content = {
      ...technical,
      kind: 'package_json_text',
      provider: 'tencent-tms',
      label: 'Normal'
    };
    const input = {
      submissionId: 'late-mixed-result',
      expectedVersion: 2,
      nextStatus: 'manual_review_pending' as const,
      results: [technical, content],
      riskSummary: {
        blocked: false,
        signalCount: 2,
        blockedLabels: []
      },
      autoRejectionReason: null
    };

    await expect(store.applyModerationDecision(input)).resolves.toBe(true);
    expect(rpcClient.rpc).toHaveBeenCalledWith('apply_moderation_decision', {
      p_submission_id: 'late-mixed-result',
      p_expected_version: 2,
      p_next_status: 'manual_review_pending',
      p_results: [
        expect.objectContaining({
          kind: 'package_scan',
          provider: 'isolated-scanner'
        }),
        expect.objectContaining({
          kind: 'package_json_text',
          provider: 'tencent-tms'
        })
      ],
      p_risk_summary: input.riskSummary,
      p_auto_rejection_reason: null
    });
  });

  it('管理员动作可映射旧 purge 升级后仅含可证明字段的重放快照', async () => {
    const rpcClient = {
      rpc: vi.fn(async () => ({
        data: {
          submission: {
            id: 'legacy-purged-result',
            status: 'published',
            status_version: 1,
            publication_basis: 'standard'
          },
          replayed: true
        },
        error: null
      }))
    };
    const store = new CloudBasePostgresStore(new MemoryRdb(), rpcClient);

    await expect(store.applyAdminAction({
      submissionId: 'legacy-purged-result',
      adminId: 'admin-1',
      action: 'approve',
      nextStatus: 'published',
      expectedVersion: 0,
      idempotencyKey: 'legacy-purged-result-key',
      reason: '回放历史批准'
    })).resolves.toEqual({
      submission: {
        id: 'legacy-purged-result',
        status: 'published',
        statusVersion: 1,
        publicationBasis: 'standard'
      },
      replayed: true
    });
  });

  it('管理员动作拒绝把四键历史快照作为新首次动作返回', async () => {
    const rpcClient = {
      rpc: vi.fn(async () => ({
        data: {
          submission: {
            id: 'legacy-shape-first-result',
            status: 'published',
            status_version: 1,
            publication_basis: 'standard'
          },
          replayed: false
        },
        error: null
      }))
    };
    const store = new CloudBasePostgresStore(new MemoryRdb(), rpcClient);

    await expect(store.applyAdminAction({
      submissionId: 'legacy-shape-first-result',
      adminId: 'admin-1',
      action: 'approve',
      nextStatus: 'published',
      expectedVersion: 0,
      idempotencyKey: 'legacy-shape-first-key',
      reason: '不得作为首次结果'
    })).rejects.toMatchObject({ code: 'DATABASE_ERROR', statusCode: 500 });
  });

  it.each([
    {
      label: '错误字段类型',
      mutate: (submission: Record<string, unknown>) => ({
        ...submission,
        status_version: '4'
      }),
      topLevelExtra: false
    },
    {
      label: '投稿私密额外字段',
      mutate: (submission: Record<string, unknown>) => ({
        ...submission,
        body: '不得进入管理员动作响应'
      }),
      topLevelExtra: false
    },
    {
      label: '顶层额外字段',
      mutate: (submission: Record<string, unknown>) => submission,
      topLevelExtra: true
    }
  ])('管理员动作安全 RPC 对$label失败关闭', async ({ mutate, topLevelExtra }) => {
    const safeSubmission = {
      id: 'unsafe-admin-result',
      kind: 'feedback',
      status: 'published',
      status_version: 1,
      publication_basis: 'standard',
      public_reason: null,
      published_at: '2026-08-31T00:00:00.000Z',
      rejected_at: null,
      quarantined_at: null,
      created_at: '2026-08-30T00:00:00.000Z',
      updated_at: '2026-08-31T00:00:00.000Z'
    };
    const rpcClient = {
      rpc: vi.fn(async () => ({
        data: {
          submission: mutate(safeSubmission),
          replayed: false,
          ...(topLevelExtra ? { debug: '不得忽略' } : {})
        },
        error: null
      }))
    };
    const store = new CloudBasePostgresStore(new MemoryRdb(), rpcClient);

    await expect(store.applyAdminAction({
      submissionId: 'unsafe-admin-result',
      adminId: 'admin-1',
      action: 'approve',
      nextStatus: 'published',
      expectedVersion: 0,
      idempotencyKey: 'unsafe-admin-result-key',
      reason: '拒绝异常响应'
    })).rejects.toMatchObject({ code: 'DATABASE_ERROR', statusCode: 500 });
  });

  it('数据库 RPC 拒绝缺少当前证据的待人工共享包批准', async () => {
    const database = new MemoryRdb();
    database.submissions.push(makeSubmission({
      id: 'manual-package',
      kind: 'shared_package',
      status: 'manual_review_pending',
      status_version: 3
    }));
    database.assets.push({
      submission_id: 'manual-package',
      object_key: 'submissions/manual-package/package.zip',
      original_name: 'pet.zip',
      declared_size: 1024,
      actual_size: 1024,
      mime_type: 'application/zip',
      role: 'package'
    });
    const { store } = createStore(database);

    await expect(store.applyAdminAction({
      submissionId: 'manual-package',
      adminId: 'admin-1',
      action: 'approve',
      nextStatus: 'published',
      expectedVersion: 3,
      idempotencyKey: 'manual-package-approve',
      reason: '批准'
    })).rejects.toMatchObject({
      code: 'TECHNICAL_SCAN_REQUIRED',
      statusCode: 409
    });
  });

  it('数据库 RPC 拒绝绑定未完成包资产的伪造扫描证据', async () => {
    const database = new MemoryRdb();
    database.submissions.push(makeSubmission({
      id: 'unfinished-package',
      kind: 'shared_package',
      status: 'manual_review_pending',
      status_version: 3
    }));
    database.assets.push({
      submission_id: 'unfinished-package',
      object_key: 'submissions/unfinished-package/package.zip',
      original_name: 'pet.zip',
      declared_size: 1024,
      actual_size: null,
      mime_type: 'application/zip',
      role: 'package'
    });
    database.moderationResults.push({
      submission_id: 'unfinished-package',
      kind: 'package_scan',
      provider: 'isolated-scanner',
      suggestion: 'Pass',
      evidence: {
        submissionId: 'unfinished-package',
        packageStorageKey: 'submissions/unfinished-package/package.zip',
        packageSizeBytes: 'null',
        submissionStatusVersion: '3',
        scanCode: 'CHARACTER_PACKAGE_SCAN_PASSED'
      }
    });
    const { store } = createStore(database);

    await expect(store.applyAdminAction({
      submissionId: 'unfinished-package',
      adminId: 'admin-1',
      action: 'approve',
      nextStatus: 'published',
      expectedVersion: 3,
      idempotencyKey: 'unfinished-package-approve',
      reason: '批准'
    })).rejects.toMatchObject({
      code: 'TECHNICAL_SCAN_REQUIRED',
      statusCode: 409
    });
  });

  it('数据库 RPC 只接受绑定当前共享包归档身份与版本的完整扫描证据', async () => {
    const database = new MemoryRdb();
    database.submissions.push(makeSubmission({
      id: 'scanned-package',
      kind: 'shared_package',
      status: 'manual_review_pending',
      status_version: 3
    }));
    database.assets.push({
      submission_id: 'scanned-package',
      object_key: 'submissions/scanned-package/package.zip',
      original_name: 'pet.zip',
      declared_size: 1024,
      actual_size: 1024,
      mime_type: 'application/zip',
      role: 'package'
    });
    database.moderationResults.push({
      submission_id: 'scanned-package',
      kind: 'package_scan',
      provider: 'isolated-scanner',
      suggestion: 'Pass',
      evidence: {
        submissionId: 'scanned-package',
        packageStorageKey: 'submissions/scanned-package/package.zip',
        packageSizeBytes: 1024,
        archiveSizeBytes: 1024,
        archiveSha256: 'a'.repeat(64),
        protocolVersion: '2026-08-15',
        ruleVersion: 'character-package-2026-08-15',
        submissionStatusVersion: 3,
        scanCode: 'CHARACTER_PACKAGE_SCAN_PASSED',
        completedAt: '2026-07-31T00:00:00.000Z',
        expiresAt: '2026-08-01T00:00:00.000Z'
      }
    });
    const { store } = createStore(database);

    await expect(store.applyAdminAction({
      submissionId: 'scanned-package',
      adminId: 'admin-1',
      action: 'approve',
      nextStatus: 'published',
      expectedVersion: 3,
      idempotencyKey: 'scanned-package-approve',
      reason: '批准'
    })).resolves.toMatchObject({
      submission: {
        id: 'scanned-package',
        status: 'published',
        statusVersion: 4
      },
      replayed: false
    });
  });

  it('管理员动作版本过期时返回稳定冲突错误', async () => {
    const database = new MemoryRdb();
    database.submissions.push(
      makeSubmission({ id: 'submission-1', status_version: 2 })
    );
    const { store } = createStore(database);

    await expect(store.applyAdminAction({
      submissionId: 'submission-1',
      adminId: 'admin-1',
      action: 'reject',
      nextStatus: 'admin_rejected',
      expectedVersion: 1,
      idempotencyKey: 'admin-action-0002',
      reason: '不符合发布要求'
    })).rejects.toMatchObject({ code: 'VERSION_CONFLICT', statusCode: 409 });
  });

  it('清理已开始后即使租约过期也拒绝恢复或发布', async () => {
    const database = new MemoryRdb();
    database.submissions.push(
      makeSubmission({
        id: 'cleanup-restore',
        status: 'deleted_quarantined',
        cleanup_started_at: '2026-07-31T00:00:00.000Z',
        cleanup_lease_until: '2026-07-31T00:01:00.000Z'
      }),
      makeSubmission({
        id: 'cleanup-publish',
        status: 'manual_review_pending',
        cleanup_started_at: '2026-07-31T00:00:00.000Z',
        cleanup_lease_until: '2026-07-31T00:01:00.000Z'
      })
    );
    const { store } = createStore(database);

    for (const input of [
      {
        submissionId: 'cleanup-restore',
        action: 'restore' as const,
        nextStatus: 'published' as const
      },
      {
        submissionId: 'cleanup-publish',
        action: 'approve' as const,
        nextStatus: 'published' as const
      }
    ]) {
      await expect(store.applyAdminAction({
        ...input,
        adminId: 'admin-1',
        expectedVersion: 0,
        idempotencyKey: `fenced-${input.submissionId}`,
        reason: '不得执行'
      })).rejects.toMatchObject({
        code: 'VERSION_CONFLICT',
        statusCode: 409
      });
    }
  });

  it('清理候选只返回到期且尚未清理的投稿', async () => {
    const database = new MemoryRdb();
    database.submissions.push(
      makeSubmission({
        id: 'due',
        status: 'admin_rejected',
        purge_after: '2026-07-31T00:00:00.000Z'
      }),
      makeSubmission({
        id: 'future',
        status: 'admin_rejected',
        purge_after: '2026-08-01T00:00:00.000Z'
      }),
      makeSubmission({
        id: 'purged',
        status: 'purged',
        purge_after: '2026-07-30T00:00:00.000Z'
      })
    );
    const { store } = createStore(database);

    await expect(
      store.listPurgeCandidates('2026-07-31T00:00:00.000Z', 10)
    ).resolves.toEqual([
      expect.objectContaining({ id: 'due', status: 'admin_rejected' })
    ]);
  });
});
