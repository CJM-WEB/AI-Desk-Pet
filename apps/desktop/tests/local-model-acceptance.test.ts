import { fixture, type Step } from './fixtures/coding-task-http';
import { resolveCodingTaskResources } from '../src/main/agent/coding-task-resources';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, test, vi } from 'vitest';
import type { TaskEvent } from '@myself/shared-types';

import {
  buildAcceptanceBundle,
  createAcceptanceRecord,
  parseAcceptanceArguments
} from '../scripts/run-local-model-acceptance.mjs';
import {
  findFinalAssistantText,
  assertRejectionCompleted,
  classifyAcceptanceCleanup,
  isExpectedDeletionPermission,
  runAcceptanceLifecycle,
  runAcceptanceWithDeadline,
  submitAcceptanceTurn
} from '../scripts/local-model-acceptance-runner';
const execFileAsync = promisify(execFile);

describe('真实本地模型验收脚本', () => {
  test('范围接纳及时返回后仍等待真正最终正文及清理后终态', async () => {
    const events: TaskEvent[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let finished = false;
    const run = submitAcceptanceTurn({ events,
      submit: async () => { events.push(scopeEvent()); },
      resolveCapabilityAuthorization: async () => {
        void gate.then(() => {
          events.push({ type: 'message', role: 'assistant', text: '来自磁盘的最终正文' });
          events.push({ type: 'phase', phase: 'success' });
        });
      },
      assertNoSideEffect: async () => undefined
    }).then(result => { finished = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(finished).toBe(false);
    release();
    expect(findFinalAssistantText(await run)).toBe('来自磁盘的最终正文');
  });

  test('正式许可拒绝后继续等待整任务结束且未知许可不被自动批准', async () => {
    const events: TaskEvent[] = [];
    let decision: string | undefined;
    const result = await submitAcceptanceTurn({ events,
      submit: async () => { events.push(scopeEvent()); },
      resolveCapabilityAuthorization: async () => {
        events.push({ type: 'task_permission_required', actionId: 'perm-1', summary: '删除', request: { action: 'delete', resources: ['note.txt'] } });
      },
      assertNoSideEffect: async () => undefined,
      resolvePermission: async event => {
        decision = event.request.action;
        events.push({ type: 'message', role: 'assistant', text: '已拒绝删除' });
        events.push({ type: 'phase', phase: 'success' });
      }
    });
    expect(decision).toBe('delete');
    expect(findFinalAssistantText(result)).toBe('已拒绝删除');
    await expect(submitAcceptanceTurn({ events: [], submit: async () => undefined,
      resolveCapabilityAuthorization: async () => undefined, assertNoSideEffect: async () => undefined,
      timeoutMs: 30
    })).rejects.toThrow('TURN_TIMEOUT');
  });

  test('正式拒绝允许任务失败终态，取消或缺少终态仍不算拒绝完成', () => {
    expect(() => assertRejectionCompleted([{ type: 'phase', phase: 'error' }])).not.toThrow();
    expect(() => assertRejectionCompleted([{ type: 'phase', phase: 'cancelled' }])).toThrow('REJECTION_NOT_COMPLETED');
    expect(() => assertRejectionCompleted([])).toThrow('REJECTION_NOT_COMPLETED');
  });

  test('没有明确场景许可处理器时拒绝继续验收', async () => {
    const events: TaskEvent[] = [];
    await expect(submitAcceptanceTurn({ events,
      submit: async () => { events.push({ type: 'task_permission_required', actionId: 'p', summary: '删除', request: { action: 'delete', resources: ['note.txt'] } }); },
      resolveCapabilityAuthorization: async () => undefined, assertNoSideEffect: async () => undefined
    })).rejects.toThrow('UNEXPECTED_PERMISSION');
  });

  test('外层关闭后事件等待停止，不能在总期限结束后遗留轮询', async () => {
    const controller = new AbortController();
    const pending = submitAcceptanceTurn({ events: [], submit: async () => undefined,
      resolveCapabilityAuthorization: async () => undefined, assertNoSideEffect: async () => undefined,
      signal: controller.signal, timeoutMs: 40 });
    controller.abort();
    await expect(pending).rejects.toThrow('ACCEPTANCE_CLOSED');
  });

  test('删除拒绝场景识别当前单文件命令，拒绝额外目标和命令拼接', () => {
    const event = (command: string): Extract<TaskEvent, { type: 'task_permission_required' }> => ({ type: 'task_permission_required', actionId: 'p', summary: '命令', request: { action: 'bash', resources: ['hash'], cwd: 'C:/project', command } });
    expect(isExpectedDeletionPermission(event('Remove-Item -LiteralPath ./keep.txt -Force'), 'C:/project')).toBe(true);
    expect(isExpectedDeletionPermission(event('Remove-Item keep.txt; Remove-Item other.txt'), 'C:/project')).toBe(false);
    expect(isExpectedDeletionPermission(event('Remove-Item ../keep.txt'), 'C:/project')).toBe(false);
    expect(isExpectedDeletionPermission(event('Remove-Item keep.txt other.txt'), 'C:/project')).toBe(false);
  });

  test('聊天验收只接受 message 或 commit 的最终正文并忽略流式 delta', () => {
    expect(findFinalAssistantText([
      { type: 'message', role: 'assistant', text: '兼容正文' }
    ])).toBe('兼容正文');
    expect(findFinalAssistantText([
      { type: 'assistant_message_start', turnId: 'turn-1' },
      { type: 'assistant_message_delta', turnId: 'turn-1', delta: '流式片段' },
      { type: 'assistant_message_commit', turnId: 'turn-1', text: '流式最终正文' }
    ])).toBe('流式最终正文');
    expect(findFinalAssistantText([
      { type: 'assistant_message_delta', turnId: 'turn-2', delta: '不能作为最终正文' }
    ])).toBeUndefined();
    expect(findFinalAssistantText([
      { type: 'message', role: 'user', text: '用户正文' }
    ])).toBeUndefined();
  });

  test('只接受显式 CPU 或 Vulkan 后端', () => {
    expect(parseAcceptanceArguments(['--backend', 'cpu'])).toEqual({ model: 'qwen', backend: 'cpu' });
    expect(parseAcceptanceArguments(['--backend=vulkan'])).toEqual({ model: 'qwen', backend: 'vulkan' });
    expect(() => parseAcceptanceArguments([])).toThrow('ACCEPTANCE_BACKEND_REQUIRED');
    expect(() => parseAcceptanceArguments(['--backend', 'cuda'])).toThrow(
      'ACCEPTANCE_BACKEND_INVALID'
    );
  });

  test('单场景严格枚举且成功记录不能表示整套通过', () => {
    expect(parseAcceptanceArguments(['--backend', 'vulkan', '--scenario', 'reject'])).toEqual({ model: 'qwen', backend: 'vulkan', scenario: 'reject' });
    expect(() => parseAcceptanceArguments(['--backend', 'cpu', '--scenario', 'unknown'])).toThrow('ACCEPTANCE_SCENARIO_INVALID');
    expect(() => parseAcceptanceArguments(['--backend', 'cpu', '--scenario'])).toThrow('ACCEPTANCE_SCENARIO_INVALID');
    const record = createAcceptanceRecord({ selection: 'reject', phase: 'passed', scenarios: [] } as never);
    expect(record).toMatchObject({ selection: 'reject', phase: 'partial' });
  });

  test('公开记录严格重建有限场景结果，剥离嵌套正文与路径', () => {
    const record = createAcceptanceRecord({ model: 'deepseek', modelId: 'deepseek-v4-flash',
      requestedBackend: null, activeBackend: null, phase: 'failed', reasonCode: 'READ_FAILED',
      checks: { chineseChat: true, cloudCallsZero: false, cloudRouteRestored: false },
      scenarios: [{ name: 'read', phase: 'passed', reasonCode: null, operations: 2, exits: [],
        finalText: 'private', path: 'C:/private' }, { name: 'secret', phase: 'passed' }],
      cleanup: true, ignoredPrompt: 'private'
    } as never);
    expect(record.schemaVersion).toBe(2);
    expect(record.scenarios).toEqual([{ name: 'read', phase: 'passed', reasonCode: null, operations: 2, exits: [] }]);
    expect(JSON.stringify(record)).not.toContain('private');
    expect(JSON.stringify(record)).not.toContain('create_file');
    expect(() => parseAcceptanceArguments(['--model', 'deepseek'])).toThrow('ACCEPTANCE_PROFILE_REQUIRED');
    expect(parseAcceptanceArguments(['--model', 'deepseek', '--profile', 'deepseek-1', '--user-data', 'C:/profile'])).toEqual({ model: 'deepseek', profileId: 'deepseek-1', userData: 'C:/profile' });
  });

  test('CLI 失败只在 stdout 输出稳定白名单且 stderr 为空', async () => {
    let failure: unknown;
    try {
      await execFileAsync(process.execPath, [
        'scripts/run-local-model-acceptance.mjs',
        '--backend',
        'invalid'
      ], { cwd: import.meta.dirname.replace(/[\\/]tests$/u, '') });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 1, stderr: '' });
    const stdout = String((failure as { stdout?: string }).stdout).trim();
    expect(JSON.parse(stdout)).toEqual({
      schemaVersion: 2,
      phase: 'failed',
      reasonCode: 'ACCEPTANCE_BACKEND_INVALID'
    });
  });

  test('CLI 运行期失败也只输出稳定码且 stderr 为空', async () => {
    let failure: unknown;
    try {
      await execFileAsync(process.execPath, [
        'scripts/run-local-model-acceptance.mjs',
        '--backend',
        'cpu'
      ], {
        cwd: import.meta.dirname.replace(/[\\/]tests$/u, ''),
        env: { ...process.env, TEMP: import.meta.filename, TMP: import.meta.filename }
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 1, stderr: '' });
    expect(JSON.parse(String((failure as { stdout?: string }).stdout).trim())).toEqual({
      schemaVersion: 2,
      phase: 'failed',
      reasonCode: 'ACCEPTANCE_FAILED'
    });
  });

  test('CLI 超时只输出单行稳定 JSON 且 stderr 为空', async () => {
    let failure: unknown;
    try {
      await execFileAsync(process.execPath, [
        'scripts/run-local-model-acceptance.mjs',
        '--backend',
        'cpu'
      ], {
        cwd: import.meta.dirname.replace(/[\\/]tests$/u, ''),
        env: {
          ...process.env,
          NODE_ENV: 'test',
          AI_PET_LOCAL_MODEL_ACCEPTANCE_TIMEOUT_FIXTURE: '1',
          TEMP: import.meta.filename,
          TMP: import.meta.filename
        }
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 1, stderr: '' });
    const stdout = String((failure as { stdout?: string }).stdout).trim();
    expect(stdout.split(/\r?\n/u)).toHaveLength(1);
    expect(JSON.parse(stdout)).toEqual({
      schemaVersion: 2,
      phase: 'failed',
      reasonCode: 'ACCEPTANCE_TIMEOUT'
    });
  });

  test('正式 ESM 验收 bundle 能由 Node 导入而不会在动态 require 前崩溃', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-pet-acceptance-import-'));
    try {
      const file = join(root, 'runner.mjs');
      await buildAcceptanceBundle(resolve(import.meta.dirname, '../scripts'), file, 'qwen');
      const output = await execFileAsync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(pathToFileURL(file).href)}); console.log(typeof m.runLocalModelAcceptance);`]);
      expect(output.stdout.trim()).toBe('function');
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30000);

  test('独立函数调用、getter及微任务受VM期限限制，失败后生命周期仍清理', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-pet-acceptance-vm-'));
    try {
      const file = join(root, 'runner.mjs');
      await buildAcceptanceBundle(resolve(import.meta.dirname, '../scripts'), file, 'qwen');
      const script = `
        import { runInNewContext } from 'node:vm';
        const { verifyRepairedFunction, runAcceptanceLifecycle } = await import(${JSON.stringify(pathToFileURL(file).href)});
        const conditional = 'exports.add = (a,b) => { if ((a===2 && b===3) || (a===-1 && b===4)) return a+b; while(true){} };';
        runInNewContext(conditional + '; if(exports.add(2,3)!==5 || exports.add(-1,4)!==3) throw new Error("original");', {exports:{}}, {timeout:1000});
        console.log('ORIGINAL_INPUTS_PASSED');
        verifyRepairedFunction('exports.add = (a,b) => a+b');
        for (const source of [conditional, 'Object.defineProperty(exports,"add",{get(){while(true){}}})',
          'exports.add = (a,b) => { Promise.resolve().then(() => { while(true){} }); return a+b; };']) {
          let closed = false;
          let failure;
          try {
            await runAcceptanceLifecycle({ timeoutMs: 3000, cancelActive: () => {}, close: async () => { closed=true; },
              run: async () => verifyRepairedFunction(source) });
          } catch (error) { failure=error.code; }
          console.log(JSON.stringify({failure,closed}));
        }
      `;
      // 三个各1000ms的VM失败样例加真实bundle启动，共用有界外层防挂期限。
      const output = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], { timeout: 8000, windowsHide: true }).catch(error => {
        throw new Error(JSON.stringify({ killed: error.killed, originalInputsPassed: String(error.stdout).includes('ORIGINAL_INPUTS_PASSED'), completedCleanupCount: (String(error.stdout).match(/"closed":true/g) ?? []).length }));
      });
      expect(output.stdout.trim().split(/\r?\n/u)).toEqual(['ORIGINAL_INPUTS_PASSED',
        JSON.stringify({ failure: 'ERR_SCRIPT_EXECUTION_TIMEOUT', closed: true }),
        JSON.stringify({ failure: 'ERR_SCRIPT_EXECUTION_TIMEOUT', closed: true }),
        JSON.stringify({ failure: 'ERR_SCRIPT_EXECUTION_TIMEOUT', closed: true })]);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30000);

  test('真实 Core 连续搜索与删除许可拒绝后关闭正常结算', async () => {
    const steps: Step[] = [];
    for (let index = 0; index < 8; index++) steps.push(
      [{ name: 'glob', args: { pattern: '*.txt' } }],
      [{ name: 'bash', args: { command: 'Remove-Item keep.txt', workdir: '.' } }],
      [{ name: 'grep', args: { pattern: 'keep', path: '.' } }],
      [{ name: 'apply_patch', args: { patchText: '*** Begin Patch\n*** Delete File: keep.txt\n*** End Patch' } }]
    );
    steps.push('拒绝后结束');
    const resources = await resolveCodingTaskResources({ appPath: resolve(import.meta.dirname, '..'), isPackaged: false, resourcesPath: '' });
    const f = await fixture(steps, resources);
    const controller = new AbortController();
    let cursor = 0;
    let done = false;
    try {
      await writeFile(join(f.directory, 'keep.txt'), 'keep');
      const running = f.session.run('删除测试文件，遇到拒绝后停止。', controller.signal).finally(() => { done = true; });
      const deadline = Date.now() + 20000;
      while (!done && Date.now() < deadline) {
        while (cursor < f.events.length) {
          const event = f.events[cursor++]!;
          if (event.type === 'permission') await f.session.replyPermission(event.id, 'reject');
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      if (!done) controller.abort();
      await running;
      try { await f.session.close(); } catch (error) { throw new Error(classifyAcceptanceCleanup(error)); }
      expect(done).toBe(true);
      expect(controller.signal.aborted).toBe(false);
      expect(f.requests).toHaveLength(33);
    } finally { controller.abort(); await f.close().catch(error => { throw new Error(classifyAcceptanceCleanup(error)); }); }
  }, 30000);

  test('整体 deadline 会先取消会话并等待正式关闭后返回稳定超时码', async () => {
    vi.useFakeTimers();
    try {
      const cancelActive = vi.fn();
      const close = vi.fn(async () => undefined);
      const execution = runAcceptanceWithDeadline({
        run: () => new Promise<never>(() => undefined),
        cancelActive,
        close,
        timeoutMs: 20
      });
      const rejected = expect(execution).rejects.toThrow('ACCEPTANCE_TIMEOUT');

      await vi.advanceTimersByTimeAsync(20);

      await rejected;
      expect(cancelActive).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  test('整体 deadline 的正式关闭失败优先返回稳定清理错误', async () => {
    vi.useFakeTimers();
    try {
      const execution = runAcceptanceWithDeadline({
        run: () => new Promise<never>(() => undefined),
        cancelActive: () => undefined,
        close: async () => { throw new Error('private cleanup detail'); },
        timeoutMs: 20
      });
      const rejected = expect(execution).rejects.toThrow('PROCESS_CLEANUP_FAILED');

      await vi.advanceTimersByTimeAsync(20);

      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  test('整体 deadline 不会因正式关闭永久挂起而无限等待', async () => {
    vi.useFakeTimers();
    try {
      const execution = runAcceptanceWithDeadline({
        run: () => new Promise<never>(() => undefined),
        cancelActive: () => undefined,
        close: () => new Promise<never>(() => undefined),
        timeoutMs: 20,
        closeTimeoutMs: 30
      });
      const rejected = expect(execution).rejects.toThrow('PROCESS_CLEANUP_FAILED');

      await vi.advanceTimersByTimeAsync(50);

      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  test('完整验收生命周期在超时清理悬空后不会于 finally 二次等待', async () => {
    vi.useFakeTimers();
    try {
      const close = vi.fn(() => new Promise<never>(() => undefined));
      const execution = runAcceptanceLifecycle({
        run: () => new Promise<never>(() => undefined),
        cancelActive: () => undefined,
        close,
        timeoutMs: 20,
        closeTimeoutMs: 30
      });
      const rejected = expect(execution).rejects.toThrow('PROCESS_CLEANUP_FAILED');

      await vi.advanceTimersByTimeAsync(50);

      await rejected;
      expect(close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  test('完整验收生命周期在运行先完成但关闭悬空时仍有界失败', async () => {
    vi.useFakeTimers();
    try {
      const execution = runAcceptanceLifecycle({
        run: async () => 'passed',
        cancelActive: () => undefined,
        close: () => new Promise<never>(() => undefined),
        timeoutMs: 100,
        closeTimeoutMs: 30
      });
      const rejected = expect(execution).rejects.toThrow('PROCESS_CLEANUP_FAILED');

      await vi.advanceTimersByTimeAsync(30);

      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });
});

function scopeEvent(): Extract<TaskEvent, { type: 'capability_authorization_required' }> {
  return { type: 'capability_authorization_required', directory: 'D:/authorized', modelId: 'test', actions: ['read', 'create', 'edit'], approvedCommands: [], requestId: 'scope', capability: 'file', requestSummary: '读取', targetProviderName: '模型', expiresAt: new Date(Date.now() + 60000).toISOString() };
}
