import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const WEBSITE_E2E_ITEM_TIMEOUT_MS = 90_000;
export const WEBSITE_E2E_TOTAL_TIMEOUT_MS = 900_000;

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

export const WEBSITE_E2E_OUTPUT_ROOT = resolve(
  repositoryRoot,
  'tests/.playwright-output/website-process-isolation',
);

const TEST_DESCRIPTION = /^\S.+:\d+:\d+\s+›\s+.+$/u;
const TOTAL_LINE = /^Total:\s+(\d+)\s+tests?\s+in\s+\d+\s+files?$/u;
const PROCESS_EXIT_TIMEOUT_MS = 5_000;

export function parseWebsiteTestList(output) {
  const lines = output.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  const start = lines.indexOf('Listing tests:');
  if (start < 0) throw new Error('无法解析网站 E2E 清单：缺少 Listing tests 标题');

  const totalIndex = lines.findIndex((line, index) => index > start && TOTAL_LINE.test(line));
  if (totalIndex < 0) throw new Error('无法解析网站 E2E 清单：缺少 Total 汇总');

  const descriptions = lines.slice(start + 1, totalIndex);
  const malformed = descriptions.find(line => !TEST_DESCRIPTION.test(line));
  if (malformed) throw new Error(`无法解析网站 E2E 测试描述：${malformed}`);
  if (descriptions.length === 0) throw new Error('没有发现网站 E2E 测试');
  if (new Set(descriptions).size !== descriptions.length) throw new Error('网站 E2E 清单包含重复测试描述');

  const expectedCount = Number(TOTAL_LINE.exec(lines[totalIndex])?.[1]);
  if (expectedCount !== descriptions.length) {
    throw new Error(`网站 E2E 清单总数不一致：发现 ${descriptions.length}，汇总 ${expectedCount}`);
  }
  return Object.freeze([...descriptions]);
}

// 单项运行交由 Playwright 官方 test-list 精确选择，不转换标题为正则；独立产物目录避免进程间覆盖。
export function createWebsiteTestInvocation({ testListPath, outputDirectory }) {
  return Object.freeze({
    executable: process.execPath,
    args: Object.freeze([
      resolve(repositoryRoot, 'node_modules/@playwright/test/cli.js'),
      'test',
      '--config',
      'tests/playwright.website.config.ts',
      '--test-list',
      testListPath,
      '--output',
      outputDirectory,
    ]),
    env: Object.freeze({ ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }),
  });
}

// 普通失败仍保留后续测试的诊断价值；超时代表运行预算或进程状态已不可信，必须立即停止。
export async function runWebsiteTestSequence(input, dependencies) {
  const startedAt = input.startedAtMs ?? dependencies.now();
  const results = [];

  for (const [offset, description] of input.descriptions.entries()) {
    const elapsed = dependencies.now() - startedAt;
    const remaining = WEBSITE_E2E_TOTAL_TIMEOUT_MS - elapsed;
    if (remaining <= 0) break;

    const index = offset + 1;
    const outputDirectory = resolve(input.outputRoot, String(index).padStart(3, '0'));
    dependencies.writeProgress?.(`[${index}/${input.descriptions.length}] start: ${description}`);
    await dependencies.writeTestList(input.testListPath, `${description}\n`);
    const itemStartedAt = dependencies.now();
    const outcome = await dependencies.executeTest({
      index,
      description,
      outputDirectory,
      timeoutMs: Math.min(WEBSITE_E2E_ITEM_TIMEOUT_MS, remaining),
    });
    const status = outcome.timedOut ? 'interrupted' : outcome.exitCode === 0 ? 'passed' : 'failed';
    results.push(Object.freeze({
      index,
      description,
      outputDirectory,
      status,
      exitCode: outcome.exitCode,
      durationMs: dependencies.now() - itemStartedAt,
    }));
    dependencies.writeProgress?.(`[${index}/${input.descriptions.length}] ${status}: ${description}`);
    if (status === 'interrupted') break;
  }

  const passed = results.filter(result => result.status === 'passed').length;
  const failed = results.filter(result => result.status === 'failed').length;
  const interrupted = results.filter(result => result.status === 'interrupted').length;
  const notRun = input.descriptions.length - results.length;
  return Object.freeze({
    discovered: input.descriptions.length,
    passed,
    failed,
    interrupted,
    notRun,
    durationMs: dependencies.now() - startedAt,
    exitCode: passed === input.descriptions.length ? 0 : 1,
    results: Object.freeze(results),
  });
}

