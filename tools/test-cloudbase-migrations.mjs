import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { inventoryCloudBaseMigrations } from './cloudbase-migration-inventory.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function parseMigrationGateArguments(arguments_, environment = {}) {
  if (arguments_.length === 0) {
    const configuredRuntime = environment.AI_PET_POSTGRES_RUNTIME;
    if (!configuredRuntime?.trim()) {
      throw new Error('必须提供本地 PostgreSQL 运行时');
    }
    return { postgresRuntime: configuredRuntime };
  }
  if (arguments_.length !== 2 || arguments_[0] !== '--postgres-runtime') {
    throw new Error(`未知参数：${arguments_[0] ?? ''}`);
  }
  if (!arguments_[1]?.trim()) {
    throw new Error('必须提供本地 PostgreSQL 运行时');
  }
  return { postgresRuntime: arguments_[1] };
}

/** 行为门锁定 PostgreSQL 17 主版本，同时允许安全接收后续补丁版本。 */
export function parseSupportedPostgresVersion(versionOutput) {
  const versionMatch = /PostgreSQL\)\s+(\d+)\.(\d+)/u.exec(versionOutput);
  if (!versionMatch) throw new Error('无法识别本地 PostgreSQL 版本');
  const major = Number(versionMatch[1]);
  if (major !== 17) throw new Error('仅支持 PostgreSQL 17 主版本');
  return { major, version: `${versionMatch[1]}.${versionMatch[2]}` };
}

/**
 * 在一次性本地实例中顺序运行真实迁移，并通过 SQL 行为断言验证状态机、
 * 完整证据、严格 TTL 边界和事务回滚；实例不会注册为系统服务。
 */
export async function runCloudBaseMigrationBehaviorGate({
  postgresRuntime,
  root = repositoryRoot
}) {
  const binaryDirectory = join(postgresRuntime, 'bin');
  const executable = name => join(binaryDirectory, `${name}.exe`);
  const versionOutput = await run(executable('postgres'), ['--version']);
  const postgresVersion = parseSupportedPostgresVersion(versionOutput);

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'ai-pet-migrations-'));
  const dataDirectory = join(temporaryRoot, 'data');
  const logPath = join(temporaryRoot, 'postgres.log');
  const port = await availablePort();
  let started = false;
  try {
    await run(executable('initdb'), [
      '-D', dataDirectory,
      '--no-locale',
      '--encoding=UTF8',
      '--auth=trust'
    ]);
    await run(executable('pg_ctl'), [
      '-D', dataDirectory,
      '-l', logPath,
      '-o', `-h 127.0.0.1 -p ${port}`,
      '-w',
      'start'
    ]);
    started = true;

    const connection = [
      '-X',
      '-h', '127.0.0.1',
      '-p', String(port),
      '-d', 'postgres',
      '-v', 'ON_ERROR_STOP=1'
    ];
    await run(executable('psql'), [...connection, '-f', '-'], bootstrapSql);

    const migrationDirectory = join(root, 'cloudbase', 'migrations');
    const migrations = await inventoryCloudBaseMigrations(
      pathToFileURL(`${migrationDirectory}\\`)
    );
    for (const migration of migrations) {
      if (migration.fileName
        === '20260831010000_admin_override_publication.sql') {
        await run(
          executable('psql'),
          [...connection, '-f', '-'],
          legacyAdminAuditFixtureSql
        );
        for (const damagedFixtureSql of [
          damagedLegacyIdentityFixtureSql,
          damagedLegacyNullExpectedVersionFixtureSql
        ]) {
          await run(
            executable('psql'),
            [...connection, '-f', '-'],
            damagedFixtureSql
          );
          let damagedUpgradeRejected = false;
          try {
            await run(executable('psql'), [
              ...connection,
              '-f', join(migrationDirectory, migration.fileName)
            ]);
          } catch (error) {
            if (!String(error).includes('invalid legacy admin audit snapshot')) {
              throw error;
            }
            damagedUpgradeRejected = true;
          }
          if (!damagedUpgradeRejected) {
            throw new Error('损坏的旧管理员审计未阻止第六迁移');
          }
          await run(
            executable('psql'),
            [...connection, '-f', '-'],
            legacyMigrationRollbackAssertionSql
          );
          await run(
            executable('psql'),
            [...connection, '-f', '-'],
            cleanupDamagedLegacyAdminAuditFixtureSql
          );
        }
      }
      await run(executable('psql'), [
        ...connection,
        '-f', join(migrationDirectory, migration.fileName)
      ]);
    }
    await run(executable('psql'), [...connection, '-f', '-'], behaviorSql);
    await run(executable('psql'), [...connection, '-f', '-'], keysetBehaviorSql);

    return {
      postgresVersion: postgresVersion.version,
      postgresMajorVersion: postgresVersion.major,
      migrationsApplied: migrations.length,
      behaviorsVerified: 52
    };
  } finally {
    if (started) {
      await run(executable('pg_ctl'), [
        '-D', dataDirectory,
        '-m', 'fast',
        '-w',
        'stop'
      ]).catch(() => undefined);
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolvePromise, reject) => {
    server.close(error => error ? reject(error) : resolvePromise());
  });
  if (!port) throw new Error('无法分配本地 PostgreSQL 端口');
  return port;
}

async function run(executable, arguments_, input) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, arguments_, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
    child.once('error', reject);
    const completionEvent = arguments_.at(-1) === 'start' ? 'exit' : 'close';
    child.once(completionEvent, code => {
      const output = Buffer.concat(stdout).toString('utf8');
      const errorOutput = Buffer.concat(stderr).toString('utf8');
      if (code === 0) {
        resolvePromise(output);
        return;
      }
      reject(new Error(
        `本地 PostgreSQL 命令失败（${code}）：${errorOutput || output}`
      ));
    });
    child.stdin.end(input);
  });
}

const bootstrapSql = String.raw`
DO $bootstrap$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END
$bootstrap$;
CREATE SCHEMA storage;
CREATE TABLE storage.buckets (
  id text PRIMARY KEY,
  name text NOT NULL,
  public boolean NOT NULL DEFAULT false
);
`;

/**
 * 在第六个前向迁移之前固定旧版全行审计快照，验证升级会收敛私密字段，
 * 同时仍保留原动作的稳定幂等结果。
 */
const legacyAdminAuditFixtureSql = String.raw`
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false);
INSERT INTO submissions (
  id, kind, title, body, status, status_version, status_token_hash,
  captcha_summary, risk_summary, published_at
) VALUES (
  'gate-legacy-audit', 'feedback', '旧版标题', '旧版私密正文',
  'published', 1, repeat('9', 64), '{"ticket":"private"}'::jsonb,
  '{"fingerprint":"private"}'::jsonb, now()
);
INSERT INTO admin_audit_logs (
  submission_id, admin_id, action, before_status, after_status, reason,
  idempotency_key, request_payload, result_snapshot
)
SELECT
  submission.id, 'admin-1', 'approve', 'manual_review_pending', 'published',
  '历史普通批准', 'gate-legacy-replay',
  jsonb_build_object(
    'submissionId', submission.id,
    'adminId', 'admin-1',
    'action', 'approve',
    'nextStatus', 'published',
    'expectedVersion', 0,
    'reason', '历史普通批准'
  ),
  jsonb_build_object('submission', to_jsonb(submission), 'replayed', false)
FROM submissions AS submission
WHERE submission.id = 'gate-legacy-audit';

-- 旧 purge 会把同一投稿的全部管理员动作快照压缩成当前 purged 状态。
INSERT INTO submissions (
  id, kind, title, body, status, status_token_hash
) VALUES (
  'gate-legacy-purged-audit', 'feedback', '已清理旧标题', '已清理旧正文',
  'manual_review_pending', repeat('c', 64)
);
DO $legacy_purged$
BEGIN
  PERFORM apply_admin_action(
    'gate-legacy-purged-audit', 'admin-1', 'approve', 'published', 0,
    'gate-legacy-purged-approve', '历史批准后被清理'
  );
  PERFORM apply_admin_action(
    'gate-legacy-purged-audit', 'admin-1', 'delete',
    'deleted_quarantined', 1, 'gate-legacy-purged-delete', '历史删除'
  );
  UPDATE submissions
  SET purge_after = now() - interval '1 minute',
      cleanup_started_at = now(),
      cleanup_lease_until = now() + interval '5 minutes'
  WHERE id = 'gate-legacy-purged-audit';
  PERFORM mark_submission_purged('gate-legacy-purged-audit', 2);
  IF (SELECT result_snapshot #>> '{submission,status}'
      FROM admin_audit_logs
      WHERE idempotency_key = 'gate-legacy-purged-approve')
      IS DISTINCT FROM 'purged' THEN
    RAISE EXCEPTION '行为门夹具失败：旧 purge 未压缩审计快照';
  END IF;
END
$legacy_purged$;
`;

/**
 * 旧数据损坏夹具验证迁移预检会失败关闭，并且整个事务不会留下半迁移结构。
 * 清理后再执行正常升级，确保失败夹具不污染后续完整行为门。
 */
