import { describe, expect, test, vi } from 'vitest';
import { AgentLoop } from '@myself/agent-core';
import type {
  ModelProvider,
  ModelRequest,
  ModelResponse
} from '@myself/agent-core';
import { FileToolError, type VerifiedWriteAction } from '@myself/file-tools';
import type { CharacterAgentBehaviorIntent } from '@myself/character-runtime';
import type { TaskEvent } from '@myself/shared-types';
import {
  AgentService,
  type AgentFileTools,
  type AgentSession
} from '../src/main/agent/agent-service';
import { PermissionPolicy } from '../src/main/agent/permission-policy';
import { PendingActionStore } from '../src/main/agent/pending-action-store';
import { OpenAICompatibleProvider } from '../src/main/providers/openai-provider';
import { createBuiltinFileToolRegistry } from '../src/main/agent/tool-registry';
import { createTaskStore } from '../src/renderer/src/stores/task-store';

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

function recycleAction(): VerifiedWriteAction {
  return Object.freeze({
    id: 'verified-recycle-1',
    toolName: 'move_to_recycle_bin' as const,
    targetRelativePath: 'archive/old.txt'
  });
}

function createHarness(
  provider: ModelProvider,
  fileOverrides: Partial<AgentFileTools> = {},
  fileDisclosureAllowed = true,
  fallbackProviders: ModelProvider[] = [],
  onEmit?: (event: TaskEvent) => void,
  emitBehaviorIntent?: (intent: CharacterAgentBehaviorIntent) => void
) {
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
    fallbackProviders,
    fileTools,
    fileDisclosureAllowed,
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
  const taskCarry = {
    beginTaskCarry: vi.fn<() => {
      playbackToken: string;
      actionId: string;
      commitFrameId: string | null;
    }>(() => ({
      playbackToken: 'carry-token-1',
      actionId: 'carry-action-1',
      commitFrameId: 'carry-frame-1'
    })),
    endTaskCarry: vi.fn()
  };
  const service = new AgentService({
    loop,
    pending,
    createSession: vi.fn(async () => session),
    emit: event => {
      events.push(event);
      onEmit?.(event);
    },
    ...(emitBehaviorIntent === undefined ? {} : { emitBehaviorIntent }),
    taskCarry,
    createConversationId: () => 'conversation-1'
  });
  return { events, fileTools, loop, pending, provider, service, taskCarry };
}

function phases(events: TaskEvent[]) {
  return events.filter(event => event.type === 'phase').map(event => event.phase);
}

