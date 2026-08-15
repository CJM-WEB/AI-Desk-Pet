import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import * as runner from './run-website-e2e-process-isolation.mjs';

const listedTests = `Listing tests:
  website.spec.ts:927:1 › 安全共享包经系统与管理员审核后才在真实网页公开
  website.spec.ts:1094:1 › 介绍章节桌面悬停与键盘聚焦同步玻璃交互
Total: 2 tests in 1 file\n`;

test('解析 Playwright 标准清单并保留完整中文测试描述', () => {
  assert.deepEqual(runner.parseWebsiteTestList(listedTests), [
    'website.spec.ts:927:1 › 安全共享包经系统与管理员审核后才在真实网页公开',
    'website.spec.ts:1094:1 › 介绍章节桌面悬停与键盘聚焦同步玻璃交互',
  ]);
});

test('拒绝空清单、重复描述、畸形行和总数不一致', () => {
  assert.throws(() => runner.parseWebsiteTestList('Listing tests:\nTotal: 0 tests in 0 files\n'), /没有发现网站 E2E/u);
  assert.throws(() => runner.parseWebsiteTestList(`Listing tests:\n  website.spec.ts:1:1 › A\n  website.spec.ts:1:1 › A\nTotal: 2 tests in 1 file\n`), /重复/u);
  assert.throws(() => runner.parseWebsiteTestList(`Listing tests:\n  不是标准测试描述\nTotal: 1 test in 1 file\n`), /无法解析/u);
  assert.throws(() => runner.parseWebsiteTestList(`Listing tests:\n  website.spec.ts:1:1 › A\nTotal: 2 tests in 1 file\n`), /总数/u);
});

test('单项命令只使用网站配置、test-list 和独立输出目录', () => {
  const invocation = runner.createWebsiteTestInvocation({
    testListPath: 'C:\\Temp\\website-e2e\\current.txt',
    outputDirectory: 'C:\\repo\\tests\\.playwright-output\\website-process-isolation\\001',
  });

  assert.equal(invocation.executable, process.execPath);
  assert.deepEqual(invocation.args.slice(1), [
    'test',
    '--config',
    'tests/playwright.website.config.ts',
    '--test-list',
    'C:\\Temp\\website-e2e\\current.txt',
    '--output',
    'C:\\repo\\tests\\.playwright-output\\website-process-isolation\\001',
  ]);
  assert.equal(invocation.args[0].endsWith('node_modules\\@playwright\\test\\cli.js') || invocation.args[0].endsWith('node_modules/@playwright/test/cli.js'), true);
  assert.equal(invocation.args.includes('--grep'), false);
  assert.equal(invocation.args.includes('--shard'), false);
  assert.equal(invocation.args.includes('--pass-with-no-tests'), false);
  assert.equal(invocation.env.NO_COLOR, '1');
  assert.equal(invocation.env.FORCE_COLOR, '0');
  assert.equal(runner.WEBSITE_E2E_ITEM_TIMEOUT_MS, 90_000);
  assert.equal(runner.WEBSITE_E2E_TOTAL_TIMEOUT_MS, 900_000);
});

