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
      if (migration.fileName
        === '20260831060000_publication_shape_guard.sql') {
        await run(
          executable('psql'),
          [...connection, '-f', '-'],
          damagedPublishedShapeFixtureSql
        );
        let damagedPublicationRejected = false;
        try {
          await run(executable('psql'), [
            ...connection,
            '-f', join(migrationDirectory, migration.fileName)
          ]);
        } catch (error) {
          if (!String(error).includes('invalid published submission shape')) {
            throw error;
          }
          damagedPublicationRejected = true;
        }
        if (!damagedPublicationRejected) {
          throw new Error('损坏的已发布记录未阻止发布结构迁移');
        }
        await run(
          executable('psql'),
          [...connection, '-f', '-'],
          publicationShapeMigrationRollbackAssertionSql
        );
        await run(
          executable('psql'),
          [...connection, '-f', '-'],
          cleanupDamagedPublishedShapeFixtureSql
        );
      }
      if (migration.fileName
        === '20260901000000_zero_cost_manual_review.sql') {
        await run(
          executable('psql'),
          [...connection, '-f', '-'],
          legacySystemReviewingFixtureSql
        );
      }
      await run(executable('psql'), [
        ...connection,
        '-f', join(migrationDirectory, migration.fileName)
      ]);
      if (migration.fileName
        === '20260901000000_zero_cost_manual_review.sql') {
        await run(
          executable('psql'),
          [...connection, '-f', '-'],
          manualReviewMigrationAssertionSql
        );
      }
    }
    await run(
      executable('psql'),
      [...connection, '-f', '-'],
      manualReviewFinalSchemaAssertionSql
    );
    await run(executable('psql'), [...connection, '-f', '-'], behaviorSql);
    await run(executable('psql'), [...connection, '-f', '-'], keysetBehaviorSql);
    await run(executable('psql'), [...connection, '-f', '-'], interactionBehaviorSql);
    await run(executable('psql'), [...connection, '-f', '-'], publicationShapeBehaviorSql);
    await runConcurrentInteractionGate(executable('psql'), connection);

    return {
      postgresVersion: postgresVersion.version,
      postgresMajorVersion: postgresVersion.major,
      migrationsApplied: migrations.length,
      behaviorsVerified: 76
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

/** 点赞与下载分别用双会话持有 operation lock，证明同 ID 并发只回放首次写入。 */
async function runConcurrentInteractionGate(psql, connection) {
  const operationId = '00000000-0000-4000-8000-000000000499';
  const downloadOperationId = '00000000-0000-4000-8000-000000000498';
  await run(psql, [...connection, '-f', '-'], String.raw`
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false);
INSERT INTO submissions (
  id, kind, title, body, status, status_token_hash, published_at,
  publication_basis
) VALUES (
  'gate-like-concurrent', 'feedback', '并发点赞', '并发点赞', 'published',
  md5('gate-like-concurrent') || md5('gate-like-concurrent'), now(), 'standard'
);
INSERT INTO public_engagement (submission_id) VALUES ('gate-like-concurrent');

INSERT INTO submissions (
  id, kind, title, body, status, status_token_hash
) VALUES (
  'gate-download-concurrent', 'shared_package', '并发下载', '并发下载',
  'manual_review_pending', md5('gate-download-concurrent') || md5('gate-download-concurrent')
);
INSERT INTO public_engagement (submission_id) VALUES ('gate-download-concurrent');
INSERT INTO assets (
  submission_id, object_key, original_name, declared_size, actual_size,
  mime_type, role
) VALUES
  ('gate-download-concurrent', 'submissions/gate-download-concurrent/cover.png',
   'cover.png', 7, 7, 'image/png', 'cover'),
  ('gate-download-concurrent', 'submissions/gate-download-concurrent/package.zip',
   'pet.zip', 8, 8, 'application/zip', 'package');
UPDATE submissions
SET status = 'published', published_at = now(), publication_basis = 'standard'
WHERE id = 'gate-download-concurrent';
`);

  const first = runUntilMarker(
    psql,
    [...connection, '-f', '-'],
    String.raw`
BEGIN;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT pg_advisory_xact_lock(hashtextextended('${operationId}', 0));
\echo interaction-lock-acquired
SELECT set_public_like(
  'gate-like-concurrent', repeat('a', 64), true, '${operationId}'::uuid,
  'feedback'
);
SELECT pg_sleep(0.35);
COMMIT;
`,
    'interaction-lock-acquired'
  );
  await first.marker;
  const second = run(psql, [...connection, '-f', '-'], String.raw`
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false);
SELECT set_public_like(
  'gate-like-concurrent', repeat('a', 64), true, '${operationId}'::uuid,
  'feedback'
);
`);
  const earlyResult = await Promise.race([
    second.then(() => 'completed'),
    new Promise(resolvePromise => setTimeout(() => resolvePromise('blocked'), 100))
  ]);
  if (earlyResult !== 'blocked') {
    throw new Error('行为门失败：并发同 operation 未等待首次事务');
  }
  await Promise.all([first.completion, second]);
  await run(psql, [...connection, '-f', '-'], String.raw`
DO $concurrent_like_gate$
BEGIN
  IF (SELECT count(*) FROM public_interaction_operations
      WHERE operation_id = '${operationId}'::uuid) <> 1
    OR (SELECT count(*) FROM engagement_votes
        WHERE submission_id = 'gate-like-concurrent') <> 1
    OR (SELECT like_count FROM public_engagement
        WHERE submission_id = 'gate-like-concurrent') <> 1 THEN
    RAISE EXCEPTION '行为门失败：并发同 operation 发生重复写入';
  END IF;
END
$concurrent_like_gate$;
`);

  const downloadFirst = runUntilMarker(
    psql,
    [...connection, '-f', '-'],
    String.raw`
BEGIN;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT pg_advisory_xact_lock(hashtextextended('${downloadOperationId}', 0));
\echo download-lock-acquired
SELECT record_public_download(
  'gate-download-concurrent', repeat('b', 64), '${downloadOperationId}'::uuid
);
SELECT pg_sleep(0.35);
COMMIT;
`,
    'download-lock-acquired'
  );
  await downloadFirst.marker;
  const downloadSecond = run(psql, [...connection, '-f', '-'], String.raw`
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false);
SELECT record_public_download(
  'gate-download-concurrent', repeat('b', 64), '${downloadOperationId}'::uuid
);
`);
  const earlyDownloadResult = await Promise.race([
    downloadSecond.then(() => 'completed'),
    new Promise(resolvePromise => setTimeout(() => resolvePromise('blocked'), 100))
  ]);
  if (earlyDownloadResult !== 'blocked') {
    throw new Error('行为门失败：并发下载同 operation 未等待首次事务');
  }
  await Promise.all([downloadFirst.completion, downloadSecond]);
  await run(psql, [...connection, '-f', '-'], String.raw`
DO $concurrent_download_gate$
BEGIN
  IF (SELECT count(*) FROM public_interaction_operations
      WHERE operation_id = '${downloadOperationId}'::uuid) <> 1
    OR (SELECT download_count FROM public_engagement
        WHERE submission_id = 'gate-download-concurrent') <> 1 THEN
    RAISE EXCEPTION '行为门失败：并发下载同 operation 发生重复计数';
  END IF;
END
$concurrent_download_gate$;
`);
}

/** 启动长事务并等待 stdout 标记，同时保留完整退出错误。 */
function runUntilMarker(executable, arguments_, input, markerText) {
  let resolveMarker;
  let rejectMarker;
  const marker = new Promise((resolvePromise, rejectPromise) => {
    resolveMarker = resolvePromise;
    rejectMarker = rejectPromise;
  });
  const completion = new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, arguments_, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const stdout = [];
    const stderr = [];
    let markerSeen = false;
    child.stdout.on('data', chunk => {
      const bytes = Buffer.from(chunk);
      stdout.push(bytes);
      if (!markerSeen && Buffer.concat(stdout).toString('utf8').includes(markerText)) {
        markerSeen = true;
        resolveMarker();
      }
    });
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
    child.once('error', error => {
      rejectMarker(error);
      rejectPromise(error);
    });
    child.once('close', code => {
      const output = Buffer.concat(stdout).toString('utf8');
      const errorOutput = Buffer.concat(stderr).toString('utf8');
      if (code === 0) {
        if (!markerSeen) rejectMarker(new Error('PostgreSQL 并发标记未出现'));
        resolvePromise(output);
        return;
      }
      const error = new Error(
        `本地 PostgreSQL 命令失败（${code}）：${errorOutput || output}`
      );
      rejectMarker(error);
      rejectPromise(error);
    });
    child.stdin.end(input);
  });
  return { marker, completion };
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

/** 在新迁移前构造一条缺失封面的已发布记录，验证 preflight 只读失败。 */
const damagedPublishedShapeFixtureSql = String.raw`
INSERT INTO submissions (
  id, kind, title, body, status, status_token_hash, published_at,
  publication_basis
) VALUES (
  'gate-damaged-published-shape', 'shared_package', '损坏已发布记录',
  '迁移不得静默修复', 'published', repeat('f', 64), now(), 'standard'
);
INSERT INTO assets (
  submission_id, object_key, original_name, declared_size, actual_size,
  mime_type, role
) VALUES (
  'gate-damaged-published-shape',
  'submissions/gate-damaged-published-shape/package.zip',
  'pet.zip', 8, 8, 'application/zip', 'package'
);
INSERT INTO public_engagement (submission_id)
VALUES ('gate-damaged-published-shape');
`;

