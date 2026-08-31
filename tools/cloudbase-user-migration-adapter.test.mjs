import assert from 'node:assert/strict';
import test from 'node:test';

import { createCloudBaseUserMigrationAdapter } from './cloudbase-user-migration-adapter.mjs';

test('用显式配置构造独立 manager 实例并代理数据库 API', async () => {
  const calls = [];
  class FakeCloudBase {
    static init() { throw new Error('不得使用单例 init'); }
    constructor(config) {
      calls.push(['constructor', config]);
      this.database = {
        previewPGUserMigrations: async options => { calls.push(['preview', options]); return { Executable: true }; },
        pushPGUserMigrations: async options => { calls.push(['push', options]); return { TaskId: 'task-1' }; },
        describeTaskResult: async options => { calls.push(['describe', options]); return { Status: 'Succeed' }; }
      };
    }
  }
  const adapter = await createCloudBaseUserMigrationAdapter({
    environmentClass: 'development',
    envId: ' development-env ',
    secretId: ' secret-id ',
    secretKey: ' secret-key ',
    token: ' temporary-token ',
    loadManager: async () => ({ default: FakeCloudBase })
  });
  const migrations = [{ Version: '20260831000000', Name: 'migration', Query: 'SELECT 1;' }];

  await adapter.preview(migrations);
  await adapter.push(migrations);
  await adapter.describeTask('task-1');

  assert.deepEqual(calls, [
    ['constructor', { envId: 'development-env', secretId: 'secret-id', secretKey: 'secret-key', token: 'temporary-token', region: 'ap-singapore' }],
    ['preview', { EnvId: 'development-env', Migrations: migrations }],
    ['push', { EnvId: 'development-env', Migrations: migrations }],
    ['describe', { EnvId: 'development-env', TaskId: 'task-1' }]
  ]);
});

test('兼容 CommonJS namespace 且不传未提供的可选配置', async () => {
  let config;
  class FakeCloudBase {
    constructor(value) {
      config = value;
      this.database = {};
    }
  }

  await createCloudBaseUserMigrationAdapter({
    environmentClass: 'development',
    envId: 'development-env',
    secretId: 'secret-id',
    secretKey: 'secret-key',
    loadManager: async () => FakeCloudBase
  });

  assert.deepEqual(config, {
    envId: 'development-env',
    secretId: 'secret-id',
    secretKey: 'secret-key',
    region: 'ap-singapore'
  });
});

test('缺少显式配置时不加载 manager SDK', async () => {
  let loads = 0;
  for (const missing of ['envId', 'secretId', 'secretKey']) {
    const options = {
      environmentClass: 'development',
      envId: 'development-env', secretId: 'secret-id', secretKey: 'secret-key',
      loadManager: async () => { loads += 1; return class {}; }
    };
    options[missing] = '';
    await assert.rejects(createCloudBaseUserMigrationAdapter(options), /迁移适配器配置不完整/u);
  }
  assert.equal(loads, 0);
});

test('非 development 环境在加载 SDK 前失败关闭', async () => {
  let loads = 0;
  await assert.rejects(
    createCloudBaseUserMigrationAdapter({
      environmentClass: 'production',
      envId: 'development-env',
      secretId: 'secret-id',
      secretKey: 'secret-key',
      loadManager: async () => { loads += 1; return class {}; }
    }),
    /只允许显式 development 环境/u
  );
  assert.equal(loads, 0);
});

test('必填配置与可选 token 均拒绝纯空白且不加载 SDK', async () => {
  let loads = 0;
  for (const blankField of ['envId', 'secretId', 'secretKey', 'token']) {
    const options = {
      environmentClass: 'development',
      envId: 'development-env',
      secretId: 'secret-id',
      secretKey: 'secret-key',
      token: 'temporary-token',
      loadManager: async () => { loads += 1; return class {}; }
    };
    options[blankField] = '   ';
    await assert.rejects(
      createCloudBaseUserMigrationAdapter(options),
      /迁移适配器配置不完整/u
    );
  }
  assert.equal(loads, 0);
});

test('拒绝 region override 且固定使用 ap-singapore', async () => {
  let loads = 0;
  await assert.rejects(
    createCloudBaseUserMigrationAdapter({
      environmentClass: 'development',
      envId: 'development-env',
      secretId: 'secret-id',
      secretKey: 'secret-key',
      region: 'ap-guangzhou',
      loadManager: async () => { loads += 1; return class {}; }
    }),
    /地域固定为 ap-singapore/u
  );
  assert.equal(loads, 0);
});

test('TCB_REGION 会覆盖显式地域时仅允许精确 ap-singapore', async () => {
  const original = process.env.TCB_REGION;
  let loads = 0;
  try {
    process.env.TCB_REGION = 'region-secret-sentinel';
    await assert.rejects(
      createCloudBaseUserMigrationAdapter({
        environmentClass: 'development',
        envId: 'development-env',
        secretId: 'secret-id',
        secretKey: 'secret-key',
        loadManager: async () => { loads += 1; return class {}; }
      }),
      error => {
        assert.match(error.message, /TCB_REGION 与固定地域不一致/u);
        assert.doesNotMatch(error.message, /region-secret-sentinel/u);
        return true;
      }
    );
    assert.equal(loads, 0);

    process.env.TCB_REGION = 'ap-singapore';
    await createCloudBaseUserMigrationAdapter({
      environmentClass: 'development',
      envId: 'development-env',
      secretId: 'secret-id',
      secretKey: 'secret-key',
      loadManager: async () => {
        loads += 1;
        return class { constructor() { this.database = {}; } };
      }
    });
    assert.equal(loads, 1);
  } finally {
    if (original === undefined) delete process.env.TCB_REGION;
    else process.env.TCB_REGION = original;
  }
});

test('创建后 TCB_REGION 漂移时在每个远端方法前失败关闭', async () => {
  const original = process.env.TCB_REGION;
  let remoteCalls = 0;
  try {
    delete process.env.TCB_REGION;
    class FakeCloudBase {
      constructor() {
        this.database = {
          previewPGUserMigrations: async () => { remoteCalls += 1; },
          pushPGUserMigrations: async () => { remoteCalls += 1; },
          describeTaskResult: async () => { remoteCalls += 1; }
        };
      }
    }
    const adapter = await createCloudBaseUserMigrationAdapter({
      environmentClass: 'development',
      envId: 'development-env',
      secretId: 'secret-id',
      secretKey: 'secret-key',
      loadManager: async () => ({ default: FakeCloudBase })
    });
    process.env.TCB_REGION = 'drifted-region-sentinel';

    for (const invoke of [
      () => adapter.preview([]),
      () => adapter.push([]),
      () => adapter.describeTask('task-1')
    ]) {
      await assert.rejects(async () => invoke(), error => {
        assert.match(error.message, /TCB_REGION 与固定地域不一致/u);
        assert.doesNotMatch(error.message, /drifted-region-sentinel/u);
        return true;
      });
    }
    assert.equal(remoteCalls, 0);
  } finally {
    if (original === undefined) delete process.env.TCB_REGION;
    else process.env.TCB_REGION = original;
  }
});