test('逐项串行执行且普通失败后继续并返回完整汇总', async () => {
  const events = [];
  let active = 0;
  const descriptions = [
    'website.spec.ts:1:1 › A',
    'website.spec.ts:2:1 › B',
    'website.spec.ts:3:1 › C',
  ];

  const summary = await runner.runWebsiteTestSequence({
    descriptions,
    testListPath: 'C:\\Temp\\current.txt',
    outputRoot: 'C:\\output',
  }, {
    now: (() => { let value = 0; return () => (value += 10); })(),
    writeTestList: async (_path, description) => events.push(['write', description]),
    writeProgress: line => events.push(['progress', line]),
    executeTest: async ({ description, timeoutMs }) => {
      active += 1;
      assert.equal(active, 1);
      events.push(['start', description, timeoutMs]);
      active -= 1;
      return { exitCode: description.endsWith('B') ? 1 : 0, timedOut: false };
    },
  });

  assert.deepEqual(summary, {
    discovered: 3,
    passed: 2,
    failed: 1,
    interrupted: 0,
    notRun: 0,
    durationMs: 100,
    exitCode: 1,
    results: [
      { index: 1, description: descriptions[0], outputDirectory: 'C:\\output\\001', status: 'passed', exitCode: 0, durationMs: 10 },
      { index: 2, description: descriptions[1], outputDirectory: 'C:\\output\\002', status: 'failed', exitCode: 1, durationMs: 10 },
      { index: 3, description: descriptions[2], outputDirectory: 'C:\\output\\003', status: 'passed', exitCode: 0, durationMs: 10 },
    ],
  });
  assert.deepEqual(events.map(event => event.slice(0, 2)), [
    ['progress', `[1/3] start: ${descriptions[0]}`], ['write', `${descriptions[0]}\n`], ['start', descriptions[0]],
    ['progress', `[1/3] passed: ${descriptions[0]}`],
    ['progress', `[2/3] start: ${descriptions[1]}`], ['write', `${descriptions[1]}\n`], ['start', descriptions[1]],
    ['progress', `[2/3] failed: ${descriptions[1]}`],
    ['progress', `[3/3] start: ${descriptions[2]}`], ['write', `${descriptions[2]}\n`], ['start', descriptions[2]],
    ['progress', `[3/3] passed: ${descriptions[2]}`],
  ]);
});

test('单项超时后停止且把剩余项记为 not run', async () => {
  const descriptions = ['website.spec.ts:1:1 › A', 'website.spec.ts:2:1 › B'];
  const summary = await runner.runWebsiteTestSequence({
    descriptions,
    testListPath: 'C:\\Temp\\current.txt',
    outputRoot: 'C:\\output',
  }, {
    now: () => 0,
    writeTestList: async () => {},
    executeTest: async ({ timeoutMs }) => {
      assert.equal(timeoutMs, 90_000);
      return { exitCode: null, timedOut: true };
    },
  });
  assert.equal(summary.interrupted, 1);
  assert.equal(summary.notRun, 1);
  assert.equal(summary.results.length, 1);
  assert.equal(summary.exitCode, 1);
});

test('全局剩余预算限制当前项并在耗尽后停止', async () => {
  const times = [0, 899_950, 899_960, 900_000];
  const observedTimeouts = [];
  const summary = await runner.runWebsiteTestSequence({
    descriptions: ['website.spec.ts:1:1 › A', 'website.spec.ts:2:1 › B'],
    testListPath: 'C:\\Temp\\current.txt',
    outputRoot: 'C:\\output',
  }, {
    now: () => times.shift() ?? 900_000,
    writeTestList: async () => {},
    executeTest: async ({ timeoutMs }) => {
      observedTimeouts.push(timeoutMs);
      return { exitCode: null, timedOut: true };
    },
  });
  assert.deepEqual(observedTimeouts, [50]);
  assert.equal(summary.interrupted, 1);
  assert.equal(summary.notRun, 1);
});

function createFakeChild(pid = 1234) {
  return Object.assign(new EventEmitter(), {
    pid,
    exitCode: null,
    signalCode: null,
  });
}

test('owned child 正常退出时返回真实退出码且不触发终止', async () => {
  const child = createFakeChild();
  const invocation = {
    executable: 'node.exe',
    args: ['test-script.mjs'],
    env: { TEST_ENV: '1' },
  };
  const result = await runner.executeOwnedProcess(invocation, 1_000, {
    spawnProcess: (executable, args, options) => {
      assert.equal(executable, invocation.executable);
      assert.deepEqual(args, invocation.args);
      assert.equal(options.env, invocation.env);
      assert.equal(options.stdio, 'inherit');
      assert.equal(options.shell, false);
      queueMicrotask(() => {
        child.exitCode = 7;
        child.emit('exit', 7, null);
      });
      return child;
    },
    terminateOwnedProcessTree: async () => assert.fail('正常退出不得调用终止器'),
  });

  assert.deepEqual(result, { exitCode: 7, timedOut: false });
  assert.equal(child.listenerCount('exit'), 0);
  assert.equal(child.listenerCount('error'), 0);
});

