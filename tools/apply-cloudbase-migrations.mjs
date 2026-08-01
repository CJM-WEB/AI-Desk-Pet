import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import CloudBase from '@cloudbase/manager-node';

const migrationPath = fileURLToPath(
  new URL('../cloudbase/migrations/20260730000000_moderation.sql', import.meta.url)
);

/** 读取固定的三项迁移凭据，缺失时不回显名称或值。 */
export function readMigrationCredentials(environment) {
  const secretId = environment.TENCENTCLOUD_SECRETID;
  const secretKey = environment.TENCENTCLOUD_SECRETKEY;
  const envId = environment.CLOUDBASE_ENV_ID;
  const region = environment.CLOUDBASE_REGION;

  if (!secretId || !secretKey || !envId || !region) {
    throw new Error('迁移配置不完整');
  }

  return { secretId, secretKey, envId, region };
}

/** 使用管理端 SDK 一次性执行受版本控制的 PostgreSQL 迁移。 */
export async function applyCloudBaseMigrations(environment = process.env) {
  const credentials = readMigrationCredentials(environment);
  const sql = await readFile(migrationPath, 'utf8');
  const app = CloudBase.init(credentials);

  await app.database.executePGSql({
    Sql: sql,
    EnvId: credentials.envId
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  applyCloudBaseMigrations().catch(() => {
    console.error('CloudBase PostgreSQL 迁移执行失败');
    process.exitCode = 1;
  });
}
