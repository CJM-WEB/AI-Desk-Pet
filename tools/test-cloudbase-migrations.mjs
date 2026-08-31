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
      await run(executable('psql'), [
        ...connection,
        '-f', join(migrationDirectory, migration.fileName)
      ]);
    }
    await run(executable('psql'), [...connection, '-f', '-'], behaviorSql);

    return {
      postgresVersion: postgresVersion.version,
      postgresMajorVersion: postgresVersion.major,
      migrationsApplied: migrations.length,
      behaviorsVerified: 9
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

DO $gate$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_status text;
  v_version bigint;
  v_count bigint;
  v_result jsonb;
BEGIN
  -- 1. 上传完成只进入系统审核。
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

  -- 6. 有效证据允许人工批准，数据库版本和审计同时推进。
  PERFORM apply_admin_action(
    'gate-valid', 'admin-1', 'approve', 'published', 2,
    'gate-valid-approve', '人工复核通过'
  );
  IF (SELECT status FROM submissions WHERE id = 'gate-valid') <> 'published'
    OR NOT EXISTS (
      SELECT 1 FROM admin_audit_logs
      WHERE idempotency_key = 'gate-valid-approve'
    ) THEN
    RAISE EXCEPTION '行为门失败：有效批准';
  END IF;

  -- 7. 自动驳回转人工必须回系统审核，不重绑旧证据。
  INSERT INTO submissions (
    id, kind, status, status_token_hash, auto_rejection_reason
  ) VALUES (
    'gate-move', 'shared_package', 'auto_rejected', repeat('b', 64), '自动驳回'
  );
  PERFORM apply_admin_action(
    'gate-move', 'admin-1', 'move_to_manual', 'system_reviewing', 0,
    'gate-move-rescan', '请求复核'
  );
  IF (SELECT status FROM submissions WHERE id = 'gate-move')
    <> 'system_reviewing' THEN
    RAISE EXCEPTION '行为门失败：转人工未重扫';
  END IF;

  -- 8. 隔离共享包恢复同样回系统审核，人工批准不会被复用。
  INSERT INTO submissions (
    id, kind, status, status_token_hash, pre_quarantine_status, quarantined_at
  ) VALUES (
    'gate-restore', 'shared_package', 'deleted_quarantined', repeat('c', 64),
    'published', now()
  );
  PERFORM apply_admin_action(
    'gate-restore', 'admin-1', 'restore', 'system_reviewing', 0,
    'gate-restore-rescan', '恢复并重扫'
  );
  IF (SELECT status FROM submissions WHERE id = 'gate-restore')
      <> 'system_reviewing'
    OR (SELECT pre_quarantine_status FROM submissions WHERE id = 'gate-restore')
      IS NOT NULL THEN
    RAISE EXCEPTION '行为门失败：恢复未重扫';
  END IF;

  -- 9. 文本恢复后同 key 回放首次快照，新 key 仍由 SQL 状态机拒绝。
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
      'gate-text-restore-new-key', '恢复文本'
    );
    RAISE EXCEPTION '行为门失败：文本恢复新 key 绕过状态机';
  EXCEPTION WHEN SQLSTATE 'P1002' THEN
    NULL;
  END;
END
$gate$;
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
