import { describe, expect, test, vi } from 'vitest';
import {
  AgentLoop,
  CAPABILITY_CLARIFICATION_TOOL_NAME
} from '@myself/agent-core';
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
import { createBuiltinAgentToolRegistry } from '../src/main/agent/tool-registry';
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

function deleteResponse(): ModelResponse {
  return {
    type: 'tool_request',
    request: {
      requestId: 'delete-1',
      toolName: 'builtin.files.delete_file',
      arguments: { relativePath: 'archive/old.txt' }
    }
  };
}

function moveResponse(requestId = 'move-1'): ModelResponse {
  return {
    type: 'tool_request',
    request: {
      requestId,
      toolName: 'builtin.files.move_file',
      arguments: {
        sourceRelativePath: 'docs/source.txt',
        targetDirectoryRelativePath: 'archive'
      }
    }
  };
}

function moveAction(): VerifiedWriteAction {
  return Object.freeze({
    operation: 'move_file' as const,
    authorizationGeneration: 0,
    sourceRelativePath: 'docs/source.txt',
    targetDirectoryRelativePath: 'archive',
    targetRelativePath: 'archive/source.txt'
  });
}

function patchAction(targetRelativePath = 'result.txt'): VerifiedWriteAction {
  return Object.freeze({
    operation: 'apply_patch' as const,
    authorizationGeneration: 0,
    targetRelativePath,
    addedLines: 1,
    removedLines: 1,
    diffPreview: '-旧\n+新',
    previewTruncated: false
  });
}

function createHarness(
  provider: ModelProvider,
  fileOverrides: Partial<AgentFileTools> = {},
  legacyFileDisclosureAllowed = true,
  fallbackProviders: ModelProvider[] = [],
  onEmit?: (event: TaskEvent) => void,
  emitBehaviorIntent?: (intent: CharacterAgentBehaviorIntent) => void,
  createSessionOverride?: (session: AgentSession) => Promise<AgentSession>,
  emitTrustedToolResult?: import('../src/main/agent/agent-service').AgentServiceOptions[
    'emitTrustedToolResult'
  ],
  pendingNow?: () => number
) {
  const events: TaskEvent[] = [];
  const loop = new AgentLoop();
  const fileTools: AgentFileTools = {
    executeRead: vi.fn(async () => ({ entries: [] })),
    preview: vi.fn(async () => verifiedAction()),
    executeWrite: vi.fn(async () => undefined),
    ...fileOverrides
  };
  const registry = createBuiltinAgentToolRegistry();
  const permissionPolicy = new PermissionPolicy({ highRiskEnabled: false });
  const session: AgentSession & { fileDisclosureAllowed?: boolean } = {
    taskKind: 'agent',
    initialCapability: 'file',
    provider,
    fallbackProviders,
    fileTools,
    powershell: { close: vi.fn(async () => undefined) } as unknown as PowerShellTool,
    workingDirectory: 'C:\\workspace',
    workingDirectoryLabel: '工作区',
    generation: 'generation-1',
    tools: registry.definitions(),
    toolRuntime: {
      prepare: raw => registry.prepare(raw, permissionPolicy),
      executeRead: request => fileTools.executeRead(request)
    },
    messages: []
  };
  const pending = new PendingActionStore({
    ...(pendingNow === undefined ? {} : { now: pendingNow }),
    onDiscard: execution => loop.discard(execution.continuationToken)
  });
  if (!legacyFileDisclosureAllowed) session.fileDisclosureAllowed = false;
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
    ...(emitTrustedToolResult === undefined ? {} : { emitTrustedToolResult }),
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
    session
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

const allFilePlanningToolNames = [
  'builtin.files.list_files',
  'builtin.files.read_file',
  'builtin.files.glob_files',
  'builtin.files.grep_files',
  'builtin.files.create_file',
  'builtin.files.move_file',
  'builtin.files.create_directory',
  'builtin.files.apply_patch',
  'builtin.files.edit_file',
  'builtin.files.delete_file',
  CAPABILITY_CLARIFICATION_TOOL_NAME
] as const;

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
  powershell: Pick<PowerShellTool, 'preview' | 'execute'> & Partial<Pick<PowerShellTool, 'close'>>,
  emitTrustedToolResult?: import('../src/main/agent/agent-service').AgentServiceOptions[
    'emitTrustedToolResult'
  ]
) {
  const events: TaskEvent[] = [];
  const loop = new AgentLoop();
  const pending = new PendingActionStore({
    onDiscard: execution => loop.discard(execution.continuationToken)
  });
  const registry = createBuiltinAgentToolRegistry();
  const fileTools: AgentFileTools = {
    executeRead: vi.fn(),
    preview: vi.fn(),
    executeWrite: vi.fn()
  };
  const session: AgentSession = {
    taskKind: 'agent',
    initialCapability: 'powershell',
    provider,
    fileTools,
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
    ...(emitTrustedToolResult === undefined ? {} : { emitTrustedToolResult }),
    createConversationId: () => 'conversation-1'
  });
  return { events, provider, service };
}

