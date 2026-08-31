import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createCloudBaseUserMigrationInputs,
  runCloudBaseUserMigrations
} from './cloudbase-user-migrations.mjs';

function migration(overrides = {}) {
  return {
    version: '20260831000000',
    name: 'restore_scanned_submission_flow',
    fileName: '20260831000000_restore_scanned_submission_flow.sql',
    sha256: 'a'.repeat(64),
    bytes: 10,
    content: Buffer.from('SELECT 1;\n'),
    ...overrides
  };
}

test('将 inventory 原始字节映射为 manager SDK 输入且不重复排序', () => {
  const migrations = [
    migration({ version: '20260831000001', name: 'second', content: Buffer.from('SELECT 2;') }),
    migration({ version: '20260831000000', name: 'first', content: Buffer.from('SELECT 1;') })
  ];

  assert.deepEqual(createCloudBaseUserMigrationInputs(migrations), [
    { Version: '20260831000001', Name: 'second', Query: 'SELECT 2;' },
    { Version: '20260831000000', Name: 'first', Query: 'SELECT 1;' }
  ]);
});

test('development 环境门在任何适配器调用前失败关闭', async () => {
  let calls = 0;
  const adapter = { preview: async () => { calls += 1; } };

  for (const environmentClass of [undefined, '', 'production', 'staging', 'Development']) {
    await assert.rejects(
      runCloudBaseUserMigrations({ environmentClass, migrations: [migration()], adapter }),
      /只允许显式 development 环境/u
    );
  }
  assert.equal(calls, 0);
});

test('预览有冲突或不可执行时不推送', async () => {
  for (const preview of [
    { Pending: [], Conflicts: [{ Version: '20260831000000' }], Executable: true },
    { Pending: [migration()], Conflicts: [], Executable: false }
  ]) {
    let pushed = false;
    await assert.rejects(
      runCloudBaseUserMigrations({
        environmentClass: 'development',
        migrations: [migration()],
        adapter: {
          preview: async () => preview,
          push: async () => { pushed = true; }
        }
      }),
      /迁移预览不可执行/u
    );
    assert.equal(pushed, false);
  }
});

test('没有 pending 时幂等成功且不推送', async () => {
  let pushed = false;
  const result = await runCloudBaseUserMigrations({
    environmentClass: 'development',
    migrations: [migration()],
    adapter: {
      preview: async () => ({ Pending: null, Conflicts: null, Executable: true }),
      push: async () => { pushed = true; }
    }
  });

  assert.deepEqual(result, { outcome: 'up-to-date' });
  assert.equal(pushed, false);
});

test('推送后轮询 Accepted 与 Running，Succeed 后完成', async () => {
  const statuses = ['Accepted', 'Running', 'Succeed'];
  let waitCount = 0;
  const result = await runCloudBaseUserMigrations({
    environmentClass: 'development',
    migrations: [migration()],
    adapter: {
      preview: async () => ({ Pending: [{ Version: '20260831000000' }], Conflicts: [], Executable: true }),
      push: async inputs => {
        assert.equal(inputs[0].Query, 'SELECT 1;\n');
        return { TaskId: 'task-1' };
      },
      describeTask: async taskId => ({ TaskId: taskId, Status: statuses.shift() })
    },
    wait: async () => { waitCount += 1; }
  });

  assert.deepEqual(result, { outcome: 'applied', taskId: 'task-1' });
  assert.equal(waitCount, 2);
});

test('Failed、未知状态与轮询超时都失败关闭', async () => {
  for (const scenario of [
    { status: 'Failed', pattern: /迁移任务失败/u },
    { status: 'Unknown', pattern: /未知迁移任务状态/u },
    { status: 'Running', maxPollAttempts: 2, pattern: /迁移任务轮询超时/u }
  ]) {
    await assert.rejects(
      runCloudBaseUserMigrations({
        environmentClass: 'development',
        migrations: [migration()],
        adapter: {
          preview: async () => ({ Pending: [{}], Conflicts: [], Executable: true }),
          push: async () => ({ TaskId: 'task-1' }),
          describeTask: async () => ({ Status: scenario.status })
        },
        maxPollAttempts: scenario.maxPollAttempts,
        wait: async () => {}
      }),
      scenario.pattern
    );
  }
});

test('每次调用都重新预览以支持安全续跑', async () => {
  let previewCalls = 0;
  let pushCalls = 0;
  const adapter = {
    preview: async () => {
      previewCalls += 1;
      return previewCalls === 1
        ? { Pending: [{}], Conflicts: [], Executable: true }
        : { Pending: [], Conflicts: [], Executable: true };
    },
    push: async () => { pushCalls += 1; return { TaskId: 'task-1' }; },
    describeTask: async () => ({ Status: 'Succeed' })
  };

  await runCloudBaseUserMigrations({ environmentClass: 'development', migrations: [migration()], adapter });
  await runCloudBaseUserMigrations({ environmentClass: 'development', migrations: [migration()], adapter });
  assert.equal(previewCalls, 2);
  assert.equal(pushCalls, 1);
});
