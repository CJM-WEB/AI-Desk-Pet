import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readMigrationCredentials } from './apply-cloudbase-migrations.mjs';

describe('CloudBase 数据库迁移配置', () => {
  it('将主环境地域传给管理 SDK', () => {
    assert.deepEqual(
      readMigrationCredentials({
        TENCENTCLOUD_SECRETID: 'secret-id',
        TENCENTCLOUD_SECRETKEY: 'secret-key',
        CLOUDBASE_ENV_ID: 'main-env',
        CLOUDBASE_REGION: 'ap-singapore'
      }),
      {
        secretId: 'secret-id',
        secretKey: 'secret-key',
        envId: 'main-env',
        region: 'ap-singapore'
      }
    );
  });

  it('缺少地域时拒绝执行，避免请求错误地域', () => {
    assert.throws(
      () =>
        readMigrationCredentials({
          TENCENTCLOUD_SECRETID: 'secret-id',
          TENCENTCLOUD_SECRETKEY: 'secret-key',
          CLOUDBASE_ENV_ID: 'main-env'
        }),
      /迁移配置不完整/u
    );
  });
});
