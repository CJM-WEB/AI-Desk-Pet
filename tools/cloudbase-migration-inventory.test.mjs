import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  createCloudBaseMigrationDryRun,
  inventoryCloudBaseMigrations
} from './cloudbase-migration-inventory.mjs';

/** 创建用后即删的迁移目录，隔离每个用例的文件系统状态。 */
async function createMigrationDirectory(t) {
  const root = await mkdtemp(join(tmpdir(), 'cloudbase-migration-inventory-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  return root;
}

/** 将临时目录转换为保留尾部分隔符的文件 URL。 */
function directoryUrl(root) {
  return pathToFileURL(`${root}${sep}`);
}

/** 验证读取失败只暴露稳定且不含敏感输入的错误。 */
function assertSanitizedReadError(message, sensitiveFragments) {
  return (error) => {
    assert.equal(error.message, message);
    for (const fragment of sensitiveFragments) {
      assert.equal(String(error).includes(fragment), false);
    }
    return true;
  };
}

test('按版本排序并对 SQL 原始字节计算 SHA-256', async (t) => {
  const root = await createMigrationDirectory(t);
  await writeFile(
    join(root, '20260808000000_direct_manual_review.sql'),
    'SELECT 2;\r\n'
  );
  await writeFile(
    join(root, '20260730000000_moderation.sql'), 'SELECT 1;\n');

  const items = await inventoryCloudBaseMigrations(directoryUrl(root));

  assert.deepEqual(items.map((item) => item.fileName), [
    '20260730000000_moderation.sql',
    '20260808000000_direct_manual_review.sql'
  ]);
  assert.equal(
    items[0].sha256,
    createHash('sha256').update('SELECT 1;\n').digest('hex')
  );
  assert.equal(items[1].bytes, Buffer.byteLength('SELECT 2;\r\n'));
  assert.deepEqual(items[0].content, Buffer.from('SELECT 1;\n'));
});

test('真实仓库迁移清单保持六个不可变前向版本', async () => {
  const items = await inventoryCloudBaseMigrations(
    new URL('../cloudbase/migrations/', import.meta.url)
  );

  assert.deepEqual(items.map((item) => item.fileName), [
    '20260730000000_moderation.sql',
    '20260807000000_public_like_kinds.sql',
    '20260808000000_direct_manual_review.sql',
    '20260815000000_shared_package_publication_guard.sql',
    '20260831000000_restore_scanned_submission_flow.sql',
    '20260831010000_admin_override_publication.sql'
  ]);
});

test('拒绝 manager SDK 不接受的含数字迁移名称', async (t) => {
  const root = await createMigrationDirectory(t);
  await writeFile(join(root, '20260808000000_phase_2.sql'), 'SELECT 1;\n');

  await assert.rejects(
    inventoryCloudBaseMigrations(directoryUrl(root)),
    /迁移文件名无效/u
  );
});

test('拒绝不符合迁移文件名契约的 SQL 文件', async (t) => {
  const root = await createMigrationDirectory(t);
  await writeFile(join(root, 'manual.sql'), 'SELECT 1;\n');

  await assert.rejects(
    inventoryCloudBaseMigrations(directoryUrl(root)),
    /迁移文件名无效/u
  );
});

test('拒绝重复的迁移版本', async (t) => {
  const root = await createMigrationDirectory(t);
  await writeFile(join(root, '20260808000000_first.sql'), 'SELECT 1;\n');
  await writeFile(join(root, '20260808000000_second.sql'), 'SELECT 2;\n');

  await assert.rejects(
    inventoryCloudBaseMigrations(directoryUrl(root)),
    /迁移版本重复：20260808000000/u
  );
});

test('拒绝空迁移文件', async (t) => {
  const root = await createMigrationDirectory(t);
  await writeFile(join(root, '20260808000000_empty.sql'), '');

  await assert.rejects(
    inventoryCloudBaseMigrations(directoryUrl(root)),
    /迁移文件为空/u
  );
});

test('拒绝没有 SQL 迁移的空目录', async (t) => {
  const root = await createMigrationDirectory(t);

  await assert.rejects(
    inventoryCloudBaseMigrations(directoryUrl(root)),
    /未发现 CloudBase PostgreSQL 迁移/u
  );
});

test('忽略非文件和非 SQL 文件', async (t) => {
  const root = await createMigrationDirectory(t);
  await mkdir(join(root, '20260808000000_directory.sql'));
  await writeFile(join(root, 'readme.txt'), 'ignore me');
  await writeFile(join(root, '20260808000000_valid.sql'), 'SELECT 1;\n');

  const items = await inventoryCloudBaseMigrations(directoryUrl(root));

  assert.deepEqual(items.map((item) => item.fileName), [
    '20260808000000_valid.sql'
  ]);
});

test('目录读取失败时不泄漏输入路径或敏感内容', async (t) => {
  const root = await createMigrationDirectory(t);
  const pathSentinel = join(root, 'directory-path-sentinel');
  const missingDirectoryUrl = directoryUrl(pathSentinel);

  await assert.rejects(
    inventoryCloudBaseMigrations(missingDirectoryUrl),
    assertSanitizedReadError('无法读取 CloudBase PostgreSQL 迁移目录', [
      pathSentinel,
      'sql-content-sentinel',
      'credential-sentinel'
    ])
  );
});

test('迁移读取失败时不泄漏路径、SQL 内容或凭据', async (t) => {
  const root = await createMigrationDirectory(t);
  const fileName = '20260808000000_unreadable.sql';
  const pathSentinel = join(root, 'migration-path-sentinel');
  await writeFile(join(root, fileName), 'SELECT 1;\n');

  await assert.rejects(
    inventoryCloudBaseMigrations(directoryUrl(root), {
      readDirectory: readdir,
      readMigrationFile: async () => {
        throw new Error(
          `EACCES: ${pathSentinel} sql-content-sentinel credential-sentinel`
        );
      }
    }),
    assertSanitizedReadError(`无法读取 CloudBase PostgreSQL 迁移文件：${fileName}`, [
      pathSentinel,
      'sql-content-sentinel',
      'credential-sentinel'
    ])
  );
});

test('按 inventory 顺序生成字段固定且稳定的 dry-run 计划', () => {
  const firstChecksum = 'a'.repeat(64);
  const secondChecksum = 'b'.repeat(64);
  const migrations = [
    {
      version: '20260730000000',
      name: 'moderation',
      fileName: '20260730000000_moderation.sql',
      sha256: firstChecksum,
      bytes: 10
    },
    {
      version: '20260808000000',
      name: 'direct_manual_review',
      fileName: '20260808000000_direct_manual_review.sql',
      sha256: secondChecksum,
      bytes: 20
    }
  ];

  const firstPlan = createCloudBaseMigrationDryRun(migrations);
  const secondPlan = createCloudBaseMigrationDryRun(migrations);

  assert.deepEqual(firstPlan, {
    mode: 'dry-run',
    migrations: [
      {
        version: '20260730000000',
        name: 'moderation',
        fileName: '20260730000000_moderation.sql',
        sha256: firstChecksum,
        bytes: 10
      },
      {
        version: '20260808000000',
        name: 'direct_manual_review',
        fileName: '20260808000000_direct_manual_review.sql',
        sha256: secondChecksum,
        bytes: 20
      }
    ],
    planSha256: createHash('sha256')
      .update(
        `20260730000000:${firstChecksum}\n20260808000000:${secondChecksum}\n`
      )
      .digest('hex')
  });
  assert.deepEqual(secondPlan, firstPlan);
});

test('dry-run 不修改输入且不公开 SQL、绝对路径或凭据', () => {
  const checksum = 'c'.repeat(64);
  const migrations = Object.freeze([
    Object.freeze({
      version: '20260730000000',
      name: 'moderation',
      fileName: '20260730000000_moderation.sql',
      sha256: checksum,
      bytes: 10,
      sql: 'SELECT secret_column FROM private_table;',
      absolutePath: 'C:\\migration-path-sentinel\\migration.sql',
      credential: 'credential-sentinel',
      content: Buffer.from('SELECT content_sentinel;')
    })
  ]);

  const plan = createCloudBaseMigrationDryRun(migrations);
  const serializedPlan = JSON.stringify(plan);

  assert.deepEqual(migrations, [
    {
      version: '20260730000000',
      name: 'moderation',
      fileName: '20260730000000_moderation.sql',
      sha256: checksum,
      bytes: 10,
      sql: 'SELECT secret_column FROM private_table;',
      absolutePath: 'C:\\migration-path-sentinel\\migration.sql',
      credential: 'credential-sentinel',
      content: Buffer.from('SELECT content_sentinel;')
    }
  ]);
  assert.notEqual(plan.migrations, migrations);
  assert.notEqual(plan.migrations[0], migrations[0]);
  assert.doesNotMatch(
    serializedPlan,
    /SELECT|content_sentinel|credential-sentinel|migration-path-sentinel|:\\\\/u
  );
});
