import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createWebChainSteps } from './web-chain-catalog.mjs';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

/**
 * 按声明顺序执行网站链，首个失败立即返回原退出码。
 * @param {'fast' | 'full'} profile 网站链档位。
 * @param {object} dependencies 可替换的进程与输出边界，仅用于测试失败路径。
 */
export function runWebChain(profile, {
  commandInterpreter = process.env.ComSpec ?? 'cmd.exe',
  platform = process.platform,
  spawnSyncImpl = spawnSync,
  writeError = line => process.stderr.write(line),
  writeOutput = line => process.stdout.write(line),
} = {}) {
  for (const step of createWebChainSteps(profile)) {
    writeOutput(`[web-chain] START ${step.id}\n`);
    // Windows 不能直接 CreateProcess 启动 .cmd；仍以固定参数数组交给系统命令解释器。
    const usesWindowsCommandShim = platform === 'win32' && step.command.toLowerCase().endsWith('.cmd');
    const command = usesWindowsCommandShim ? commandInterpreter : step.command;
    const args = usesWindowsCommandShim
      ? ['/d', '/s', '/c', step.command, ...step.args]
      : step.args;
    const result = spawnSyncImpl(command, args, {
      cwd: repositoryRoot,
      stdio: 'inherit',
      shell: false,
    });
    const exitCode = result.status ?? 1;

    if (result.error || exitCode !== 0) {
      writeError(`[web-chain] FAIL ${step.id} exit ${exitCode}\n`);
      return exitCode;
    }

    writeOutput(`[web-chain] PASS ${step.id}\n`);
  }

  return 0;
}

/** 解析受限 CLI 参数并返回可直接设置给 process.exitCode 的结果。 */
export function runWebChainCli(args, dependencies) {
  if (args.length !== 2 || args[0] !== '--profile' || !['fast', 'full'].includes(args[1])) {
    dependencies?.writeError?.('用法: node tools/verification/verify-web-chain.mjs --profile fast|full\n');
    return 2;
  }

  return runWebChain(args[1], dependencies);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runWebChainCli(process.argv.slice(2));
}
