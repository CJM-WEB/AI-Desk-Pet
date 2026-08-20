import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const cliPath = fileURLToPath(new URL('./plan-cloudbase-migrations.mjs', import.meta.url));
const inventoryPath = fileURLToPath(new URL('./cloudbase-migration-inventory.mjs', import.meta.url));
const migrationsPath = fileURLToPath(new URL('../cloudbase/migrations/', import.meta.url));

/** 通过独立进程验证 CLI，避免测试进程掩盖模块加载产生的副作用。 */
function run(args, cwd = repositoryRoot) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
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

/** 以相对路径排序保存迁移目录原始字节，精确检测内容与文件集变化。 */
async function snapshotMigrationDirectory(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const snapshot = new Map();

  for (const entry of entries) {
    const relativePath = `${prefix}${entry.name}`;
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [path, content] of await snapshotMigrationDirectory(absolutePath, `${relativePath}/`)) {
        snapshot.set(path, content);
      }
    } else if (entry.isFile()) {
      snapshot.set(relativePath, await readFile(absolutePath));
    }
  }

  return snapshot;
}

test('dry-run 子进程不改写迁移目录中的任意原始字节', async () => {
  const before = await snapshotMigrationDirectory(migrationsPath);
  const result = run(['--dry-run']);
  const after = await snapshotMigrationDirectory(migrationsPath);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(after, before);
});

test('CLI 从非仓库当前目录仍可运行', () => {
  const result = run(['--dry-run'], fileURLToPath(new URL('../../', import.meta.url)));

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).mode, 'dry-run');
});

test('CLI 与 inventory 仅保留迁移读取能力', async () => {
  const source = `${await readFile(cliPath, 'utf8')}\n${await readFile(inventoryPath, 'utf8')}`;

  assert.doesNotMatch(
    source,
    /@cloudbase\/manager-node|process\.env|\bfetch\b|node:(?:http|https|net|child_process)|\b(?:writeFile|appendFile|rm|unlink|rename|mkdir|chmod|executePGSql|database)\b/u,
  );
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
