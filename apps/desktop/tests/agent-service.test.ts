import { describe, expect, test, vi } from 'vitest';
import { AgentLoop } from '@myself/agent-core';
import type {
  ModelProvider,
  ModelRequest,
  ModelResponse
} from '@myself/agent-core';
import { FileToolError, type VerifiedWriteAction } from '@myself/file-tools';
import type { TaskEvent } from '@myself/shared-types';
import {
  AgentService,
  type AgentFileTools,
  type AgentSession
} from '../src/main/agent/agent-service';
import { PermissionPolicy } from '../src/main/agent/permission-policy';
import { PendingActionStore } from '../src/main/agent/pending-action-store';
import { createBuiltinFileToolRegistry } from '../src/main/agent/tool-registry';

class ScriptedProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];

  constructor(private readonly script: Array<ModelResponse | Error>) {}

  async respond(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(structuredClone(request));
    const next = this.script.shift();
    if (!next) throw new Error('测试 Provider 没有更多响应');
    if (next instanceof Error) throw next;
    return next;
  }
}

function writeResponse(
  toolName: 'builtin.files.create_file' | 'builtin.files.create_directory'
    = 'builtin.files.create_file'
): ModelResponse {
  return {
    type: 'tool_request',
    request: {
      requestId: 'write-1',
      toolName,
      arguments: {
        relativePath: toolName === 'builtin.files.create_file' ? 'result.txt' : 'output'
      }
    }
  };
}

function verifiedAction(): VerifiedWriteAction {
  return Object.freeze({
    id: 'verified-1',
    toolName: 'create_file' as const,
    targetRelativePath: 'result.txt'
  });
}

function createHarness(provider: ModelProvider, fileOverrides: Partial<AgentFileTools> = {}) {
  const events: TaskEvent[] = [];
  const loop = new AgentLoop();
  const fileTools: AgentFileTools = {
    executeRead: vi.fn(async () => ({ entries: [] })),
    preview: vi.fn(async () => verifiedAction()),
    executeWrite: vi.fn(async () => undefined),
    ...fileOverrides
  };
  const registry = createBuiltinFileToolRegistry();
  const permissionPolicy = new PermissionPolicy({ highRiskEnabled: false });
  const session: AgentSession = {
    provider,
    fileTools,
    tools: registry.definitions(),
    toolRuntime: {
      prepare: raw => registry.prepare(raw, permissionPolicy),
      executeRead: request => fileTools.executeRead(request)
    },
    messages: []
  };
  const pending = new PendingActionStore({
    onDiscard: execution => loop.discard(execution.continuationToken)
  });
  const service = new AgentService({
    loop,
    pending,
    createSession: vi.fn(async () => session),
    emit: event => events.push(event),
    createConversationId: () => 'conversation-1'
  });
  return { events, fileTools, loop, pending, provider, service };
}

function phases(events: TaskEvent[]) {
  return events.filter(event => event.type === 'phase').map(event => event.phase);
}

