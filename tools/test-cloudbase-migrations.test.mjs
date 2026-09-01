import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  createSessionLifecycle,
  parseMigrationGateArguments,
  parseSupportedPostgresVersion,
  runConcurrentOfficialDownloadMetricGate,
  runCloudBaseMigrationBehaviorGate
} from './test-cloudbase-migrations.mjs';

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function controlledSession(completion = Promise.resolve(), cancellations = []) {
  let cancelled = false;
  return {
    marker: Promise.resolve(),
    completion,
    release() {},
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      cancellations.push(true);
    }
  };
}

const nextTurn = () => new Promise(resolvePromise => setImmediate(resolvePromise));

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

test('官方安装包锁观察每轮刷新 PostgreSQL 统计快照', async () => {
  const source = await readFile(
    new URL('./test-cloudbase-migrations.mjs', import.meta.url),
    'utf8'
  );
  const start = source.indexOf('DO $official_download_metric_wait_gate$');
  const end = source.indexOf('$official_download_metric_wait_gate$;', start);
  const observationSql = source.slice(start, end);

  assert.match(
    observationSql,
    /LOOP\s+PERFORM pg_stat_clear_snapshot\(\);\s+IF EXISTS/u
  );
});

test('官方安装包并发门等待所有并发依赖后才校验最终计数', async () => {
  for (const pendingName of ['first', 'second', 'observation']) {
    const firstCompletion = deferred();
    const secondCompletion = deferred();
    const observation = deferred();
    const dependencies = {
      first: firstCompletion,
      second: secondCompletion,
      observation
    };
    const sessions = [
      controlledSession(firstCompletion.promise),
      controlledSession(secondCompletion.promise)
    ];
    let sessionIndex = 0;
    let finalCountChecked = false;
    const gate = runConcurrentOfficialDownloadMetricGate('psql', [], {
      runCommand: async (_executable, _arguments, input) => {
        if (input.includes('$concurrent_official_download_metric_gate$')) {
          finalCountChecked = true;
          return;
        }
        await observation.promise;
      },
      startInteractiveSession: () => controlledSession(),
      startSession: () => sessions[sessionIndex++]
    });

    for (const [name, dependency] of Object.entries(dependencies)) {
      if (name !== pendingName) dependency.resolve();
    }
    await nextTurn();
    assert.equal(finalCountChecked, false, `${pendingName} 尚未完成`);
    dependencies[pendingName].resolve();
    await gate;
    assert.equal(finalCountChecked, true);
  }
});

test('第二会话原始失败不会被延迟观察错误遮蔽', async () => {
  const observation = deferred();
  const barrier = controlledSession();
  const first = controlledSession();
  let sessionIndex = 0;
  const gate = runConcurrentOfficialDownloadMetricGate('psql', [], {
    runCommand: () => observation.promise,
    startInteractiveSession: () => barrier,
    startSession: () => {
      sessionIndex += 1;
      if (sessionIndex === 1) return first;
      return controlledSession(Promise.reject(new Error('SECOND_ORIGINAL')));
    }
  });

  const rejection = assert.rejects(gate, /SECOND_ORIGINAL/u);
  await nextTurn();
  observation.reject(new Error('OBSERVATION_MASK'));
  await rejection;
});

test('交互会话释放写入失败后仍可幂等取消子进程', () => {
  let killCount = 0;
  let writeCount = 0;
  const lifecycle = createSessionLifecycle({
    stdin: {
      end() {},
      write() {
        writeCount += 1;
        throw new Error('COMMIT 写入失败');
      }
    },
    kill: () => {
      killCount += 1;
    }
  });

  assert.throws(() => lifecycle.release(), /COMMIT 写入失败/u);
  assert.doesNotThrow(() => lifecycle.release());
  lifecycle.cancel();
  lifecycle.cancel();
  assert.equal(writeCount, 1);
  assert.equal(killCount, 1);
});

test('交互会话取消后释放不再写入 COMMIT', () => {
  let killCount = 0;
  let writeCount = 0;
  const lifecycle = createSessionLifecycle({
    stdin: {
      end() {},
      write() {
        writeCount += 1;
      }
    },
    kill: () => {
      killCount += 1;
    }
  });

  lifecycle.cancel();
  lifecycle.release();
  assert.equal(writeCount, 0);
  assert.equal(killCount, 1);
});

test('后续会话创建失败时回收此前已创建的全部会话', async () => {
  const barrierCancellations = [];
  const firstCancellations = [];
  const barrier = controlledSession(Promise.resolve(), barrierCancellations);
  const first = controlledSession(Promise.resolve(), firstCancellations);
  let sessionIndex = 0;

  await assert.rejects(
    runConcurrentOfficialDownloadMetricGate('psql', [], {
      startInteractiveSession: () => barrier,
      startSession: () => {
        sessionIndex += 1;
        if (sessionIndex === 1) return first;
        throw new Error('第二会话创建失败');
      }
    }),
    /第二会话创建失败/u
  );
  assert.equal(barrierCancellations.length, 1);
  assert.equal(firstCancellations.length, 1);
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
  assert.equal(result.migrationsApplied, 16);
  assert.equal(result.behaviorsVerified, 85);
});