const damagedLegacyIdentityFixtureSql = String.raw`
INSERT INTO submissions (
  id, kind, status, status_version, status_token_hash
) VALUES ('gate-damaged-submission-id', 'feedback', 'purged', 1, repeat('d', 64));

INSERT INTO admin_audit_logs (
  submission_id, admin_id, action, before_status, after_status, reason,
  idempotency_key, request_payload, result_snapshot
) VALUES (
    'gate-damaged-submission-id', 'admin-1', 'approve',
    'manual_review_pending', 'published', '损坏投稿编号',
    'gate-damaged-submission-id-key',
    jsonb_build_object(
      'submissionId', '另一个投稿',
      'adminId', 'admin-1',
      'action', 'approve',
      'nextStatus', 'published',
      'expectedVersion', 0,
      'reason', '损坏投稿编号'
    ),
    jsonb_build_object(
      'submission', jsonb_build_object(
        'id', 'gate-damaged-submission-id',
        'status', 'purged'
      ),
      'replayed', false
    )
  );
`;

const damagedLegacyNullExpectedVersionFixtureSql = String.raw`
INSERT INTO submissions (
  id, kind, status, status_version, status_token_hash
) VALUES ('gate-damaged-null-version', 'feedback', 'purged', 1, repeat('e', 64));

INSERT INTO admin_audit_logs (
  submission_id, admin_id, action, before_status, after_status, reason,
  idempotency_key, request_payload, result_snapshot
) VALUES (
    'gate-damaged-null-version', 'admin-1', 'delete',
    'manual_review_pending', 'deleted_quarantined', '损坏预期版本',
    'gate-damaged-null-version-key',
    jsonb_build_object(
      'submissionId', 'gate-damaged-null-version',
      'adminId', 'admin-1',
      'action', 'delete',
      'nextStatus', 'deleted_quarantined',
      'expectedVersion', NULL,
      'reason', '损坏预期版本'
    ),
    jsonb_build_object(
      'submission', jsonb_build_object(
        'id', 'gate-damaged-null-version',
        'status', 'purged'
      ),
      'replayed', false
    )
  );
`;

const legacyMigrationRollbackAssertionSql = String.raw`
DO $rollback_assertion$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'submissions'
      AND column_name = 'publication_basis'
  ) THEN
    RAISE EXCEPTION '行为门失败：损坏旧审计使第六迁移部分提交';
  END IF;
  IF (
    SELECT count(*)
    FROM admin_audit_logs
    WHERE idempotency_key IN (
      'gate-damaged-submission-id-key',
      'gate-damaged-null-version-key'
    )
  ) IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION '行为门失败：迁移失败未完整回滚损坏夹具';
  END IF;
END
$rollback_assertion$;
`;

const cleanupDamagedLegacyAdminAuditFixtureSql = String.raw`
DELETE FROM admin_audit_logs
WHERE idempotency_key IN (
  'gate-damaged-submission-id-key',
  'gate-damaged-null-version-key'
);
DELETE FROM submissions
WHERE id IN (
  'gate-damaged-submission-id',
  'gate-damaged-null-version'
);
`;

