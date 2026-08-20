import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';

const cliPath = resolve('tools/plan-cloudbase-migrations.mjs');
const migrationsPath = resolve('cloudbase/migrations');

/** 通过独立进程验证 CLI，避免测试进程掩盖模块加载产生的副作用。 */
function run(args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CLOUDBASE_ENV_ID: 'environment-sentinel',
      TENCENTCLOUD_SECRETID: 'secret-id-sentinel',
      TENCENTCLOUD_SECRETKEY: 'secret-key-sentinel'
    }
  });
}

test('只接受一次 --dry-run 并稳定输出脱敏 JSON 计划', () => {
  const first = run(['--dry-run']);
  const second = run(['--dry-run']);

  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stderr, '');
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, first.stdout);

  const plan = JSON.parse(first.stdout);
  assert.equal(plan.mode, 'dry-run');
  assert.ok(plan.migrations.length >= 4);
  assert.match(plan.planSha256, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(
    first.stdout,
    /SELECT|TENCENTCLOUD_SECRET|CLOUDBASE_ENV_ID|environment-sentinel|secret-(?:id|key)-sentinel|Project Optimization/u
  );
});

test('dry-run 子进程不改写迁移目录', async () => {
  const before = await stat(migrationsPath);
  const result = run(['--dry-run']);
  const after = await stat(migrationsPath);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test('拒绝无参数、未知参数和重复 dry-run 参数', () => {
  for (const args of [[], ['--apply'], ['--unknown'], ['--dry-run', '--dry-run']]) {
    const result = run(args);

    assert.notEqual(result.status, 0, args.join(' '));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /当前迁移入口仅允许 --dry-run/u);
    assert.doesNotMatch(
      result.stderr,
      /environment-sentinel|secret-(?:id|key)-sentinel|CLOUDBASE_ENV_ID|TENCENTCLOUD_SECRET/u
    );
  }
});