const publicationShapeMigrationRollbackAssertionSql = String.raw`
DO $publication_shape_rollback$
BEGIN
  IF to_regprocedure('assert_submission_publication_shape(text)') IS NOT NULL
    OR to_regprocedure('enforce_submission_publication_shape()') IS NOT NULL
    OR to_regclass('assets_one_cover_per_submission_idx') IS NOT NULL
    OR to_regclass('assets_one_package_per_submission_idx') IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname IN (
        'submissions_publication_shape_guard',
        'assets_publication_shape_guard'
      )
    ) THEN
    RAISE EXCEPTION '行为门失败：发布结构迁移失败后留下半迁移对象';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM submissions
    WHERE id = 'gate-damaged-published-shape'
      AND status = 'published'
      AND title = '损坏已发布记录'
  ) OR (
    SELECT count(*) FROM assets
    WHERE submission_id = 'gate-damaged-published-shape'
  ) IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION '行为门失败：发布结构迁移静默修改了损坏存量';
  END IF;
END
$publication_shape_rollback$;
`;

const cleanupDamagedPublishedShapeFixtureSql = String.raw`
DELETE FROM submissions WHERE id = 'gate-damaged-published-shape';
`;

/** 在切换 migration 前构造带 worker 运行态和历史审核事实的遗留投稿。 */
const legacySystemReviewingFixtureSql = String.raw`
INSERT INTO submissions (
  id, kind, title, body, status, status_version, status_token_hash,
  moderation_lease_until, moderation_attempts, moderation_next_retry_at,
  moderation_last_error, moderation_alerted_at, risk_summary,
  auto_rejection_reason
) VALUES (
  'gate-legacy-system-reviewing', 'shared_package', '遗留系统审核',
  '迁移时保留历史事实', 'system_reviewing', 4,
  md5('gate-legacy-system-reviewing') || md5('gate-legacy-system-reviewing'),
  now() + interval '10 minutes', 3,
  now() + interval '20 minutes', 'worker-timeout', now(),
  '{"legacyRisk":"kept"}'::jsonb, '原自动驳回原因'
);
INSERT INTO moderation_results (
  submission_id, kind, provider, rule_version, suggestion, label, score,
  evidence, requested_at, completed_at, error_message
) VALUES (
  'gate-legacy-system-reviewing', 'package_scan', 'legacy-scanner',
  'legacy-rule', 'Block', '历史危险结论', 1,
  '{"scanCode":"LEGACY_BLOCK"}'::jsonb,
  now() - interval '2 hours', now() - interval '1 hour', NULL
);
`;

/** 切换后只改变队列与 worker 运行态，不改写历史扫描和风险事实。 */
const manualReviewMigrationAssertionSql = String.raw`
DO $manual_review_migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM submissions
    WHERE id = 'gate-legacy-system-reviewing'
      AND status = 'manual_review_pending'
      AND status_version = 5
      AND moderation_lease_until IS NULL
      AND moderation_attempts = 0
      AND moderation_next_retry_at IS NULL
      AND moderation_last_error IS NULL
      AND moderation_alerted_at IS NULL
  ) THEN
    RAISE EXCEPTION '行为门失败：遗留状态、版本或 worker 运行态未正确迁移';
  END IF;
  IF (SELECT risk_summary FROM submissions
      WHERE id = 'gate-legacy-system-reviewing')
      IS DISTINCT FROM '{"legacyRisk":"kept"}'::jsonb
    OR (SELECT auto_rejection_reason FROM submissions
        WHERE id = 'gate-legacy-system-reviewing')
      IS DISTINCT FROM '原自动驳回原因'
    OR (SELECT count(*) FROM moderation_results
        WHERE submission_id = 'gate-legacy-system-reviewing') <> 1
    OR (SELECT evidence FROM moderation_results
        WHERE submission_id = 'gate-legacy-system-reviewing')
      IS DISTINCT FROM '{"scanCode":"LEGACY_BLOCK"}'::jsonb THEN
    RAISE EXCEPTION '行为门失败：迁移改写了历史审核或风险事实';
  END IF;
END
$manual_review_migration$;
`;

/** 最终 schema 只能保留人工审核、历史事实与发布安全结构。 */
const manualReviewFinalSchemaAssertionSql = String.raw`
DO $manual_review_final_schema$
BEGIN
  IF to_regprocedure('claim_moderation_jobs(integer,timestamp with time zone)') IS NOT NULL
    OR to_regprocedure(
      'apply_moderation_decision(text,bigint,text,jsonb,jsonb,text)'
    ) IS NOT NULL
    OR to_regprocedure(
      'record_moderation_failure(text,bigint,text,jsonb)'
    ) IS NOT NULL THEN
    RAISE EXCEPTION '行为门失败：最终 schema 仍暴露审核 worker RPC';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'submissions'
      AND column_name IN (
        'moderation_lease_until',
        'moderation_attempts',
        'moderation_next_retry_at',
        'moderation_last_error',
        'moderation_alerted_at'
      )
  ) THEN
    RAISE EXCEPTION '行为门失败：最终 schema 仍保留审核 worker 运行态列';
  END IF;
  IF to_regclass('submissions_moderation_queue_idx') IS NOT NULL THEN
    RAISE EXCEPTION '行为门失败：最终 schema 仍保留审核 worker 专用索引';
  END IF;
  IF to_regclass('moderation_results') IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM moderation_results
      WHERE submission_id = 'gate-legacy-system-reviewing'
        AND evidence = '{"scanCode":"LEGACY_BLOCK"}'::jsonb
    ) THEN
    RAISE EXCEPTION '行为门失败：最终 schema 未保留历史审核事实';
  END IF;
  IF (
    SELECT count(*)
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'submissions'
      AND column_name IN (
        'risk_summary', 'auto_rejection_reason', 'publication_basis'
      )
  ) <> 3 THEN
    RAISE EXCEPTION '行为门失败：最终 schema 未保留风险与发布依据字段';
  END IF;
  IF to_regclass('admin_audit_logs') IS NULL
    OR to_regprocedure(
      'apply_admin_action(text,text,text,text,bigint,text,text,text)'
    ) IS NULL THEN
    RAISE EXCEPTION '行为门失败：最终 schema 未保留管理员动作与审计';
  END IF;
  IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = 'submissions_publication_shape_guard'
        AND NOT tgisinternal
    )
    OR NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = 'assets_publication_shape_guard'
        AND NOT tgisinternal
    ) THEN
    RAISE EXCEPTION '行为门失败：最终 schema 未保留发布结构触发器';
  END IF;
END
$manual_review_final_schema$;
`;

