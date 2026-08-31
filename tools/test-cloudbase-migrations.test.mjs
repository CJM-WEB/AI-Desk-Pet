import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { test } from 'node:test';

import {
  parseMigrationGateArguments,
  parseSupportedPostgresVersion,
  runCloudBaseMigrationBehaviorGate
} from './test-cloudbase-migrations.mjs';

test('迁移行为门要求显式本地 PostgreSQL 运行时且拒绝未知参数', () => {
  assert.throws(
    () => parseMigrationGateArguments([], {}),
    /必须提供本地 PostgreSQL 运行时/u
  );
  assert.throws(
    () => parseMigrationGateArguments(['--unknown']),
    /未知参数/u
  );
  assert.deepEqual(parseMigrationGateArguments([
    '--postgres-runtime', 'C:\\postgres-runtime'
  ]), {
    postgresRuntime: 'C:\\postgres-runtime'
  });
  assert.deepEqual(parseMigrationGateArguments([], {
    AI_PET_POSTGRES_RUNTIME: 'C:\\postgres-runtime'
  }), {
    postgresRuntime: 'C:\\postgres-runtime'
  });
});

test('迁移行为门接受 PostgreSQL 17 的补丁版本并拒绝其他主版本', () => {
  assert.deepEqual(
    parseSupportedPostgresVersion('postgres (PostgreSQL) 17.11'),
    { major: 17, version: '17.11' }
  );
  assert.deepEqual(
    parseSupportedPostgresVersion('postgres (PostgreSQL) 17.12'),
    { major: 17, version: '17.12' }
  );
  assert.throws(
    () => parseSupportedPostgresVersion('postgres (PostgreSQL) 16.8'),
    /仅支持 PostgreSQL 17/u
  );
});

test('真实临时 PostgreSQL 顺序执行全部迁移并验证事务行为', {
  skip: !process.env.AI_PET_POSTGRES_RUNTIME
}, async () => {
  const runtime = process.env.AI_PET_POSTGRES_RUNTIME;
  await access(runtime);
  const result = await runCloudBaseMigrationBehaviorGate({
    postgresRuntime: runtime
  });

  assert.equal(result.postgresMajorVersion, 17);
  assert.match(result.postgresVersion, /^17\./u);
  assert.equal(result.migrationsApplied > 0, true);
  assert.equal(result.behaviorsVerified, 9);
});