function hasProcessExited(child) {
  return child.exitCode != null || child.signalCode != null;
}

function waitForProcessExit(child, timeoutMessage, dependencies) {
  if (hasProcessExited(child)) {
    return Promise.resolve({ code: child.exitCode ?? null, signal: child.signalCode ?? null });
  }

  const setTimer = dependencies.setTimer ?? setTimeout;
  const clearTimer = dependencies.clearTimer ?? clearTimeout;
  return new Promise((resolvePromise, rejectPromise) => {
    let timer;
    const cleanup = () => {
      clearTimer(timer);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
    };
    const onExit = (code, signal) => {
      cleanup();
      resolvePromise({ code, signal });
    };
    const onError = error => {
      cleanup();
      rejectPromise(error);
    };

    child.once('exit', onExit);
    child.once('error', onError);
    timer = setTimer(() => {
      cleanup();
      rejectPromise(new Error(timeoutMessage));
    }, PROCESS_EXIT_TIMEOUT_MS);
  });
}

// 只终止调用方持有的 child：Windows 使用该 PID 的进程树，其他平台只向该对象发送 SIGTERM。
export async function terminateOwnedProcessTree(child, dependencies = {}) {
  if (!Number.isInteger(child.pid) || child.pid <= 0) {
    throw new Error('无法终止 owned child：缺少 PID');
  }

  const platform = dependencies.platform ?? process.platform;
  if (platform === 'win32') {
    const spawnProcess = dependencies.spawnProcess ?? spawn;
    let taskkill;
    try {
      taskkill = spawnProcess('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        shell: false,
      });
    } catch (error) {
      throw new Error(`taskkill 启动失败：${error.message}`, { cause: error });
    }

    let helperExit;
    try {
      helperExit = await waitForProcessExit(taskkill, 'taskkill 在 5 秒内未退出', dependencies);
    } catch (error) {
      if (error.message === 'taskkill 在 5 秒内未退出') throw error;
      throw new Error(`taskkill 启动失败：${error.message}`, { cause: error });
    }
    if (helperExit.code !== 0) {
      throw new Error(`taskkill 执行失败：退出码 ${helperExit.code ?? 'null'}${helperExit.signal ? `，信号 ${helperExit.signal}` : ''}`);
    }
  } else {
    let signalled;
    try {
      signalled = child.kill('SIGTERM');
    } catch (error) {
      throw new Error(`发送 SIGTERM 失败：${error.message}`, { cause: error });
    }
    if (!signalled && !hasProcessExited(child)) throw new Error('发送 SIGTERM 失败：原子进程拒绝终止信号');
  }

  await waitForProcessExit(child, '原子进程在 5 秒内未退出', dependencies);
}

export async function executeOwnedProcess(invocation, timeoutMs, dependencies = {}) {
  const spawnProcess = dependencies.spawnProcess ?? spawn;
  const terminate = dependencies.terminateOwnedProcessTree ?? terminateOwnedProcessTree;
  const setTimer = dependencies.setTimer ?? setTimeout;
  const clearTimer = dependencies.clearTimer ?? clearTimeout;
  const child = spawnProcess(invocation.executable, invocation.args, {
    cwd: repositoryRoot,
    env: invocation.env,
    stdio: 'inherit',
    shell: false,
  });

  // exit、error 与单项 timer 只允许一个分支收敛；收敛时统一清理监听器和 timer。
  const outcome = await new Promise((resolvePromise, rejectPromise) => {
    let timer;
    const cleanup = () => {
      clearTimer(timer);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
    };
    const settle = (callback, value) => {
      cleanup();
      callback(value);
    };
    const onExit = (code, signal) => {
      settle(resolvePromise, { exitCode: signal == null ? code : null, timedOut: false });
    };
    const onError = error => {
      settle(rejectPromise, error);
    };

    child.once('exit', onExit);
    child.once('error', onError);
    timer = setTimer(() => {
      settle(resolvePromise, { exitCode: null, timedOut: true });
    }, timeoutMs);
  });

  if (!outcome.timedOut) return outcome;
  await terminate(child);
  return outcome;
}