test('owned child 超时时把同一对象交给终止器并等待清理完成', async () => {
  const child = createFakeChild();
  let releaseTermination;
  let notifyTerminationStarted;
  const terminationGate = new Promise(resolve => { releaseTermination = resolve; });
  const terminationStarted = new Promise(resolve => { notifyTerminationStarted = resolve; });
  let settled = false;

  const execution = runner.executeOwnedProcess({ executable: 'node.exe', args: [], env: {} }, 50, {
    spawnProcess: () => child,
    setTimer: callback => {
      queueMicrotask(callback);
      return 1;
    },
    clearTimer: () => {},
    terminateOwnedProcessTree: async receivedChild => {
      assert.equal(receivedChild, child);
      notifyTerminationStarted();
      await terminationGate;
    },
  }).then(result => {
    settled = true;
    return result;
  });

  await terminationStarted;
  assert.equal(settled, false);
  releaseTermination();
  assert.deepEqual(await execution, { exitCode: null, timedOut: true });
  assert.equal(child.listenerCount('exit'), 0);
  assert.equal(child.listenerCount('error'), 0);
});

test('超时收敛后 child 若已自然退出则不得启动 taskkill', async () => {
  const child = createFakeChild(4321);
  let taskkillStarted = false;

  const result = await runner.executeOwnedProcess({ executable: 'node.exe', args: [], env: {} }, 50, {
    spawnProcess: () => child,
    setTimer: callback => {
      queueMicrotask(callback);
      return 1;
    },
    clearTimer: () => {},
    terminateOwnedProcessTree: async receivedChild => {
      receivedChild.exitCode = 0;
      await runner.terminateOwnedProcessTree(receivedChild, {
        platform: 'win32',
        spawnProcess: () => {
          taskkillStarted = true;
          return createFakeChild();
        },
      });
    },
  });

  assert.deepEqual(result, { exitCode: null, timedOut: true });
  assert.equal(taskkillStarted, false);
});

test('owned child 启动错误作为明确失败抛出且不触发终止', async () => {
  const child = createFakeChild();
  await assert.rejects(runner.executeOwnedProcess({ executable: 'missing.exe', args: [], env: {} }, 1_000, {
    spawnProcess: () => {
      queueMicrotask(() => child.emit('error', new Error('spawn boom')));
      return child;
    },
    terminateOwnedProcessTree: async () => assert.fail('启动错误不得调用终止器'),
  }), /spawn boom/u);
  assert.equal(child.listenerCount('exit'), 0);
  assert.equal(child.listenerCount('error'), 0);
});

test('缺少 owned child PID 时拒绝清理且不启动 taskkill', async () => {
  const child = createFakeChild();
  delete child.pid;
  let spawnCalled = false;

  await assert.rejects(runner.terminateOwnedProcessTree(child, {
    platform: 'win32',
    spawnProcess: () => {
      spawnCalled = true;
      return createFakeChild();
    },
  }), /缺少 PID/u);
  assert.equal(spawnCalled, false);
});

test('Windows 只按 owned child PID 调用 taskkill 并等待原 child 退出', async () => {
  const child = createFakeChild(4321);
  const taskkill = createFakeChild(9876);
  let settled = false;

  const termination = runner.terminateOwnedProcessTree(child, {
    platform: 'win32',
    spawnProcess: (executable, args, options) => {
      assert.equal(executable, 'taskkill.exe');
      assert.deepEqual(args, ['/PID', '4321', '/T', '/F']);
      assert.deepEqual(options, { stdio: 'ignore', shell: false });
      queueMicrotask(() => {
        taskkill.exitCode = 0;
        taskkill.emit('exit', 0, null);
      });
      return taskkill;
    },
  }).then(() => { settled = true; });

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  child.signalCode = 'SIGTERM';
  child.emit('exit', null, 'SIGTERM');
  await termination;
  assert.equal(child.listenerCount('exit'), 0);
  assert.equal(taskkill.listenerCount('exit'), 0);
  assert.equal(taskkill.listenerCount('error'), 0);
});

