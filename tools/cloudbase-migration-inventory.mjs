import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';

const migrationFileNamePattern =
  /^(?<version>\d{14})_(?<name>[a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/u;

const defaultFileSystem = {
  readDirectory: readdir,
  readMigrationFile: readFile
};

/**
 * 将已排序的迁移清单投影为只读预览；只公开迁移契约字段，
 * 防止调用方附带的 SQL、路径或凭据进入 dry-run 输出。
 */
export function createCloudBaseMigrationDryRun(migrations) {
  const planMigrations = migrations.map((migration) => ({
    version: migration.version,
    name: migration.name,
    fileName: migration.fileName,
    sha256: migration.sha256,
    bytes: migration.bytes
  }));
  const planBody = planMigrations
    .map((migration) => `${migration.version}:${migration.sha256}\n`)
    .join('');

  return {
    mode: 'dry-run',
    migrations: planMigrations,
    planSha256: createHash('sha256').update(planBody).digest('hex')
  };
}

/**
 * 读取迁移目录并生成稳定的内容清单。
 *
 * 仅接受符合版本与名称契约的普通 SQL 文件；任一无效迁移均会中止，
 * 避免调用方基于不完整或可变的目录状态继续执行。
 */
export async function inventoryCloudBaseMigrations(
  directoryUrl,
  fileSystem = defaultFileSystem
) {
  let entries;
  try {
    entries = await fileSystem.readDirectory(directoryUrl, {
      withFileTypes: true
    });
  } catch {
    throw new Error('无法读取 CloudBase PostgreSQL 迁移目录');
  }

  const seenVersions = new Set();
  const migrations = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.sql')) continue;

    const match = migrationFileNamePattern.exec(entry.name);
    if (!match?.groups) {
      throw new Error(`迁移文件名无效：${entry.name}`);
    }
    if (seenVersions.has(match.groups.version)) {
      throw new Error(`迁移版本重复：${match.groups.version}`);
    }

    let content;
    try {
      content = await fileSystem.readMigrationFile(
        new URL(entry.name, directoryUrl)
      );
    } catch {
      throw new Error(`无法读取 CloudBase PostgreSQL 迁移文件：${entry.name}`);
    }
    if (content.byteLength === 0) {
      throw new Error(`迁移文件为空：${entry.name}`);
    }

    seenVersions.add(match.groups.version);
    migrations.push({
      version: match.groups.version,
      name: match.groups.name,
      fileName: entry.name,
      sha256: createHash('sha256').update(content).digest('hex'),
      bytes: content.byteLength
    });
  }

  migrations.sort((left, right) => left.version.localeCompare(right.version));
  if (migrations.length === 0) {
    throw new Error('未发现 CloudBase PostgreSQL 迁移');
  }
  return migrations;
}
