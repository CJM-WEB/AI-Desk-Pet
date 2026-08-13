import { describe, expect, test, vi } from 'vitest';
import { AgentLoop } from '@myself/agent-core';
import type {
  ModelMessage,
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
import { createBuiltinPowerShellToolRegistry } from '../src/main/agent/tool-registry';
import type { PowerShellTool, VerifiedPowerShellAction } from '../src/main/agent/powershell-tool';
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
  toolName: 'builtin.files.create_file' | 'builtin.files.apply_patch' | 'builtin.files.delete_file'
    = 'builtin.files.create_file'
): ModelResponse {
  return {
    type: 'tool_request',
    request: {
      requestId: 'write-1',
      toolName,
      arguments: toolName === 'builtin.files.create_file'
        ? { relativePath: 'result.txt', content: '正文' }
        : toolName === 'builtin.files.apply_patch'
          ? { relativePath: 'result.txt', patch: '@@ -1 +1 @@\n-before\n+after\n' }
          : { relativePath: 'result.txt' }
    }
  };
}

function verifiedAction(): VerifiedWriteAction {
  return Object.freeze({
    operation: 'create_file' as const,
    authorizationGeneration: 0,
    targetRelativePath: 'result.txt',
    contentCharacters: 2,
    contentPreview: '正文',
    contentPreviewSuppressedReason: null,
    previewTruncated: false
  });
}

function readResponse(requestId = 'read-1'): ModelResponse {
  return {
    type: 'tool_request',
    request: {
      requestId,
      toolName: 'builtin.files.list_files',
      arguments: { relativePath: '.' }
    }
  };
}

class DeferredProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];
  private resolveResponse!: (response: ModelResponse) => void;
  private readonly response = new Promise<ModelResponse>(resolve => {
    this.resolveResponse = resolve;
  });

  async respond(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(structuredClone(request));
    return this.response;
  }

  resolve(response: ModelResponse): void {
    this.resolveResponse(response);
  }
}

class RepairDeferredProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];
  private readonly responses: Array<(response: ModelResponse) => void> = [];

  respond(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(structuredClone(request));
    return new Promise(resolve => {
      this.responses.push(resolve);
    });
  }

  resolve(index: number, response: ModelResponse): void {
    const resolve = this.responses[index];
    if (!resolve) throw new Error('缺少待完成的模型响应');
    resolve(response);
  }
}

function recycleAction(): VerifiedWriteAction {
  return Object.freeze({
    operation: 'delete_file' as const,
    authorizationGeneration: 0,
    targetRelativePath: 'archive/old.txt',
    targetType: 'file'
  });
}

function createHarness(
  provider: ModelProvider,
  fileOverrides: Partial<AgentFileTools> = {},
  fileDisclosureAllowed = true,
  fallbackProviders: ModelProvider[] = [],
  onEmit?: (event: TaskEvent) => void,
  emitBehaviorIntent?: (intent: CharacterAgentBehaviorIntent) => void,
  createSessionOverride?: (session: AgentSession) => Promise<AgentSession>
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
    taskKind: 'file',
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
  const createSession = vi.fn(async () => (
    createSessionOverride ? createSessionOverride(session) : session
  ));
  const service = new AgentService({
    loop,
    pending,
    createSession,
    emit: event => {
      events.push(event);
      onEmit?.(event);
    },
    ...(emitBehaviorIntent === undefined ? {} : { emitBehaviorIntent }),
    taskCarry,
    createConversationId: () => 'conversation-1'
  });
  return {
    createSession,
    events,
    fileTools,
    loop,
    pending,
    provider,
    service,
    session,
    taskCarry
  };
}