const behaviorSql = String.raw`
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false);

CREATE OR REPLACE FUNCTION gate_seed(p_id text)
RETURNS void LANGUAGE plpgsql AS $seed$
BEGIN
  PERFORM create_submission(
    jsonb_build_object(
      'id', p_id,
      'kind', 'shared_package',
      'title', '临时数据库行为门',
      'body', '验证完整扫描证据',
      'status_token_hash', md5(p_id) || md5(p_id)
    ),
    jsonb_build_array(
      jsonb_build_object(
        'role', 'cover',
        'storage_key', 'submissions/' || p_id || '/cover.png',
        'file_name', 'cover.png',
        'declared_bytes', 7,
        'content_type', 'image/png'
      ),
      jsonb_build_object(
        'role', 'package',
        'storage_key', 'submissions/' || p_id || '/package.zip',
        'file_name', 'pet.zip',
        'declared_bytes', 8,
        'content_type', 'application/zip'
      )
    )
  );
  PERFORM complete_submission_upload(
    p_id,
    jsonb_build_array(
      jsonb_build_object(
        'role', 'cover',
        'storage_key', 'submissions/' || p_id || '/cover.png',
        'actual_bytes', 7,
        'content_type', 'image/png'
      ),
      jsonb_build_object(
        'role', 'package',
        'storage_key', 'submissions/' || p_id || '/package.zip',
        'actual_bytes', 8,
        'content_type', 'application/zip'
      )
    )
  );
END
$seed$;

CREATE OR REPLACE FUNCTION gate_pass_result(
  p_id text,
  p_status_version bigint,
  p_completed_at timestamptz,
  p_archive_size bigint DEFAULT 8
)
RETURNS jsonb LANGUAGE sql AS $result$
  SELECT jsonb_build_array(jsonb_build_object(
    'kind', 'package_scan',
    'provider', 'isolated-scanner',
    'rule_version', 'character-package-2026-08-15',
    'suggestion', 'Pass',
    'label', '技术检查：CHARACTER_PACKAGE_SCAN_PASSED',
    'score', NULL,
    'evidence', jsonb_build_object(
      'submissionId', p_id,
      'packageStorageKey', 'submissions/' || p_id || '/package.zip',
      'packageSizeBytes', 8,
      'archiveSizeBytes', p_archive_size,
      'archiveSha256', repeat('a', 64),
      'protocolVersion', '2026-08-15',
      'ruleVersion', 'character-package-2026-08-15',
      'scanCode', 'CHARACTER_PACKAGE_SCAN_PASSED',
      'completedAt', p_completed_at,
      'expiresAt', p_completed_at + interval '24 hours',
      'submissionStatusVersion', p_status_version
    ),
    'requested_at', p_completed_at,
    'completed_at', p_completed_at,
    'error_message', NULL
  ));
$result$;

/** 行为门用危险结果，证明后到技术事实不被改写为通过。 */
CREATE OR REPLACE FUNCTION gate_block_result(
  p_id text,
  p_completed_at timestamptz
)
RETURNS jsonb LANGUAGE sql AS $result$
  SELECT jsonb_build_array(jsonb_build_object(
    'kind', 'package_scan',
    'provider', 'isolated-scanner',
    'rule_version', 'character-package-2026-08-15',
    'suggestion', 'Block',
    'label', '技术检查：MALWARE_DETECTED',
    'score', 1,
    'evidence', jsonb_build_object('scanCode', 'MALWARE_DETECTED'),
    'requested_at', p_completed_at - interval '1 minute',
    'completed_at', p_completed_at,
    'error_message', NULL
  ));
$result$;

/** 故障注入只拦截指定幂等键，用于证明审计写入失败会回滚状态变更。 */
CREATE OR REPLACE FUNCTION gate_fail_audit_insert()
RETURNS trigger LANGUAGE plpgsql AS $trigger$
BEGIN
  IF NEW.idempotency_key = 'gate-late-audit-failure' THEN
    RAISE EXCEPTION '行为门注入的审计写入失败'
      USING ERRCODE = 'P9001';
  END IF;
  RETURN NEW;
END
$trigger$;
CREATE TRIGGER gate_fail_audit_insert
BEFORE INSERT ON admin_audit_logs
FOR EACH ROW EXECUTE FUNCTION gate_fail_audit_insert();

DO $gate$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_status text;
  v_version bigint;
  v_claimed_version bigint;
  v_cleanup_version bigint;
  v_claimed_id text;
  v_count bigint;
  v_evidence_case text;
  v_first_snapshot jsonb;
  v_result jsonb;
BEGIN
  -- 旧版全行审计快照升级后必须精确收敛，并继续回放首次动作事实。
  SELECT result_snapshot INTO v_first_snapshot
  FROM admin_audit_logs
  WHERE idempotency_key = 'gate-legacy-replay';
  IF (
      SELECT array_agg(key ORDER BY key)
      FROM jsonb_object_keys(
        v_first_snapshot -> 'submission'
      ) AS snapshot_key(key)
    ) IS DISTINCT FROM ARRAY[
      'created_at', 'id', 'kind', 'public_reason', 'publication_basis',
      'published_at', 'quarantined_at', 'rejected_at', 'status',
      'status_version', 'updated_at'
    ]::text[]
    OR v_first_snapshot #>> '{submission,status}' IS DISTINCT FROM 'published'
    OR v_first_snapshot #>> '{submission,status_version}' IS DISTINCT FROM '1'
    OR v_first_snapshot #>> '{submission,publication_basis}'
      IS DISTINCT FROM 'standard' THEN
    RAISE EXCEPTION '行为门失败：旧版审计快照未安全收敛';
  END IF;
  v_result := apply_admin_action(
    'gate-legacy-audit', 'admin-1', 'approve', 'published', 0,
    'gate-legacy-replay', '历史普通批准'
  );
  IF COALESCE((v_result ->> 'replayed')::boolean, false) IS NOT TRUE
    OR (v_result - 'replayed') <> (v_first_snapshot - 'replayed') THEN
    RAISE EXCEPTION '行为门失败：旧版审计快照无法稳定回放';
  END IF;

  -- 被旧 purge 压缩的快照只能用审计事实重建，不得猜测已清理字段。
  SELECT result_snapshot INTO v_first_snapshot
  FROM admin_audit_logs
  WHERE idempotency_key = 'gate-legacy-purged-approve';
  IF (
      SELECT array_agg(key ORDER BY key)
      FROM jsonb_object_keys(
        v_first_snapshot -> 'submission'
      ) AS snapshot_key(key)
    ) IS DISTINCT FROM ARRAY[
      'id', 'publication_basis', 'status', 'status_version'
    ]::text[]
    OR v_first_snapshot #>> '{submission,id}'
      IS DISTINCT FROM 'gate-legacy-purged-audit'
    OR v_first_snapshot #>> '{submission,status}'
      IS DISTINCT FROM 'published'
    OR v_first_snapshot #>> '{submission,status_version}' IS DISTINCT FROM '1'
    OR v_first_snapshot #>> '{submission,publication_basis}'
      IS DISTINCT FROM 'standard' THEN
    RAISE EXCEPTION '行为门失败：旧 purge 快照未按审计事实重建';
  END IF;
  v_result := apply_admin_action(
    'gate-legacy-purged-audit', 'admin-1', 'approve', 'published', 0,
    'gate-legacy-purged-approve', '历史批准后被清理'
  );
  IF COALESCE((v_result ->> 'replayed')::boolean, false) IS NOT TRUE
    OR (v_result - 'replayed') <> (v_first_snapshot - 'replayed') THEN
    RAISE EXCEPTION '行为门失败：旧 purge 快照无法回放首次动作';
  END IF;

  -- 同一旧 purge 投稿的删除动作也必须从审计事实恢复精确四键结果。
  SELECT result_snapshot INTO v_first_snapshot
  FROM admin_audit_logs
  WHERE idempotency_key = 'gate-legacy-purged-delete';
  IF (
      SELECT array_agg(key ORDER BY key)
      FROM jsonb_object_keys(
        v_first_snapshot -> 'submission'
      ) AS snapshot_key(key)
    ) IS DISTINCT FROM ARRAY[
      'id', 'publication_basis', 'status', 'status_version'
    ]::text[]
    OR v_first_snapshot #>> '{submission,id}'
      IS DISTINCT FROM 'gate-legacy-purged-audit'
    OR v_first_snapshot #>> '{submission,status}'
      IS DISTINCT FROM 'deleted_quarantined'
    OR v_first_snapshot #>> '{submission,status_version}' IS DISTINCT FROM '2'
    OR v_first_snapshot #> '{submission,publication_basis}'
      IS DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION '行为门失败：旧 purge 删除快照未按审计事实重建';
  END IF;
  v_result := apply_admin_action(
    'gate-legacy-purged-audit', 'admin-1', 'delete',
    'deleted_quarantined', 1, 'gate-legacy-purged-delete', '历史删除'
  );
  IF COALESCE((v_result ->> 'replayed')::boolean, false) IS NOT TRUE
    OR (v_result - 'replayed') <> (v_first_snapshot - 'replayed') THEN
    RAISE EXCEPTION '行为门失败：旧 purge 删除快照无法稳定回放';
  END IF;

  -- 1. 数据库约束直接拒绝 published + NULL，不依赖服务层。
  BEGIN
    INSERT INTO submissions (
      id, kind, status, status_token_hash, publication_basis
    ) VALUES (
      'gate-invalid-basis', 'feedback', 'published', repeat('0', 64), NULL
    );
    RAISE EXCEPTION '行为门失败：published 接受了空发布依据';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    NULL;
  END;

  -- SQL NULL 必须由稳定参数错误拒绝，不得落入三值逻辑。
  PERFORM create_text_submission(jsonb_build_object(
    'id', 'gate-null-next',
    'kind', 'feedback',
    'title', 'NULL 参数',
    'body', '验证下一状态不得为空',
    'status_token_hash', repeat('1', 64)
  ));
  BEGIN
    PERFORM apply_moderation_decision(
      'gate-null-next', 0, NULL, '[]'::jsonb, '{}'::jsonb, NULL
    );
    RAISE EXCEPTION '行为门失败：p_next_status 接受了 SQL NULL';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    NULL;
  END;

  PERFORM create_text_submission(jsonb_build_object(
    'id', 'gate-null-results',
    'kind', 'feedback',
    'title', 'NULL 参数',
    'body', '验证审核结果不得为空',
    'status_token_hash', repeat('2', 64)
  ));
  BEGIN
    PERFORM apply_moderation_decision(
      'gate-null-results', 0, 'manual_review_pending', NULL, '{}'::jsonb, NULL
    );
    RAISE EXCEPTION '行为门失败：p_results 接受了 SQL NULL';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    NULL;
  END;

  PERFORM create_text_submission(jsonb_build_object(
    'id', 'gate-null-risk',
    'kind', 'feedback',
    'title', 'NULL 参数',
    'body', '验证风险摘要不得为空',
    'status_token_hash', repeat('3', 64)
  ));
  BEGIN
    PERFORM apply_moderation_decision(
      'gate-null-risk', 0, 'manual_review_pending', '[]'::jsonb, NULL, NULL
    );
    RAISE EXCEPTION '行为门失败：p_risk_summary 接受了 SQL NULL';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    NULL;
  END;

  -- 2. 上传完成只进入系统审核。
  PERFORM gate_seed('gate-valid');
  SELECT status, status_version INTO v_status, v_version
  FROM submissions WHERE id = 'gate-valid';
  IF v_status <> 'system_reviewing' OR v_version <> 1 THEN
    RAISE EXCEPTION '行为门失败：上传状态流';
  END IF;
  PERFORM create_text_submission(jsonb_build_object(
    'id', 'gate-feedback',
    'kind', 'feedback',
    'title', '匿名用户',
    'body', '文本投稿也先系统审核',
    'status_token_hash', repeat('d', 64)
  ));
  IF (SELECT status FROM submissions WHERE id = 'gate-feedback')
    <> 'system_reviewing' THEN
    RAISE EXCEPTION '行为门失败：文本投稿直接进入人工队列';
  END IF;

  -- 2. 弱证据被拒绝，函数内插入在异常子事务中完整回滚。
  PERFORM gate_seed('gate-weak');
  BEGIN
    PERFORM apply_moderation_decision(
      'gate-weak', 1, 'manual_review_pending',
      jsonb_build_array(jsonb_build_object(
        'kind', 'package_scan',
        'provider', 'isolated-scanner',
        'rule_version', 'character-package-2026-08-15',
        'suggestion', 'Pass',
        'label', '弱证据',
        'evidence', jsonb_build_object(
          'submissionId', 'gate-weak',
          'packageStorageKey', 'submissions/gate-weak/package.zip',
          'packageSizeBytes', 8,
          'archiveSizeBytes', 8,
          'archiveSha256', repeat('a', 64),
          'completedAt', v_now,
          'expiresAt', v_now + interval '24 hours',
          'submissionStatusVersion', 2
        ),
        'requested_at', v_now,
        'completed_at', v_now
      )),
      '{}'::jsonb,
      NULL
    );
    RAISE EXCEPTION '行为门失败：弱证据被接受';
  EXCEPTION WHEN SQLSTATE 'P1003' THEN
    NULL;
  END;
  SELECT count(*) INTO v_count
  FROM moderation_results WHERE submission_id = 'gate-weak';
  IF v_count <> 0 OR (SELECT status FROM submissions WHERE id = 'gate-weak')
    <> 'system_reviewing' THEN
    RAISE EXCEPTION '行为门失败：异常事务未回滚';
  END IF;

  -- 3. 归档大小身份不一致时同样失败关闭。
  PERFORM gate_seed('gate-mismatch');
  BEGIN
    PERFORM apply_moderation_decision(
      'gate-mismatch', 1, 'manual_review_pending',
      gate_pass_result('gate-mismatch', 2, v_now, 7),
      '{}'::jsonb,
      NULL
    );
    RAISE EXCEPTION '行为门失败：不一致归档身份被接受';
  EXCEPTION WHEN SQLSTATE 'P1003' THEN
    NULL;
  END;

  -- 4. 历史扫描结果不能覆盖本次完整证据绑定的 ZIP 身份。
  INSERT INTO moderation_results (
    submission_id, kind, provider, rule_version, suggestion, label,
    evidence, requested_at, completed_at
  ) VALUES (
    'gate-valid', 'package_scan', 'isolated-scanner',
    'character-package-2026-08-15', 'Pass', '历史扫描',
    (gate_pass_result('gate-valid', 1, v_now - interval '1 hour')->0)
      || jsonb_build_object('archiveSha256', repeat('b', 64)),
    v_now - interval '1 hour', v_now - interval '1 hour'
  );

  -- 完整证据把系统审核原子推进到人工队列并保存完整 ZIP SHA-256。
  PERFORM apply_moderation_decision(
    'gate-valid', 1, 'manual_review_pending',
    gate_pass_result('gate-valid', 2, v_now),
    '{"blocked":false}'::jsonb,
    NULL
  );
  IF (SELECT status FROM submissions WHERE id = 'gate-valid')
      <> 'manual_review_pending'
    OR (SELECT sha256 FROM assets
        WHERE submission_id = 'gate-valid' AND role = 'package')
      <> repeat('a', 64) THEN
    RAISE EXCEPTION '行为门失败：完整扫描决策';
  END IF;

  -- 5. expiresAt > now 才有效，恰好相等必须无效。
  IF technical_scan_evidence_valid('gate-valid', 2, v_now + interval '24 hours')
    THEN
    RAISE EXCEPTION '行为门失败：TTL 等号边界';
  END IF;

  -- 6. 有效证据存在时不允许错标为强制发布。
  BEGIN
    PERFORM apply_admin_action(
      'gate-valid', 'admin-1', 'force_publish', 'published', 2,
      'gate-valid-force', '应走普通批准', 'ADMIN_OVERRIDE_ACCEPTED'
    );
    RAISE EXCEPTION '行为门失败：有效证据被错标为强制发布';
  EXCEPTION WHEN SQLSTATE 'P1002' THEN
    NULL;
  END;

  -- 服务看似完整的证据仍由数据库逐行核对；任一真实行不一致都允许走强制发布。
  FOREACH v_evidence_case IN ARRAY ARRAY[
    'gate-force-archive-sha',
    'gate-force-rule-version',
    'gate-force-completed-at'
  ] LOOP
    PERFORM gate_seed(v_evidence_case);
    PERFORM apply_moderation_decision(
      v_evidence_case, 1, 'manual_review_pending',
      gate_pass_result(v_evidence_case, 2, v_now),
      '{"blocked":false}'::jsonb,
      NULL
    );
    IF v_evidence_case = 'gate-force-archive-sha' THEN
      UPDATE assets
      SET sha256 = repeat('b', 64)
      WHERE submission_id = v_evidence_case AND role = 'package';
    ELSIF v_evidence_case = 'gate-force-rule-version' THEN
      UPDATE moderation_results
      SET rule_version = 'character-package-legacy'
      WHERE submission_id = v_evidence_case AND kind = 'package_scan';
    ELSE
      UPDATE moderation_results
      SET completed_at = completed_at + interval '1 second'
      WHERE submission_id = v_evidence_case AND kind = 'package_scan';
    END IF;
    IF technical_scan_evidence_valid(v_evidence_case, 2, v_now) THEN
      RAISE EXCEPTION '行为门失败：真实行不一致仍被识别为有效证据';
    END IF;
    v_result := apply_admin_action(
      v_evidence_case, 'admin-1', 'force_publish', 'published', 2,
      v_evidence_case || '-force', '数据库确认真实证据不完整',
      'ADMIN_OVERRIDE_ACCEPTED'
    );
    IF (SELECT status FROM submissions WHERE id = v_evidence_case)
        <> 'published'
      OR (SELECT publication_basis FROM submissions WHERE id = v_evidence_case)
        <> 'admin_override'
      OR v_result #>> '{submission,publication_basis}' <> 'admin_override' THEN
      RAISE EXCEPTION '行为门失败：真实行不一致未允许强制发布';
    END IF;
  END LOOP;

  -- 7. 有效证据允许普通批准，并原子写入 standard 发布依据。
  PERFORM apply_admin_action(
    'gate-valid', 'admin-1', 'approve', 'published', 2,
    'gate-valid-approve', '人工复核通过'
  );
  IF (SELECT status FROM submissions WHERE id = 'gate-valid') <> 'published'
    OR (SELECT publication_basis FROM submissions WHERE id = 'gate-valid')
      <> 'standard'
    OR NOT EXISTS (
      SELECT 1 FROM admin_audit_logs
      WHERE idempotency_key = 'gate-valid-approve'
    ) THEN
    RAISE EXCEPTION '行为门失败：有效批准';
  END IF;

  -- standard 发布依据即使伪造租约也不得进入后到分支。
  UPDATE submissions
  SET moderation_lease_until = v_now + interval '5 minutes'
  WHERE id = 'gate-valid';
  SELECT count(*) INTO v_count
  FROM moderation_results WHERE submission_id = 'gate-valid';
  v_result := apply_moderation_decision(
    'gate-valid', 1, 'auto_rejected', gate_block_result('gate-valid', v_now),
    '{"blocked":true,"severity":"high"}'::jsonb, '不应写入'
  );
  IF COALESCE((v_result ->> 'applied')::boolean, false) IS NOT FALSE
    OR (SELECT count(*) FROM moderation_results
        WHERE submission_id = 'gate-valid') <> v_count
    OR (SELECT risk_summary FROM submissions
        WHERE id = 'gate-valid') IS DISTINCT FROM '{"blocked":false}'::jsonb
    OR (SELECT status_version FROM submissions WHERE id = 'gate-valid') <> 3
    OR (SELECT publication_basis FROM submissions WHERE id = 'gate-valid')
      <> 'standard' THEN
    RAISE EXCEPTION '行为门失败：standard 发布接受了后到结果';
  END IF;
  UPDATE submissions
  SET moderation_lease_until = NULL
  WHERE id = 'gate-valid';

  -- 独立的无租约强制发布记录不得接受第一次后到结果。
  INSERT INTO submissions (
    id, kind, status, status_version, status_token_hash,
    publication_basis, risk_summary
  ) VALUES (
    'gate-no-lease-late', 'shared_package', 'published', 4,
    repeat('8', 64), 'admin_override',
    '{"blocked":false,"severity":"low"}'::jsonb
  );
  v_result := apply_moderation_decision(
    'gate-no-lease-late', 2, 'auto_rejected',
    gate_block_result('gate-no-lease-late', v_now),
    '{"blocked":true,"severity":"high"}'::jsonb, '不应写入'
  );
  IF COALESCE((v_result ->> 'applied')::boolean, false) IS NOT FALSE
    OR EXISTS (
      SELECT 1 FROM moderation_results
      WHERE submission_id = 'gate-no-lease-late'
    )
    OR (SELECT risk_summary FROM submissions
        WHERE id = 'gate-no-lease-late') IS DISTINCT FROM
      '{"blocked":false,"severity":"low"}'::jsonb
    OR (SELECT status_version FROM submissions
        WHERE id = 'gate-no-lease-late') IS DISTINCT FROM 4 THEN
    RAISE EXCEPTION '行为门失败：无租约仍接受首次后到结果';
  END IF;

  -- 已过期租约与无租约同样失败关闭，不得追加结果或改写任何裁决事实。
  PERFORM gate_seed('gate-expired-late');
  UPDATE submissions
  SET created_at = v_now - interval '3 days'
  WHERE id = 'gate-expired-late';
  SELECT claimed.status_version INTO v_claimed_version
  FROM claim_moderation_jobs(1, v_now + interval '5 minutes') AS claimed
  WHERE claimed.id = 'gate-expired-late';
  IF v_claimed_version <> 2 THEN
    RAISE EXCEPTION '行为门失败：未真实领取过期租约测试任务';
  END IF;
  PERFORM apply_admin_action(
    'gate-expired-late', 'admin-1', 'move_to_manual',
    'manual_review_pending', 2, 'gate-expired-late-manual', '人工接管扫描中任务'
  );
  PERFORM apply_admin_action(
    'gate-expired-late', 'admin-1', 'force_publish', 'published', 3,
    'gate-expired-late-force', '管理员承担扫描中发布风险',
    'ADMIN_OVERRIDE_ACCEPTED'
  );
  UPDATE submissions
  SET moderation_lease_until = v_now - interval '1 second'
  WHERE id = 'gate-expired-late';
  v_result := apply_moderation_decision(
    'gate-expired-late', 2, 'auto_rejected',
    gate_block_result('gate-expired-late', v_now),
    '{"blocked":true,"severity":"high"}'::jsonb, '不得写入'
  );
  IF COALESCE((v_result ->> 'applied')::boolean, false) IS NOT FALSE
    OR EXISTS (
      SELECT 1 FROM moderation_results
      WHERE submission_id = 'gate-expired-late'
    )
    OR (SELECT risk_summary FROM submissions
        WHERE id = 'gate-expired-late') IS DISTINCT FROM '{}'::jsonb
    OR (SELECT auto_rejection_reason FROM submissions
        WHERE id = 'gate-expired-late') IS NOT NULL
    OR (SELECT status FROM submissions
        WHERE id = 'gate-expired-late') IS DISTINCT FROM 'published'
    OR (SELECT status_version FROM submissions
        WHERE id = 'gate-expired-late') IS DISTINCT FROM 4
    OR (SELECT publication_basis FROM submissions
        WHERE id = 'gate-expired-late') IS DISTINCT FROM 'admin_override'
    OR (SELECT count(*) FROM admin_audit_logs
        WHERE submission_id = 'gate-expired-late') <> 2 THEN
    RAISE EXCEPTION '行为门失败：过期租约后到结果修改了原子事实';
  END IF;

  -- 反馈、系统审核和自动驳回都不得一步强制发布。
  PERFORM apply_admin_action(
    'gate-feedback', 'admin-1', 'move_to_manual', 'manual_review_pending', 0,
    'gate-feedback-manual', '文本转人工'
  );
  BEGIN
    PERFORM apply_admin_action(
      'gate-feedback', 'admin-1', 'force_publish', 'published', 1,
      'gate-feedback-force', '反馈不得强制发布',
      'ADMIN_OVERRIDE_ACCEPTED'
    );
    RAISE EXCEPTION '行为门失败：feedback 接受了强制发布';
  EXCEPTION WHEN SQLSTATE 'P1002' THEN
    NULL;
  END;

  PERFORM gate_seed('gate-direct-system');
  BEGIN
    PERFORM apply_admin_action(
      'gate-direct-system', 'admin-1', 'force_publish', 'published', 1,
      'gate-direct-system-force', '系统审核不得跳步',
      'ADMIN_OVERRIDE_ACCEPTED'
    );
    RAISE EXCEPTION '行为门失败：system_reviewing 直接强制发布';
  EXCEPTION WHEN SQLSTATE 'P1002' THEN
    NULL;
  END;

  INSERT INTO submissions (
    id, kind, status, status_token_hash, auto_rejection_reason
  ) VALUES (
    'gate-direct-auto', 'shared_package', 'auto_rejected', repeat('4', 64),
    '自动驳回'
  );
  BEGIN
    PERFORM apply_admin_action(
      'gate-direct-auto', 'admin-1', 'force_publish', 'published', 0,
      'gate-direct-auto-force', '自动驳回不得跳步',
      'ADMIN_OVERRIDE_ACCEPTED'
    );
    RAISE EXCEPTION '行为门失败：auto_rejected 直接强制发布';
  EXCEPTION WHEN SQLSTATE 'P1002' THEN
    NULL;
  END;

  -- 8. 共享包可以从系统审核直接转入人工待审。
  PERFORM gate_seed('gate-move');
  PERFORM apply_admin_action(
    'gate-move', 'admin-1', 'move_to_manual', 'manual_review_pending', 1,
    'gate-move-manual', '请求人工复核'
  );
  IF (SELECT status FROM submissions WHERE id = 'gate-move')
    <> 'manual_review_pending' THEN
    RAISE EXCEPTION '行为门失败：共享包未直接转人工';
  END IF;

  -- 危险共享包转人工只改管理状态，不改写原技术结论。
  INSERT INTO submissions (
    id, kind, status, status_token_hash, auto_rejection_reason, risk_summary
  ) VALUES (
    'gate-auto-move', 'shared_package', 'auto_rejected', repeat('f', 64),
    '检测到危险文件', '{"blocked":true,"severity":"high"}'::jsonb
  );
  INSERT INTO moderation_results (
    submission_id, kind, provider, rule_version, suggestion, label,
    evidence, requested_at, completed_at
  ) VALUES (
    'gate-auto-move', 'package_scan', 'isolated-scanner',
    'character-package-2026-08-15', 'Block', '技术检查：MALWARE_DETECTED',
    '{"scanCode":"MALWARE_DETECTED"}'::jsonb, v_now, v_now
  );
  PERFORM apply_admin_action(
    'gate-auto-move', 'admin-1', 'move_to_manual',
    'manual_review_pending', 0, 'gate-auto-move-manual', '转人工复核'
  );
  IF (SELECT status FROM submissions WHERE id = 'gate-auto-move')
      <> 'manual_review_pending'
    OR (SELECT auto_rejection_reason FROM submissions
        WHERE id = 'gate-auto-move') <> '检测到危险文件'
    OR (SELECT risk_summary FROM submissions
        WHERE id = 'gate-auto-move') IS DISTINCT FROM
      '{"blocked":true,"severity":"high"}'::jsonb
    OR NOT EXISTS (
      SELECT 1 FROM moderation_results
      WHERE submission_id = 'gate-auto-move' AND suggestion = 'Block'
    )
    OR EXISTS (
      SELECT 1 FROM moderation_results
      WHERE submission_id = 'gate-auto-move' AND suggestion = 'Pass'
    ) THEN
    RAISE EXCEPTION '行为门失败：危险共享包转人工改写了技术事实';
  END IF;

  -- Worker 初读后管理员两步强制发布；数据库必须从混合结果中只保留唯一技术事实。
  PERFORM gate_seed('gate-late-mixed');
  UPDATE submissions
  SET created_at = v_now - interval '2 days'
  WHERE id = 'gate-late-mixed';
  SELECT claimed.status_version INTO v_claimed_version
  FROM claim_moderation_jobs(3, v_now + interval '5 minutes') AS claimed
  WHERE claimed.id = 'gate-late-mixed';
  IF v_claimed_version <> 2 THEN
    RAISE EXCEPTION '行为门失败：未真实领取混合后到审核任务';
  END IF;
  PERFORM apply_admin_action(
    'gate-late-mixed', 'admin-1', 'move_to_manual',
    'manual_review_pending', 2, 'gate-late-mixed-manual', '人工接管扫描中任务'
  );
  PERFORM apply_admin_action(
    'gate-late-mixed', 'admin-1', 'force_publish', 'published', 3,
    'gate-late-mixed-force', '管理员承担扫描中发布风险',
    'ADMIN_OVERRIDE_ACCEPTED'
  );

  BEGIN
    PERFORM apply_moderation_decision(
      'gate-late-mixed', 2, 'manual_review_pending',
      jsonb_build_array(jsonb_build_object(
        'kind', 'package_json_text',
        'provider', 'tencent-tms',
        'rule_version', '2026-07-31',
        'suggestion', 'Pass',
        'label', 'Normal',
        'score', NULL,
        'evidence', jsonb_build_object('path', 'manifest.json'),
        'requested_at', v_now,
        'completed_at', v_now,
        'error_message', NULL
      )),
      '{"blocked":false}'::jsonb, NULL
    );
    RAISE EXCEPTION '行为门失败：混合后到接受缺失技术记录';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    NULL;
  END;
  BEGIN
    PERFORM apply_moderation_decision(
      'gate-late-mixed', 2, 'auto_rejected',
      gate_block_result('gate-late-mixed', v_now)
        || gate_block_result('gate-late-mixed', v_now),
      '{"blocked":false}'::jsonb, '重复技术记录'
    );
    RAISE EXCEPTION '行为门失败：混合后到接受重复技术记录';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    NULL;
  END;
  BEGIN
    PERFORM apply_moderation_decision(
      'gate-late-mixed', 2, 'auto_rejected',
      jsonb_set(
        gate_block_result('gate-late-mixed', v_now),
        '{0,label}',
        'null'::jsonb
      ),
      '{"blocked":false}'::jsonb, '畸形技术记录'
    );
    RAISE EXCEPTION '行为门失败：混合后到接受畸形技术记录';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    NULL;
  END;
  IF (SELECT moderation_lease_until FROM submissions
      WHERE id = 'gate-late-mixed') IS NULL
    OR EXISTS (
      SELECT 1 FROM moderation_results
      WHERE submission_id = 'gate-late-mixed'
    ) THEN
    RAISE EXCEPTION '行为门失败：无效混合后到修改了原子事实';
  END IF;

  v_result := apply_moderation_decision(
    'gate-late-mixed', 2, 'auto_rejected',
    gate_block_result('gate-late-mixed', v_now)
      || jsonb_build_array(jsonb_build_object(
        'kind', 'package_json_text',
        'provider', 'tencent-tms',
        'rule_version', '2026-07-31',
        'suggestion', 'Pass',
        'label', 'Normal',
        'score', NULL,
        'evidence', jsonb_build_object('path', 'manifest.json'),
        'requested_at', v_now,
        'completed_at', v_now,
        'error_message', NULL
      )),
    '{"blocked":false,"signalCount":2,"blockedLabels":[],"severity":"low"}'::jsonb,
    '非技术结果不得降低风险'
  );
  IF COALESCE((v_result ->> 'applied')::boolean, false) IS NOT TRUE
    OR COALESCE((v_result ->> 'lateResult')::boolean, false) IS NOT TRUE
    OR (SELECT status FROM submissions WHERE id = 'gate-late-mixed')
      <> 'published'
    OR (SELECT status_version FROM submissions WHERE id = 'gate-late-mixed') <> 4
    OR (SELECT publication_basis FROM submissions WHERE id = 'gate-late-mixed')
      <> 'admin_override'
    OR (SELECT moderation_lease_until FROM submissions
        WHERE id = 'gate-late-mixed') IS NOT NULL
    OR (SELECT risk_summary FROM submissions WHERE id = 'gate-late-mixed')
      IS DISTINCT FROM
      '{"blocked":true,"signalCount":1,"blockedLabels":["技术检查：MALWARE_DETECTED"]}'::jsonb
    OR (SELECT count(*) FROM moderation_results
        WHERE submission_id = 'gate-late-mixed') <> 1
    OR EXISTS (
      SELECT 1 FROM moderation_results
      WHERE submission_id = 'gate-late-mixed'
        AND (kind <> 'package_scan' OR provider <> 'isolated-scanner')
    ) THEN
    RAISE EXCEPTION '行为门失败：混合后到未原子保留唯一技术事实';
  END IF;

  -- 9. 已领取的审核任务先转人工，为后到结果保留真实租约事实。
  PERFORM gate_seed('gate-late');
  UPDATE submissions
  SET created_at = v_now - interval '1 day'
  WHERE id = 'gate-late';
  SELECT claimed.status_version INTO v_claimed_version
  FROM claim_moderation_jobs(1, v_now + interval '5 minutes') AS claimed
  WHERE claimed.id = 'gate-late';
  IF v_claimed_version <> 2 THEN
    RAISE EXCEPTION '行为门失败：未真实领取后到审核任务';
  END IF;
  INSERT INTO moderation_results (
    submission_id, kind, provider, rule_version, suggestion, label,
    evidence, requested_at, completed_at
  ) VALUES (
    'gate-late', 'package_scan', 'isolated-scanner',
    'character-package-2026-08-15', 'Review', '待人工确认',
    '{}'::jsonb, v_now - interval '2 minutes', v_now - interval '1 minute'
  );
  PERFORM apply_admin_action(
    'gate-late', 'admin-1', 'move_to_manual', 'manual_review_pending', 2,
    'gate-late-manual', '人工接管已领取任务'
  );

  -- 10. 缺少通过证据时普通批准必须失败且不产生状态或审计写入。
  BEGIN
    PERFORM apply_admin_action(
      'gate-late', 'admin-1', 'approve', 'published', 3,
      'gate-late-approve', '普通批准不得绕过扫描'
    );
    RAISE EXCEPTION '行为门失败：无通过证据仍可普通批准';
  EXCEPTION WHEN SQLSTATE 'P1003' THEN
    NULL;
  END;
  IF (SELECT status_version FROM submissions WHERE id = 'gate-late') <> 3
    OR EXISTS (
      SELECT 1 FROM admin_audit_logs
      WHERE idempotency_key = 'gate-late-approve'
    ) THEN
    RAISE EXCEPTION '行为门失败：普通批准拒绝未回滚';
  END IF;

  -- 11. 强制发布缺少专用风险确认时必须回滚。
  BEGIN
    PERFORM apply_admin_action(
      'gate-late', 'admin-1', 'force_publish', 'published', 3,
      'gate-late-missing-ack', '缺少风险确认', NULL
    );
    RAISE EXCEPTION '行为门失败：缺少风险确认仍可强制发布';
  EXCEPTION WHEN SQLSTATE 'P1002' THEN
    NULL;
  END;
  IF (SELECT status_version FROM submissions WHERE id = 'gate-late') <> 3
    OR (SELECT publication_basis FROM submissions WHERE id = 'gate-late')
      IS NOT NULL THEN
    RAISE EXCEPTION '行为门失败：缺少确认的强制发布未回滚';
  END IF;

  BEGIN
    PERFORM apply_admin_action(
      'gate-late', 'admin-1', 'force_publish', 'published', 3,
      'gate-late-wrong-ack', '错误风险确认',
      'ADMIN_OVERRIDE_CONFIRMED'
    );
    RAISE EXCEPTION '行为门失败：错误风险确认字面量被接受';
  EXCEPTION WHEN SQLSTATE 'P1002' THEN
    NULL;
  END;

  -- 12. 审计写入失败必须回滚已更新的状态和发布依据。
  BEGIN
    PERFORM apply_admin_action(
      'gate-late', 'admin-1', 'force_publish', 'published', 3,
      'gate-late-audit-failure', '验证原子回滚',
      'ADMIN_OVERRIDE_ACCEPTED'
    );
    RAISE EXCEPTION '行为门失败：审计故障未阻止强制发布';
  EXCEPTION WHEN SQLSTATE 'P9001' THEN
    NULL;
  END;
  IF (SELECT status FROM submissions WHERE id = 'gate-late')
      <> 'manual_review_pending'
    OR (SELECT status_version FROM submissions WHERE id = 'gate-late') <> 3
    OR (SELECT publication_basis FROM submissions WHERE id = 'gate-late')
      IS NOT NULL THEN
    RAISE EXCEPTION '行为门失败：审计故障后状态未原子回滚';
  END IF;

  -- 13. 合法强制发布原子写入状态、发布依据和完整审计。
  v_result := apply_admin_action(
    'gate-late', 'admin-1', 'force_publish', 'published', 3,
    'gate-late-force', '管理员确认承担风险',
    'ADMIN_OVERRIDE_ACCEPTED'
  );
  IF (SELECT status FROM submissions WHERE id = 'gate-late') <> 'published'
    OR (SELECT status_version FROM submissions WHERE id = 'gate-late') <> 4
    OR (SELECT publication_basis FROM submissions WHERE id = 'gate-late')
      <> 'admin_override'
    OR v_result #>> '{submission,publication_basis}' <> 'admin_override'
    OR NOT EXISTS (
      SELECT 1 FROM admin_audit_logs
      WHERE idempotency_key = 'gate-late-force'
        AND action = 'force_publish'
        AND request_payload ->> 'riskAcknowledgement'
          = 'ADMIN_OVERRIDE_ACCEPTED'
        AND request_payload #>> '{latestScanSummary,suggestion}' = 'Review'
    )
    OR EXISTS (
      SELECT 1 FROM moderation_results
      WHERE submission_id = 'gate-late' AND suggestion = 'Pass'
    )
    OR (
      SELECT array_agg(key ORDER BY key)
      FROM jsonb_object_keys(v_result -> 'submission') AS snapshot_key(key)
    ) IS DISTINCT FROM ARRAY[
      'created_at', 'id', 'kind', 'public_reason', 'publication_basis',
      'published_at', 'quarantined_at', 'rejected_at', 'status',
      'status_version', 'updated_at'
    ]::text[]
    OR (
      SELECT array_agg(key ORDER BY key)
      FROM admin_audit_logs AS audit,
        LATERAL jsonb_object_keys(
          audit.result_snapshot -> 'submission'
        ) AS snapshot_key(key)
      WHERE audit.idempotency_key = 'gate-late-force'
    ) IS DISTINCT FROM ARRAY[
      'created_at', 'id', 'kind', 'public_reason', 'publication_basis',
      'published_at', 'quarantined_at', 'rejected_at', 'status',
      'status_version', 'updated_at'
    ]::text[] THEN
    RAISE EXCEPTION '行为门失败：强制发布原子事实不完整';
  END IF;

  -- 后到分支不接受空结果数组，失败不得消费租约。
  BEGIN
    PERFORM apply_moderation_decision(
      'gate-late', 2, 'auto_rejected', '[]'::jsonb,
      '{"blocked":false,"severity":"low"}'::jsonb, '空结果'
    );
    RAISE EXCEPTION '行为门失败：后到分支接受空结果数组';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    NULL;
  END;
  IF (SELECT moderation_lease_until FROM submissions WHERE id = 'gate-late')
      IS NULL
    OR (SELECT count(*) FROM moderation_results
        WHERE submission_id = 'gate-late') <> 1 THEN
    RAISE EXCEPTION '行为门失败：空后到结果修改了数据';
  END IF;

  -- 14. 后到危险结果只追加扫描事实和风险，不改发布状态、版本或依据。
  v_result := apply_moderation_decision(
    'gate-late', 2, 'auto_rejected', gate_block_result('gate-late', v_now),
    '{"blocked":true,"severity":"high"}'::jsonb, '检测到危险文件'
  );
  IF COALESCE((v_result ->> 'applied')::boolean, false) IS NOT TRUE
    OR COALESCE((v_result ->> 'lateResult')::boolean, false) IS NOT TRUE
    OR (SELECT status FROM submissions WHERE id = 'gate-late') <> 'published'
    OR (SELECT status_version FROM submissions WHERE id = 'gate-late') <> 4
    OR (SELECT publication_basis FROM submissions WHERE id = 'gate-late')
      <> 'admin_override'
    OR (SELECT risk_summary FROM submissions
        WHERE id = 'gate-late') IS DISTINCT FROM
      '{"blocked":true,"signalCount":1,"blockedLabels":["技术检查：MALWARE_DETECTED"]}'::jsonb
    OR NOT EXISTS (
      SELECT 1 FROM moderation_results
      WHERE submission_id = 'gate-late' AND suggestion = 'Block'
    )
    OR (SELECT count(*) FROM moderation_results
        WHERE submission_id = 'gate-late') <> 2
    OR (SELECT count(*) FROM moderation_results
        WHERE submission_id = 'gate-late' AND suggestion = 'Review') <> 1 THEN
    RAISE EXCEPTION '行为门失败：后到危险结果破坏发布事实';
  END IF;

  -- 成功后到必须消费租约；重复调用不追加、不用低风险覆盖高风险。
  IF (SELECT moderation_lease_until FROM submissions WHERE id = 'gate-late')
      IS NOT NULL THEN
    RAISE EXCEPTION '行为门失败：后到结果未消费审核租约';
  END IF;
  v_result := apply_moderation_decision(
    'gate-late', 2, 'auto_rejected',
    gate_block_result('gate-late', v_now + interval '1 minute'),
    '{"blocked":false,"severity":"low"}'::jsonb, '重复后到结果'
  );
  IF COALESCE((v_result ->> 'applied')::boolean, false) IS NOT FALSE
    OR (SELECT count(*) FROM moderation_results
        WHERE submission_id = 'gate-late') <> 2
    OR (SELECT risk_summary FROM submissions
        WHERE id = 'gate-late') IS DISTINCT FROM
      '{"blocked":true,"signalCount":1,"blockedLabels":["技术检查：MALWARE_DETECTED"]}'::jsonb
    OR (SELECT status FROM submissions WHERE id = 'gate-late') <> 'published'
    OR (SELECT status_version FROM submissions WHERE id = 'gate-late') <> 4
    OR (SELECT publication_basis FROM submissions WHERE id = 'gate-late')
      <> 'admin_override'
    OR (SELECT count(*) FROM admin_audit_logs
        WHERE submission_id = 'gate-late') <> 2 THEN
    RAISE EXCEPTION '行为门失败：重复后到修改了原子事实';
  END IF;

  -- 15. 同键同请求在扫描摘要变化后仍回放首次快照。
  v_result := apply_admin_action(
    'gate-late', 'admin-1', 'force_publish', 'published', 3,
    'gate-late-force', '管理员确认承担风险',
    'ADMIN_OVERRIDE_ACCEPTED'
  );
  IF COALESCE((v_result ->> 'replayed')::boolean, false) IS NOT TRUE
    OR v_result #>> '{submission,status_version}' <> '4'
    OR v_result #>> '{submission,publication_basis}' <> 'admin_override'
    OR (SELECT count(*) FROM admin_audit_logs
        WHERE idempotency_key = 'gate-late-force') <> 1
    OR (SELECT request_payload #>> '{latestScanSummary,suggestion}'
        FROM admin_audit_logs
        WHERE idempotency_key = 'gate-late-force') <> 'Review' THEN
    RAISE EXCEPTION '行为门失败：幂等回放未保留首次快照';
  END IF;

  -- 16. 同一幂等键携带不同输入必须冲突且不改数据。
  BEGIN
    PERFORM apply_admin_action(
      'gate-late', 'admin-1', 'force_publish', 'published', 3,
      'gate-late-force', '更换理由', 'ADMIN_OVERRIDE_ACCEPTED'
    );
    RAISE EXCEPTION '行为门失败：幂等键异参未冲突';
  EXCEPTION WHEN SQLSTATE 'P1001' THEN
    NULL;
  END;
  IF (SELECT status_version FROM submissions WHERE id = 'gate-late') <> 4
    OR (SELECT count(*) FROM admin_audit_logs
        WHERE idempotency_key = 'gate-late-force') <> 1 THEN
    RAISE EXCEPTION '行为门失败：幂等冲突修改了数据';
  END IF;

  -- 17. cleanup 开始和 purge 都不得破坏幂等首次快照。
  SELECT result_snapshot INTO v_first_snapshot
  FROM admin_audit_logs
  WHERE idempotency_key = 'gate-late-force';
  PERFORM apply_admin_action(
    'gate-late', 'admin-1', 'delete', 'deleted_quarantined', 4,
    'gate-late-delete', '主动下架高风险共享包'
  );
  IF (SELECT publication_basis FROM submissions WHERE id = 'gate-late')
      IS NOT NULL THEN
    RAISE EXCEPTION '行为门失败：非发布状态仍保留发布依据';
  END IF;

  UPDATE submissions
  SET purge_after = v_now - interval '1 minute'
  WHERE id = 'gate-late';
  SELECT claimed ->> 'id', (claimed ->> 'status_version')::bigint
  INTO v_claimed_id, v_cleanup_version
  FROM claim_cleanup_jobs(1, v_now + interval '5 minutes') AS claimed;
  IF v_claimed_id <> 'gate-late' OR v_cleanup_version <> 6
    OR (SELECT cleanup_started_at FROM submissions WHERE id = 'gate-late')
      IS NULL THEN
    RAISE EXCEPTION '行为门失败：未真实领取 cleanup 任务';
  END IF;

  v_result := apply_admin_action(
    'gate-late', 'admin-1', 'force_publish', 'published', 3,
    'gate-late-force', '管理员确认承担风险',
    'ADMIN_OVERRIDE_ACCEPTED'
  );
  IF COALESCE((v_result ->> 'replayed')::boolean, false) IS NOT TRUE
    OR (v_result - 'replayed') <> (v_first_snapshot - 'replayed')
    OR (SELECT result_snapshot FROM admin_audit_logs
        WHERE idempotency_key = 'gate-late-force') <> v_first_snapshot THEN
    RAISE EXCEPTION '行为门失败：cleanup 开始后未回放首次快照';
  END IF;

  PERFORM mark_submission_purged('gate-late', 6);
  IF (SELECT status FROM submissions WHERE id = 'gate-late') <> 'purged'
    OR (SELECT status_version FROM submissions WHERE id = 'gate-late') <> 7
    OR (SELECT result_snapshot FROM admin_audit_logs
        WHERE idempotency_key = 'gate-late-force') <> v_first_snapshot THEN
    RAISE EXCEPTION '行为门失败：purge 改写了首次快照';
  END IF;

  v_result := apply_admin_action(
    'gate-late', 'admin-1', 'force_publish', 'published', 3,
    'gate-late-force', '管理员确认承担风险',
    'ADMIN_OVERRIDE_ACCEPTED'
  );
  IF COALESCE((v_result ->> 'replayed')::boolean, false) IS NOT TRUE
    OR (v_result - 'replayed') <> (v_first_snapshot - 'replayed') THEN
    RAISE EXCEPTION '行为门失败：purged 后未回放首次快照';
  END IF;

  BEGIN
    PERFORM apply_admin_action(
      'gate-late', 'admin-1', 'force_publish', 'published', 7,
      'gate-late-purged-new-key', 'purged 新请求必须拒绝',
      'ADMIN_OVERRIDE_ACCEPTED'
    );
    RAISE EXCEPTION '行为门失败：purged 新 key 绕过状态机';
  EXCEPTION WHEN SQLSTATE 'P1002' THEN
    NULL;
  END;

  -- purge 资格中的 NULL 必须按不满足处理，不能穿透三值逻辑。
  INSERT INTO submissions (
    id, kind, status, status_token_hash, cleanup_started_at,
    cleanup_lease_until, purge_after
  ) VALUES (
    'gate-purge-null', 'feedback', 'deleted_quarantined', repeat('7', 64),
    v_now, v_now + interval '5 minutes', NULL
  );
  v_result := mark_submission_purged('gate-purge-null', 0);
  IF COALESCE((v_result ->> 'applied')::boolean, false) IS NOT FALSE
    OR (SELECT status FROM submissions WHERE id = 'gate-purge-null')
      IS DISTINCT FROM 'deleted_quarantined'
    OR (SELECT status_version FROM submissions WHERE id = 'gate-purge-null')
      IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION '行为门失败：NULL purge_after 被视为满足清理资格';
  END IF;

  -- 共享包从隔离恢复仍回系统审核且保持空发布依据。
  INSERT INTO submissions (
    id, kind, status, status_token_hash, pre_quarantine_status, quarantined_at
  ) VALUES (
    'gate-restore', 'shared_package', 'deleted_quarantined', repeat('5', 64),
    'published', now()
  );
  PERFORM apply_admin_action(
    'gate-restore', 'admin-1', 'restore', 'system_reviewing', 0,
    'gate-restore-rescan', '恢复并重扫'
  );
  IF (SELECT status FROM submissions WHERE id = 'gate-restore')
      <> 'system_reviewing'
    OR (SELECT pre_quarantine_status FROM submissions WHERE id = 'gate-restore')
      IS NOT NULL
    OR (SELECT publication_basis FROM submissions WHERE id = 'gate-restore')
      IS NOT NULL THEN
    RAISE EXCEPTION '行为门失败：恢复未重扫';
  END IF;

  -- 补充兼容门：文本恢复保持既有七参数 RPC 调用及幂等快照语义。
  INSERT INTO submissions (
    id, kind, status, status_token_hash, pre_quarantine_status, quarantined_at
  ) VALUES (
    'gate-text-restore', 'feedback', 'deleted_quarantined', repeat('e', 64),
    'published', now()
  );
  v_result := apply_admin_action(
    'gate-text-restore', 'admin-1', 'restore', 'published', 0,
    'gate-text-restore-replay', '恢复文本'
  );
  v_result := apply_admin_action(
    'gate-text-restore', 'admin-1', 'restore', 'published', 0,
    'gate-text-restore-replay', '恢复文本'
  );
  IF COALESCE((v_result ->> 'replayed')::boolean, false) IS NOT TRUE
    OR v_result #>> '{submission,status}' <> 'published' THEN
    RAISE EXCEPTION '行为门失败：文本恢复未回放首次快照';
  END IF;
  BEGIN
    PERFORM apply_admin_action(
      'gate-text-restore', 'admin-1', 'restore', 'published', 0,
      'gate-text-restore-replay', '恢复文本', ''
    );
    RAISE EXCEPTION '行为门失败：普通动作在幂等回放时接受了额外确认';
  EXCEPTION WHEN SQLSTATE 'P1002' THEN
    NULL;
  END;
  BEGIN
    PERFORM apply_admin_action(
      'gate-text-restore', 'admin-1', 'restore', 'published', 0,
      'gate-text-restore-new-key', '恢复文本'
    );
    RAISE EXCEPTION '行为门失败：文本恢复新 key 绕过状态机';
  EXCEPTION WHEN SQLSTATE 'P1002' THEN
    NULL;
  END;
END
$gate$;
`;