describe('AgentService', () => {
  test('同一 AgentService 的事务后续复用同一 AgentSession', async () => {
    const provider = new ScriptedProvider([
      readResponse(),
      { type: 'text', text: '首次读取完成。' },
      readResponse(),
      { type: 'text', text: '后续读取完成。' }
    ]);
    const harness = createHarness(provider);

    await harness.service.submitFileTask({ text: '读取 test.txt', visibleHistory: [] });
    await harness.service.submitFileTask({ text: '继续读取该文件', visibleHistory: [] });

    expect(harness.createSession).toHaveBeenCalledOnce();
  });

  test('4000 字符用户原文与 1200 字符私有规划上下文使用独立预算和消息', async () => {
    const provider = new ScriptedProvider([
      readResponse(),
      { type: 'text', text: '读取完成。' }
    ]);
    const harness = createHarness(provider);
    const text = 'a'.repeat(4_000);
    const privatePlanningContext = 'p'.repeat(1_200);

    await harness.service.submitFileTask({
      text,
      visibleHistory: [],
      privatePlanningContext
    });

    expect(provider.requests[0]?.messages.at(-1)).toEqual({ role: 'user', content: text });
    expect(provider.requests[0]?.messages).toContainEqual({
      role: 'system',
      content: `任务内私有规划上下文：${privatePlanningContext}`
    });
  });

  test.each([
    ['成功', true],
    ['失败', false]
  ] as const)('PowerShell %s只发布脱敏 Main 私有结果', async (_label, ok) => {
    const trustedResults: import('../src/main/agent/agent-service').AgentTrustedToolResult[] = [];
    const provider = new ScriptedProvider([
      shellRequest(),
      { type: 'text', text: ok ? '命令完成。' : '命令失败。' }
    ]);
    const action = powerShellAction();
    const { events, service } = createPowerShellHarness(provider, {
      preview: vi.fn(() => action),
      execute: vi.fn(async () => ({
        ...powerShellResult(ok),
        stdout: '不得进入私有结果的输出',
        stderr: ok ? '' : '不得进入私有结果的错误输出'
      }))
    }, result => trustedResults.push(result));

    await service.submitFileTask({ text: '运行私有命令', visibleHistory: [] });
    const pending = events.find(event => event.type === 'pending_action');
    if (!pending || pending.type !== 'pending_action') throw new Error('缺少 PowerShell 确认');
    await service.confirm(pending.action.actionId);

    expect(trustedResults).toEqual([{
      toolName: 'powershell',
      ok,
      relativePaths: []
    }]);
    expect(JSON.stringify(trustedResults)).not.toContain('私有命令');
    expect(JSON.stringify(trustedResults)).not.toContain('不得进入私有结果');
  });

  test('只读真实成功只向 Main 私有端口发布一次脱敏相对路径结果', async () => {
    const trustedResults: import('../src/main/agent/agent-service').AgentTrustedToolResult[] = [];
    const provider = new ScriptedProvider([
      readResponse(),
      { type: 'text', text: '读取完成' }
    ]);
    const harness = createHarness(
      provider,
      { executeRead: vi.fn(async () => ({
        toolName: 'list_files',
        relativePath: '.',
        entries: [
          { relativePath: 'docs/test.txt', type: 'file' },
          { relativePath: 'C:\\private.txt', type: 'file' }
        ],
        content: '不得进入私有结果端口的正文',
        truncated: false
      })) },
      true,
      [],
      undefined,
      undefined,
      undefined,
      result => trustedResults.push(result)
    );

    await harness.service.submitFileTask({ text: '列出文件', visibleHistory: [] });

    expect(trustedResults).toEqual([{
      toolName: 'list_files',
      ok: true,
      relativePaths: ['.', 'docs/test.txt']
    }]);
    expect(JSON.stringify(harness.events)).not.toContain('relativePaths');
    expect(JSON.stringify(harness.events)).not.toContain('docs/test.txt');
  });

  test('确认写真实成功只向 Main 私有端口发布一次目标相对路径', async () => {
    const trustedResults: import('../src/main/agent/agent-service').AgentTrustedToolResult[] = [];
    const provider = new ScriptedProvider([
      writeResponse(),
      { type: 'text', text: '创建完成' }
    ]);
    const harness = createHarness(
      provider,
      {},
      true,
      [],
      undefined,
      undefined,
      undefined,
      result => trustedResults.push(result)
    );

    await harness.service.submitFileTask({ text: '创建 result.txt', visibleHistory: [] });
    const pending = harness.events.find(event => event.type === 'pending_action');
    if (!pending || pending.type !== 'pending_action') throw new Error('缺少创建确认卡');
    await harness.service.confirm(pending.action.actionId);

    expect(trustedResults).toEqual([{
      toolName: 'create_file',
      ok: true,
      relativePaths: ['result.txt']
    }]);
    expect(JSON.stringify(harness.events)).not.toContain('relativePaths');
  });

  test('失败、取消和过期写动作都不向私有端口发布成功结果', async () => {
    const trustedResults: import('../src/main/agent/agent-service').AgentTrustedToolResult[] = [];
    const failed = createHarness(
      new ScriptedProvider([writeResponse(), { type: 'text', text: '失败已处理' }]),
      { executeWrite: vi.fn(async () => { throw new FileToolError('TARGET_EXISTS', 'private'); }) },
      true,
      [],
      undefined,
      undefined,
      undefined,
      result => trustedResults.push(result)
    );
    await failed.service.submitFileTask({ text: '创建 result.txt', visibleHistory: [] });
    const failedPending = failed.events.find(event => event.type === 'pending_action');
    if (!failedPending || failedPending.type !== 'pending_action') throw new Error('缺少失败确认卡');
    await failed.service.confirm(failedPending.action.actionId);

    const cancelled = createHarness(
      new ScriptedProvider([writeResponse()]),
      {}, true, [], undefined, undefined, undefined,
      result => trustedResults.push(result)
    );
    await cancelled.service.submitFileTask({ text: '创建 result.txt', visibleHistory: [] });
    const cancelledPending = cancelled.events.find(event => event.type === 'pending_action');
    if (!cancelledPending || cancelledPending.type !== 'pending_action') throw new Error('缺少取消确认卡');
    cancelled.service.cancelAction(cancelledPending.action.actionId);

    await expect(cancelled.service.confirm(cancelledPending.action.actionId))
      .rejects.toThrow('ACTION_EXPIRED');
    expect(trustedResults.filter(result => result.ok)).toEqual([]);
  });

  test('确认卡真实 TTL 到期后拒绝执行且不发布私有成功结果', async () => {
    let now = 0;
    const trustedResults: import('../src/main/agent/agent-service').AgentTrustedToolResult[] = [];
    const harness = createHarness(
      new ScriptedProvider([writeResponse()]),
      {},
      true,
      [],
      undefined,
      undefined,
      undefined,
      result => trustedResults.push(result),
      () => now
    );
    await harness.service.submitFileTask({ text: '创建 expired.txt', visibleHistory: [] });
    const pending = harness.events.find(event => event.type === 'pending_action');
    if (!pending || pending.type !== 'pending_action') throw new Error('缺少待过期确认卡');

    now = 120_000;
    await expect(harness.service.confirm(pending.action.actionId)).rejects.toThrow('ACTION_EXPIRED');

    expect(harness.fileTools.executeWrite).not.toHaveBeenCalled();
    expect(trustedResults.filter(result => result.ok)).toEqual([]);
  });
  test('旧文件披露值为 false 时创建文件确认后的续跑仍公告完整文件工具', async () => {
    const provider = new ScriptedProvider([
      writeResponse(),
      { type: 'text', text: '文件已创建' }
    ]);
    const { events, service } = createHarness(provider, {}, false);

    await service.submitFileTask({
      text: '创建 result.txt',
      visibleHistory: [],
      planningHint: { operation: 'create_file' }
    });
    const pendingEvent = events.find(event => event.type === 'pending_action');
    if (!pendingEvent || pendingEvent.type !== 'pending_action') throw new Error('缺少文件确认');
    await service.confirm(pendingEvent.action.actionId);

    expect(provider.requests[1]?.tools.map(tool => tool.function.name)).toEqual(expect.arrayContaining([
      'builtin.files.read_file',
      'builtin.files.edit_file',
      'builtin.files.move_file'
    ]));
  });

  test('PowerShell 首轮仅公告命令工具，首个可信结果后恢复完整组合工具面', async () => {
    const provider = new ScriptedProvider([
      shellRequest(),
      { type: 'text', text: '命令执行完毕' }
    ]);
    const powershell = {
      preview: vi.fn(() => powerShellAction()),
      execute: vi.fn(async () => powerShellResult(true))
    };
    const { events, service } = createPowerShellHarness(provider, powershell);

    await service.submitFileTask({ text: '运行 Get-ChildItem', visibleHistory: [] });
    const pendingEvent = events.find(event => event.type === 'pending_action');
    if (!pendingEvent || pendingEvent.type !== 'pending_action') throw new Error('缺少 PowerShell 确认');
    await service.confirm(pendingEvent.action.actionId);

    expect(provider.requests[0]?.tools.map(tool => tool.function.name)).toEqual([
      'builtin.powershell.run'
    ]);
    expect(provider.requests[1]?.tools.map(tool => tool.function.name)).toEqual(expect.arrayContaining([
      'builtin.powershell.run',
      'builtin.files.read_file',
      'builtin.files.create_file'
    ]));
  });

  test('PowerShell 可信结果后恢复完整组合工具面', async () => {
    const provider = new ScriptedProvider([
      shellRequest(),
      { type: 'text', text: '命令执行完毕' }
    ]);
    const { events, service } = createPowerShellHarness(provider, {
      preview: vi.fn(() => powerShellAction()),
      execute: vi.fn(async () => powerShellResult(true))
    });

    await service.submitFileTask({ text: '运行命令后整理文件', visibleHistory: [] });
    const pending = events.find(event => event.type === 'pending_action');
    if (!pending || pending.type !== 'pending_action') throw new Error('缺少 PowerShell 确认');
    await service.confirm(pending.action.actionId);

    expect(provider.requests[0]?.tools.map(tool => tool.function.name)).toEqual([
      'builtin.powershell.run'
    ]);
    const continuationTools = provider.requests[1]?.tools.map(tool => tool.function.name) ?? [];
    expect(continuationTools).toEqual(expect.arrayContaining([
      'builtin.powershell.run',
      'builtin.files.list_files',
      'builtin.files.read_file',
      'builtin.files.glob_files',
      'builtin.files.grep_files',
      'builtin.files.create_file',
      'builtin.files.create_directory',
      'builtin.files.apply_patch',
      'builtin.files.edit_file',
      'builtin.files.delete_file',
      'builtin.files.move_file'
    ]));
  });

  test('错误创建提示不隐藏模型选择的移动工具，确认后只以 Main 结果恢复总结', async () => {
    const provider = new ScriptedProvider([
      moveResponse(),
      { type: 'text', text: 'source.txt 已移动' }
    ]);
    const { events, fileTools, service } = createHarness(provider, {
      preview: vi.fn(async () => moveAction())
    });

    await service.submitFileTask({
      text: '把 docs/source.txt 移动到 archive 文件夹',
      visibleHistory: [],
      planningHint: { operation: 'create_file' }
    });

    const planningTools = provider.requests[0]?.tools.map(tool => tool.function.name) ?? [];
    expect(planningTools).toContain('builtin.files.move_file');
    expect(planningTools).toContain('builtin.files.create_file');
    expect(planningTools).not.toContain('builtin.powershell.run');
    const pending = events.find(event => event.type === 'pending_action');
    if (!pending || pending.type !== 'pending_action') throw new Error('缺少移动确认卡');
    expect(pending.action).toMatchObject({
      operation: 'move_file',
      sourceRelativePath: 'docs/source.txt',
      targetRelativePath: 'archive/source.txt'
    });

    await service.confirm(pending.action.actionId);

    expect(fileTools.executeWrite).toHaveBeenCalledExactlyOnceWith(moveAction());
    expect(events).toContainEqual({ type: 'message', role: 'assistant', text: 'source.txt 已移动' });
  });

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

  test('失败 PowerShell 续跑后允许第二个命令进入独立确认', async () => {
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
    const preview = vi.fn(() => firstAction);
    const execute = vi.fn().mockResolvedValueOnce(powerShellResult(false));
    const { events, service } = createPowerShellHarness(provider, { preview, execute });

    await service.submitFileTask({ text: '运行命令', visibleHistory: [] });
    const firstPending = events.find(event => event.type === 'pending_action');
    if (!firstPending || firstPending.type !== 'pending_action') throw new Error('缺少首次确认');
    await service.confirm(firstPending.action.actionId);

    expect(execute).toHaveBeenCalledOnce();
    expect(events.filter(event => event.type === 'pending_action')).toHaveLength(2);
    expect(phases(events).at(-1)).toBe('awaiting_confirmation');
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
    const registry = createBuiltinAgentToolRegistry();
    const fileTools: AgentFileTools = {
      executeRead: vi.fn(),
      preview: vi.fn(),
      executeWrite: vi.fn()
    };
    const session: AgentSession = {
      taskKind: 'agent',
      initialCapability: 'powershell',
      provider,
      fileTools,
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

  test('文件任务在首次工具前按缺失字段公开宿主固定文案', async () => {
    const { events, service } = createHarness(new ScriptedProvider([{
      type: 'tool_request',
      request: {
        requestId: 'clarify-target-1',
        toolName: CAPABILITY_CLARIFICATION_TOOL_NAME,
        arguments: { missingField: 'target_path' }
      }
    }]));

    await service.submitFileTask({ text: '创建文件', visibleHistory: [] });

    expect(events).toEqual([
      { type: 'phase', phase: 'thinking' },
      { type: 'message', role: 'assistant', text: '请提供目标文件或目录的相对路径。' },
      { type: 'phase', phase: 'success' }
    ]);
  });

  test('宿主已确认目标路径缺失时只向模型公告结构化澄清工具', async () => {
    const provider = new ScriptedProvider([{
      type: 'tool_request',
      request: {
        requestId: 'clarify-target-only-1',
        toolName: CAPABILITY_CLARIFICATION_TOOL_NAME,
        arguments: { missingField: 'target_path' }
      }
    }]);
    const { service } = createHarness(provider);

    await service.submitFileTask({
      text: '删除一个文件，但我还没有提供目标路径。',
      visibleHistory: [],
      planningHint: { operation: 'delete_file', missingField: 'target_path' }
    });

    expect(provider.requests[0]?.tools.map(tool => tool.function.name)).toEqual([
      CAPABILITY_CLARIFICATION_TOOL_NAME
    ]);
  });

  test('等待确认时新文字任务会替换旧卡且不能冒充 actionId 确认', async () => {
    const provider = new ScriptedProvider([
      {
        type: 'tool_request',
        request: {
          requestId: 'delete-empty-1',
          toolName: 'builtin.files.delete_file',
          arguments: { relativePath: 'empty' }
        }
      },
      {
        type: 'tool_request',
        request: {
          requestId: 'clarify-target-2',
          toolName: CAPABILITY_CLARIFICATION_TOOL_NAME,
          arguments: { missingField: 'target_path' }
        }
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
      visibleHistory: [],
      planningHint: {
        operation: 'delete_file'
      }
    });

    expect(provider.requests[0]?.tools.map(tool => tool.function.name))
      .toEqual(allFilePlanningToolNames);
    expect(provider.requests[0]?.tools.map(tool => tool.function.name))
      .toContain(CAPABILITY_CLARIFICATION_TOOL_NAME);

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
    expect(provider.requests).toHaveLength(2);
    expect(harness.fileTools.executeWrite).not.toHaveBeenCalled();
  });

  test('创建 abc 文件夹只调用 create_directory 并生成专用确认卡', async () => {
    const provider = new ScriptedProvider([
      {
        type: 'tool_request',
        request: {
          requestId: 'create-directory-1',
          toolName: 'builtin.files.create_directory',
          arguments: { relativePath: 'abc' }
        }
      },
      { type: 'text', text: '目录创建完成' }
    ]);
    const directoryAction = Object.freeze({
      operation: 'create_directory' as const,
      authorizationGeneration: 0,
      targetRelativePath: 'abc'
    });
    const harness = createHarness(provider, {
      preview: vi.fn(async () => directoryAction)
    });

    await harness.service.submitFileTask({
      text: '在当前目录下创建一个名为abc的文件夹',
      visibleHistory: [],
      planningHint: {
        operation: 'create_directory'
      }
    });

    expect(provider.requests[0]?.tools.map(tool => tool.function.name))
      .toEqual(allFilePlanningToolNames);
    const pendingEvent = harness.events.at(-1);
    expect(pendingEvent).toEqual({
      type: 'pending_action',
      action: expect.objectContaining({
        operation: 'create_directory',
        summary: '创建目录 abc',
        targetRelativePath: 'abc'
      })
    });
    if (!pendingEvent || pendingEvent.type !== 'pending_action') throw new Error('缺少创建目录确认卡');
    await harness.service.confirm(pendingEvent.action.actionId);
    expect(harness.fileTools.executeWrite).toHaveBeenCalledWith(directoryAction);
    expect(harness.events).toContainEqual({
      type: 'message', role: 'assistant', text: '目录创建完成'
    });
    expect(phases(harness.events).at(-1)).toBe('success');
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
      type: 'tool_request',
      request: {
        requestId: 'clarify-reset-1',
        toolName: CAPABILITY_CLARIFICATION_TOOL_NAME,
        arguments: { missingField: 'target_path' }
      }
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
      type: 'tool_request',
      request: {
        requestId: 'clarify-cancel-1',
        toolName: CAPABILITY_CLARIFICATION_TOOL_NAME,
        arguments: { missingField: 'target_path' }
      }
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
      type: 'tool_request',
      request: {
        requestId: 'clarify-history-1',
        toolName: CAPABILITY_CLARIFICATION_TOOL_NAME,
        arguments: { missingField: 'target_path' }
      }
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
                name: 'builtin__files__list_files',
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

  test.each([
    {
      operation: 'create_file' as const,
      publicName: 'builtin.files.create_file',
      arguments: { relativePath: 'created.txt', content: '正文' },
      action: verifiedAction()
    },
    {
      operation: 'create_directory' as const,
      publicName: 'builtin.files.create_directory',
      arguments: { relativePath: 'created-directory' },
      action: Object.freeze({
        operation: 'create_directory' as const,
        authorizationGeneration: 0,
        targetRelativePath: 'created-directory'
      })
    },
    {
      operation: 'edit_file' as const,
      publicName: 'builtin.files.edit_file',
      arguments: { relativePath: 'result.txt', oldString: '旧', newString: '新' },
      action: Object.freeze({
        operation: 'apply_patch' as const,
        authorizationGeneration: 0,
        targetRelativePath: 'result.txt',
        addedLines: 1,
        removedLines: 1,
        diffPreview: '-旧\n+新',
        previewTruncated: false
      })
    },
    {
      operation: 'move_file' as const,
      publicName: 'builtin.files.move_file',
      arguments: {
        sourceRelativePath: 'docs/source.txt',
        targetDirectoryRelativePath: 'archive'
      },
      action: moveAction()
    },
    {
      operation: 'delete_file' as const,
      publicName: 'builtin.files.delete_file',
      arguments: { relativePath: 'archive/old.txt' },
      action: recycleAction()
    }
  ])('$operation 仍产生逐次确认并回注真实工具名', async testCase => {
    const provider = new ScriptedProvider([{
      type: 'tool_request',
      request: {
        requestId: `write-${testCase.operation}`,
        toolName: testCase.publicName,
        arguments: testCase.arguments
      }
    }, { type: 'text', text: `${testCase.operation} 已完成` }]);
    const { events, fileTools, service } = createHarness(provider, {
      preview: vi.fn(async () => testCase.action)
    });

    await service.submitFileTask({
      text: `执行 ${testCase.operation}`,
      visibleHistory: [],
      planningHint: { operation: testCase.operation }
    });
    const pendingEvent = events.find(event => event.type === 'pending_action');
    if (!pendingEvent || pendingEvent.type !== 'pending_action') throw new Error('缺少写操作确认卡');
    expect(fileTools.executeWrite).not.toHaveBeenCalled();

    await service.confirm(pendingEvent.action.actionId);

    expect(fileTools.executeWrite).toHaveBeenCalledWith(testCase.action);
    expect(JSON.parse((provider.requests[1]?.messages.at(-1) as Extract<ModelMessage, {
      role: 'tool';
    }>).content)).toMatchObject({
      ok: true,
      toolName: testCase.operation
    });
    expect(events.at(-1)).toEqual({ type: 'phase', phase: 'success' });
  });

  test.each([
    {
      operation: 'read_file' as const,
      publicName: 'builtin.files.read_file',
      internalName: 'read_file',
      arguments: { relativePath: 'notes.txt' }
    },
    {
      operation: 'glob_files' as const,
      publicName: 'builtin.files.glob_files',
      internalName: 'glob_files',
      arguments: { relativePath: '.', pattern: '**/*.txt' }
    },
    {
      operation: 'grep_files' as const,
      publicName: 'builtin.files.grep_files',
      internalName: 'grep_files',
      arguments: { relativePath: '.', pattern: 'needle' }
    }
  ])('$publicName 成功时以 $internalName 执行并回注同名事实', async testCase => {
    const provider = new ScriptedProvider([{
      type: 'tool_request',
      request: {
        requestId: `read-${testCase.internalName}`,
        toolName: testCase.publicName,
        arguments: testCase.arguments
      }
    }, { type: 'text', text: `${testCase.internalName} 已完成` }]);
    const executeRead = vi.fn(async () => ({
      toolName: testCase.internalName,
      relativePath: '.',
      truncated: false
    }));
    const { service } = createHarness(provider, { executeRead });

    await service.submitFileTask({
      text: `执行 ${testCase.operation}`,
      visibleHistory: [],
      planningHint: { operation: testCase.operation }
    });

    expect(executeRead).toHaveBeenCalledWith(expect.objectContaining({
      toolName: testCase.internalName
    }));
    expect(JSON.parse((provider.requests[1]?.messages.at(-1) as Extract<ModelMessage, {
      role: 'tool';
    }>).content)).toMatchObject({ toolName: testCase.internalName });
  });

  test.each([
    {
      operation: 'read_file' as const,
      publicName: 'builtin.files.read_file',
      internalName: 'read_file',
      arguments: { relativePath: 'missing.txt' },
      action: null
    },
    {
      operation: 'glob_files' as const,
      publicName: 'builtin.files.glob_files',
      internalName: 'glob_files',
      arguments: { relativePath: '.', pattern: '**/*.txt' },
      action: null
    },
    {
      operation: 'grep_files' as const,
      publicName: 'builtin.files.grep_files',
      internalName: 'grep_files',
      arguments: { relativePath: '.', pattern: 'needle' },
      action: null
    },
    {
      operation: 'create_file' as const,
      publicName: 'builtin.files.create_file',
      internalName: 'create_file',
      arguments: { relativePath: 'result.txt', content: '正文' },
      action: verifiedAction()
    },
    {
      operation: 'edit_file' as const,
      publicName: 'builtin.files.edit_file',
      internalName: 'edit_file',
      arguments: { relativePath: 'result.txt', oldString: '旧', newString: '新' },
      action: patchAction()
    },
    {
      operation: 'apply_patch' as const,
      publicName: 'builtin.files.apply_patch',
      internalName: 'apply_patch',
      arguments: {
        relativePath: 'result.txt',
        patch: '@@ -1 +1 @@\n-旧\n+新\n'
      },
      action: patchAction()
    },
    {
      operation: 'move_file' as const,
      publicName: 'builtin.files.move_file',
      internalName: 'move_file',
      arguments: {
        sourceRelativePath: 'docs/source.txt',
        targetDirectoryRelativePath: 'archive'
      },
      action: moveAction()
    },
    {
      operation: 'delete_file' as const,
      publicName: 'builtin.files.delete_file',
      internalName: 'delete_file',
      arguments: { relativePath: 'archive/old.txt' },
      action: recycleAction()
    }
  ])('$publicName 失败时也以 $internalName 回注且不得公开伪成功', async testCase => {
    const provider = new ScriptedProvider([{
      type: 'tool_request',
      request: {
        requestId: `failure-${testCase.internalName}`,
        toolName: testCase.publicName,
        arguments: testCase.arguments
      }
    }, { type: 'text', text: '模型伪称操作成功' }]);
    const fileFailure = new FileToolError('ENTRY_NOT_FOUND', 'C:\\private\\missing.txt');
    const { events, service } = createHarness(provider, {
      executeRead: vi.fn(async () => { throw fileFailure; }),
      preview: vi.fn(async () => {
        if (testCase.action === null) throw new Error('只读测试不应预览');
        return testCase.action;
      }),
      executeWrite: vi.fn(async () => { throw fileFailure; })
    });

    await service.submitFileTask({
      text: `执行 ${testCase.operation}`,
      visibleHistory: [],
      planningHint: { operation: testCase.operation }
    });
    const pendingEvent = events.find(event => event.type === 'pending_action');
    if (testCase.action !== null) {
      if (!pendingEvent || pendingEvent.type !== 'pending_action') throw new Error('缺少失败写操作确认卡');
      await service.confirm(pendingEvent.action.actionId);
    }

    expect(JSON.parse((provider.requests[1]?.messages.at(-1) as Extract<ModelMessage, {
      role: 'tool';
    }>).content)).toEqual({
      ok: false,
      toolName: testCase.internalName,
      code: 'ENTRY_NOT_FOUND'
    });
    expect(events).not.toContainEqual({
      type: 'message', role: 'assistant', text: '模型伪称操作成功'
    });
    expect(events.at(-1)).toEqual({ type: 'phase', phase: 'error' });
  });

  test('下一任务取消旧确认后可使用新的结构化写请求', async () => {
    const provider = new ScriptedProvider([
      {
        type: 'tool_request',
        request: {
          requestId: 'first-directory',
          toolName: 'builtin.files.create_directory',
          arguments: { relativePath: 'first-directory' }
        }
      },
      {
        type: 'tool_request',
        request: {
          requestId: 'second-directory',
          toolName: 'builtin.files.create_directory',
          arguments: { relativePath: 'second-directory' }
        }
      },
      {
        type: 'tool_request',
        request: {
          requestId: 'second-directory-retry',
          toolName: 'builtin.files.create_directory',
          arguments: { relativePath: 'second-directory' }
        }
      }
    ]);
    const { events, fileTools, service } = createHarness(provider, {
      preview: vi.fn(async () => Object.freeze({
        operation: 'create_directory' as const,
        authorizationGeneration: 0,
        targetRelativePath: 'first-directory'
      }))
    });

    await service.submitFileTask({
      text: '创建 first-directory',
      visibleHistory: [],
      planningHint: {
        operation: 'create_directory'
      }
    });
    const first = events.find(event => event.type === 'pending_action');
    if (!first || first.type !== 'pending_action') throw new Error('缺少首个确认卡');
    service.cancelAction(first.action.actionId);

    await service.submitFileTask({
      text: '创建 second-directory',
      visibleHistory: [],
      planningHint: { operation: 'create_directory' }
    });

    expect(fileTools.preview).toHaveBeenCalledTimes(2);
    expect(fileTools.executeWrite).not.toHaveBeenCalled();
  });

  test('取消会隔离迟到的明确创建响应', async () => {
    const provider = new DeferredProvider();
    const { fileTools, service } = createHarness(provider);
    const submitting = service.submitFileTask({
      text: '创建 private-directory', visibleHistory: [],
      planningHint: {
        operation: 'create_directory'
      }
    });
    await vi.waitFor(() => expect(provider.requests).toHaveLength(1));
    service.cancelActive();
    provider.resolve({
      type: 'tool_request',
      request: {
        requestId: 'late-private-directory', toolName: 'builtin.files.create_directory',
        arguments: { relativePath: 'private-directory' }
      }
    });

    await submitting;
    expect(fileTools.preview).not.toHaveBeenCalled();
    expect(fileTools.executeWrite).not.toHaveBeenCalled();
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

  test('edit_file 复用 apply_patch 确认卡，但向模型回注真实工具名', async () => {
    const provider = new ScriptedProvider([{
      type: 'tool_request',
      request: {
        requestId: 'edit-1',
        toolName: 'builtin.files.edit_file',
        arguments: {
          relativePath: 'result.txt',
          oldString: '旧文本',
          newString: '新文本'
        }
      }
    }, { type: 'text', text: 'result.txt 已修改' }]);
    const editAction: VerifiedWriteAction = Object.freeze({
      operation: 'apply_patch',
      authorizationGeneration: 0,
      targetRelativePath: 'result.txt',
      addedLines: 1,
      removedLines: 1,
      diffPreview: '-旧文本\n+新文本',
      previewTruncated: false
    });
    const harness = createHarness(provider, {
      preview: vi.fn(async () => editAction)
    });

    await harness.service.submitFileTask({
      text: '替换 result.txt 中的文本',
      visibleHistory: [],
      planningHint: { operation: 'edit_file' }
    });
    const pendingEvent = harness.events.find(event => event.type === 'pending_action');
    if (!pendingEvent || pendingEvent.type !== 'pending_action') throw new Error('缺少编辑确认卡');
    expect(pendingEvent.action.operation).toBe('apply_patch');

    await harness.service.confirm(pendingEvent.action.actionId);

    expect(provider.requests[1]?.messages.at(-1)).toEqual({
      role: 'tool',
      toolCallId: 'edit-1',
      content: '{"ok":true,"toolName":"edit_file","targetRelativePath":"result.txt"}'
    });
    expect(harness.fileTools.executeWrite).toHaveBeenCalledExactlyOnceWith(editAction);
  });

  test('当前角色没有搬运动作且角色反馈异常时删除确认仍立即执行并恢复模型总结', async () => {
    const provider = new ScriptedProvider([
      deleteResponse(),
      { type: 'text', text: 'old.txt 已移入回收站' }
    ]);
    const harness = createHarness(
      provider,
      { preview: vi.fn(async () => recycleAction()) },
      true,
      [],
      event => {
        if (event.type === 'character_carrying') throw new Error('角色反馈端口不可用');
      }
    );
    await harness.service.submitFileTask({ text: '把 old.txt 移入回收站', visibleHistory: [] });
    const pendingEvent = harness.events.find(event => event.type === 'pending_action');
    if (!pendingEvent || pendingEvent.type !== 'pending_action') throw new Error('缺少确认事件');

    await harness.service.confirm(pendingEvent.action.actionId);

    expect(harness.fileTools.executeWrite).toHaveBeenCalledExactlyOnceWith(recycleAction());
    expect(harness.events).toContainEqual({
      type: 'message',
      role: 'assistant',
      text: 'old.txt 已移入回收站'
    });
    expect(harness.events).not.toContainEqual(expect.objectContaining({
      type: 'error',
      code: 'AGENT_INTERNAL_ERROR'
    }));
  });

  test('回收站端口失败保留 RECYCLE_BIN_FAILED 并发布稳定下一步建议', async () => {
    const harness = createHarness(
      new ScriptedProvider([deleteResponse(), { type: 'text', text: '未能移入回收站' }]),
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

    await harness.service.confirm(pendingEvent.action.actionId);
    expect(harness.fileTools.executeWrite).toHaveBeenCalledExactlyOnceWith(recycleAction());
    expect(harness.events.filter(event => event.type === 'error')).toEqual([{
      type: 'error',
      code: 'RECYCLE_BIN_FAILED',
      message: '无法将目标移入 Windows 回收站，原目标仍保留。',
      nextAction: '请检查目标是否被占用或 Windows 回收站是否可用后重试。'
    }]);
    expect(JSON.stringify(harness.events)).not.toContain('private');
    expect(phases(harness.events).filter(phase => phase === 'error')).toHaveLength(1);
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
      new ScriptedProvider([deleteResponse(), { type: 'text', text: '旧总结不得公开' }]),
      {
        preview: vi.fn(async () => recycleAction()),
        executeWrite: vi.fn(() => execution.promise)
      }
    );
    await harness.service.submitFileTask({ text: '移入回收站', visibleHistory: [] });
    const pendingEvent = harness.events.find(event => event.type === 'pending_action');
    if (!pendingEvent || pendingEvent.type !== 'pending_action') throw new Error('缺少确认事件');
    const confirming = harness.service.confirm(pendingEvent.action.actionId);
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

  test('目标冲突安全回注后允许模型改参并通过第二张确认完成', async () => {
    const provider = new ScriptedProvider([
      writeResponse(),
      {
        type: 'tool_request',
        request: {
          requestId: 'write-2',
          toolName: 'builtin.files.create_file',
          arguments: { relativePath: 'result-2.txt', content: '正文' }
        }
      },
      { type: 'text', text: 'result-2.txt 已创建' }
    ]);
    const secondAction = Object.freeze({
      ...verifiedAction(),
      targetRelativePath: 'result-2.txt'
    });
    const { events, fileTools, service } = createHarness(provider, {
      preview: vi.fn()
        .mockResolvedValueOnce(verifiedAction())
        .mockResolvedValueOnce(secondAction),
      executeWrite: vi.fn()
        .mockRejectedValueOnce(new FileToolError('TARGET_EXISTS', 'C:\\private\\result.txt'))
        .mockResolvedValueOnce(undefined)
    });
    await service.submitFileTask({ text: '创建 result.txt', visibleHistory: [] });
    const pendingEvent = events.find(event => event.type === 'pending_action');
    if (!pendingEvent || pendingEvent.type !== 'pending_action') throw new Error('缺少确认事件');

    await service.confirm(pendingEvent.action.actionId);
    const pendingEvents = events.filter(event => event.type === 'pending_action');
    expect(pendingEvents).toHaveLength(2);
    const secondPending = pendingEvents[1];
    if (!secondPending || secondPending.type !== 'pending_action') throw new Error('缺少第二张确认卡');
    await service.confirm(secondPending.action.actionId);

    expect(fileTools.executeWrite).toHaveBeenCalledTimes(2);
    expect(provider.requests).toHaveLength(3);
    expect(JSON.stringify(provider.requests[1])).not.toContain('private');
    expect(provider.requests[1]?.messages.at(-1)).toEqual(expect.objectContaining({
      role: 'tool',
      content: '{"ok":false,"toolName":"create_file","code":"TARGET_EXISTS"}'
    }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', code: 'TARGET_EXISTS' }));
    expect(events.at(-1)).toEqual({ type: 'phase', phase: 'success' });
  });

  test('失败任务结束后同一 AgentService 的全新创建任务可确认成功', async () => {
    const provider = new ScriptedProvider([
      writeResponse(),
      { type: 'text', text: '旧任务不应伪装成功' },
      {
        type: 'tool_request',
        request: {
          requestId: 'new-task-create',
          toolName: 'builtin.files.create_file',
          arguments: { relativePath: 'available.txt', content: '新正文' }
        }
      },
      { type: 'text', text: 'available.txt 已创建' }
    ]);
    const availableAction = Object.freeze({
      ...verifiedAction(),
      targetRelativePath: 'available.txt',
      contentCharacters: 3,
      contentPreview: '新正文'
    });
    const { events, fileTools, service } = createHarness(provider, {
      preview: vi.fn()
        .mockResolvedValueOnce(verifiedAction())
        .mockResolvedValueOnce(availableAction),
      executeWrite: vi.fn()
        .mockRejectedValueOnce(new FileToolError('TARGET_EXISTS', 'C:\\private\\result.txt'))
        .mockResolvedValueOnce(undefined)
    });

    await service.submitFileTask({
      text: '创建已存在的 result.txt',
      visibleHistory: [],
      planningHint: { operation: 'create_file' }
    });
    const firstPending = events.find(event => event.type === 'pending_action');
    if (!firstPending || firstPending.type !== 'pending_action') throw new Error('缺少失败任务确认卡');
    await service.confirm(firstPending.action.actionId);
    expect(events.at(-1)).toEqual({ type: 'phase', phase: 'error' });

    await service.submitFileTask({
      text: '创建新的 available.txt',
      visibleHistory: [],
      planningHint: { operation: 'create_file' }
    });
    const secondPending = events.filter(event => event.type === 'pending_action').at(-1);
    if (!secondPending || secondPending.type !== 'pending_action') throw new Error('缺少新任务确认卡');
    expect(fileTools.executeWrite).toHaveBeenCalledTimes(1);
    await service.confirm(secondPending.action.actionId);

    expect(fileTools.executeWrite).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual({
      type: 'message', role: 'assistant', text: 'available.txt 已创建'
    });
    expect(events.at(-1)).toEqual({ type: 'phase', phase: 'success' });
  });

  test('纯写多步任务逐次确认后恢复完整文件工具', async () => {
    const provider = new ScriptedProvider([
      writeResponse(),
      moveResponse(),
      { type: 'text', text: '文件已创建并移动' }
    ]);
    const { events, fileTools, service } = createHarness(provider, {
      preview: vi.fn()
        .mockResolvedValueOnce(verifiedAction())
        .mockResolvedValueOnce(moveAction())
    });

    await service.submitFileTask({
      text: '创建 result.txt 后移动到 archive 文件夹',
      visibleHistory: [],
      planningHint: { operation: 'create_file' }
    });
    const firstPending = events.find(event => event.type === 'pending_action');
    if (!firstPending || firstPending.type !== 'pending_action') throw new Error('缺少第一张确认卡');
    await service.confirm(firstPending.action.actionId);

    const pendingEvents = events.filter(event => event.type === 'pending_action');
    expect(pendingEvents).toHaveLength(2);
    expect(provider.requests[1]?.tools.map(tool => tool.function.name)).toEqual(expect.arrayContaining([
      'builtin.files.list_files',
      'builtin.files.read_file',
      'builtin.files.glob_files',
      'builtin.files.grep_files',
      'builtin.files.create_file',
      'builtin.files.move_file',
      'builtin.files.edit_file'
    ]));
    const secondPending = pendingEvents[1];
    if (!secondPending || secondPending.type !== 'pending_action') throw new Error('缺少第二张确认卡');
    await service.confirm(secondPending.action.actionId);

    expect(fileTools.executeWrite).toHaveBeenCalledTimes(2);
    expect(events.at(-1)).toEqual({ type: 'phase', phase: 'success' });
  });

  test('单次多文件补丁请求由 Main 拆成逐文件确认且全部确认后才续跑模型', async () => {
    const provider = new ScriptedProvider([
      writeResponse('builtin.files.apply_patch'),
      { type: 'text', text: '两个文件均已修改' }
    ]);
    const firstAction = Object.freeze({
      operation: 'apply_patch' as const,
      authorizationGeneration: 0,
      targetRelativePath: 'docs/first.txt',
      addedLines: 1,
      removedLines: 1,
      diffPreview: '-first old\n+first new',
      previewTruncated: false
    });
    const secondAction = Object.freeze({
      ...firstAction,
      targetRelativePath: 'docs/second.txt',
      diffPreview: '-second old\n+second new'
    });
    const overrides = {
      previewMany: vi.fn(async () => [firstAction, secondAction])
    } as Partial<AgentFileTools> & {
      previewMany: (request: unknown) => Promise<readonly VerifiedWriteAction[]>;
    };
    const { events, fileTools, service } = createHarness(provider, overrides);

    await service.submitFileTask({ text: '同时修改两个文件', visibleHistory: [] });
    const firstPending = events.find(event => event.type === 'pending_action');
    if (!firstPending || firstPending.type !== 'pending_action') throw new Error('缺少第一张确认卡');
    expect(firstPending.action).toMatchObject({ targetRelativePath: 'docs/first.txt' });

    await service.confirm(firstPending.action.actionId);
    expect(fileTools.executeWrite).toHaveBeenCalledTimes(1);
    expect(provider.requests).toHaveLength(1);
    const pendingEvents = events.filter(event => event.type === 'pending_action');
    expect(pendingEvents).toHaveLength(2);
    const secondPending = pendingEvents[1];
    if (!secondPending || secondPending.type !== 'pending_action') throw new Error('缺少第二张确认卡');
    expect(secondPending.action).toMatchObject({ targetRelativePath: 'docs/second.txt' });

    await service.confirm(secondPending.action.actionId);
    expect(fileTools.executeWrite).toHaveBeenCalledTimes(2);
    expect(provider.requests).toHaveLength(2);
    expect(events.at(-1)).toEqual({ type: 'phase', phase: 'success' });
  });

  test('多文件补丁取消后续确认时保留已执行事实但绝不执行或续跑余项', async () => {
    const provider = new ScriptedProvider([writeResponse('builtin.files.apply_patch')]);
    const patchAction = (targetRelativePath: string): VerifiedWriteAction => Object.freeze({
      operation: 'apply_patch' as const,
      authorizationGeneration: 0,
      targetRelativePath,
      addedLines: 1,
      removedLines: 1,
      diffPreview: '-old\n+new',
      previewTruncated: false
    });
    const overrides = {
      previewMany: vi.fn(async () => [
        patchAction('docs/first.txt'),
        patchAction('docs/second.txt')
      ])
    } as Partial<AgentFileTools> & {
      previewMany: (request: unknown) => Promise<readonly VerifiedWriteAction[]>;
    };
    const { events, fileTools, service } = createHarness(provider, overrides);

    await service.submitFileTask({ text: '同时修改两个文件', visibleHistory: [] });
    const firstPending = events.find(event => event.type === 'pending_action');
    if (!firstPending || firstPending.type !== 'pending_action') throw new Error('缺少第一张确认卡');
    await service.confirm(firstPending.action.actionId);
    const pendingEvents = events.filter(event => event.type === 'pending_action');
    const secondPending = pendingEvents[1];
    if (!secondPending || secondPending.type !== 'pending_action') throw new Error('缺少第二张确认卡');

    service.cancelAction(secondPending.action.actionId);

    expect(fileTools.executeWrite).toHaveBeenCalledOnce();
    expect(provider.requests).toHaveLength(1);
    expect(events.at(-2)).toEqual({
      type: 'message',
      role: 'assistant',
      text: '已完成以下文件操作：docs/first.txt。其余文件操作已取消，未执行。'
    });
    expect(events.at(-1)).toEqual({ type: 'phase', phase: 'cancelled' });
    await expect(service.confirm(secondPending.action.actionId)).rejects.toThrow('ACTION_EXPIRED');
    expect(fileTools.executeWrite).toHaveBeenCalledOnce();
  });

  test('多文件补丁后续项失败时公开已完成相对路径和未执行事实', async () => {
    const provider = new ScriptedProvider([
      writeResponse('builtin.files.apply_patch'),
      { type: 'text', text: '两个文件均已修改' }
    ]);
    const patchAction = (targetRelativePath: string): VerifiedWriteAction => Object.freeze({
      operation: 'apply_patch' as const,
      authorizationGeneration: 0,
      targetRelativePath,
      addedLines: 1,
      removedLines: 1,
      diffPreview: '-old\n+new',
      previewTruncated: false
    });
    let executions = 0;
    const overrides = {
      previewMany: vi.fn(async () => [
        patchAction('docs/first.txt'),
        patchAction('docs/second.txt')
      ]),
      executeWrite: vi.fn(async () => {
        executions += 1;
        if (executions === 2) throw new FileToolError('ENTRY_CHANGED', '第二个文件已变化');
      })
    } as Partial<AgentFileTools> & {
      previewMany: (request: unknown) => Promise<readonly VerifiedWriteAction[]>;
    };
    const { events, service } = createHarness(provider, overrides);

    await service.submitFileTask({ text: '同时修改两个文件', visibleHistory: [] });
    const firstPending = events.find(event => event.type === 'pending_action');
    if (!firstPending || firstPending.type !== 'pending_action') throw new Error('缺少第一张确认卡');
    await service.confirm(firstPending.action.actionId);
    const pendingEvents = events.filter(event => event.type === 'pending_action');
    const secondPending = pendingEvents[1];
    if (!secondPending || secondPending.type !== 'pending_action') throw new Error('缺少第二张确认卡');

    await service.confirm(secondPending.action.actionId);

    expect(events).toContainEqual({
      type: 'message',
      role: 'assistant',
      text: '已完成以下文件操作：docs/first.txt。当前文件操作失败，其余文件操作未执行。'
    });
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
