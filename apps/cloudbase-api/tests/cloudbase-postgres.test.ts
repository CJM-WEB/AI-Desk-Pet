import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CloudBasePostgresStore } from '../src/adapters/cloudbase-postgres.js';

const migrationPath = fileURLToPath(
  new URL('../migrations/001_moderation.sql', import.meta.url)
);

describe('CloudBase PostgreSQL 迁移', () => {
  it('迁移包含必要表、状态约束和版本条件更新', () => {
    const sql = readFileSync(migrationPath, 'utf8');

    for (const table of [
      'submissions',
      'assets',
      'moderation_results',
      'admin_audit_logs',
      'public_engagement'
    ]) {
      expect(sql).toContain(`CREATE TABLE ${table}`);
    }

    expect(sql).toContain('status_version');
    expect(sql).toContain('purge_after');
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
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
      'public_engagement'
    ]) {
      expect(sql).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      expect(sql).toContain(`REVOKE ALL ON TABLE ${table} FROM anon, authenticated`);
      expect(sql).toContain(`GRANT ALL ON TABLE ${table} TO service_role`);
    }
  });

  it('特权数据库函数显式校验 service_role 并收回公开执行权', () => {
    const sql = readFileSync(migrationPath, 'utf8');

    expect(sql.match(/SECURITY DEFINER/g)).toHaveLength(2);
    expect(sql.match(/request\.jwt\.claims/g)).toHaveLength(2);
    expect(sql.match(/<> 'service_role'/g)).toHaveLength(2);
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION claim_moderation_jobs(integer, timestamptz) FROM PUBLIC, anon, authenticated'
    );
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION apply_admin_action(text, text, text, text, bigint, text, text) FROM PUBLIC, anon, authenticated'
    );
  });

  it('管理员动作同时具备版本条件更新和幂等请求保护', () => {
    const sql = readFileSync(migrationPath, 'utf8');

    expect(sql).toContain('idempotency_key text NOT NULL UNIQUE');
    expect(sql).toContain('AND status_version = p_expected_version');
    expect(sql).toContain('status_version = status_version + 1');
    expect(sql).toContain("'replayed', true");
  });

  it('发布动作写入发布时间且租约必须指向未来', () => {
    const sql = readFileSync(migrationPath, 'utf8');

    expect(sql).toContain(
      "WHEN p_next_status = 'published' THEN COALESCE(published_at, now())"
    );
    expect(sql).toContain('IF p_lease_until <= now() THEN');
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
  moderation_lease_until: string | null;
  published_at: string | null;
  purge_after: string | null;
  created_at: string;
  updated_at: string;
}

interface MemoryAudit {
  request: Record<string, unknown>;
  result: Record<string, unknown>;
}

interface QueryResult {
  data: unknown;
  error: { code?: string; message: string } | null;
}

/** 只模拟仓储使用到的 PostgREST 查询语义，并保存可观察的数据库状态。 */
class MemoryRdb {
  readonly submissions: MemorySubmission[] = [];
  readonly moderationResults: Array<Record<string, unknown>> = [];
  readonly audits = new Map<string, MemoryAudit>();

  from(table: string): MemoryQuery {
    return new MemoryQuery(this, table);
  }

  async rpc(name: string, params: Record<string, unknown>): Promise<QueryResult> {
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

    if (name === 'apply_admin_action') {
      const idempotencyKey = params.p_idempotency_key as string;
      const request = structuredClone(params);
      const previous = this.audits.get(idempotencyKey);

      if (previous) {
        if (JSON.stringify(previous.request) !== JSON.stringify(request)) {
          return {
            data: null,
            error: { code: '22023', message: 'idempotency key reused' }
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

      row.status = params.p_next_status as string;
      row.status_version += 1;
      const result = {
        submission: structuredClone(row),
        replayed: false
      };
      this.audits.set(idempotencyKey, { request, result });
      return { data: structuredClone(result), error: null };
    }

    return { data: null, error: { message: `未知 RPC：${name}` } };
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
  private rangeStart = 0;
  private rangeEnd: number | null = null;
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

  range(from: number, to: number): this {
    this.rangeStart = from;
    this.rangeEnd = to;
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

    if (this.table !== 'submissions') {
      return { data: null, error: { message: `未知数据表：${this.table}` } };
    }

    if (this.operation === 'insert') {
      const value = Array.isArray(this.values) ? this.values[0] : this.values;
      if (!value) return { data: null, error: { message: '缺少插入数据' } };
      const row = makeSubmission({
        id: value.id as string,
        status_token_hash: value.status_token_hash as string
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

    const end = this.rangeEnd === null
      ? this.maximum === null ? undefined : this.rangeStart + this.maximum
      : this.rangeEnd + 1;
    const sliced = rows.slice(this.rangeStart, end);
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
    moderation_lease_until: input.moderation_lease_until ?? null,
    published_at: input.published_at ?? null,
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
    store: new CloudBasePostgresStore({ rdb: () => database })
  };
}

describe('CloudBase PostgreSQL 仓储', () => {
  it('创建投稿后只能用令牌哈希查询裁剪状态', async () => {
    const { store } = createStore();
    await store.createSubmission({ id: 'submission-1', statusTokenHash: 'b'.repeat(64) });

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
    const { store } = createStore();
    await store.createSubmission({ id: 'submission-1', statusTokenHash: 'b'.repeat(64) });

    await expect(store.completeUpload({ submissionId: 'submission-1' }))
      .resolves.toMatchObject({ id: 'submission-1', status: 'system_reviewing' });
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
      store.claimModerationJobs(10, '2026-07-31T00:10:00.000Z')
    ).resolves.toEqual([
      expect.objectContaining({ id: 'expired', status: 'system_reviewing' })
    ]);
    expect(database.submissions.find((row) => row.id === 'expired'))
      .toMatchObject({ moderation_lease_until: '2026-07-31T00:10:00.000Z' });
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

  it('公开列表按发布时间稳定分页且只返回公开字段', async () => {
    const database = new MemoryRdb();
    database.submissions.push(
      makeSubmission({
        id: 'published-1',
        title: '第一项',
        body: '公开正文一',
        status: 'published',
        published_at: '2026-07-31T03:00:00.000Z'
      }),
      makeSubmission({
        id: 'published-2',
        title: '第二项',
        body: '公开正文二',
        status: 'published',
        published_at: '2026-07-31T02:00:00.000Z'
      }),
      makeSubmission({
        id: 'published-3',
        title: '第三项',
        body: '公开正文三',
        status: 'published',
        published_at: '2026-07-31T01:00:00.000Z'
      }),
      makeSubmission({
        id: 'hidden',
        title: '不可见',
        status: 'manual_review_pending'
      })
    );
    const { store } = createStore(database);

    const firstPage = await store.listPublished({ limit: 2 });
    expect(firstPage).toEqual({
      items: [
        {
          id: 'published-1',
          title: '第一项',
          body: '公开正文一',
          publishedAt: '2026-07-31T03:00:00.000Z'
        },
        {
          id: 'published-2',
          title: '第二项',
          body: '公开正文二',
          publishedAt: '2026-07-31T02:00:00.000Z'
        }
      ],
      nextCursor: 2
    });
    await expect(store.listPublished({ limit: 2, cursor: firstPage.nextCursor }))
      .resolves.toEqual({
        items: [
          {
            id: 'published-3',
            title: '第三项',
            body: '公开正文三',
            publishedAt: '2026-07-31T01:00:00.000Z'
          }
        ],
        nextCursor: null
      });
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
