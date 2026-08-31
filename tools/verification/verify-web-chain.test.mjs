import assert from 'node:assert/strict';
import test from 'node:test';

import { createWebChainSteps } from './web-chain-catalog.mjs';
import { runWebChainCli } from './verify-web-chain.mjs';

test('快速与完整 profile 只按批准顺序执行网站链目标', () => {
  const fastIds = createWebChainSteps('fast').map(step => step.id);
  assert.deepEqual(fastIds, [
    'scope', 'ownership', 'verification-tests', 'shared-types-typecheck',
    'shared-types-test', 'website-typecheck', 'website-test',
    'cloudbase-typecheck', 'cloudbase-test', 'scanner-typecheck',
    'scanner-test', 'release-typecheck', 'release-test',
    'migration-tool-test', 'dependency-audit',
  ]);

  const fullIds = createWebChainSteps('full').map(step => step.id);
  assert.deepEqual(fullIds.slice(0, fastIds.length), fastIds);
  assert.deepEqual(fullIds.slice(fastIds.length), [
    'cloudbase-build', 'cloudbase-build-output-test',
    'cloudbase-build-tool-test', 'scanner-candidate', 'website-e2e',
  ]);
  assert.doesNotMatch(
    JSON.stringify(createWebChainSteps('full')),
    /desktop|agent-core|file-tools|character-runtime|character-assets/u,
  );
});

test('命令目录使用参数数组并隔离 CloudBase 快速测试与构建产物测试', () => {
  const fullSteps = createWebChainSteps('full');
  const commands = Object.fromEntries(fullSteps.map(step => [step.id, step]));

  assert.deepEqual(commands['cloudbase-test'], {
    id: 'cloudbase-test',
    command: 'pnpm.cmd',
    args: [
      '--filter', '@myself/cloudbase-api', 'exec', 'vitest', 'run',
      '--config', 'vitest.config.ts', '--exclude', 'tests/build-output.test.ts',
    ],
  });
  assert.deepEqual(commands['cloudbase-build-output-test'], {
    id: 'cloudbase-build-output-test',
    command: 'pnpm.cmd',
    args: [
      '--filter', '@myself/cloudbase-api', 'exec', 'vitest', 'run',
      '--config', 'vitest.config.ts', 'tests/build-output.test.ts',
    ],
  });
  assert.equal(commands['verification-tests'].command, process.execPath);
  assert.equal(commands['verification-tests'].args[0], '--test');
  assert.ok(commands['verification-tests'].args.length > 1);
  assert.deepEqual(
    commands['verification-tests'].args.slice(1),
    [...commands['verification-tests'].args.slice(1)].sort(),
  );
  assert.doesNotMatch(commands['verification-tests'].args.join(' '), /\*/u);
});

test('首个失败保留退出码并阻止后续命令执行', () => {
  const calls = [];
  const stdout = [];
  const stderr = [];
  const spawnSyncImpl = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: calls.length === 2 ? 17 : 0 };
  };

  const exitCode = runWebChainCli(['--profile', 'fast'], {
    spawnSyncImpl,
    writeError: line => stderr.push(line),
    writeOutput: line => stdout.push(line),
  });

  assert.equal(exitCode, 17);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.shell, false);
  assert.match(stdout.join(''), /\[web-chain\] START scope/u);
  assert.match(stdout.join(''), /\[web-chain\] PASS scope/u);
  assert.match(stderr.join(''), /\[web-chain\] FAIL ownership .*17/u);
  assert.doesNotMatch(stdout.join(''), /verification-tests/u);
});

test('Windows 通过命令解释器参数数组启动 pnpm.cmd', () => {
  const calls = [];
  const commandInterpreter = 'C:\\Windows\\System32\\cmd.exe';
  const exitCode = runWebChainCli(['--profile', 'fast'], {
    commandInterpreter,
    platform: 'win32',
    spawnSyncImpl: (command, args) => {
      calls.push({ command, args });
      return { status: calls.length === 4 ? 17 : 0 };
    },
    writeError: () => {},
    writeOutput: () => {},
  });

  assert.equal(exitCode, 17);
  assert.deepEqual(calls[3], {
    command: commandInterpreter,
    args: [
      '/d', '/s', '/c', 'pnpm.cmd',
      '--filter', '@myself/shared-types', 'typecheck',
    ],
  });
});

test('非法 CLI 参数返回 2、输出用法并且不启动子进程', () => {
  const invalidArgs = [
    [],
    ['--profile', 'unknown'],
    ['--profile', 'fast', 'extra'],
  ];

  for (const args of invalidArgs) {
    let spawnCalls = 0;
    const stderr = [];
    const exitCode = runWebChainCli(args, {
      spawnSyncImpl: () => {
        spawnCalls += 1;
        return { status: 0 };
      },
      writeError: line => stderr.push(line),
      writeOutput: () => {},
    });

    assert.equal(exitCode, 2);
    assert.equal(spawnCalls, 0);
    assert.match(
      stderr.join(''),
      /用法: node tools\/verification\/verify-web-chain\.mjs --profile fast\|full/u,
    );
  }
});
