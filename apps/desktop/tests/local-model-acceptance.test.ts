import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { describe, expect, test, vi } from 'vitest';

import {
  createAcceptanceRecord,
  parseAcceptanceArguments
} from '../scripts/run-local-model-acceptance.mjs';
import {
  findFinalAssistantText,
  runAcceptanceLifecycle,
  runAcceptanceWithDeadline
} from '../scripts/local-model-acceptance-runner';
const execFileAsync = promisify(execFile);

describe('真实本地模型验收脚本', () => {
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
    expect(parseAcceptanceArguments(['--backend', 'cpu'])).toEqual({ backend: 'cpu' });
    expect(parseAcceptanceArguments(['--backend=vulkan'])).toEqual({ backend: 'vulkan' });
    expect(() => parseAcceptanceArguments([])).toThrow('ACCEPTANCE_BACKEND_REQUIRED');
    expect(() => parseAcceptanceArguments(['--backend', 'cuda'])).toThrow(
      'ACCEPTANCE_BACKEND_INVALID'
    );
  });

  test('公开记录只保留固定白名单，不接受路径、正文或原始日志', () => {
    const record = createAcceptanceRecord({
      requestedBackend: 'vulkan',
      activeBackend: 'vulkan',
      phase: 'passed',
      reasonCode: null,
      checks: {
        chineseChat: true,
        reasoningDisabled: true,
        toolCall: true,
        confirmation: true,
        fileSideEffect: true,
        toolResultSummary: true,
        cancelRecovery: true,
        cloudCallsZero: true,
        cloudRouteRestored: true,
        createOperation: true,
        moveOperation: true,
        deleteOperation: true,
        chineseRelativePath: true,
        clarification: true,
        userRejected: true,
        toolFailureRecovery: true
      },
      ignoredAbsolutePath: 'C:\\private\\secret.txt',
      ignoredPrompt: '不要进入公开记录',
      ignoredRawLog: 'llama-server stderr'
    });

    expect(record).toEqual({
      schemaVersion: 1,
      requestedBackend: 'vulkan',
      activeBackend: 'vulkan',
      phase: 'passed',
      reasonCode: null,
      toolName: 'create_file',
      checks: {
        chineseChat: true,
        reasoningDisabled: true,
        toolCall: true,
        confirmation: true,
        fileSideEffect: true,
        toolResultSummary: true,
        cancelRecovery: true,
        cloudCallsZero: true,
        cloudRouteRestored: true,
        createOperation: true,
        moveOperation: true,
        deleteOperation: true,
        chineseRelativePath: true,
        clarification: true,
        userRejected: true,
        toolFailureRecovery: true
      }
    });
    expect(JSON.stringify(record)).not.toContain('private');
    expect(JSON.stringify(record)).not.toContain('不要进入公开记录');
    expect(JSON.stringify(record)).not.toContain('stderr');
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
      schemaVersion: 1,
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
      schemaVersion: 1,
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
      schemaVersion: 1,
      phase: 'failed',
      reasonCode: 'ACCEPTANCE_TIMEOUT'
    });
  });

  test('runner 只组合生产 Runtime、Service 与 Main 会话链，不保留第二套进程实现', async () => {
    const source = await readFile(new URL('../scripts/local-model-acceptance-runner.ts', import.meta.url), 'utf8');

    expect(source).toContain('new LocalModelRuntime(');
    expect(source).toContain('new LocalModelService(');
    expect(source).toContain('new ProviderRegistry(');
    expect(source).toContain('createMainConversationComposition(');
    expect(source).toContain('coordinator.resolveFileAction(');
    expect(source).not.toContain("from 'node:child_process'");
    expect(source).not.toContain("from 'node:net'");
    expect(source).not.toContain('processPort:');
    expect(source).not.toContain('startRequestedBackend');
    expect(source).not.toContain('cleanupAcceptanceProcess');
  });

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
