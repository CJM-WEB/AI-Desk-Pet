import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { inventoryCloudBaseMigrations } from './cloudbase-migration-inventory.mjs';

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

test('目录读取失败时向调用方抛出错误', async (t) => {
  const root = await createMigrationDirectory(t);
  const missingDirectoryUrl = directoryUrl(join(root, 'missing'));

  await assert.rejects(inventoryCloudBaseMigrations(missingDirectoryUrl));
});