function deferred<T = void>(): { promise: Promise<T>; resolve(value?: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function shellRequest(): ModelResponse {
  return {
    type: 'tool_request',
    request: {
      requestId: 'shell-1',
      toolName: 'builtin.powershell.run',
      arguments: { command: 'Get-ChildItem' }
    }
  };
}

function powerShellAction(): VerifiedPowerShellAction {
  return Object.freeze({
    kind: 'powershell',
    command: 'Get-ChildItem',
    workingDirectoryLabel: '工作区',
    runMode: 'foreground',
    generation: 'generation-1',
    expiresAtMs: Date.now() + 60_000
  });
}

function phases(events: TaskEvent[]) {
  return events.filter(event => event.type === 'phase').map(event => event.phase);
}

function powerShellResult(ok: boolean) {
  return {
    ok,
    toolName: 'powershell' as const,
    status: ok ? 'succeeded' as const : 'failed' as const,
    timeoutKind: null,
    exitCode: ok ? 0 : 1,
    stdout: '',
    stderr: ok ? '' : '失败',
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 1
  };
}

function createPowerShellHarness(
  provider: ModelProvider,
  powershell: Pick<PowerShellTool, 'preview' | 'execute'> & Partial<Pick<PowerShellTool, 'close'>>
) {
  const events: TaskEvent[] = [];
  const loop = new AgentLoop();
  const pending = new PendingActionStore({
    onDiscard: execution => loop.discard(execution.continuationToken)
  });
  const registry = createBuiltinPowerShellToolRegistry();
  const session: AgentSession = {
    taskKind: 'powershell',
    provider,
    powershell: { close: vi.fn(async () => undefined), ...powershell } as PowerShellTool,
    workingDirectory: 'C:\\workspace',
    workingDirectoryLabel: '工作区',
    generation: 'generation-1',
    tools: registry.definitions(),
    toolRuntime: {
      prepare: raw => registry.prepare(raw, new PermissionPolicy({ highRiskEnabled: true })),
      executeRead: vi.fn()
    },
    messages: []
  };
  const service = new AgentService({
    loop,
    pending,
    createSession: async () => session,
    emit: event => events.push(event),
    createConversationId: () => 'conversation-1'
  });
  return { events, service };
}

describe('AgentService', () => {
  test('reset 等待前台 PowerShell 执行收敛且丢弃迟到结果', async () => {
    const execution = deferred<ReturnType<typeof powerShellResult>>();
    const execute = vi.fn(() => execution.promise);
    const { events, service } = createPowerShellHarness(
      new ScriptedProvider([shellRequest(), { type: 'text', text: '迟到总结不得公开' }]),
      { preview: vi.fn(() => powerShellAction()), execute }
    );

    await service.submitFileTask({ text: '运行命令', visibleHistory: [] });
    const pending = events.find(event => event.type === 'pending_action');
    if (!pending || pending.type !== 'pending_action') throw new Error('缺少确认');
    const confirming = service.confirm(pending.action.actionId);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());

    let resetSettled = false;
    const resetting = service.resetForNewConversation().then(() => { resetSettled = true; });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(resetSettled).toBe(false);
    execution.resolve(powerShellResult(false));
    await resetting;
    await confirming;

    expect(events).not.toContainEqual({
      type: 'message', role: 'assistant', text: '迟到总结不得公开'
    });
  });

  test('close 等待前台 PowerShell 执行收敛且丢弃迟到结果', async () => {
    const execution = deferred<ReturnType<typeof powerShellResult>>();
    const execute = vi.fn(() => execution.promise);
    const { events, service } = createPowerShellHarness(
      new ScriptedProvider([shellRequest(), { type: 'text', text: '迟到总结不得公开' }]),
      { preview: vi.fn(() => powerShellAction()), execute }
    );

    await service.submitFileTask({ text: '运行命令', visibleHistory: [] });
    const pending = events.find(event => event.type === 'pending_action');
    if (!pending || pending.type !== 'pending_action') throw new Error('缺少确认');
    const confirming = service.confirm(pending.action.actionId);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());

    let closeSettled = false;
    const closing = service.close().then(() => { closeSettled = true; });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(closeSettled).toBe(false);
    execution.resolve(powerShellResult(false));
    await closing;
    await confirming;

    expect(events).not.toContainEqual({
      type: 'message', role: 'assistant', text: '迟到总结不得公开'
    });
  });

  test('失败 PowerShell 续跑出第二次确认时保留会话所有权，后续成功可确认', async () => {
    const provider = new ScriptedProvider([
      {
        type: 'tool_request',
        request: {
          requestId: 'shell-1',
          toolName: 'builtin.powershell.run',
          arguments: { command: 'Get-ChildItem' }
        }
      },
      {
        type: 'tool_request',
        request: {
          requestId: 'shell-2',
          toolName: 'builtin.powershell.run',
          arguments: { command: 'Get-Date' }
        }
      },
      { type: 'text', text: '第二个命令已成功。' }
    ]);
    const firstAction = Object.freeze({
      kind: 'powershell' as const,
      command: 'Get-ChildItem',
      workingDirectoryLabel: '工作区',
      runMode: 'foreground' as const,
      generation: 'generation-1',
      expiresAtMs: Date.now() + 60_000
    });
    const secondAction = Object.freeze({ ...firstAction, command: 'Get-Date' });
    const preview = vi.fn((input: { command: string }) => (
      input.command === 'Get-ChildItem' ? firstAction : secondAction
    ));
    const execute = vi.fn()
      .mockResolvedValueOnce(powerShellResult(false))
      .mockResolvedValueOnce(powerShellResult(true));
    const { events, service } = createPowerShellHarness(provider, { preview, execute });

    await service.submitFileTask({ text: '运行命令', visibleHistory: [] });
    const firstPending = events.find(event => event.type === 'pending_action');
    if (!firstPending || firstPending.type !== 'pending_action') throw new Error('缺少首次确认');
    await service.confirm(firstPending.action.actionId);
    const secondPending = events.filter(event => event.type === 'pending_action').at(-1);
    if (!secondPending || secondPending.type !== 'pending_action') throw new Error('缺少第二次确认');
    await service.confirm(secondPending.action.actionId);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual({
      type: 'message',
      role: 'assistant',
      text: '第二个命令已成功。'
    });
    expect(phases(events).at(-1)).toBe('success');
  });

  test('失败 PowerShell 的模型总结失败只发布中性能力结果，绝不伪称文件成功', async () => {
    const summaryError = Object.assign(new Error('provider failed'), {
      code: 'PROVIDER_SERVER_ERROR',
      retryable: false
    });
    const provider = new ScriptedProvider([{
      type: 'tool_request',
      request: {
        requestId: 'shell-1',
        toolName: 'builtin.powershell.run',
        arguments: { command: 'Get-ChildItem' }
      }
    }, summaryError]);
    const action = Object.freeze({
      kind: 'powershell' as const,
      command: 'Get-ChildItem',
      workingDirectoryLabel: '工作区',
      runMode: 'foreground' as const,
      generation: 'generation-1',
      expiresAtMs: Date.now() + 60_000
    });
    const { events, service } = createPowerShellHarness(provider, {
      preview: vi.fn(() => action),
      execute: vi.fn(async () => powerShellResult(false))
    });

    await service.submitFileTask({ text: '运行命令', visibleHistory: [] });
    const pendingEvent = events.find(event => event.type === 'pending_action');
    if (!pendingEvent || pendingEvent.type !== 'pending_action') throw new Error('缺少确认');
    await expect(service.confirm(pendingEvent.action.actionId)).rejects.toThrow('provider failed');

    expect(events).toContainEqual({
      type: 'error',
      code: 'PROVIDER_SUMMARY_FAILED_AFTER_CAPABILITY_RESULT',
      message: '本地能力操作已结束，但模型总结失败。',
      nextAction: '可以查看本地操作结果，或稍后重新请求总结。'
    });
    expect(JSON.stringify(events)).not.toContain('本地文件操作已成功');
  });

  test('PowerShell 预览携带绝对目录标签时不发布确认卡', async () => {
    const provider = new ScriptedProvider([{
      type: 'tool_request',
      request: {
        requestId: 'shell-1',
        toolName: 'builtin.powershell.run',
        arguments: { command: 'Get-ChildItem' }
      }
    }]);
    const action = Object.freeze({
      kind: 'powershell' as const,
      command: 'Get-ChildItem',
      workingDirectoryLabel: 'C:\\secret\\workspace',
      runMode: 'foreground' as const,
      generation: 'generation-1',
      expiresAtMs: Date.now() + 60_000
    });
    const { events, service } = createPowerShellHarness(provider, {
      preview: vi.fn(() => action),
      execute: vi.fn(async () => powerShellResult(true))
    });

    await expect(service.submitFileTask({ text: '运行命令', visibleHistory: [] }))
      .rejects.toThrow();

    expect(events).not.toContainEqual(expect.objectContaining({ type: 'pending_action' }));
    expect(events.at(-1)).toEqual({ type: 'phase', phase: 'error' });
  });

  test('PowerShell 确认使用会话目录上下文并将真实失败事实续跑给模型', async () => {
    const provider = new ScriptedProvider([{
      type: 'tool_request',
      request: {
        requestId: 'shell-1',
        toolName: 'builtin.powershell.run',
        arguments: { command: 'Get-ChildItem' }
      }
    }, { type: 'text', text: '命令执行失败。' }]);
    const action: VerifiedPowerShellAction = Object.freeze({
      kind: 'powershell',
      command: 'Get-ChildItem',
      workingDirectoryLabel: '工作区',
      runMode: 'foreground',
      generation: 'generation-1',
      expiresAtMs: Date.now() + 60_000
    });
    const preview = vi.fn(() => action);
    const execute = vi.fn(async () => ({
      ok: false,
      toolName: 'powershell' as const,
      status: 'failed' as const,
      timeoutKind: null,
      exitCode: 1,
      stdout: '',
      stderr: '失败',
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 1
    }));
    const loop = new AgentLoop();
    const pending = new PendingActionStore({
      onDiscard: execution => loop.discard(execution.continuationToken)
    });
    const events: TaskEvent[] = [];
    const registry = createBuiltinPowerShellToolRegistry();
    const session: AgentSession = {
      taskKind: 'powershell',
      provider,
      powershell: { preview, execute } as unknown as PowerShellTool,
      workingDirectory: 'C:\\workspace',
      workingDirectoryLabel: '工作区',
      generation: 'generation-1',
      tools: registry.definitions(),
      toolRuntime: {
        prepare: raw => registry.prepare(raw, new PermissionPolicy({ highRiskEnabled: true })),
        executeRead: vi.fn()
      },
      messages: []
    };
    const service = new AgentService({
      loop,
      pending,
      createSession: async () => session,
      emit: event => events.push(event),
      createConversationId: () => 'conversation-1'
    });

    await service.submitFileTask({ text: '运行 Get-ChildItem', visibleHistory: [] });
    const pendingEvent = events.find(event => event.type === 'pending_action');
    if (!pendingEvent || pendingEvent.type !== 'pending_action') throw new Error('缺少 PowerShell 确认');
    await service.confirm(pendingEvent.action.actionId);

    expect(preview).toHaveBeenCalledWith({
      command: 'Get-ChildItem',
      workingDirectory: 'C:\\workspace',
      workingDirectoryLabel: '工作区',
      generation: 'generation-1'
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(events.filter(event => event.type === 'character_carrying')).toEqual([]);
    expect(phases(events).at(-1)).toBe('error');
  });

  test('文件任务在连续两次工具前伪成功时公开稳定错误且不泄露模型正文', async () => {
    const firstViolation = '我没有权限执行这个文件任务';
    const secondViolation = '文件已经创建完成';
    const provider = new ScriptedProvider([
      { type: 'text', text: firstViolation },
      { type: 'text', text: secondViolation }
    ]);
    const { events, service, session } = createHarness(provider);

    await expect(service.submitFileTask({ text: '创建 result.txt', visibleHistory: [] }))
      .rejects.toMatchObject({ code: 'CAPABILITY_PLAN_PROTOCOL_INVALID' });

    expect(phases(events)).toEqual(['thinking', 'error']);
    expect(events).not.toContainEqual({ type: 'phase', phase: 'success' });
    expect(JSON.stringify(events)).not.toContain(firstViolation);
    expect(JSON.stringify(events)).not.toContain(secondViolation);
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.tools).toEqual(provider.requests[0]?.tools);
    expect(session.messages).toEqual([]);
  });

  test('文件任务在首次工具前公开严格 JSON 所表达的澄清问题', async () => {
    const { events, service } = createHarness(new ScriptedProvider([{
      type: 'text',
      text: '{"kind":"clarification_required","question":"请提供目标文件名"}'
    }]));

    await service.submitFileTask({ text: '创建文件', visibleHistory: [] });

    expect(events).toEqual([
      { type: 'phase', phase: 'thinking' },
      { type: 'message', role: 'assistant', text: '请提供目标文件名' },
      { type: 'phase', phase: 'success' }
    ]);
  });

  test('等待确认时新文字任务会替换旧卡且不能冒充 actionId 确认', async () => {
    const modelConfirmation = '请确认是否删除当前目录下的 empty 文件夹？';
    const provider = new ScriptedProvider([
      {
        type: 'text',
        text: JSON.stringify({ kind: 'clarification_required', question: modelConfirmation })
      },
      {
        type: 'tool_request',
        request: {
          requestId: 'delete-empty-1',
          toolName: 'builtin.files.delete_file',
          arguments: { relativePath: 'empty' }
        }
      },
      {
        type: 'text',
        text: '{"kind":"clarification_required","question":"请提供目标文件名"}'
      }
    ]);
    const harness = createHarness(provider, {
      preview: vi.fn(async () => Object.freeze({
        operation: 'delete_file' as const,
        authorizationGeneration: 0,
        targetRelativePath: 'empty',
        targetType: 'empty_directory' as const
      }))
    });

    await harness.service.submitFileTask({
      text: '帮我把当前目录下的empty文件夹删除了',
      visibleHistory: []
    });

    expect(JSON.stringify(harness.events)).not.toContain(modelConfirmation);
    const pendingEvent = harness.events.at(-1);
    expect(pendingEvent).toEqual({
      type: 'pending_action',
      action: expect.objectContaining({
        actionId: expect.any(String),
        operation: 'delete_file',
        targetRelativePath: 'empty'
      })
    });
    if (!pendingEvent || pendingEvent.type !== 'pending_action') throw new Error('缺少正式确认卡');
    await harness.service.submitFileTask({
      text: '确认执行',
      visibleHistory: []
    });
    await expect(harness.service.confirm(pendingEvent.action.actionId))
      .rejects.toThrow('ACTION_EXPIRED');
    expect(provider.requests).toHaveLength(3);
    expect(harness.fileTools.executeWrite).not.toHaveBeenCalled();
  });

  test('重置后迟到的协议修复响应不公开消息也不写入会话历史', async () => {
    const provider = new RepairDeferredProvider();
    const { events, service, session } = createHarness(provider);
    const submitting = service.submitFileTask({ text: '创建 result.txt', visibleHistory: [] });
    await vi.waitFor(() => expect(provider.requests).toHaveLength(1));

    provider.resolve(0, { type: 'text', text: '文件已经创建完成' });
    await vi.waitFor(() => expect(provider.requests).toHaveLength(2));
    const resetting = service.resetForNewConversation();
    provider.resolve(1, {
      type: 'text',
      text: '{"kind":"clarification_required","question":"请提供目标文件名"}'
    });
    await Promise.all([submitting, resetting]);

    expect(events).toEqual([{ type: 'phase', phase: 'thinking' }]);
    expect(session.messages).toEqual([]);
  });

  test('取消后迟到的合法协议修复响应不公开消息也不写入会话历史', async () => {
    const provider = new RepairDeferredProvider();
    const { events, service, session } = createHarness(provider);
    const submitting = service.submitFileTask({ text: '创建 result.txt', visibleHistory: [] });
    await vi.waitFor(() => expect(provider.requests).toHaveLength(1));

    provider.resolve(0, { type: 'text', text: '文件已经创建完成' });
    await vi.waitFor(() => expect(provider.requests).toHaveLength(2));
    service.cancelActive();
    provider.resolve(1, {
      type: 'text',
      text: '{"kind":"clarification_required","question":"请提供目标文件名"}'
    });
    await submitting;

    expect(events).toEqual([
      { type: 'phase', phase: 'thinking' },
      { type: 'phase', phase: 'cancelled' }
    ]);
    expect(session.messages).toEqual([]);
  });

  test('文件任务只发布 Agent 结果，并按系统消息、可见历史、当前用户消息的顺序请求模型', async () => {
    const provider = new ScriptedProvider([{
      type: 'tool_request',
      request: {
        requestId: 'read-history-1',
        toolName: 'builtin.files.list_files',
        arguments: { relativePath: '.' }
      }
    }, { type: 'text', text: '处理完成' }]);
    const harness = createHarness(provider);
    harness.session.messages.push({ role: 'system', content: '文件系统提示' });
    const visibleHistory = Object.freeze([
      { role: 'user', content: '历史用户消息' },
      { role: 'assistant', content: '历史助手消息' }
    ]) satisfies readonly ModelMessage[];

    await harness.service.submitFileTask({
      text: '列出目录',
      visibleHistory
    });

    expect(provider.requests[0]?.messages).toEqual([
      { role: 'system', content: '文件系统提示' },
      { role: 'user', content: '历史用户消息' },
      { role: 'assistant', content: '历史助手消息' },
      { role: 'user', content: '列出目录' }
    ]);
    expect(harness.session.messages).toEqual([
      { role: 'system', content: '文件系统提示' }
    ]);
    expect(visibleHistory).toEqual([
      { role: 'user', content: '历史用户消息' },
      { role: 'assistant', content: '历史助手消息' }
    ]);
    expect(harness.events).not.toContainEqual(expect.objectContaining({
      type: 'message',
      role: 'user'
    }));
    expect(harness.events).not.toContainEqual({ type: 'phase', phase: 'listening' });
  });

  test.each([
    ['system 消息', [{ role: 'system', content: '任务系统轨迹' }]],
    ['tool 消息', [{ role: 'tool', content: '{}', toolCallId: 'tool-1' }]],
    ['assistant toolRequest', [{
      role: 'assistant',
      content: '',
      toolRequest: {
        requestId: 'private-request',
        toolName: 'builtin.files.list_files',
        arguments: { relativePath: '.' }
      }
    }]],
    ['额外字段', [{ role: 'user', content: '公开历史', privateTrace: '不得进入' }]]
  ])('可见历史拒绝%s', async (_name, visibleHistory) => {
    const harness = createHarness(new ScriptedProvider([]));

    await expect(harness.service.submitFileTask({
      text: '列出目录',
      visibleHistory: visibleHistory as readonly ModelMessage[]
    })).rejects.toMatchObject({ code: 'INPUT_INVALID' });

    expect(harness.createSession).not.toHaveBeenCalled();
    expect(harness.events.at(-2)).toEqual(expect.objectContaining({
      type: 'error',
      code: 'INPUT_INVALID'
    }));
  });

  test('首次等待前复制可见历史，调用方后续篡改不改变模型输入', async () => {
    const sessionGate = deferred();
    const provider = new ScriptedProvider([{
      type: 'text',
      text: '{"kind":"clarification_required","question":"请补充目标文件名"}'
    }]);
    const harness = createHarness(
      provider,
      {},
      true,
      [],
      undefined,
      undefined,
      async session => {
        await sessionGate.promise;
        return session;
      }
    );
    const historyMessage: ModelMessage = { role: 'user', content: '原始历史' };
    const visibleHistory: ModelMessage[] = [historyMessage];

    const submitting = harness.service.submitFileTask({
      text: '当前任务',
      visibleHistory
    });
    await vi.waitFor(() => expect(harness.createSession).toHaveBeenCalledOnce());
    historyMessage.content = '篡改后的历史';
    visibleHistory.push({ role: 'assistant', content: '迟到注入' });
    sessionGate.resolve();
    await submitting;

    expect(provider.requests[0]?.messages).toEqual([
      { role: 'user', content: '原始历史' },
      { role: 'user', content: '当前任务' }
    ]);
  });

  test('行为意图只调用内部回调且不广播到 Renderer 任务事件', async () => {
    const emitBehaviorIntent = vi.fn();
    const { events, service } = createHarness(
      new ScriptedProvider([readResponse(), {
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

    await service.submitFileTask({ text: '处理任务', visibleHistory: [] });

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
    const fetchClient = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: 'read-1',
              type: 'function',
              function: {
                name: 'builtin.files.list_files',
                arguments: '{"relativePath":"."}'
              }
            }]
          }
        }]
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{
          message: {
            content: '处理完成',
            metadata: { emotion: 'happy' }
          }
        }]
      }), { status: 200 }));
    const provider = new OpenAICompatibleProvider(
      { baseUrl: 'https://provider.example/v1', modelId: 'test-model' },
      async () => 'secret',
      fetchClient
    );
    const harness = createHarness(
      provider,
      {},
      true,
      [],
      event => store.getState().apply(event)
    );
    const apply = vi.spyOn(store.getState(), 'apply');

    await harness.service.submitFileTask({ text: '处理任务', visibleHistory: [] });

    expect(harness.events).toEqual([
      { type: 'phase', phase: 'thinking' },
      { type: 'phase', phase: 'acting' },
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
    const { events, service } = createHarness(new ScriptedProvider([readResponse(), {
      type: 'text',
      text: '完成',
      emotion: 'happy'
    }]));
    await service.submitFileTask({ text: '处理任务', visibleHistory: [] });
    expect(events).toContainEqual({
      type: 'character_emotion',
      label: 'happy'
    });
  });

  test('主模型可重试失败耗尽后改用备用模型完成当前 Agent 请求', async () => {
    const firstError = Object.assign(new Error('PRIMARY_DOWN'), { retryable: true });
    const secondError = Object.assign(new Error('PRIMARY_DOWN'), { retryable: true });
    const primary = new ScriptedProvider([firstError, secondError]);
    const fallback = new ScriptedProvider([
      readResponse(),
      { type: 'text', text: '备用模型已响应' }
    ]);
    const { events, service } = createHarness(primary, {}, true, [fallback]);

    await service.submitFileTask({ text: '继续任务', visibleHistory: [] });

    expect(primary.requests).toHaveLength(2);
    expect(fallback.requests).toHaveLength(2);
    expect(events).toContainEqual({
      type: 'message',
      role: 'assistant',
      text: '备用模型已响应'
    });
  });

  test('非空可见历史绑定主 Provider，主模型失败时绝不披露给备用 Provider', async () => {
    const firstError = Object.assign(new Error('PRIMARY_DOWN'), { retryable: true });
    const secondError = Object.assign(new Error('PRIMARY_DOWN'), { retryable: true });
    const primary = new ScriptedProvider([firstError, secondError]);
    const fallback = new ScriptedProvider([{ type: 'text', text: '不得收到历史' }]);
    const { service } = createHarness(primary, {}, true, [fallback]);

    await expect(service.submitFileTask({
      text: '继续任务',
      visibleHistory: [{ role: 'user', content: '仅授权给主 Provider 的历史' }]
    })).rejects.toThrow('PRIMARY_DOWN');

    expect(primary.requests).toHaveLength(2);
    expect(fallback.requests).toEqual([]);
  });

  test('文件分类未授权时拒绝历史写请求进入预览和执行', async () => {
    const { events, fileTools, service } = createHarness(
      new ScriptedProvider([writeResponse()]),
      {},
      false
    );

    await expect(service.submitFileTask({ text: '创建 result.txt', visibleHistory: [] })).rejects.toThrow(
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
          toolName: 'builtin.files.list_files',
          arguments: { relativePath: '.' }
        }
      },
      { type: 'text', text: '目录为空' }
    ]);
    const { events, fileTools, service } = createHarness(provider);

    await service.submitFileTask({ text: '列出目录', visibleHistory: [] });

    expect(fileTools.executeRead).toHaveBeenCalledOnce();
    expect(phases(events)).toEqual(['thinking', 'acting', 'success']);
    expect(events).toContainEqual({ type: 'message', role: 'assistant', text: '目录为空' });
  });

  test('写请求只发布公开预览并进入等待确认', async () => {
    const { events, fileTools, service } = createHarness(
      new ScriptedProvider([writeResponse()])
    );

    await service.submitFileTask({ text: '创建 result.txt', visibleHistory: [] });

    expect(phases(events)).toEqual(['thinking', 'awaiting_confirmation']);
    expect(events.at(-1)).toEqual({
      type: 'pending_action',
      action: expect.objectContaining({
        category: 'file',
        conversationId: 'conversation-1',
        risk: 'write',
        operation: 'create_file',
        targetRelativePath: 'result.txt',
        contentCharacters: 2,
        contentPreview: '正文',
        previewTruncated: false
      })
    });
    expect(events.at(-1)).not.toHaveProperty('action.requestId');
    expect(JSON.stringify(events)).not.toContain('continuationToken');
    expect(JSON.stringify(events)).not.toContain('executionRequest');
    expect(JSON.stringify(events)).not.toContain('authorizationGeneration');
    expect(fileTools.preview).toHaveBeenCalledExactlyOnceWith({
      requestId: 'write-1',
      toolName: 'create_file',
      arguments: { relativePath: 'result.txt', content: '正文' }
    });
  });

  test('确认后只写一次并恢复模型总结', async () => {
    const provider = new ScriptedProvider([
      writeResponse(),
      { type: 'text', text: 'result.txt 已创建' }
    ]);
    const { events, fileTools, service } = createHarness(provider);
    await service.submitFileTask({ text: '创建 result.txt', visibleHistory: [] });
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
    await harness.service.submitFileTask({ text: '把 old.txt 移入回收站', visibleHistory: [] });
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
    await harness.service.submitFileTask({ text: '移入回收站', visibleHistory: [] });
    const pendingEvent = harness.events.find(event => event.type === 'pending_action');
    if (!pendingEvent || pendingEvent.type !== 'pending_action') throw new Error('缺少确认事件');

    const confirming = harness.service.confirm(pendingEvent.action.actionId);
    await Promise.resolve();
    expect(harness.service.onPlaybackStarted('carry-token-1', 'carry-action-1')).toBe(true);
    expect(harness.service.onPlaybackStarted('carry-token-1', 'carry-action-1')).toBe(false);
    await confirming;

    expect(harness.fileTools.executeWrite).toHaveBeenCalledOnce();
  });

  test('回收站端口失败保留 RECYCLE_BIN_FAILED 并发布稳定下一步建议', async () => {
    const harness = createHarness(
      new ScriptedProvider([writeResponse()]),
      {
        preview: vi.fn(async () => recycleAction()),
        executeWrite: vi.fn(async () => {
          throw new FileToolError('RECYCLE_BIN_FAILED', 'C:\\private\\secret.txt');
        })
      }
    );
    await harness.service.submitFileTask({ text: '移入回收站', visibleHistory: [] });
    const pendingEvent = harness.events.find(event => event.type === 'pending_action');
    if (!pendingEvent || pendingEvent.type !== 'pending_action') throw new Error('缺少确认事件');

    const confirming = harness.service.confirm(pendingEvent.action.actionId);
    await Promise.resolve();
    harness.service.onPlaybackStarted('carry-token-1', 'carry-action-1');
    harness.service.onCommitFrame('carry-token-1', 'carry-action-1', 'carry-frame-1');

    await expect(confirming).rejects.toMatchObject({ code: 'RECYCLE_BIN_FAILED' });
    expect(harness.events.filter(event => event.type === 'error')).toEqual([{
      type: 'error',
      code: 'RECYCLE_BIN_FAILED',
      message: '无法将目标移入 Windows 回收站，原目标仍保留。',
      nextAction: '请检查目标是否被占用或 Windows 回收站是否可用后重试。'
    }]);
    expect(JSON.stringify(harness.events)).not.toContain('private');
    expect(phases(harness.events).filter(phase => phase === 'error')).toHaveLength(1);
  });

  test('回收站提交前取消会丢弃续跑且永不执行文件动作', async () => {
    const harness = createHarness(
      new ScriptedProvider([writeResponse()]),
      { preview: vi.fn(async () => recycleAction()) }
    );
    const discard = vi.spyOn(harness.loop, 'discard');
    await harness.service.submitFileTask({ text: '移入回收站', visibleHistory: [] });
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
    await harness.service.submitFileTask({ text: '移入回收站', visibleHistory: [] });
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
    await harness.service.submitFileTask({ text: '移入回收站', visibleHistory: [] });
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
      await harness.service.submitFileTask({ text: '移入回收站', visibleHistory: [] });
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
    await harness.service.submitFileTask({ text: '移入回收站', visibleHistory: [] });
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
    const submitting = service.submitFileTask({ text: '等待模型', visibleHistory: [] });
    await vi.waitFor(() => expect(provider.respond).toHaveBeenCalledOnce());

    service.cancelActive();
    await submitting;

    expect(phases(events)).toEqual(['thinking', 'cancelled']);
  });

  test('reset 先隔离不服从 AbortSignal 的 Provider，迟到回复不得穿透新会话', async () => {
    const provider = new DeferredProvider();
    const harness = createHarness(provider);
    const submitting = harness.service.submitFileTask({ text: '旧任务', visibleHistory: [] });
    await vi.waitFor(() => expect(provider.requests).toHaveLength(1));

    const resetting = (harness.service as unknown as {
      resetForNewConversation(): Promise<void>;
    }).resetForNewConversation();
    let resetSettled = false;
    void resetting.then(() => {
      resetSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(resetSettled).toBe(true);
    provider.resolve({ type: 'text', text: '不得进入新会话' });
    await resetting;
    await submitting;

    expect(harness.events).not.toContainEqual({
      type: 'message',
      role: 'assistant',
      text: '不得进入新会话'
    });
  });

  test('reset 在等待文件确认时丢弃 continuation，旧 actionId 永久失效', async () => {
    const harness = createHarness(new ScriptedProvider([writeResponse()]));
    const discard = vi.spyOn(harness.loop, 'discard');
    await harness.service.submitFileTask({ text: '创建 result.txt', visibleHistory: [] });
    const pendingEvent = harness.events.find(event => event.type === 'pending_action');
    if (!pendingEvent || pendingEvent.type !== 'pending_action') throw new Error('缺少确认事件');

    await (harness.service as unknown as {
      resetForNewConversation(): Promise<void>;
    }).resetForNewConversation();

    expect(discard).toHaveBeenCalledOnce();
    await expect(harness.service.confirm(pendingEvent.action.actionId)).rejects
      .toThrow('ACTION_EXPIRED');
    expect(harness.fileTools.executeWrite).not.toHaveBeenCalled();
  });

  test('reset 在动画提交前撤销事务并等待确认流程真实收敛', async () => {
    const harness = createHarness(
      new ScriptedProvider([writeResponse()]),
      { preview: vi.fn(async () => recycleAction()) }
    );
    const discard = vi.spyOn(harness.loop, 'discard');
    await harness.service.submitFileTask({ text: '移入回收站', visibleHistory: [] });
    const pendingEvent = harness.events.find(event => event.type === 'pending_action');
    if (!pendingEvent || pendingEvent.type !== 'pending_action') throw new Error('缺少确认事件');
    const confirming = harness.service.confirm(pendingEvent.action.actionId);
    await Promise.resolve();

    await (harness.service as unknown as {
      resetForNewConversation(): Promise<void>;
    }).resetForNewConversation();

    await expect(confirming).rejects.toThrow('FILE_TASK_USER_CANCELLED');
    expect(discard).toHaveBeenCalledOnce();
    expect(harness.fileTools.executeWrite).not.toHaveBeenCalled();
    expect(harness.service.onCommitFrame(
      'carry-token-1',
      'carry-action-1',
      'carry-frame-1'
    )).toBe(false);
  });

  test.each(['acting', 'carrying'] as const)(
    '普通写在 %s 事件监听器同步 reset 后不得越过不可逆写边界',
    async resetAt => {
      let service!: AgentService;
      let resetting: Promise<void> | null = null;
      const harness = createHarness(
        new ScriptedProvider([writeResponse(), { type: 'text', text: '不得公开旧总结' }]),
        {},
        true,
        [],
        event => {
          const matched = resetAt === 'acting'
            ? event.type === 'phase' && event.phase === 'acting'
            : event.type === 'character_carrying' && event.carrying;
          if (matched && resetting === null) resetting = service.resetForNewConversation();
        }
      );
      service = harness.service;
      const discard = vi.spyOn(harness.loop, 'discard');
      await service.submitFileTask({ text: '创建 result.txt', visibleHistory: [] });
      const pendingEvent = harness.events.find(event => event.type === 'pending_action');
      if (!pendingEvent || pendingEvent.type !== 'pending_action') throw new Error('缺少确认事件');

      const confirming = service.confirm(pendingEvent.action.actionId);

      await expect(confirming).rejects.toThrow('FILE_TASK_USER_CANCELLED');
      await resetting;
      expect(harness.fileTools.executeWrite).not.toHaveBeenCalled();
      expect(discard).toHaveBeenCalledOnce();
      expect(harness.events).not.toContainEqual({
        type: 'message',
        role: 'assistant',
        text: '不得公开旧总结'
      });
      expect(phases(harness.events).slice(-1)).toEqual(['acting']);
    }
  );

  test('reset 遇到不可逆执行时等待真实结果，但屏蔽旧总结和终态事件', async () => {
    const execution = deferred();
    const harness = createHarness(
      new ScriptedProvider([writeResponse(), { type: 'text', text: '旧总结不得公开' }]),
      {
        preview: vi.fn(async () => recycleAction()),
        executeWrite: vi.fn(() => execution.promise)
      }
    );
    await harness.service.submitFileTask({ text: '移入回收站', visibleHistory: [] });
    const pendingEvent = harness.events.find(event => event.type === 'pending_action');
    if (!pendingEvent || pendingEvent.type !== 'pending_action') throw new Error('缺少确认事件');
    const confirming = harness.service.confirm(pendingEvent.action.actionId);
    await Promise.resolve();
    harness.service.onPlaybackStarted('carry-token-1', 'carry-action-1');
    harness.service.onCommitFrame('carry-token-1', 'carry-action-1', 'carry-frame-1');
    await vi.waitFor(() => expect(harness.fileTools.executeWrite).toHaveBeenCalledOnce());

    let resetSettled = false;
    const resetting = (harness.service as unknown as {
      resetForNewConversation(): Promise<void>;
    }).resetForNewConversation().then(() => {
      resetSettled = true;
    });
    await Promise.resolve();
    expect(resetSettled).toBe(false);
    execution.resolve();
    await resetting;
    await confirming.catch(() => undefined);

    expect(harness.events).not.toContainEqual({
      type: 'message',
      role: 'assistant',
      text: '旧总结不得公开'
    });
    expect(harness.fileTools.executeWrite).toHaveBeenCalledOnce();
  });

  test('Provider 失败会发送公开错误和 error 终止阶段', async () => {
    const providerError = Object.assign(new Error('private details'), {
      code: 'PROVIDER_AUTHENTICATION_FAILED',
      retryable: false
    });
    const { events, service } = createHarness(new ScriptedProvider([providerError]));

    await expect(service.submitFileTask({ text: '调用模型', visibleHistory: [] })).rejects.toThrow('private details');
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
      readResponse(),
      { type: 'text', text: '重试成功' }
    ]);
    const { events, service } = createHarness(provider);

    await service.submitFileTask({ text: '调用模型', visibleHistory: [] });

    expect(provider.requests).toHaveLength(3);
    expect(events).toContainEqual({ type: 'message', role: 'assistant', text: '重试成功' });
    expect(phases(events)).toEqual(['thinking', 'acting', 'success']);
  });

  test('无效输入返回明确的公开错误码', async () => {
    const { events, service } = createHarness(new ScriptedProvider([]));

    await expect(service.submitFileTask({ text: '   ', visibleHistory: [] })).rejects.toThrow('INPUT_INVALID');

    expect(events.at(-2)).toEqual(expect.objectContaining({ type: 'error', code: 'INPUT_INVALID' }));
    expect(events.at(-1)).toEqual({ type: 'phase', phase: 'error' });
  });

  test.each([null, undefined])('空结构输入 %s 稳定映射为 INPUT_INVALID', async input => {
    const { events, service } = createHarness(new ScriptedProvider([]));

    await expect(service.submitFileTask(input as never)).rejects.toMatchObject({
      code: 'INPUT_INVALID'
    });

    expect(events.at(-2)).toEqual(expect.objectContaining({
      type: 'error',
      code: 'INPUT_INVALID'
    }));
    expect(events.at(-1)).toEqual({ type: 'phase', phase: 'error' });
  });

  test('无效写路径在预览阶段失败并丢弃续跑状态', async () => {
    const { events, loop, service } = createHarness(
      new ScriptedProvider([writeResponse()]),
      { preview: vi.fn(async () => { throw new FileToolError('PATH_INVALID', '路径无效'); }) }
    );
    const discard = vi.spyOn(loop, 'discard');

    await expect(service.submitFileTask({ text: '创建越界文件', visibleHistory: [] })).rejects.toThrow('路径无效');

    expect(discard).toHaveBeenCalledOnce();
    expect(events.at(-2)).toEqual(expect.objectContaining({ type: 'error', code: 'PATH_INVALID' }));
    expect(events.at(-1)).toEqual({ type: 'phase', phase: 'error' });
  });

  test.each([
    ['ENTRY_CHANGED', '文件在确认后发生变化，未执行操作。', '请重新发起文件操作并确认最新内容。'],
    ['ENTRY_TYPE_UNSUPPORTED', '该文件类型或目录状态不支持此操作。', '请选择普通文本文件、普通文件或空目录后重试。'],
    ['LINK_NOT_ALLOWED', '不允许对符号链接或 Junction 执行此文件操作。', '请选择授权目录内的普通文件或目录。'],
    ['RECYCLE_BIN_FAILED', '无法将目标移入 Windows 回收站，原目标仍保留。', '请检查目标是否被占用或 Windows 回收站是否可用后重试。']
  ] as const)(
    '文件错误 %s 使用稳定脱敏消息和下一步建议',
    async (code, message, nextAction) => {
      const { events, service } = createHarness(
        new ScriptedProvider([writeResponse()]),
        { preview: vi.fn(async () => { throw new FileToolError(code, 'C:\\private\\secret.txt'); }) }
      );

      await expect(service.submitFileTask({ text: '处理文件', visibleHistory: [] })).rejects
        .toMatchObject({ code });

      expect(events.at(-2)).toEqual({ type: 'error', code, message, nextAction });
      expect(JSON.stringify(events)).not.toContain('private');
      expect(events.at(-1)).toEqual({ type: 'phase', phase: 'error' });
    }
  );

  test('目标冲突不会恢复模型且产生 error 终止阶段', async () => {
    const provider = new ScriptedProvider([writeResponse()]);
    const { events, fileTools, service } = createHarness(provider, {
      executeWrite: vi.fn(async () => {
        throw new FileToolError('TARGET_EXISTS', '目标已经存在');
      })
    });
    await service.submitFileTask({ text: '创建 result.txt', visibleHistory: [] });
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
    await service.submitFileTask({ text: '创建 result.txt', visibleHistory: [] });
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