const behaviorSql = String.raw`
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false);

/** 行为门只创建正式人工审核入口，不再模拟 worker 领取或租约。 */
CREATE OR REPLACE FUNCTION gate_seed(p_id text)
RETURNS void LANGUAGE plpgsql AS $seed$
BEGIN
  PERFORM create_submission(
    jsonb_build_object(
      'id', p_id,
      'kind', 'shared_package',
      'title', '临时数据库行为门',
      'body', '验证人工审核与发布边界',
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

/** 故障注入只拦截指定幂等键，证明审计失败会回滚状态变更。 */
CREATE OR REPLACE FUNCTION gate_fail_audit_insert()
RETURNS trigger LANGUAGE plpgsql AS $trigger$
BEGIN
  IF NEW.idempotency_key = 'gate-force-audit-failure' THEN
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
  v_cleanup_version bigint;
  v_case integer;
  v_first_snapshot jsonb;
  v_result jsonb;
BEGIN
  -- 旧版审计事实必须继续使用收敛后的首次快照稳定回放。
  SELECT result_snapshot INTO v_first_snapshot
  FROM admin_audit_logs
  WHERE idempotency_key = 'gate-legacy-replay';
  v_result := apply_admin_action(
    'gate-legacy-audit', 'admin-1', 'approve', 'published', 0,
    'gate-legacy-replay', '历史普通批准'
  );
  IF COALESCE((v_result ->> 'replayed')::boolean, false) IS NOT TRUE
    OR (v_result - 'replayed') <> (v_first_snapshot - 'replayed') THEN
    RAISE EXCEPTION '行为门失败：旧版审计快照无法稳定回放';
  END IF;

  -- 数据库约束直接拒绝 published + NULL，不依赖服务层。
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

  -- 新共享包完成上传后直接进入人工队列。
  PERFORM gate_seed('gate-manual-force');
  IF (SELECT status FROM submissions WHERE id = 'gate-manual-force')
      <> 'manual_review_pending'
    OR (SELECT status_version FROM submissions WHERE id = 'gate-manual-force')
      <> 1 THEN
    RAISE EXCEPTION '行为门失败：共享包完成上传未直入人工队列';
  END IF;

  -- 反馈直接进入人工队列，普通批准写入 standard 发布依据与审计。
  PERFORM create_text_submission(jsonb_build_object(
    'id', 'gate-feedback',
    'kind', 'feedback',
    'title', '匿名用户',
    'body', '文本投稿直入人工队列',
    'status_token_hash', repeat('d', 64)
  ));
  IF (SELECT status FROM submissions WHERE id = 'gate-feedback')
    <> 'manual_review_pending' THEN
    RAISE EXCEPTION '行为门失败：文本投稿未直入人工队列';
  END IF;
  BEGIN
    PERFORM apply_admin_action(
      'gate-feedback', 'admin-1', 'force_publish', 'published', 0,
      'gate-feedback-direct-force', '反馈不得强制发布',
      'ADMIN_OVERRIDE_ACCEPTED'
    );
    RAISE EXCEPTION '行为门失败：反馈接受了直接强制发布';
  EXCEPTION WHEN SQLSTATE 'P1002' THEN
    NULL;
  END;
  IF (SELECT status FROM submissions WHERE id = 'gate-feedback')
      IS DISTINCT FROM 'manual_review_pending'
    OR (SELECT status_version FROM submissions WHERE id = 'gate-feedback')
      IS DISTINCT FROM 0
    OR (SELECT publication_basis FROM submissions WHERE id = 'gate-feedback')
      IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM admin_audit_logs WHERE submission_id = 'gate-feedback'
    ) THEN
    RAISE EXCEPTION '行为门失败：反馈强制发布拒绝留下了副作用';
  END IF;
  PERFORM apply_admin_action(
    'gate-feedback', 'admin-1', 'approve', 'published', 0,
    'gate-feedback-approve', '反馈审核通过'
  );
  IF (SELECT publication_basis FROM submissions WHERE id = 'gate-feedback')
      <> 'standard'
    OR NOT EXISTS (
      SELECT 1 FROM admin_audit_logs
      WHERE idempotency_key = 'gate-feedback-approve'
        AND action = 'approve'
    ) THEN
    RAISE EXCEPTION '行为门失败：反馈普通批准未保留发布与审计事实';
  END IF;

  -- 新共享包没有有效扫描证据时，普通批准必须失败且不写审计。
  BEGIN
    PERFORM apply_admin_action(
      'gate-manual-force', 'admin-1', 'approve', 'published', 1,
      'gate-manual-approve', '无证据普通批准'
    );
    RAISE EXCEPTION '行为门失败：无通过证据共享包仍可普通批准';
  EXCEPTION WHEN SQLSTATE 'P1003' THEN
    NULL;
  END;
  IF (SELECT status_version FROM submissions WHERE id = 'gate-manual-force') <> 1
    OR EXISTS (
      SELECT 1 FROM admin_audit_logs
      WHERE idempotency_key = 'gate-manual-approve'
    ) THEN
    RAISE EXCEPTION '行为门失败：普通批准拒绝未回滚';
  END IF;

  -- 风险字段与历史审核结果继续保存，且不得伪造 Pass 证据。
  UPDATE submissions
  SET risk_summary = '{"blocked":false,"severity":"unknown"}'::jsonb,
      auto_rejection_reason = '缺少有效扫描证据'
  WHERE id = 'gate-manual-force';
  INSERT INTO moderation_results (
    submission_id, kind, provider, rule_version, suggestion, label,
    evidence, requested_at, completed_at
  ) VALUES (
    'gate-manual-force', 'package_scan', 'manual-import',
    'character-package-2026-08-15', 'Review', '待人工确认',
    '{"scanCode":"SCAN_NOT_AVAILABLE"}'::jsonb,
    v_now - interval '1 minute', v_now
  );

  -- 强制发布必须携带精确风险确认；错误输入不得改变状态。
  FOREACH v_case IN ARRAY ARRAY[0, 1] LOOP
    BEGIN
      PERFORM apply_admin_action(
        'gate-manual-force', 'admin-1', 'force_publish', 'published', 1,
        CASE WHEN v_case = 0
          THEN 'gate-force-missing-ack'
          ELSE 'gate-force-wrong-ack'
        END,
        '验证强制发布确认',
        CASE WHEN v_case = 0 THEN NULL ELSE 'ADMIN_OVERRIDE_CONFIRMED' END
      );
      RAISE EXCEPTION '行为门失败：强制发布接受了无效风险确认';
    EXCEPTION WHEN SQLSTATE 'P1002' THEN
      NULL;
    END;
  END LOOP;
  IF (SELECT status_version FROM submissions WHERE id = 'gate-manual-force') <> 1
    OR (SELECT publication_basis FROM submissions WHERE id = 'gate-manual-force')
      IS NOT NULL THEN
    RAISE EXCEPTION '行为门失败：无效风险确认未回滚';
  END IF;

  -- 审计写入失败必须回滚已更新的状态和发布依据。
  BEGIN
    PERFORM apply_admin_action(
      'gate-manual-force', 'admin-1', 'force_publish', 'published', 1,
      'gate-force-audit-failure', '验证原子回滚',
      'ADMIN_OVERRIDE_ACCEPTED'
    );
    RAISE EXCEPTION '行为门失败：审计故障未阻止强制发布';
  EXCEPTION WHEN SQLSTATE 'P9001' THEN
    NULL;
  END;
  IF (SELECT status FROM submissions WHERE id = 'gate-manual-force')
      <> 'manual_review_pending'
    OR (SELECT status_version FROM submissions WHERE id = 'gate-manual-force')
      <> 1
    OR (SELECT publication_basis FROM submissions WHERE id = 'gate-manual-force')
      IS NOT NULL THEN
    RAISE EXCEPTION '行为门失败：审计故障后状态未原子回滚';
  END IF;

  -- 合法强制发布保留真实扫描摘要、风险确认、发布标记和固定审计快照。
  v_result := apply_admin_action(
    'gate-manual-force', 'admin-1', 'force_publish', 'published', 1,
    'gate-manual-force-publish', '管理员确认承担无扫描证据风险',
    'ADMIN_OVERRIDE_ACCEPTED'
  );
  IF (SELECT status FROM submissions WHERE id = 'gate-manual-force')
      <> 'published'
    OR (SELECT status_version FROM submissions WHERE id = 'gate-manual-force')
      <> 2
    OR (SELECT publication_basis FROM submissions WHERE id = 'gate-manual-force')
      <> 'admin_override'
    OR v_result #>> '{submission,publication_basis}' <> 'admin_override'
    OR NOT EXISTS (
      SELECT 1 FROM admin_audit_logs
      WHERE idempotency_key = 'gate-manual-force-publish'
        AND action = 'force_publish'
        AND request_payload ->> 'riskAcknowledgement'
          = 'ADMIN_OVERRIDE_ACCEPTED'
        AND request_payload #>> '{latestScanSummary,suggestion}' = 'Review'
    )
    OR EXISTS (
      SELECT 1 FROM moderation_results
      WHERE submission_id = 'gate-manual-force' AND suggestion = 'Pass'
    ) THEN
    RAISE EXCEPTION '行为门失败：强制发布原子事实不完整';
  END IF;

  -- 同键同请求稳定回放首次快照；异参必须冲突。
  SELECT result_snapshot INTO v_first_snapshot
  FROM admin_audit_logs
  WHERE idempotency_key = 'gate-manual-force-publish';
  v_result := apply_admin_action(
    'gate-manual-force', 'admin-1', 'force_publish', 'published', 1,
    'gate-manual-force-publish', '管理员确认承担无扫描证据风险',
    'ADMIN_OVERRIDE_ACCEPTED'
  );
  IF COALESCE((v_result ->> 'replayed')::boolean, false) IS NOT TRUE
    OR (v_result - 'replayed') <> (v_first_snapshot - 'replayed') THEN
    RAISE EXCEPTION '行为门失败：强制发布未稳定回放首次快照';
  END IF;
  BEGIN
    PERFORM apply_admin_action(
      'gate-manual-force', 'admin-1', 'force_publish', 'published', 1,
      'gate-manual-force-publish', '更换理由', 'ADMIN_OVERRIDE_ACCEPTED'
    );
    RAISE EXCEPTION '行为门失败：幂等键异参未冲突';
  EXCEPTION WHEN SQLSTATE 'P1001' THEN
    NULL;
  END;

  -- 下架、cleanup 与 purge 不得破坏首次审计，历史审核行只清空私密证据。
  PERFORM apply_admin_action(
    'gate-manual-force', 'admin-1', 'delete', 'deleted_quarantined', 2,
    'gate-manual-force-delete', '主动下架风险共享包'
  );
  UPDATE submissions
  SET purge_after = v_now - interval '1 minute'
  WHERE id = 'gate-manual-force';
  SELECT (claimed ->> 'status_version')::bigint INTO v_cleanup_version
  FROM claim_cleanup_jobs(1, v_now + interval '5 minutes') AS claimed
  WHERE claimed ->> 'id' = 'gate-manual-force';
  IF v_cleanup_version <> 4 THEN
    RAISE EXCEPTION '行为门失败：cleanup 未领取人工强制发布记录';
  END IF;
  PERFORM mark_submission_purged('gate-manual-force', 4);
  IF (SELECT status FROM submissions WHERE id = 'gate-manual-force') <> 'purged'
    OR (SELECT status_version FROM submissions WHERE id = 'gate-manual-force') <> 5
    OR (SELECT result_snapshot FROM admin_audit_logs
        WHERE idempotency_key = 'gate-manual-force-publish') <> v_first_snapshot
    OR (SELECT count(*) FROM moderation_results
        WHERE submission_id = 'gate-manual-force') <> 1
    OR (SELECT evidence FROM moderation_results
        WHERE submission_id = 'gate-manual-force') <> '{}'::jsonb THEN
    RAISE EXCEPTION '行为门失败：purge 破坏了审计或历史审核行';
  END IF;

  -- 有效历史技术证据仍允许普通批准，并拒绝错标为管理员覆盖。
  PERFORM gate_seed('gate-standard');
  UPDATE assets
  SET sha256 = repeat('a', 64)
  WHERE submission_id = 'gate-standard' AND role = 'package';
  INSERT INTO moderation_results (
    submission_id, kind, provider, rule_version, suggestion, label,
    evidence, requested_at, completed_at
  ) VALUES (
    'gate-standard', 'package_scan', 'isolated-scanner',
    'character-package-2026-08-15', 'Pass',
    '技术检查：CHARACTER_PACKAGE_SCAN_PASSED',
    jsonb_build_object(
      'submissionId', 'gate-standard',
      'packageStorageKey', 'submissions/gate-standard/package.zip',
      'packageSizeBytes', 8,
      'archiveSizeBytes', 8,
      'archiveSha256', repeat('a', 64),
      'protocolVersion', '2026-08-15',
      'ruleVersion', 'character-package-2026-08-15',
      'scanCode', 'CHARACTER_PACKAGE_SCAN_PASSED',
      'completedAt', v_now,
      'expiresAt', v_now + interval '24 hours',
      'submissionStatusVersion', 1
    ),
    v_now, v_now
  );
  BEGIN
    PERFORM apply_admin_action(
      'gate-standard', 'admin-1', 'force_publish', 'published', 1,
      'gate-standard-force', '有效证据不得错标覆盖',
      'ADMIN_OVERRIDE_ACCEPTED'
    );
    RAISE EXCEPTION '行为门失败：有效证据被错标为强制发布';
  EXCEPTION WHEN SQLSTATE 'P1002' THEN
    NULL;
  END;
  PERFORM apply_admin_action(
    'gate-standard', 'admin-1', 'approve', 'published', 1,
    'gate-standard-approve', '人工复核通过'
  );
  IF (SELECT publication_basis FROM submissions WHERE id = 'gate-standard')
      <> 'standard' THEN
    RAISE EXCEPTION '行为门失败：有效证据普通批准未标记 standard';
  END IF;

  -- 历史 system_reviewing 与 auto_rejected 仍可由管理员转入人工，且风险事实不变。
  PERFORM gate_seed('gate-historical-system');
  UPDATE submissions
  SET status = 'system_reviewing'
  WHERE id = 'gate-historical-system';
  BEGIN
    PERFORM apply_admin_action(
      'gate-historical-system', 'admin-1', 'force_publish', 'published', 1,
      'gate-historical-system-direct-force', '历史系统状态不得跳步',
      'ADMIN_OVERRIDE_ACCEPTED'
    );
    RAISE EXCEPTION '行为门失败：历史系统状态接受了直接强制发布';
  EXCEPTION WHEN SQLSTATE 'P1002' THEN
    NULL;
  END;
  IF (SELECT status FROM submissions WHERE id = 'gate-historical-system')
      IS DISTINCT FROM 'system_reviewing'
    OR (SELECT status_version FROM submissions
        WHERE id = 'gate-historical-system') IS DISTINCT FROM 1
    OR (SELECT publication_basis FROM submissions
        WHERE id = 'gate-historical-system') IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM admin_audit_logs
      WHERE submission_id = 'gate-historical-system'
    ) THEN
    RAISE EXCEPTION '行为门失败：历史系统状态强制发布拒绝留下了副作用';
  END IF;
  PERFORM apply_admin_action(
    'gate-historical-system', 'admin-1', 'move_to_manual',
    'manual_review_pending', 1, 'gate-historical-system-manual',
    '接管历史系统队列'
  );
  IF (SELECT status FROM submissions WHERE id = 'gate-historical-system')
      <> 'manual_review_pending' THEN
    RAISE EXCEPTION '行为门失败：历史系统状态无法转人工';
  END IF;

  INSERT INTO submissions (
    id, kind, status, status_token_hash, auto_rejection_reason, risk_summary
  ) VALUES (
    'gate-historical-auto', 'shared_package', 'auto_rejected', repeat('f', 64),
    '检测到危险文件', '{"blocked":true,"severity":"high"}'::jsonb
  );
  INSERT INTO moderation_results (
    submission_id, kind, provider, rule_version, suggestion, label,
    evidence, requested_at, completed_at
  ) VALUES (
    'gate-historical-auto', 'package_scan', 'isolated-scanner',
    'character-package-2026-08-15', 'Block', '技术检查：MALWARE_DETECTED',
    '{"scanCode":"MALWARE_DETECTED"}'::jsonb, v_now, v_now
  );
  BEGIN
    PERFORM apply_admin_action(
      'gate-historical-auto', 'admin-1', 'force_publish', 'published', 0,
      'gate-historical-auto-direct-force', '自动驳回不得跳步',
      'ADMIN_OVERRIDE_ACCEPTED'
    );
    RAISE EXCEPTION '行为门失败：自动驳回接受了直接强制发布';
  EXCEPTION WHEN SQLSTATE 'P1002' THEN
    NULL;
  END;
  IF (SELECT status FROM submissions WHERE id = 'gate-historical-auto')
      IS DISTINCT FROM 'auto_rejected'
    OR (SELECT status_version FROM submissions WHERE id = 'gate-historical-auto')
      IS DISTINCT FROM 0
    OR (SELECT publication_basis FROM submissions
        WHERE id = 'gate-historical-auto') IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM admin_audit_logs
      WHERE submission_id = 'gate-historical-auto'
    ) THEN
    RAISE EXCEPTION '行为门失败：自动驳回强制发布拒绝留下了副作用';
  END IF;
  PERFORM apply_admin_action(
    'gate-historical-auto', 'admin-1', 'move_to_manual',
    'manual_review_pending', 0, 'gate-historical-auto-manual', '转人工复核'
  );
  IF (SELECT auto_rejection_reason FROM submissions
      WHERE id = 'gate-historical-auto') <> '检测到危险文件'
    OR (SELECT risk_summary FROM submissions
        WHERE id = 'gate-historical-auto') IS DISTINCT FROM
      '{"blocked":true,"severity":"high"}'::jsonb
    OR NOT EXISTS (
      SELECT 1 FROM moderation_results
      WHERE submission_id = 'gate-historical-auto' AND suggestion = 'Block'
    ) THEN
    RAISE EXCEPTION '行为门失败：历史危险结果转人工时被改写';
  END IF;

  -- 共享包恢复后再次发布，旧 key 仍只按管理员原始输入回放首次人工审核快照。
  PERFORM gate_seed('gate-restore');
  UPDATE submissions
  SET risk_summary = '{"blocked":true,"severity":"high"}'::jsonb,
      auto_rejection_reason = '历史自动拒绝事实'
  WHERE id = 'gate-restore';
  PERFORM apply_admin_action(
    'gate-restore', 'admin-1', 'delete', 'deleted_quarantined', 1,
    'gate-restore-delete', '隔离后复核'
  );
  v_result := apply_admin_action(
    'gate-restore', 'admin-1', 'restore', 'manual_review_pending', 2,
    'gate-restore-manual', '恢复后人工复核'
  );
  SELECT result_snapshot INTO v_first_snapshot
  FROM admin_audit_logs
  WHERE idempotency_key = 'gate-restore-manual';
  IF (SELECT status FROM submissions WHERE id = 'gate-restore')
      <> 'manual_review_pending'
    OR (SELECT status_version FROM submissions WHERE id = 'gate-restore') <> 3
    OR (SELECT publication_basis FROM submissions WHERE id = 'gate-restore')
      IS NOT NULL
    OR (SELECT risk_summary FROM submissions WHERE id = 'gate-restore')
      IS DISTINCT FROM '{"blocked":true,"severity":"high"}'::jsonb
    OR (SELECT auto_rejection_reason FROM submissions WHERE id = 'gate-restore')
      IS DISTINCT FROM '历史自动拒绝事实'
    OR NOT EXISTS (
      SELECT 1 FROM admin_audit_logs
      WHERE idempotency_key = 'gate-restore-manual'
        AND action = 'restore'
        AND before_status = 'deleted_quarantined'
        AND after_status = 'manual_review_pending'
        AND result_snapshot #>> '{submission,status}' = 'manual_review_pending'
    ) THEN
    RAISE EXCEPTION '行为门失败：共享包恢复的人工状态、风险或审计事实不完整';
  END IF;
  PERFORM apply_admin_action(
    'gate-restore', 'admin-1', 'force_publish', 'published', 3,
    'gate-restore-force', '恢复后再次确认风险', 'ADMIN_OVERRIDE_ACCEPTED'
  );
  v_result := apply_admin_action(
    'gate-restore', 'admin-1', 'restore', 'published', 2,
    'gate-restore-manual', '恢复后人工复核'
  );
  IF COALESCE((v_result ->> 'replayed')::boolean, false) IS NOT TRUE
    OR (v_result - 'replayed') <> (v_first_snapshot - 'replayed')
    OR v_result #>> '{submission,status}' <> 'manual_review_pending'
    OR (SELECT request_payload #>> '{nextStatus}' FROM admin_audit_logs
        WHERE idempotency_key = 'gate-restore-manual')
      <> 'manual_review_pending' THEN
    RAISE EXCEPTION '行为门失败：共享包后续发布破坏首次恢复回放';
  END IF;
  BEGIN
    PERFORM apply_admin_action(
      'gate-restore', 'admin-2', 'restore', 'published', 2,
      'gate-restore-manual', '恢复后人工复核'
    );
    RAISE EXCEPTION '行为门失败：恢复幂等键接受了不同管理员';
  EXCEPTION WHEN SQLSTATE 'P1001' THEN NULL;
  END;
  BEGIN
    PERFORM apply_admin_action(
      'gate-restore', 'admin-1', 'restore', 'published', 3,
      'gate-restore-manual', '恢复后人工复核'
    );
    RAISE EXCEPTION '行为门失败：恢复幂等键接受了不同版本';
  EXCEPTION WHEN SQLSTATE 'P1001' THEN NULL;
  END;
  BEGIN
    PERFORM apply_admin_action(
      'gate-restore', 'admin-1', 'restore', 'published', 2,
      'gate-restore-manual', '同键改理由'
    );
    RAISE EXCEPTION '行为门失败：恢复幂等键接受了不同理由';
  EXCEPTION WHEN SQLSTATE 'P1001' THEN NULL;
  END;
  BEGIN
    PERFORM apply_admin_action(
      'gate-restore', 'admin-1', 'delete', 'deleted_quarantined', 2,
      'gate-restore-manual', '恢复后人工复核'
    );
    RAISE EXCEPTION '行为门失败：恢复幂等键接受了不同动作';
  EXCEPTION WHEN SQLSTATE 'P1001' THEN NULL;
  END;
  BEGIN
    PERFORM apply_admin_action(
      'gate-restore', 'admin-1', 'restore', 'manual_review_pending', 2,
      'gate-restore-new-key', '恢复后人工复核'
    );
    RAISE EXCEPTION '行为门失败：新 key 绕过共享包旧版本';
  EXCEPTION WHEN SQLSTATE '40001' THEN NULL;
  END;
  IF (SELECT status FROM submissions WHERE id = 'gate-restore') <> 'published'
    OR (SELECT status_version FROM submissions WHERE id = 'gate-restore') <> 4
    OR EXISTS (
      SELECT 1 FROM admin_audit_logs
      WHERE idempotency_key = 'gate-restore-new-key'
    ) THEN
    RAISE EXCEPTION '行为门失败：共享包无效新 key 改写状态、版本或审计';
  END IF;

  INSERT INTO submissions (
    id, kind, title, body, status, status_token_hash,
    pre_quarantine_status, quarantined_at
  ) VALUES (
    'gate-text-restore', 'feedback', '恢复标题', '恢复正文',
    'deleted_quarantined', repeat('e', 64), 'published', now()
  );
  v_result := apply_admin_action(
    'gate-text-restore', 'admin-1', 'restore', 'published', 0,
    'gate-text-restore-replay', '恢复文本'
  );
  SELECT result_snapshot INTO v_first_snapshot
  FROM admin_audit_logs
  WHERE idempotency_key = 'gate-text-restore-replay';
  PERFORM apply_admin_action(
    'gate-text-restore', 'admin-1', 'delete', 'deleted_quarantined', 1,
    'gate-text-restore-delete', '恢复后再次隔离'
  );
  v_result := apply_admin_action(
    'gate-text-restore', 'admin-1', 'restore', 'deleted_quarantined', 0,
    'gate-text-restore-replay', '恢复文本'
  );
  IF COALESCE((v_result ->> 'replayed')::boolean, false) IS NOT TRUE
    OR (v_result - 'replayed') <> (v_first_snapshot - 'replayed')
    OR v_result #>> '{submission,status}' <> 'published' THEN
    RAISE EXCEPTION '行为门失败：文本后续流转破坏首次恢复回放';
  END IF;
  BEGIN
    PERFORM apply_admin_action(
      'gate-text-restore', 'admin-1', 'restore', 'deleted_quarantined', 0,
      'gate-text-restore-new-key', '恢复文本'
    );
    RAISE EXCEPTION '行为门失败：新 key 绕过文本恢复旧版本';
  EXCEPTION WHEN SQLSTATE '40001' THEN NULL;
  END;
  IF (SELECT status FROM submissions WHERE id = 'gate-text-restore')
      <> 'deleted_quarantined'
    OR (SELECT status_version FROM submissions WHERE id = 'gate-text-restore') <> 2
    OR EXISTS (
      SELECT 1 FROM admin_audit_logs
      WHERE idempotency_key = 'gate-text-restore-new-key'
    ) THEN
    RAISE EXCEPTION '行为门失败：文本恢复无效新 key 改写状态、版本或审计';
  END IF;
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
    PERFORM * FROM list_public_feedback(NULL, 1, NULL, NULL);
    RAISE EXCEPTION '行为门失败：反馈列表接受 NULL kind';
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
  INSERT INTO assets (
    submission_id, object_key, original_name, declared_size, actual_size,
    mime_type, role
  )
  SELECT id, 'submissions/' || id || '/cover.png', 'cover.png', 7, 7,
         'image/png', 'cover'
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
  INSERT INTO assets (
    submission_id, object_key, original_name, declared_size, actual_size,
    mime_type, role
  ) VALUES (
    'keyset-community-d', 'submissions/keyset-community-d/cover.png',
    'cover.png', 7, 7, 'image/png', 'cover'
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

/** 互动行为门验证 desired-state、幂等冲突、设备隔离、TTL、权限与有限清理。 */
const interactionBehaviorSql = String.raw`
DO $interaction_security_gate$
BEGIN
  IF has_function_privilege(
      'anon', 'set_public_like(text,character,boolean,uuid,text)', 'EXECUTE')
    OR has_function_privilege(
      'anon', 'record_public_download(text,character,uuid)', 'EXECUTE')
    OR has_function_privilege(
      'authenticated',
      'purge_expired_public_interaction_operations(integer)',
      'EXECUTE')
    OR NOT has_function_privilege(
      'service_role', 'set_public_like(text,character,boolean,uuid,text)', 'EXECUTE')
    OR NOT has_function_privilege(
      'service_role', 'record_public_download(text,character,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '行为门失败：互动 RPC 权限不符合 service_role 边界';
  END IF;
  IF to_regprocedure('toggle_public_like(text,character)') IS NOT NULL THEN
    RAISE EXCEPTION '行为门失败：旧 toggle RPC 仍然存在';
  END IF;
  IF to_regprocedure('set_public_like(text,character,boolean,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION '行为门失败：旧四参数点赞 RPC 仍然存在';
  END IF;
  IF to_regprocedure('record_public_download(text)') IS NOT NULL THEN
    RAISE EXCEPTION '行为门失败：旧单参数下载 RPC 仍然存在';
  END IF;

  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', false);
  BEGIN
    PERFORM set_public_like(
      'missing', repeat('a', 64), true,
      '00000000-0000-4000-8000-000000000401'::uuid, 'feedback'
    );
    RAISE EXCEPTION '行为门失败：点赞未拒绝非 service_role claims';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;
  BEGIN
    PERFORM purge_expired_public_interaction_operations(1);
    RAISE EXCEPTION '行为门失败：账本清理未拒绝非 service_role claims';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;
  BEGIN
    PERFORM record_public_download(
      'missing', repeat('a', 64),
      '00000000-0000-4000-8000-000000000501'::uuid
    );
    RAISE EXCEPTION '行为门失败：下载未拒绝非 service_role claims';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;
END
$interaction_security_gate$;

SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false);

DO $interaction_gate$
DECLARE
  v_first jsonb;
  v_replay jsonb;
  v_rate_limited jsonb;
  v_not_found jsonb;
  v_purged integer;
  v_index integer;
BEGIN
  INSERT INTO submissions (
    id, kind, title, body, status, status_token_hash, published_at,
    publication_basis
  ) VALUES
    ('gate-like-one', 'feedback', '点赞一', '点赞一', 'published', md5('gate-like-one') || md5('gate-like-one'), now(), 'standard'),
    ('gate-like-devices', 'suggestion', '点赞二', '点赞二', 'published', md5('gate-like-devices') || md5('gate-like-devices'), now(), 'standard'),
    ('gate-like-expiry', 'feedback', '点赞过期', '点赞过期', 'published', md5('gate-like-expiry') || md5('gate-like-expiry'), now(), 'standard'),
    ('gate-like-rate', 'feedback', '点赞限流', '点赞限流', 'published', md5('gate-like-rate') || md5('gate-like-rate'), now(), 'standard'),
    ('gate-like-unpublished', 'feedback', '未发布点赞', '未发布点赞', 'manual_review_pending', md5('gate-like-unpublished') || md5('gate-like-unpublished'), NULL, NULL),
    ('gate-like-wrong-kind', 'feedback', '错误入口点赞', '错误入口点赞', 'published', md5('gate-like-wrong-kind') || md5('gate-like-wrong-kind'), now(), 'standard'),
    ('gate-like-community', 'shared_package', '社区点赞', '社区点赞', 'published', md5('gate-like-community') || md5('gate-like-community'), now(), 'standard'),
    ('gate-download-one', 'shared_package', '下载一', '下载一', 'published', md5('gate-download-one') || md5('gate-download-one'), now(), 'standard'),
    ('gate-download-two', 'shared_package', '下载二', '下载二', 'published', md5('gate-download-two') || md5('gate-download-two'), now(), 'standard'),
    ('gate-download-rate', 'shared_package', '下载限流', '下载限流', 'published', md5('gate-download-rate') || md5('gate-download-rate'), now(), 'standard');
  INSERT INTO public_engagement (submission_id)
  VALUES ('gate-like-one'), ('gate-like-devices'), ('gate-like-expiry'),
    ('gate-like-rate'), ('gate-like-wrong-kind'), ('gate-like-community'),
    ('gate-download-one'), ('gate-download-two'), ('gate-download-rate');
  INSERT INTO assets (
    submission_id, object_key, original_name, declared_size, actual_size,
    mime_type, role
  )
  SELECT submission_id,
    'submissions/' || submission_id || '/cover.png',
    'cover.png', 7, 7, 'image/png', 'cover'
  FROM unnest(ARRAY[
    'gate-like-community', 'gate-download-one', 'gate-download-two',
    'gate-download-rate'
  ]) AS ids(submission_id);
  INSERT INTO assets (
    submission_id, object_key, original_name, declared_size, actual_size,
    mime_type, role
  )
  SELECT submission_id,
    'submissions/' || submission_id || '/package.zip',
    'pet.zip', 8, 8, 'application/zip', 'package'
  FROM unnest(ARRAY[
    'gate-like-community', 'gate-download-one', 'gate-download-two',
    'gate-download-rate'
  ]) AS ids(submission_id);

  BEGIN
    INSERT INTO public_interaction_operations (
      operation_id, action, submission_id, fingerprint_hash, desired_liked,
      result_snapshot, expires_at
    ) VALUES (
      '00000000-0000-4000-8000-000000000590'::uuid,
      'download', 'gate-download-one', repeat('a', 64), NULL,
      '[]'::jsonb, now() + interval '24 hours'
    );
    RAISE EXCEPTION '行为门失败：账本接受非 object 结果快照';
  EXCEPTION WHEN SQLSTATE '23514' THEN NULL;
  END;
  BEGIN
    INSERT INTO public_interaction_operations (
      operation_id, action, submission_id, fingerprint_hash, desired_liked,
      result_snapshot, expires_at
    ) VALUES (
      '00000000-0000-4000-8000-000000000591'::uuid,
      'download', 'gate-download-one', repeat('a', 64), NULL,
      jsonb_build_object('liked', true, 'like_count', 1),
      now() + interval '24 hours'
    );
    RAISE EXCEPTION '行为门失败：下载账本接受点赞快照形状';
  EXCEPTION WHEN SQLSTATE '23514' THEN NULL;
  END;
  BEGIN
    INSERT INTO public_interaction_operations (
      operation_id, action, submission_id, fingerprint_hash, desired_liked,
      result_snapshot, expires_at
    ) VALUES (
      '00000000-0000-4000-8000-000000000592'::uuid,
      'like', 'gate-download-one', repeat('a', 64), true,
      jsonb_build_object('download_count', 1), now() + interval '24 hours'
    );
    RAISE EXCEPTION '行为门失败：点赞账本接受下载快照形状';
  EXCEPTION WHEN SQLSTATE '23514' THEN NULL;
  END;

  v_first := set_public_like(
    'gate-like-one', repeat('a', 64), true,
    '00000000-0000-4000-8000-000000000401'::uuid, 'feedback'
  );
  v_replay := set_public_like(
    'gate-like-one', repeat('a', 64), true,
    '00000000-0000-4000-8000-000000000401'::uuid, 'feedback'
  );
  IF v_first IS DISTINCT FROM jsonb_build_object('liked', true, 'like_count', 1)
    OR v_replay IS DISTINCT FROM v_first
    OR (SELECT count(*) FROM public_interaction_operations
        WHERE operation_id = '00000000-0000-4000-8000-000000000401'::uuid) <> 1 THEN
    RAISE EXCEPTION '行为门失败：同 operation 同输入未回放首次结果';
  END IF;

  BEGIN
    PERFORM set_public_like(
      'gate-like-one', repeat('a', 64), false,
      '00000000-0000-4000-8000-000000000401'::uuid, 'feedback'
    );
    RAISE EXCEPTION '行为门失败：同 operation 异参未冲突';
  EXCEPTION WHEN SQLSTATE 'P1001' THEN NULL;
  END;

  PERFORM set_public_like(
    'gate-like-one', repeat('a', 64), true,
    '00000000-0000-4000-8000-000000000402'::uuid, 'feedback'
  );
  IF (SELECT like_count FROM public_engagement
      WHERE submission_id = 'gate-like-one') <> 1
    OR (SELECT count(*) FROM engagement_votes
        WHERE submission_id = 'gate-like-one') <> 1 THEN
    RAISE EXCEPTION '行为门失败：不同 operation 同 desired state 重复计数';
  END IF;

  PERFORM set_public_like(
    'gate-like-one', repeat('a', 64), false,
    '00000000-0000-4000-8000-000000000403'::uuid, 'feedback'
  );
  PERFORM set_public_like(
    'gate-like-one', repeat('a', 64), false,
    '00000000-0000-4000-8000-000000000404'::uuid, 'feedback'
  );
  IF (SELECT like_count FROM public_engagement
      WHERE submission_id = 'gate-like-one') <> 0 THEN
    RAISE EXCEPTION '行为门失败：重复 false 产生负数或错误计数';
  END IF;

  PERFORM set_public_like(
    'gate-like-devices', repeat('b', 64), true,
    '00000000-0000-4000-8000-000000000405'::uuid, 'feedback'
  );
  PERFORM set_public_like(
    'gate-like-devices', repeat('c', 64), true,
    '00000000-0000-4000-8000-000000000406'::uuid, 'feedback'
  );
  IF (SELECT like_count FROM public_engagement
      WHERE submission_id = 'gate-like-devices') <> 2
    OR (SELECT count(*) FROM engagement_votes
        WHERE submission_id = 'gate-like-devices') <> 2 THEN
    RAISE EXCEPTION '行为门失败：两设备未保持独立投票';
  END IF;

  PERFORM set_public_like(
    'gate-like-expiry', repeat('e', 64), true,
    '00000000-0000-4000-8000-000000000407'::uuid, 'feedback'
  );
  UPDATE public_interaction_operations
  SET expires_at = now()
  WHERE operation_id = '00000000-0000-4000-8000-000000000407'::uuid;
  PERFORM set_public_like(
    'gate-like-expiry', repeat('e', 64), false,
    '00000000-0000-4000-8000-000000000407'::uuid, 'feedback'
  );
  IF (SELECT desired_liked FROM public_interaction_operations
      WHERE operation_id = '00000000-0000-4000-8000-000000000407'::uuid) IS DISTINCT FROM false
    OR (SELECT like_count FROM public_engagement
        WHERE submission_id = 'gate-like-expiry') <> 0 THEN
    RAISE EXCEPTION '行为门失败：到期但未 cleanup 的 operation 仍被回放或冲突';
  END IF;

  FOR v_index IN 1..10 LOOP
    PERFORM set_public_like(
      'gate-like-rate', repeat('f', 64), true,
      ('00000000-0000-4000-8002-' || lpad(to_hex(v_index), 12, '0'))::uuid,
      'feedback'
    );
  END LOOP;
  v_rate_limited := set_public_like(
    'gate-like-rate', repeat('f', 64), false,
    '00000000-0000-4000-8002-000000000011'::uuid, 'feedback'
  );
  IF v_rate_limited IS DISTINCT FROM jsonb_build_object(
      'rate_limited', true,
      'retry_after_seconds', (v_rate_limited ->> 'retry_after_seconds')::integer
    ) THEN
    RAISE EXCEPTION '行为门失败：新 operation 未受原子点赞配额保护';
  END IF;
  UPDATE submissions
  SET status = 'manual_review_pending',
      publication_basis = NULL,
      published_at = NULL
  WHERE id = 'gate-like-rate';
  v_replay := set_public_like(
    'gate-like-rate', repeat('f', 64), true,
    '00000000-0000-4000-8002-000000000001'::uuid, 'feedback'
  );
  IF v_replay IS DISTINCT FROM jsonb_build_object('liked', true, 'like_count', 1) THEN
    RAISE EXCEPTION '行为门失败：配额耗尽或取消发布阻断同 operation 首次结果回放';
  END IF;

  FOR v_index IN 1..10 LOOP
    BEGIN
      v_not_found := set_public_like(
        'gate-like-unpublished', repeat('9', 64), true,
        ('00000000-0000-4000-8003-' || lpad(to_hex(v_index), 12, '0'))::uuid,
        'feedback'
      );
      IF v_not_found IS DISTINCT FROM jsonb_build_object('not_found', true) THEN
        RAISE EXCEPTION '行为门失败：未发布首次点赞没有返回私有 not-found 事实';
      END IF;
    EXCEPTION WHEN SQLSTATE 'P0002' THEN
      RAISE EXCEPTION '行为门失败：未发布首次点赞抛错并回滚限流计数';
    END;
  END LOOP;
  v_rate_limited := set_public_like(
    'gate-like-unpublished', repeat('9', 64), true,
    '00000000-0000-4000-8003-000000000011'::uuid, 'feedback'
  );
  IF v_rate_limited ->> 'rate_limited' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION '行为门失败：未发布投稿可用新 UUID 绕过首次限流';
  END IF;

  FOR v_index IN 1..10 LOOP
    v_not_found := set_public_like(
      'gate-like-missing', repeat('8', 64), true,
      ('00000000-0000-4000-8004-' || lpad(to_hex(v_index), 12, '0'))::uuid,
      'feedback'
    );
    IF v_not_found IS DISTINCT FROM jsonb_build_object('not_found', true) THEN
      RAISE EXCEPTION '行为门失败：缺失投稿未返回统一私有 not-found 事实';
    END IF;
  END LOOP;
  v_rate_limited := set_public_like(
    'gate-like-missing', repeat('8', 64), true,
    '00000000-0000-4000-8004-000000000011'::uuid, 'feedback'
  );
  IF v_rate_limited ->> 'rate_limited' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION '行为门失败：缺失投稿未消费统一首次限流配额';
  END IF;

  FOR v_index IN 1..10 LOOP
    v_not_found := set_public_like(
      'gate-like-wrong-kind', repeat('7', 64), true,
      ('00000000-0000-4000-8005-' || lpad(to_hex(v_index), 12, '0'))::uuid,
      'community'
    );
    IF v_not_found IS DISTINCT FROM jsonb_build_object('not_found', true) THEN
      RAISE EXCEPTION '行为门失败：错误 endpoint kind 未返回统一私有 not-found 事实';
    END IF;
  END LOOP;
  v_rate_limited := set_public_like(
    'gate-like-wrong-kind', repeat('7', 64), true,
    '00000000-0000-4000-8005-000000000011'::uuid, 'community'
  );
  IF v_rate_limited ->> 'rate_limited' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION '行为门失败：错误 endpoint kind 未消费统一首次限流配额';
  END IF;

  v_first := set_public_like(
    'gate-like-community', repeat('6', 64), true,
    '00000000-0000-4000-8006-000000000001'::uuid, 'community'
  );
  BEGIN
    PERFORM set_public_like(
      'gate-like-community', repeat('6', 64), true,
      '00000000-0000-4000-8006-000000000001'::uuid, 'feedback'
    );
    RAISE EXCEPTION '行为门失败：社区 operation 可从反馈 endpoint 回放';
  EXCEPTION WHEN SQLSTATE 'P1001' THEN NULL;
  END;
  IF v_first IS DISTINCT FROM jsonb_build_object('liked', true, 'like_count', 1)
    OR (SELECT like_count FROM public_engagement
        WHERE submission_id = 'gate-like-community') <> 1 THEN
    RAISE EXCEPTION '行为门失败：跨 endpoint 冲突改写了首次点赞结果';
  END IF;

  v_first := record_public_download(
    'gate-download-one', repeat('a', 64),
    '00000000-0000-4000-8000-000000000501'::uuid
  );
  v_replay := record_public_download(
    'gate-download-one', repeat('a', 64),
    '00000000-0000-4000-8000-000000000501'::uuid
  );
  IF v_first IS DISTINCT FROM jsonb_build_object('download_count', 1)
    OR v_replay IS DISTINCT FROM v_first
    OR (SELECT download_count FROM public_engagement
        WHERE submission_id = 'gate-download-one') <> 1 THEN
    RAISE EXCEPTION '行为门失败：同 operation 下载重放重复计数';
  END IF;

  BEGIN
    PERFORM record_public_download(
      'gate-download-two', repeat('a', 64),
      '00000000-0000-4000-8000-000000000501'::uuid
    );
    RAISE EXCEPTION '行为门失败：下载 operation 可跨投稿回放';
  EXCEPTION WHEN SQLSTATE 'P1001' THEN NULL;
  END;
  BEGIN
    PERFORM record_public_download(
      'gate-download-one', repeat('b', 64),
      '00000000-0000-4000-8000-000000000501'::uuid
    );
    RAISE EXCEPTION '行为门失败：下载 operation 可跨设备回放';
  EXCEPTION WHEN SQLSTATE 'P1001' THEN NULL;
  END;
  BEGIN
    PERFORM record_public_download(
      'gate-like-community', repeat('6', 64),
      '00000000-0000-4000-8006-000000000001'::uuid
    );
    RAISE EXCEPTION '行为门失败：点赞 operation 可从下载 endpoint 回放';
  EXCEPTION WHEN SQLSTATE 'P1001' THEN NULL;
  END;

  v_replay := record_public_download(
    'gate-download-one', repeat('a', 64),
    '00000000-0000-4000-8000-000000000502'::uuid
  );
  IF v_replay IS DISTINCT FROM jsonb_build_object('download_count', 2)
    OR (SELECT download_count FROM public_engagement
        WHERE submission_id = 'gate-download-one') <> 2 THEN
    RAISE EXCEPTION '行为门失败：不同下载 operation 未各增加一次';
  END IF;

  v_first := record_public_download(
    'gate-download-one', repeat('a', 64),
    '00000000-0000-4000-8000-000000000503'::uuid
  );
  UPDATE public_interaction_operations
  SET created_at = statement_timestamp() - interval '24 hours',
      expires_at = statement_timestamp()
  WHERE operation_id = '00000000-0000-4000-8000-000000000503'::uuid;
  v_replay := record_public_download(
    'gate-download-two', repeat('b', 64),
    '00000000-0000-4000-8000-000000000503'::uuid
  );
  IF v_first IS DISTINCT FROM jsonb_build_object('download_count', 3)
    OR v_replay IS DISTINCT FROM jsonb_build_object('download_count', 1)
    OR (SELECT submission_id FROM public_interaction_operations
        WHERE operation_id = '00000000-0000-4000-8000-000000000503'::uuid)
       IS DISTINCT FROM 'gate-download-two'
    OR (SELECT expires_at - created_at FROM public_interaction_operations
        WHERE operation_id = '00000000-0000-4000-8000-000000000503'::uuid)
       IS DISTINCT FROM interval '24 hours' THEN
    RAISE EXCEPTION '行为门失败：恰好 24 小时到期的下载 operation 未按新输入复用';
  END IF;

  FOR v_index IN 1..10 LOOP
    PERFORM record_public_download(
      'gate-download-rate', repeat('5', 64),
      ('00000000-0000-4000-8007-' || lpad(to_hex(v_index), 12, '0'))::uuid
    );
  END LOOP;
  v_rate_limited := record_public_download(
    'gate-download-rate', repeat('5', 64),
    '00000000-0000-4000-8007-000000000011'::uuid
  );
  IF v_rate_limited ->> 'rate_limited' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION '行为门失败：新下载 operation 未受原子配额保护';
  END IF;
  v_replay := record_public_download(
    'gate-download-rate', repeat('5', 64),
    '00000000-0000-4000-8007-00000000000a'::uuid
  );
  IF v_replay IS DISTINCT FROM jsonb_build_object('download_count', 10)
    OR (SELECT download_count FROM public_engagement
        WHERE submission_id = 'gate-download-rate') <> 10 THEN
    RAISE EXCEPTION '行为门失败：配额耗尽阻断下载首次结果回放或重复计数';
  END IF;

  FOR v_index IN 1..10 LOOP
    v_not_found := record_public_download(
      'gate-download-missing', repeat('4', 64),
      ('00000000-0000-4000-8008-' || lpad(to_hex(v_index), 12, '0'))::uuid
    );
    IF v_not_found IS DISTINCT FROM jsonb_build_object('not_found', true) THEN
      RAISE EXCEPTION '行为门失败：缺失投稿未返回统一私有下载 not-found 事实';
    END IF;
  END LOOP;
  v_rate_limited := record_public_download(
    'gate-download-missing', repeat('4', 64),
    '00000000-0000-4000-8008-000000000011'::uuid
  );
  IF v_rate_limited ->> 'rate_limited' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION '行为门失败：缺失投稿未消费统一下载首次限流配额';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public_interaction_operations
    WHERE expires_at - created_at IS DISTINCT FROM interval '24 hours'
  ) THEN
    RAISE EXCEPTION '行为门失败：互动账本不是精确 24 小时过期';
  END IF;
  FOR v_index IN 1..501 LOOP
    INSERT INTO public_interaction_operations (
      operation_id, action, submission_id, fingerprint_hash, desired_liked,
      result_snapshot, created_at, expires_at
    ) VALUES (
      ('00000000-0000-4000-8001-' || lpad(to_hex(v_index), 12, '0'))::uuid,
      'like', 'gate-like-one', repeat('d', 64), true,
      jsonb_build_object('liked', true, 'like_count', 1),
      now() - interval '25 hours', now() - interval '1 hour'
    );
  END LOOP;
  v_purged := purge_expired_public_interaction_operations(500);
  IF v_purged <> 500 OR (
      SELECT count(*) FROM public_interaction_operations
      WHERE expires_at <= now()) <> 1 THEN
    RAISE EXCEPTION '行为门失败：互动账本清理未限制为每轮 500 条';
  END IF;
  BEGIN
    PERFORM purge_expired_public_interaction_operations(501);
    RAISE EXCEPTION '行为门失败：互动账本清理接受超过 500 的 limit';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