describe('AgentService', () => {
  test('行为意图只调用内部回调且不广播到 Renderer 任务事件', async () => {
    const emitBehaviorIntent = vi.fn();
    const { events, service } = createHarness(
      new ScriptedProvider([{
        type: 'text',
        text: '处理完成',
        behaviorIntent: {
          stateIntent: { semantic: 'think' },
          actionSemantic: 'think',
          urgency: 50,
          explanation: '正在整理回应。'
        }
      }]),
      {},
      true,
      [],
      undefined,
      emitBehaviorIntent
    );

    await service.submit('处理任务');

    expect(emitBehaviorIntent).toHaveBeenCalledExactlyOnceWith({
      stateIntent: { semantic: 'think' },
      actionSemantic: 'think',
      urgency: 50,
      explanation: '正在整理回应。'
    });
    expect(JSON.stringify(events)).not.toContain('正在整理回应。');
  });

  test('OpenAI metadata 情绪按真实事件顺序延迟到 success 展示结束后重放', async () => {
    vi.useFakeTimers();
    const store = createTaskStore();
    store.getState().configureCharacterExtensions([{
      stateId: 'custom:wave',
      triggers: [],
      keywords: [],
      emotions: ['happy']
    }]);
    const provider = new OpenAICompatibleProvider(
      { baseUrl: 'https://provider.example/v1', modelId: 'test-model' },
      async () => 'secret',
      vi.fn(async () => new Response(JSON.stringify({
        choices: [{
          message: {
            content: '处理完成',
            metadata: { emotion: 'happy' }
          }
        }]
      }), { status: 200 }))
    );
    const harness = createHarness(
      provider,
      {},
      true,
      [],
      event => store.getState().apply(event)
    );
    const apply = vi.spyOn(store.getState(), 'apply');

    await harness.service.submit('处理任务');

    expect(harness.events).toEqual([
      { type: 'message', role: 'user', text: '处理任务' },
      { type: 'phase', phase: 'listening' },
      { type: 'phase', phase: 'thinking' },
      { type: 'character_emotion', label: 'happy' },
      { type: 'message', role: 'assistant', text: '处理完成' },
      { type: 'phase', phase: 'success' }
    ]);
    expect(apply.mock.calls.map(([event]) => event)).toEqual(harness.events);
    expect(store.getState().characterState.stateId).toBe('success');
    vi.advanceTimersByTime(1_500);
    expect(store.getState().characterState.stateId).toBe('custom:wave');
    vi.useRealTimers();
  });

  test('AgentLoop 情绪事件转换为无自由文本推测的 character_emotion 任务事件', async () => {
    const { events, service } = createHarness(new ScriptedProvider([{
      type: 'text',
      text: '完成',
      emotion: 'happy'
    }]));
    await service.submit('处理任务');
    expect(events).toContainEqual({
      type: 'character_emotion',
      label: 'happy'
    });
  });

  test('主模型可重试失败耗尽后改用备用模型完成当前 Agent 请求', async () => {
    const firstError = Object.assign(new Error('PRIMARY_DOWN'), { retryable: true });
    const secondError = Object.assign(new Error('PRIMARY_DOWN'), { retryable: true });
    const primary = new ScriptedProvider([firstError, secondError]);
    const fallback = new ScriptedProvider([{ type: 'text', text: '备用模型已响应' }]);
    const { events, service } = createHarness(primary, {}, true, [fallback]);

    await service.submit('继续任务');

    expect(primary.requests).toHaveLength(2);
    expect(fallback.requests).toHaveLength(1);
    expect(events).toContainEqual({
      type: 'message',
      role: 'assistant',
      text: '备用模型已响应'
    });
  });

  test('文件分类未授权时拒绝历史写请求进入预览和执行', async () => {
    const { events, fileTools, service } = createHarness(
      new ScriptedProvider([writeResponse()]),
      {},
      false
    );

    await expect(service.submit('创建 result.txt')).rejects.toThrow(
      'FILE_DISCLOSURE_DENIED'
    );
    expect(fileTools.preview).not.toHaveBeenCalled();
    expect(fileTools.executeWrite).not.toHaveBeenCalled();
    expect(events.at(-2)).toEqual(expect.objectContaining({
      type: 'error',
      code: 'FILE_DISCLOSURE_DENIED'
    }));
  });

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
    expect(phases(events)).toEqual(['listening', 'thinking', 'acting', 'success']);
    expect(events).toContainEqual({ type: 'message', role: 'user', text: '列出目录' });
    expect(events).toContainEqual({ type: 'message', role: 'assistant', text: '目录为空' });
  });

  test('写请求只发布公开预览并进入等待确认', async () => {
    const { events, fileTools, service } = createHarness(
      new ScriptedProvider([writeResponse()])
    );

    await service.submit('创建 result.txt');

    expect(phases(events)).toEqual(['listening', 'thinking', 'awaiting_confirmation']);
    expect(events.at(-1)).toEqual({
      type: 'pending_action',
      action: expect.objectContaining({
        conversationId: 'conversation-1',
        risk: 'write',
        operation: 'create_file',
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
    expect(events).toContainEqual({ type: 'character_carrying', carrying: true });
    expect(events).toContainEqual({ type: 'character_carrying', carrying: false });
    expect(events.findIndex(event => (
      event.type === 'character_carrying' && event.carrying
    ))).toBeLessThan(events.findIndex(event => (
      event.type === 'character_carrying' && !event.carrying
    )));
    expect(phases(events)).toEqual([
      'listening',
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

  test('回收站确认等待匹配的开始与提交帧后才执行并恢复总结', async () => {
    const provider = new ScriptedProvider([
      writeResponse(),
      { type: 'text', text: 'old.txt 已移入回收站' }
    ]);
    const harness = createHarness(provider, {
      preview: vi.fn(async () => recycleAction())
    });
    await harness.service.submit('把 old.txt 移入回收站');
    const pendingEvent = harness.events.find(event => event.type === 'pending_action');
    if (!pendingEvent || pendingEvent.type !== 'pending_action') throw new Error('缺少确认事件');

    const confirming = harness.service.confirm(pendingEvent.action.actionId);
    await Promise.resolve();
    expect(harness.fileTools.executeWrite).not.toHaveBeenCalled();
    expect(harness.service.onPlaybackStarted('wrong-token', 'carry-action-1')).toBe(false);
    expect(harness.service.onPlaybackStarted('carry-token-1', 'carry-action-1')).toBe(true);
    expect(harness.fileTools.executeWrite).not.toHaveBeenCalled();
    expect(harness.service.onCommitFrame(
      'carry-token-1',
      'carry-action-1',
      'carry-frame-1'
    )).toBe(true);
    await confirming;

    expect(harness.fileTools.executeWrite).toHaveBeenCalledExactlyOnceWith(recycleAction());
    expect(harness.taskCarry.beginTaskCarry).toHaveBeenCalledOnce();
    expect(harness.taskCarry.endTaskCarry).toHaveBeenCalledOnce();
    expect(phases(harness.events)).toEqual([
      'listening',
      'thinking',
      'awaiting_confirmation',
      'acting',
      'thinking',
      'success'
    ]);
  });

  test('回收站无提交帧时由匹配的 started 提交且只执行一次', async () => {
    const harness = createHarness(
      new ScriptedProvider([writeResponse(), { type: 'text', text: '已完成' }]),
      { preview: vi.fn(async () => recycleAction()) }
    );
    harness.taskCarry.beginTaskCarry.mockReturnValue({
      playbackToken: 'carry-token-1',
      actionId: 'carry-action-1',
      commitFrameId: null
    });
    await harness.service.submit('移入回收站');
    const pendingEvent = harness.events.find(event => event.type === 'pending_action');
    if (!pendingEvent || pendingEvent.type !== 'pending_action') throw new Error('缺少确认事件');

    const confirming = harness.service.confirm(pendingEvent.action.actionId);
    await Promise.resolve();
    expect(harness.service.onPlaybackStarted('carry-token-1', 'carry-action-1')).toBe(true);
    expect(harness.service.onPlaybackStarted('carry-token-1', 'carry-action-1')).toBe(false);
    await confirming;

    expect(harness.fileTools.executeWrite).toHaveBeenCalledOnce();
  });

  test('回收站提交前取消会丢弃续跑且永不执行文件动作', async () => {
    const harness = createHarness(
      new ScriptedProvider([writeResponse()]),
      { preview: vi.fn(async () => recycleAction()) }
    );
    const discard = vi.spyOn(harness.loop, 'discard');
    await harness.service.submit('移入回收站');
    const pendingEvent = harness.events.find(event => event.type === 'pending_action');
    if (!pendingEvent || pendingEvent.type !== 'pending_action') throw new Error('缺少确认事件');

    const confirming = harness.service.confirm(pendingEvent.action.actionId);
    await Promise.resolve();
    harness.service.cancelActive();
    await expect(confirming).rejects.toThrow('FILE_TASK_USER_CANCELLED');

    expect(discard).toHaveBeenCalledOnce();
    expect(harness.fileTools.executeWrite).not.toHaveBeenCalled();
    expect(harness.taskCarry.endTaskCarry).toHaveBeenCalledOnce();
    expect(harness.service.onCommitFrame(
      'carry-token-1',
      'carry-action-1',
      'carry-frame-1'
    )).toBe(false);
  });

  test('回收站提交前收到匹配的播放终止会撤销提交权', async () => {
    const harness = createHarness(
      new ScriptedProvider([writeResponse()]),
      { preview: vi.fn(async () => recycleAction()) }
    );
    await harness.service.submit('移入回收站');
    const pendingEvent = harness.events.find(event => event.type === 'pending_action');
    if (!pendingEvent || pendingEvent.type !== 'pending_action') throw new Error('缺少确认事件');

    const confirming = harness.service.confirm(pendingEvent.action.actionId);
    await Promise.resolve();
    harness.service.onPlaybackStarted('carry-token-1', 'carry-action-1');
    expect(harness.service.onPlaybackTerminal(
      'carry-token-1',
      'carry-action-1',
      'interrupted'
    )).toBe(true);
    await expect(confirming).rejects.toThrow('FILE_TASK_PLAYBACK_CANCELLED');

    expect(harness.fileTools.executeWrite).not.toHaveBeenCalled();
    expect(harness.service.onCommitFrame(
      'carry-token-1',
      'carry-action-1',
      'carry-frame-1'
    )).toBe(false);
  });

  test('角色切换或用户交互使播放授权失效后旧提交帧不能写文件', async () => {
    const harness = createHarness(
      new ScriptedProvider([writeResponse()]),
      { preview: vi.fn(async () => recycleAction()) }
    );
    await harness.service.submit('移入回收站');
    const pendingEvent = harness.events.find(event => event.type === 'pending_action');
    if (!pendingEvent || pendingEvent.type !== 'pending_action') throw new Error('缺少确认事件');

    const confirming = harness.service.confirm(pendingEvent.action.actionId);
    await Promise.resolve();
    harness.service.onPlaybackStarted('carry-token-1', 'carry-action-1');
    expect(harness.service.invalidateFileTaskPlaybackGrant()).toBe(true);
    await expect(confirming).rejects.toThrow('FILE_TASK_PLAYBACK_CANCELLED');

    expect(harness.service.onCommitFrame(
      'carry-token-1',
      'carry-action-1',
      'carry-frame-1'
    )).toBe(false);
    expect(harness.fileTools.executeWrite).not.toHaveBeenCalled();
  });

  test('回收站等待播放超时由 Main 轮询推进并撤销提交权', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness(
        new ScriptedProvider([writeResponse()]),
        { preview: vi.fn(async () => recycleAction()) }
      );
      await harness.service.submit('移入回收站');
      const pendingEvent = harness.events.find(event => event.type === 'pending_action');
      if (!pendingEvent || pendingEvent.type !== 'pending_action') throw new Error('缺少确认事件');

      const confirming = harness.service.confirm(pendingEvent.action.actionId);
      await Promise.resolve();
      vi.advanceTimersByTime(30_001);
      expect(harness.service.advanceFileTaskTransaction()).toBe(true);
      await expect(confirming).rejects.toThrow('FILE_TASK_PLAYBACK_TIMEOUT');

      expect(harness.fileTools.executeWrite).not.toHaveBeenCalled();
      expect(harness.service.onPlaybackStarted(
        'carry-token-1',
        'carry-action-1'
      )).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test('回收站本地成功但模型总结失败时警告且保持 success 终态', async () => {
    const summaryError = Object.assign(new Error('provider failed'), {
      code: 'PROVIDER_SERVER_ERROR',
      retryable: false
    });
    const harness = createHarness(
      new ScriptedProvider([writeResponse(), summaryError]),
      { preview: vi.fn(async () => recycleAction()) }
    );
    await harness.service.submit('移入回收站');
    const pendingEvent = harness.events.find(event => event.type === 'pending_action');
    if (!pendingEvent || pendingEvent.type !== 'pending_action') throw new Error('缺少确认事件');

    const confirming = harness.service.confirm(pendingEvent.action.actionId);
    await Promise.resolve();
    harness.service.onPlaybackStarted('carry-token-1', 'carry-action-1');
    harness.service.onCommitFrame('carry-token-1', 'carry-action-1', 'carry-frame-1');
    await expect(confirming).rejects.toThrow('provider failed');

    expect(harness.events).toContainEqual({
      type: 'error',
      code: 'PROVIDER_SUMMARY_FAILED_AFTER_WRITE',
      message: '本地文件操作已成功，但模型总结失败。',
      nextAction: '可以查看文件结果，或稍后重新请求总结。'
    });
    expect(phases(harness.events)).not.toContain('error');
    expect(phases(harness.events).at(-1)).toBe('success');
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

    expect(phases(events)).toEqual(['listening', 'thinking', 'cancelled']);
  });

  test('Provider 失败会发送公开错误和 error 终止阶段', async () => {
    const providerError = Object.assign(new Error('private details'), {
      code: 'PROVIDER_AUTHENTICATION_FAILED',
      retryable: false
    });
    const { events, service } = createHarness(new ScriptedProvider([providerError]));

    await expect(service.submit('调用模型')).rejects.toThrow('private details');
    expect(service.hasReportedFailure(providerError)).toBe(true);

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
    expect(phases(events)).toEqual(['listening', 'thinking', 'success']);
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