/** 三条列表在真实 PostgreSQL 上验证同时间戳排序与翻页期间变更。 */
const keysetBehaviorSql = String.raw`
DO $keyset_security_gate$
BEGIN
  IF has_function_privilege(
      'anon', 'list_public_community(integer,timestamptz,text)', 'EXECUTE')
    OR has_function_privilege(
      'authenticated', 'list_public_feedback(text,integer,timestamptz,text)', 'EXECUTE')
    OR NOT has_function_privilege(
      'service_role', 'list_admin_submissions(integer,text,timestamptz,text)', 'EXECUTE') THEN
    RAISE EXCEPTION '行为门失败：列表 RPC 权限不符合 service_role 边界';
  END IF;

  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', false);
  BEGIN
    PERFORM * FROM list_public_community(1, NULL, NULL);
    RAISE EXCEPTION '行为门失败：社区列表未拒绝非 service_role claims';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;
  BEGIN
    PERFORM * FROM list_public_feedback('feedback', 1, NULL, NULL);
    RAISE EXCEPTION '行为门失败：反馈列表未拒绝非 service_role claims';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;
  BEGIN
    PERFORM * FROM list_admin_submissions(1, NULL, NULL, NULL);
    RAISE EXCEPTION '行为门失败：管理员列表未拒绝非 service_role claims';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;
END
$keyset_security_gate$;

SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false);

DO $keyset_gate$
DECLARE
  v_time timestamptz := '2099-08-31T03:00:00.000Z';
  v_ids text[];
BEGIN
  -- 三个 RPC 都必须把 NULL limit 当作越界输入，而不是无上限查询。
  BEGIN
    PERFORM * FROM list_public_community(NULL, NULL, NULL);
    RAISE EXCEPTION '行为门失败：社区列表接受 NULL limit';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    NULL;
  END;
  BEGIN
    PERFORM * FROM list_public_feedback('feedback', NULL, NULL, NULL);
    RAISE EXCEPTION '行为门失败：反馈列表接受 NULL limit';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    NULL;
  END;
  BEGIN
    PERFORM * FROM list_admin_submissions(NULL, NULL, NULL, NULL);
    RAISE EXCEPTION '行为门失败：管理员列表接受 NULL limit';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    NULL;
  END;

  INSERT INTO submissions (
    id, kind, title, body, status, status_token_hash, published_at,
    publication_basis, created_at
  ) VALUES
    ('keyset-community-a', 'shared_package', 'A', 'A', 'published', md5('keyset-community-a') || md5('keyset-community-a'), v_time, 'standard', v_time),
    ('keyset-community-b', 'shared_package', 'B', 'B', 'published', md5('keyset-community-b') || md5('keyset-community-b'), v_time, 'standard', v_time),
    ('keyset-community-c', 'shared_package', 'C', 'C', 'published', md5('keyset-community-c') || md5('keyset-community-c'), v_time, 'standard', v_time),
    ('keyset-feedback-a', 'feedback', 'A', 'A', 'published', md5('keyset-feedback-a') || md5('keyset-feedback-a'), v_time, 'standard', v_time),
    ('keyset-feedback-b', 'feedback', 'B', 'B', 'published', md5('keyset-feedback-b') || md5('keyset-feedback-b'), v_time, 'standard', v_time),
    ('keyset-feedback-c', 'feedback', 'C', 'C', 'published', md5('keyset-feedback-c') || md5('keyset-feedback-c'), v_time, 'standard', v_time),
    ('keyset-admin-a', 'feedback', 'A', 'A', 'system_reviewing', md5('keyset-admin-a') || md5('keyset-admin-a'), NULL, NULL, v_time),
    ('keyset-admin-b', 'feedback', 'B', 'B', 'system_reviewing', md5('keyset-admin-b') || md5('keyset-admin-b'), NULL, NULL, v_time),
    ('keyset-admin-c', 'feedback', 'C', 'C', 'system_reviewing', md5('keyset-admin-c') || md5('keyset-admin-c'), NULL, NULL, v_time);

  INSERT INTO public_engagement (submission_id)
  SELECT id FROM submissions WHERE id LIKE 'keyset-community-%' OR id LIKE 'keyset-feedback-%';
  INSERT INTO assets (
    submission_id, object_key, original_name, declared_size, actual_size,
    mime_type, role
  )
  SELECT id, 'submissions/' || id || '/package.zip', 'pet.zip', 8, 8,
         'application/zip', 'package'
  FROM submissions WHERE id LIKE 'keyset-community-%';

  SELECT array_agg(page.id) INTO v_ids
  FROM list_public_community(1, NULL, NULL) AS page
  WHERE page.id LIKE 'keyset-community-%';
  IF v_ids IS DISTINCT FROM ARRAY['keyset-community-c', 'keyset-community-b']::text[] THEN
    RAISE EXCEPTION '行为门失败：社区第一页未按同时间戳 id 降序返回 limit+1';
  END IF;

  INSERT INTO submissions (
    id, kind, title, body, status, status_token_hash, published_at,
    publication_basis, created_at
  ) VALUES (
    'keyset-community-d', 'shared_package', 'D', 'D', 'published', md5('keyset-community-d') || md5('keyset-community-d'),
    v_time, 'standard', v_time
  );
  INSERT INTO public_engagement (submission_id) VALUES ('keyset-community-d');
  INSERT INTO assets (
    submission_id, object_key, original_name, declared_size, actual_size,
    mime_type, role
  ) VALUES (
    'keyset-community-d', 'submissions/keyset-community-d/package.zip',
    'pet.zip', 8, 8, 'application/zip', 'package'
  );
  SELECT array_agg(page.id) INTO v_ids
  FROM list_public_community(2, v_time, 'keyset-community-c') AS page
  WHERE page.id LIKE 'keyset-community-%';
  IF v_ids IS DISTINCT FROM ARRAY['keyset-community-b', 'keyset-community-a']::text[] THEN
    RAISE EXCEPTION '行为门失败：社区第二页在插入后重复或漏项';
  END IF;

  SELECT array_agg(page.id) INTO v_ids
  FROM list_public_feedback('feedback', 1, NULL, NULL) AS page
  WHERE page.id LIKE 'keyset-feedback-%';
  IF v_ids IS DISTINCT FROM ARRAY['keyset-feedback-c', 'keyset-feedback-b']::text[] THEN
    RAISE EXCEPTION '行为门失败：反馈第一页未按同时间戳 id 降序返回 limit+1';
  END IF;
  UPDATE submissions
  SET published_at = v_time + interval '1 minute'
  WHERE id = 'keyset-feedback-c';
  SELECT array_agg(page.id) INTO v_ids
  FROM list_public_feedback('feedback', 2, v_time, 'keyset-feedback-c') AS page
  WHERE page.id LIKE 'keyset-feedback-%';
  IF v_ids IS DISTINCT FROM ARRAY['keyset-feedback-b', 'keyset-feedback-a']::text[] THEN
    RAISE EXCEPTION '行为门失败：反馈第二页在更新后重复或漏项';
  END IF;

  SELECT array_agg(page.id) INTO v_ids
  FROM list_admin_submissions(1, 'system_reviewing', NULL, NULL) AS page
  WHERE page.id LIKE 'keyset-admin-%';
  IF v_ids IS DISTINCT FROM ARRAY['keyset-admin-c', 'keyset-admin-b']::text[] THEN
    RAISE EXCEPTION '行为门失败：管理员第一页未按同时间戳 id 降序返回 limit+1';
  END IF;
  UPDATE submissions SET status = 'manual_review_pending'
  WHERE id = 'keyset-admin-c';
  SELECT array_agg(page.id) INTO v_ids
  FROM list_admin_submissions(2, 'system_reviewing', v_time, 'keyset-admin-c') AS page
  WHERE page.id LIKE 'keyset-admin-%';
  IF v_ids IS DISTINCT FROM ARRAY['keyset-admin-b', 'keyset-admin-a']::text[] THEN
    RAISE EXCEPTION '行为门失败：管理员第二页在状态变化后重复或漏项';
  END IF;
END
$keyset_gate$;
`;

if (process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseMigrationGateArguments(process.argv.slice(2), process.env);
  const result = await runCloudBaseMigrationBehaviorGate(options);
  process.stdout.write(
    `PostgreSQL ${result.postgresVersion}：${result.migrationsApplied} 个迁移，`
      + `${result.behaviorsVerified} 项行为验证通过\n`
  );
}