END
$interaction_gate$;
`;

/** 发布态结构门验证普通/强制发布、事务回滚和已发布资产持续不变量。 */
const publicationShapeBehaviorSql = String.raw`
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false);

CREATE OR REPLACE FUNCTION gate_seed_publication_shape(
  p_id text,
  p_kind text DEFAULT 'shared_package'
)
RETURNS void LANGUAGE plpgsql AS $seed$
BEGIN
  INSERT INTO submissions (
    id, kind, title, body, status, status_token_hash
  ) VALUES (
    p_id, p_kind, '发布结构标题', '发布结构正文',
    'manual_review_pending', md5(p_id) || md5(p_id)
  );
  IF p_kind = 'shared_package' THEN
    INSERT INTO assets (
      submission_id, object_key, original_name, declared_size, actual_size,
      mime_type, role
    ) VALUES
      (p_id, 'submissions/' || p_id || '/cover.webp', 'cover.webp',
       7, 7, 'image/webp', 'cover'),
      (p_id, 'submissions/' || p_id || '/package.zip', 'pet.zip',
       8, 8, 'application/zip', 'package');
  END IF;
END
$seed$;

CREATE OR REPLACE FUNCTION gate_add_publication_shape_evidence(p_id text)
RETURNS void LANGUAGE plpgsql AS $evidence$
DECLARE
  v_completed_at timestamptz := clock_timestamp() - interval '1 hour';
  v_package assets%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_package
  FROM assets WHERE submission_id = p_id AND role = 'package';
  UPDATE assets SET sha256 = repeat('a', 64) WHERE id = v_package.id;
  INSERT INTO moderation_results (
    submission_id, kind, provider, rule_version, suggestion, label, score,
    evidence, requested_at, completed_at, error_message
  ) VALUES (
    p_id, 'package_scan', 'isolated-scanner',
    'character-package-2026-08-15', 'Pass',
    '技术检查：CHARACTER_PACKAGE_SCAN_PASSED', NULL,
    jsonb_build_object(
      'submissionId', p_id,
      'packageStorageKey', v_package.object_key,
      'packageSizeBytes', v_package.actual_size,
      'archiveSizeBytes', v_package.actual_size,
      'archiveSha256', repeat('a', 64),
      'protocolVersion', '2026-08-15',
      'ruleVersion', 'character-package-2026-08-15',
      'scanCode', 'CHARACTER_PACKAGE_SCAN_PASSED',
      'completedAt', v_completed_at,
      'expiresAt', v_completed_at + interval '24 hours',
      'submissionStatusVersion', 0
    ),
    v_completed_at, v_completed_at, NULL
  );