describe('AgentService', () => {
  test('列目录成功后生成最终助手消息和 success', async () => {
    const provider = new ScriptedProvider([
      {
        type: 'tool_request',
        request: {
          requestId: 'read-1',
          toolName: 'builtin.files.list_directory',
          arguments: { relativePath: '.' }
        }
      },
      { type: 'text', text: '目录为空' }
    ]);
    const { events, fileTools, service } = createHarness(provider);

    await service.submit('列出目录');

    expect(fileTools.executeRead).toHaveBeenCalledOnce();
    expect(phases(events)).toEqual(['thinking', 'acting', 'success']);
    expect(events).toContainEqual({ type: 'message', role: 'user', text: '列出目录' });
    expect(events).toContainEqual({ type: 'message', role: 'assistant', text: '目录为空' });
  });

  test('写请求只发布公开预览并进入等待确认', async () => {
    const { events, fileTools, service } = createHarness(
      new ScriptedProvider([writeResponse()])
    );

    await service.submit('创建 result.txt');

    expect(phases(events)).toEqual(['thinking', 'awaiting_confirmation']);
    expect(events.at(-1)).toEqual({
      type: 'pending_action',
      action: expect.objectContaining({
        conversationId: 'conversation-1',
        risk: 'write',
        targetRelativePath: 'result.txt'
      })
    });
    expect(events.at(-1)).not.toHaveProperty('action.requestId');
    expect(JSON.stringify(events)).not.toContain('continuationToken');
    expect(JSON.stringify(events)).not.toContain('executionRequest');
    expect(JSON.stringify(events)).not.toContain('verified-1');
    expect(fileTools.preview).toHaveBeenCalledExactlyOnceWith({
      requestId: 'write-1',
      toolName: 'create_file',
      arguments: { relativePath: 'result.txt' }
    });
  });

  test('确认后只写一次并恢复模型总结', async () => {
    const provider = new ScriptedProvider([
      writeResponse(),
      { type: 'text', text: 'result.txt 已创建' }
    ]);
    const { events, fileTools, service } = createHarness(provider);
    await service.submit('创建 result.txt');
    const pendingEvent = events.find(event => event.type === 'pending_action');
    if (!pendingEvent || pendingEvent.type !== 'pending_action') throw new Error('缺少确认事件');

    await service.confirm(pendingEvent.action.actionId);

    expect(fileTools.executeWrite).toHaveBeenCalledOnce();
    expect(phases(events)).toEqual([
      'thinking',
      'awaiting_confirmation',
      'acting',
      'thinking',
      'success'
    ]);
    expect(events).toContainEqual({
      type: 'message',
      role: 'assistant',
      text: 'result.txt 已创建'
    });
    await expect(service.confirm(pendingEvent.action.actionId)).rejects.toThrow('ACTION_EXPIRED');
    expect(fileTools.executeWrite).toHaveBeenCalledOnce();
  });

  test('取消进行中的 Provider 调用会进入 cancelled', async () => {
    const provider: ModelProvider = {
      respond: vi.fn(async (_request, signal) => new Promise<ModelResponse>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')));
      }))
    };
    const { events, service } = createHarness(provider);
    const submitting = service.submit('等待模型');
    await vi.waitFor(() => expect(provider.respond).toHaveBeenCalledOnce());

    service.cancelActive();
    await submitting;

    expect(phases(events)).toEqual(['thinking', 'cancelled']);
  });

  test('Provider 失败会发送公开错误和 error 终止阶段', async () => {
    const providerError = Object.assign(new Error('private details'), {
      code: 'PROVIDER_AUTHENTICATION_FAILED',
      retryable: false
    });
    const { events, service } = createHarness(new ScriptedProvider([providerError]));

    await expect(service.submit('调用模型')).rejects.toThrow('private details');

    expect(events.at(-2)).toEqual(expect.objectContaining({
      type: 'error',
      code: 'PROVIDER_AUTHENTICATION_FAILED'
    }));
    expect(events.at(-1)).toEqual({ type: 'phase', phase: 'error' });
    expect(JSON.stringify(events)).not.toContain('private details');
  });

  test('可重试的 Provider 错误只自动重试一次', async () => {
    const retryableError = Object.assign(new Error('temporary failure'), {
      code: 'PROVIDER_SERVER_ERROR',
      retryable: true
    });
    const provider = new ScriptedProvider([
      retryableError,
      { type: 'text', text: '重试成功' }
    ]);
    const { events, service } = createHarness(provider);

    await service.submit('调用模型');

    expect(provider.requests).toHaveLength(2);
    expect(events).toContainEqual({ type: 'message', role: 'assistant', text: '重试成功' });
    expect(phases(events)).toEqual(['thinking', 'success']);
  });

  test('无效输入返回明确的公开错误码', async () => {
    const { events, service } = createHarness(new ScriptedProvider([]));

    await expect(service.submit('   ')).rejects.toThrow('INPUT_INVALID');

    expect(events.at(-2)).toEqual(expect.objectContaining({ type: 'error', code: 'INPUT_INVALID' }));
    expect(events.at(-1)).toEqual({ type: 'phase', phase: 'error' });
  });

  test('无效写路径在预览阶段失败并丢弃续跑状态', async () => {
    const { events, loop, service } = createHarness(
      new ScriptedProvider([writeResponse()]),
      { preview: vi.fn(async () => { throw new FileToolError('PATH_INVALID', '路径无效'); }) }
    );
    const discard = vi.spyOn(loop, 'discard');

    await expect(service.submit('创建越界文件')).rejects.toThrow('路径无效');

    expect(discard).toHaveBeenCalledOnce();
    expect(events.at(-2)).toEqual(expect.objectContaining({ type: 'error', code: 'PATH_INVALID' }));
    expect(events.at(-1)).toEqual({ type: 'phase', phase: 'error' });
  });

  test('目标冲突不会恢复模型且产生 error 终止阶段', async () => {
    const provider = new ScriptedProvider([writeResponse()]);
    const { events, fileTools, service } = createHarness(provider, {
      executeWrite: vi.fn(async () => {
        throw new FileToolError('TARGET_EXISTS', '目标已经存在');
      })
    });
    await service.submit('创建 result.txt');
    const pendingEvent = events.find(event => event.type === 'pending_action');
    if (!pendingEvent || pendingEvent.type !== 'pending_action') throw new Error('缺少确认事件');

    await expect(service.confirm(pendingEvent.action.actionId)).rejects.toThrow('目标已经存在');

    expect(fileTools.executeWrite).toHaveBeenCalledOnce();
    expect(provider.requests).toHaveLength(1);
    expect(events.at(-2)).toEqual(expect.objectContaining({ type: 'error', code: 'TARGET_EXISTS' }));
    expect(events.at(-1)).toEqual({ type: 'phase', phase: 'error' });
  });

  test('本地写入成功但总结失败时明确区分结果', async () => {
    const summaryError = Object.assign(new Error('provider failed'), {
      code: 'PROVIDER_SERVER_ERROR',
      retryable: false
    });
    const provider = new ScriptedProvider([writeResponse(), summaryError]);
    const { events, fileTools, service } = createHarness(provider);
    await service.submit('创建 result.txt');
    const pendingEvent = events.find(event => event.type === 'pending_action');
    if (!pendingEvent || pendingEvent.type !== 'pending_action') throw new Error('缺少确认事件');

    await expect(service.confirm(pendingEvent.action.actionId)).rejects.toThrow('provider failed');

    expect(fileTools.executeWrite).toHaveBeenCalledOnce();
    expect(provider.requests).toHaveLength(2);
    expect(events.at(-2)).toEqual({
      type: 'error',
      code: 'PROVIDER_SUMMARY_FAILED_AFTER_WRITE',
      message: '本地文件操作已成功，但模型总结失败。',
      nextAction: '可以查看文件结果，或稍后重新请求总结。'
    });
    expect(events.at(-1)).toEqual({ type: 'phase', phase: 'error' });

    await expect(service.confirm(pendingEvent.action.actionId)).rejects.toThrow('ACTION_EXPIRED');
    expect(fileTools.executeWrite).toHaveBeenCalledOnce();
    expect(provider.requests).toHaveLength(2);
  });
});