test('原 child 已退出时直接收敛且不启动 taskkill', async () => {
  const child = createFakeChild(4321);
  child.exitCode = 0;
  let taskkillStarted = false;

  await runner.terminateOwnedProcessTree(child, {
    platform: 'win32',
    spawnProcess: () => {
      taskkillStarted = true;
      return createFakeChild();
    },
  });
  assert.equal(taskkillStarted, false);
  assert.equal(child.listenerCount('exit'), 0);
});

test('taskkill 非零退出与启动错误均返回明确中文错误', async t => {
  await t.test('非零退出', async () => {
    const taskkill = createFakeChild();
    await assert.rejects(runner.terminateOwnedProcessTree(createFakeChild(), {
      platform: 'win32',
      spawnProcess: () => {
        queueMicrotask(() => taskkill.emit('exit', 5, null));
        return taskkill;
      },
    }), /taskkill.*退出码 5/u);
  });

  await t.test('启动错误', async () => {
    const taskkill = createFakeChild();
    await assert.rejects(runner.terminateOwnedProcessTree(createFakeChild(), {
      platform: 'win32',
      spawnProcess: () => {
        queueMicrotask(() => taskkill.emit('error', new Error('access denied')));
        return taskkill;
      },
    }), /taskkill.*启动失败.*access denied/u);
  });
});

test('taskkill 或原 child 在 5 秒内不退出时返回明确中文错误', async t => {
  const immediateTimer = callback => {
    queueMicrotask(callback);
    return 1;
  };

  await t.test('taskkill 不退出', async () => {
    const child = createFakeChild(4321);
    const taskkill = createFakeChild(9876);
    let helperKillSignal = null;
    let helperUnrefCalled = false;
    taskkill.kill = signal => {
      helperKillSignal = signal;
      queueMicrotask(() => {
        taskkill.signalCode = signal;
        taskkill.emit('exit', null, signal);
      });
      return true;
    };
    taskkill.unref = () => { helperUnrefCalled = true; };

    await assert.rejects(runner.terminateOwnedProcessTree(child, {
      platform: 'win32',
      spawnProcess: () => taskkill,
      setTimer: immediateTimer,
      clearTimer: () => {},
    }), /taskkill.*5 秒.*原子进程.*5 秒/u);
    assert.equal(helperKillSignal, 'SIGTERM');
    assert.equal(helperUnrefCalled, true);
    assert.equal(taskkill.signalCode, 'SIGTERM');
    assert.equal(taskkill.listenerCount('exit'), 0);
    assert.equal(taskkill.listenerCount('error'), 0);
    assert.equal(child.listenerCount('exit'), 0);
    assert.equal(child.listenerCount('error'), 0);
  });

  await t.test('原 child 不退出', async () => {
    const taskkill = createFakeChild();
    await assert.rejects(runner.terminateOwnedProcessTree(createFakeChild(), {
      platform: 'win32',
      spawnProcess: () => {
        queueMicrotask(() => taskkill.emit('exit', 0, null));
        return taskkill;
      },
      setTimer: immediateTimer,
      clearTimer: () => {},
    }), /原子进程.*5 秒/u);
  });
});

test('非 Windows 只向 owned child 发送 SIGTERM 并等待退出', async () => {
  const child = createFakeChild();
  child.kill = signal => {
    assert.equal(signal, 'SIGTERM');
    queueMicrotask(() => {
      child.signalCode = signal;
      child.emit('exit', null, signal);
    });
    return true;
  };

  await runner.terminateOwnedProcessTree(child, {
    platform: 'linux',
    spawnProcess: () => assert.fail('非 Windows 不得启动清理命令'),
  });
});