END
$evidence$;

DO $publication_shape_gate$
DECLARE
  v_case text;
  v_id text;
  v_action text;
  v_result jsonb;
BEGIN
  IF to_regprocedure('assert_submission_publication_shape(text)') IS NULL
    OR to_regprocedure('enforce_submission_publication_shape()') IS NULL
    OR to_regclass('assets_one_cover_per_submission_idx') IS NULL
    OR to_regclass('assets_one_package_per_submission_idx') IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = 'submissions_publication_shape_guard'
        AND tgdeferrable AND tginitdeferred
    )
    OR NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = 'assets_publication_shape_guard'
        AND tgdeferrable AND tginitdeferred
    ) THEN
    RAISE EXCEPTION '行为门失败：发布结构函数、索引或延迟触发器缺失';
  END IF;

  FOREACH v_case IN ARRAY ARRAY[
    'missing-cover', 'wrong-package-key', 'nested-cover',
    'null-cover-size', 'zero-package-size', 'wrong-cover-mime',
    'wrong-package-mime', 'empty-title', 'empty-body'
  ] LOOP
    v_id := 'gate-shape-' || v_case;
    PERFORM gate_seed_publication_shape(v_id);
    CASE v_case
      WHEN 'missing-cover' THEN
        DELETE FROM assets WHERE submission_id = v_id AND role = 'cover';
      WHEN 'wrong-package-key' THEN
        UPDATE assets SET object_key = 'submissions/' || v_id || '/wrong.zip'
        WHERE submission_id = v_id AND role = 'package';
      WHEN 'nested-cover' THEN
        UPDATE assets SET object_key = 'submissions/' || v_id || '/nested/cover.webp'
        WHERE submission_id = v_id AND role = 'cover';
      WHEN 'null-cover-size' THEN
        UPDATE assets SET actual_size = NULL
        WHERE submission_id = v_id AND role = 'cover';
      WHEN 'zero-package-size' THEN
        UPDATE assets SET actual_size = 0
        WHERE submission_id = v_id AND role = 'package';
      WHEN 'wrong-cover-mime' THEN
        UPDATE assets SET mime_type = 'image/png'
        WHERE submission_id = v_id AND role = 'cover';
      WHEN 'wrong-package-mime' THEN
        UPDATE assets SET mime_type = 'application/octet-stream'
        WHERE submission_id = v_id AND role = 'package';
      WHEN 'empty-title' THEN
        UPDATE submissions SET title = '   ' WHERE id = v_id;
      WHEN 'empty-body' THEN
        UPDATE submissions SET body = E'\n\t' WHERE id = v_id;
    END CASE;
    v_action := CASE
      WHEN v_case IN (
        'missing-cover', 'wrong-package-key', 'wrong-cover-mime', 'empty-body'
      ) THEN 'approve'
      ELSE 'force_publish'
    END;
    IF v_action = 'approve' THEN
      PERFORM gate_add_publication_shape_evidence(v_id);
    END IF;

    BEGIN
      v_result := apply_admin_action(
        v_id, 'admin-1', v_action, 'published', 0,
        v_id || '-action', '结构损坏不得发布',
        CASE WHEN v_action = 'force_publish'
          THEN 'ADMIN_OVERRIDE_ACCEPTED' ELSE NULL END
      );
      SET CONSTRAINTS ALL IMMEDIATE;
      RAISE EXCEPTION '行为门失败：结构损坏 % 仍可执行 %', v_case, v_action;
    EXCEPTION WHEN SQLSTATE 'P1002' THEN
      SET CONSTRAINTS ALL DEFERRED;
    END;
    IF EXISTS (
      SELECT 1 FROM submissions
      WHERE id = v_id
        AND (status <> 'manual_review_pending'
          OR status_version <> 0 OR publication_basis IS NOT NULL)
    ) OR EXISTS (
      SELECT 1 FROM admin_audit_logs WHERE idempotency_key = v_id || '-action'
    ) OR EXISTS (
      SELECT 1 FROM public_engagement WHERE submission_id = v_id
    ) THEN
      RAISE EXCEPTION '行为门失败：结构拒绝留下状态、依据、审计或互动半状态';
    END IF;
  END LOOP;

  PERFORM gate_seed_publication_shape('gate-shape-duplicate-package');
  BEGIN
    INSERT INTO assets (
      submission_id, object_key, original_name, declared_size, actual_size,
      mime_type, role
    ) VALUES (
      'gate-shape-duplicate-package',
      'submissions/gate-shape-duplicate-package/second.zip',
      'second.zip', 9, 9, 'application/zip', 'package'
    );
    RAISE EXCEPTION '行为门失败：部分唯一索引接受重复 package';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  PERFORM gate_seed_publication_shape('gate-shape-valid-force');
  INSERT INTO assets (
    submission_id, object_key, original_name, declared_size, actual_size,
    mime_type, role
  ) VALUES
    ('gate-shape-valid-force',
     'submissions/gate-shape-valid-force/derived/preview-1.webp',
     'preview-1.webp', 3, 3, 'image/webp', 'derived'),
    ('gate-shape-valid-force',
     'submissions/gate-shape-valid-force/derived/preview-2.webp',
     'preview-2.webp', 4, 4, 'image/webp', 'derived');
  v_result := apply_admin_action(
    'gate-shape-valid-force', 'admin-1', 'force_publish', 'published', 0,
    'gate-shape-valid-force-action', '管理员确认无扫描证据风险',
    'ADMIN_OVERRIDE_ACCEPTED'
  );
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  IF v_result #>> '{submission,publication_basis}' <> 'admin_override'
    OR (SELECT status FROM submissions WHERE id = 'gate-shape-valid-force')
      <> 'published'
    OR (SELECT count(*) FROM assets
        WHERE submission_id = 'gate-shape-valid-force' AND role = 'derived')
      <> 2 THEN
    RAISE EXCEPTION '行为门失败：合法多 derived 共享包无法强制发布';
  END IF;

  FOREACH v_case IN ARRAY ARRAY['feedback', 'suggestion'] LOOP
    v_id := 'gate-shape-valid-' || v_case;
    PERFORM gate_seed_publication_shape(v_id, v_case);
    v_result := apply_admin_action(
      v_id, 'admin-1', 'approve', 'published', 0,
      v_id || '-approve', '合法文本投稿批准'
    );
    SET CONSTRAINTS ALL IMMEDIATE;
    SET CONSTRAINTS ALL DEFERRED;
    IF v_result #>> '{submission,publication_basis}' <> 'standard'
      OR (SELECT count(*) FROM assets WHERE submission_id = v_id) <> 0 THEN
      RAISE EXCEPTION '行为门失败：合法文本投稿被要求资产或扫描证据';
    END IF;
  END LOOP;

  PERFORM gate_seed_publication_shape('gate-shape-invalid-feedback', 'feedback');
  UPDATE submissions SET title = ' ' WHERE id = 'gate-shape-invalid-feedback';
  PERFORM gate_seed_publication_shape('gate-shape-invalid-suggestion', 'suggestion');
  UPDATE submissions SET body = ' ' WHERE id = 'gate-shape-invalid-suggestion';
  FOREACH v_id IN ARRAY ARRAY[
    'gate-shape-invalid-feedback', 'gate-shape-invalid-suggestion'
  ] LOOP
    BEGIN
      PERFORM apply_admin_action(
        v_id, 'admin-1', 'approve', 'published', 0,
        v_id || '-approve', '空文本不得批准'
      );
      SET CONSTRAINTS ALL IMMEDIATE;
      RAISE EXCEPTION '行为门失败：空文本反馈或建议仍可发布';
    EXCEPTION WHEN SQLSTATE 'P1002' THEN
      SET CONSTRAINTS ALL DEFERRED;
    END;
    IF EXISTS (
      SELECT 1 FROM submissions
      WHERE id = v_id AND (
        status <> 'manual_review_pending' OR status_version <> 0
        OR publication_basis IS NOT NULL
      )
    ) OR EXISTS (
      SELECT 1 FROM admin_audit_logs WHERE idempotency_key = v_id || '-approve'
    ) THEN
      RAISE EXCEPTION '行为门失败：文本结构拒绝留下半状态';
    END IF;
  END LOOP;

  BEGIN
    UPDATE assets SET actual_size = 0
    WHERE submission_id = 'gate-shape-valid-force' AND role = 'cover';
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION '行为门失败：已发布封面可在事务末保留零大小';
  EXCEPTION WHEN SQLSTATE 'P1002' THEN
    SET CONSTRAINTS ALL DEFERRED;
  END;
  IF (SELECT actual_size FROM assets
      WHERE submission_id = 'gate-shape-valid-force' AND role = 'cover') <> 7 THEN
    RAISE EXCEPTION '行为门失败：已发布资产更新拒绝未回滚';
  END IF;

  BEGIN
    DELETE FROM assets
    WHERE submission_id = 'gate-shape-valid-force' AND role = 'package';
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION '行为门失败：已发布 package 可在事务末缺失';
  EXCEPTION WHEN SQLSTATE 'P1002' THEN
    SET CONSTRAINTS ALL DEFERRED;
  END;
  IF NOT EXISTS (
    SELECT 1 FROM assets
    WHERE submission_id = 'gate-shape-valid-force' AND role = 'package'
  ) THEN
    RAISE EXCEPTION '行为门失败：已发布资产删除拒绝未回滚';
  END IF;

  DELETE FROM assets
  WHERE submission_id = 'gate-shape-valid-force' AND role = 'cover';
  INSERT INTO assets (
    submission_id, object_key, original_name, declared_size, actual_size,
    mime_type, role
  ) VALUES (
    'gate-shape-valid-force',
    'submissions/gate-shape-valid-force/cover.webp',
    'replacement.webp', 9, 9, 'image/webp', 'cover'
  );
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  IF (SELECT count(*) FROM assets
      WHERE submission_id = 'gate-shape-valid-force' AND role = 'cover') <> 1
    OR (SELECT original_name FROM assets
        WHERE submission_id = 'gate-shape-valid-force' AND role = 'cover')
      <> 'replacement.webp' THEN
    RAISE EXCEPTION '行为门失败：同一事务先删旧封面再插新封面被错误拒绝';
  END IF;
END
$publication_shape_gate$;
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
