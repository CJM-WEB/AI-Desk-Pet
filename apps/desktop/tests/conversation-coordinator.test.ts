import type { ModelProvider, ModelRequest, ModelResponse } from '@myself/agent-core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskEvent } from '@myself/shared-types';
import { describe, expect, test, vi } from 'vitest';
import {
  DisclosurePolicy,
  PrivacySessionRegistry
} from '../src/main/agent/disclosure-policy';
import {
  ConversationCoordinator,
  type ChatTurnFactory,
  type ConversationCapabilityTaskPort
} from '../src/main/conversation/conversation-coordinator';
import { ConversationDisclosureAdapter } from '../src/main/conversation/conversation-disclosure-adapter';
import { ConversationHistory } from '../src/main/conversation/conversation-history';
import { ConversationSessionStore } from '../src/main/conversation/conversation-session-store';
import { ConversationChatAdapter } from '../src/main/conversation/conversation-chat-adapter';
import type { ConversationBehaviorPort } from
  '../src/main/characters/character-behavior-director';
import type {
  CodingTaskOutcome,
  CodingTaskToolResult
} from '../src/main/agent/coding-task-service';
import { ProviderResponseError } from '../src/main/providers/provider-response-error';

const behaviorContext = {
  character: { idleStateId: 'state-1355',
    identity: { formsOfAddress: [], dislikes: [], boundaries: [], exampleLines: [],
      name: '测试角色', description: '测试角色', background: '测试环境', traits: [],
      languageStyle: '简洁', likes: [], behavioralTendencies: []
    },
    states: [{ agentInferable: true,
      name: '移动', stateId: 'state-1355', tags: [],
      actions: [{ name: '散步', actionId: 'action-1413', tags: [] }]
    }]
  },
  runtime: {
    chatting: false, taskRunning: false, awaitingConfirmation: false, moving: false,
    dragging: false,
    carrying: false,
    movementMode: 2 as const
  },
  proactivityMode: 'assistive' as const,
  recentActions: []
};

function behaviorPortDouble(
  overrides: Partial<ConversationBehaviorPort> = {}
): ConversationBehaviorPort {
  return {
    prepareUserPrompt: vi.fn(async text => ({
      originalText: text,
      capabilityText: text,
      explicitDirective: null
    })),
    getChatContext: vi.fn(() => behaviorContext),
    captureExpressionContext: vi.fn(() => null),
    handleChatResponseFinished: vi.fn(),
    completeUserPrompt: vi.fn(),
    handleTaskEvent: vi.fn(),
    applyPlaybackFeedback: vi.fn(),
    cancelActive: vi.fn(),
    reset: vi.fn(),
    close: vi.fn(async () => undefined),
    ...overrides
  };
}

interface ProviderScript {
  requests: ModelRequest[];
  signals: AbortSignal[];
  provider: ModelProvider;
}

class CapturingCapabilityTasks implements ConversationCapabilityTaskPort {
  readonly submissions: Array<Parameters<ConversationCapabilityTaskPort['submit']>[0]> = [];
  readonly preparedGenerations: string[] = [];
  unsubscribeCalls = 0;
  unsubscribeError: Error | null = null;
  resetCalls = 0;
  prepareError: Error | null = null;
  resetError: Error | null = null;
  closeCalls = 0;
  closeError: Error | null = null;
  closeBarrier: Promise<void> | null = null;
  prepareBarrier: Promise<void> | null = null;
  cancelCalls = 0;
  activationCalls = 0;
  nextOutcome: CodingTaskOutcome = { kind: 'completed', acted: false };
  target: {
    profileId: string;
    providerIdentity: string;
    providerName: string;
    capabilityRevision: string;
    directory: string; modelId: string; approvedCommands: readonly string[];
  } = Object.freeze({
    profileId: 'profile-agent',
    providerIdentity: 'openai',
    providerName: 'OpenAI Agent',
    capabilityRevision: 'revision-agent',
    directory: 'D:\\authorized', modelId: 'model-test', approvedCommands: [],
  });
  private listener: Parameters<ConversationCapabilityTaskPort['onEvent']>[0] | null = null;
  private trustedResultListener:
    | Parameters<ConversationCapabilityTaskPort['onTrustedToolResult']>[0]
    | null = null;

  onEvent(listener: Parameters<ConversationCapabilityTaskPort['onEvent']>[0]): () => void {
    this.listener = listener;
    return () => {
      this.unsubscribeCalls += 1;
      if (this.listener === listener) this.listener = null;
      if (this.unsubscribeError) throw this.unsubscribeError;
    };
  }

  onTrustedToolResult(
    listener: Parameters<ConversationCapabilityTaskPort['onTrustedToolResult']>[0]
  ): () => void {
    this.trustedResultListener = listener;
    return () => {
      if (this.trustedResultListener === listener) this.trustedResultListener = null;
    };
  }

  async submit(input: Parameters<ConversationCapabilityTaskPort['submit']>[0]): Promise<CodingTaskOutcome> {
    this.submissions.push(input);
    return this.nextOutcome;
  }

  async prepareTarget(input: { generation: string; taskKind: 'file' | 'powershell' }) {
    this.preparedGenerations.push(input.generation);
    const barrier = this.prepareBarrier;
    this.prepareBarrier = null;
    if (barrier) await barrier;
    if (this.prepareError) throw this.prepareError;
    return this.target;
  }

  async prepareSnapshot(input: { generation: string; taskKind: 'file' | 'powershell' }) {
    return this.prepareTarget(input);
  }

  async activateTarget(): Promise<void> { this.activationCalls += 1; }

  cancelActive(): void {
    this.cancelCalls += 1;
  }

  async resolveAction(): Promise<void> {}

  async resetForNewConversation(): Promise<void> {
    this.resetCalls += 1;
    if (this.resetError) throw this.resetError;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.closeBarrier) await this.closeBarrier;
    if (this.closeError) throw this.closeError;
  }

  publish(event: TaskEvent, generation: string): void {
    this.listener?.(event, generation);
  }

  publishTrustedToolResult(
    result: CodingTaskToolResult,
    generation: string,
    target = this.target
  ): void {
    this.trustedResultListener?.(result, generation, target);
  }
}

function scriptedProvider(response: ModelResponse | Error, preservePlainText = false): ProviderScript {
  const requests: ModelRequest[] = [];
  const signals: AbortSignal[] = [];
  return {
    requests,
    signals,
    provider: {
      async respond(request, signal) {
        requests.push(request);
        signals.push(signal);
        if (response instanceof Error) throw response;
        if (request.responseContract) {
          const control = response.type === 'text' && !preservePlainText ? response.structured_output : undefined;
          return { type: 'structured', structured_output: 表现选择(control) };
        }
        return response;
      }
    }
  };
}

function 完整聊天控制(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { movementControl: { kind: 'keep' }, ...overrides };
}

function 表现选择(control: Record<string, unknown> = {}): Record<string, unknown> {
  const movement = control.movementControl as { kind?: string; mode?: number; target?: string; distance?: string } | undefined;
  const state = (control.expressionPlan as { states?: Array<{ stateId: string; actions: Array<{ actionId: string }> }> } | undefined)?.states?.[0];
  const mode = movement?.kind === 'set_mode' ? ['still', 'continuous', 'intermittent'][movement.mode ?? 0]
    : movement?.kind === 'move_once' ? 'once' : 'keep';
  const moving = control.requestKind === 'movement' || mode !== 'keep';
  return { kind: moving ? 'movement' : control.requestKind === 'state' || control.requestKind === 'action' ? control.requestKind : 'none',
    choice: control.explicitPlayback ?? (state ? { stateId: state.stateId, actionId: state.actions[0]?.actionId } : null),
    mode, target: mode === 'once' ? movement?.target : null, distance: mode === 'once' ? movement?.distance : null };
}

function 申请任务(): ModelResponse {
  return { type: 'tool_request', request: { requestId: 'native-1', toolName: 'request_task_authorization', arguments: {} } };
}

function 任务模型() {
  return { profileId: 'chat', providerIdentity: 'openai', providerName: 'Chat', script: scriptedProvider(申请任务()) };
}

function deferredProvider(): ProviderScript & {
  resolve(response: ModelResponse): void;
  reject(error: Error): void;
} {
  const requests: ModelRequest[] = [];
  const signals: AbortSignal[] = [];
  let resolve!: (response: ModelResponse) => void;
  let reject!: (error: Error) => void;
  const response = new Promise<ModelResponse>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return {
    requests,
    signals,
    resolve,
    reject,
    provider: {
      async respond(request, signal) {
        requests.push(request);
        signals.push(signal);
        if (request.responseContract) return { type: 'structured', structured_output: 表现选择() };
        return response;
      }
    }
  };
}

function deferredVoid(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function createHarness(scripts: Array<{
  profileId: string;
  providerIdentity: string;
  providerName: string;
  script: ProviderScript;
}>, options: {
  singleSlot?: boolean;
  factoryError?: Error;
  fileTasks?: CapturingCapabilityTasks;
  behavior?: ConversationBehaviorPort;
  history?: ConversationHistory;
  onEmit?: (event: TaskEvent, coordinator: ConversationCoordinator) => void;
} = {}) {
  const history = options.history ?? new ConversationHistory();
  const events: TaskEvent[] = [];
  const fileTasks = options.fileTasks ?? new CapturingCapabilityTasks();
  const privacySessions = new PrivacySessionRegistry();
  privacySessions.register('session-1', { incognito: false });
  const providers = new Map(scripts.map(item => [item.profileId, item.providerIdentity]));
  const disclosureAdapter = new ConversationDisclosureAdapter({
    sessionId: 'session-1',
    privacySessions,
    disclosurePolicy: new DisclosurePolicy({
      privacySessions,
      resolveProfileProvider: profileId => profileId === fileTasks.target.profileId
        ? fileTasks.target.providerIdentity
        : providers.get(profileId) ?? null,
      resolveCurrentSourceProvider: () => null
    })
  });
  let factoryIndex = 0;
  let factoryCalls = 0;
  const behavior = options.behavior ?? behaviorPortDouble();
  const chatTurnFactory: ChatTurnFactory = {
    async create() {
      factoryCalls += 1;
      if (options.factoryError) throw options.factoryError;
      const item = scripts[factoryIndex++];
      if (!item) throw new Error('UNEXPECTED_FACTORY_CALL');
      return {
        adapter: new ConversationChatAdapter(item.script.provider, undefined, { singleSlot: options.singleSlot === true }),
        profileId: item.profileId,
        providerIdentity: item.providerIdentity,
        providerName: item.providerName
      };
    }
  };
  const ids = ['generation-current', 'request-1', 'request-2', 'request-3'];
  let coordinator!: ConversationCoordinator;
  coordinator = new ConversationCoordinator({
    history,
    chatTurnFactory,
    disclosureAdapter,
    capabilityTasks: fileTasks,
    behavior,
    emit: event => {
      events.push(event);
      options.onEmit?.(event, coordinator);
    },
    createId: () => ids.shift() ?? 'request-fallback'
  });
  return {
    coordinator,
    disclosureAdapter,
    events,
    behavior,
    fileTasks,
    history,
    factoryCallCount: () => factoryCalls
  };
}

function phases(events: readonly TaskEvent[]): string[] {
  return events
    .filter((event): event is Extract<TaskEvent, { type: 'phase' }> => event.type === 'phase')
    .map(event => event.phase);
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : undefined;
}

function scopeId(harness: ReturnType<typeof createHarness>): string {
  const event = harness.events.filter(event => event.type === 'capability_authorization_required').at(-1);
  if (event?.type !== 'capability_authorization_required') throw new Error('缺少范围卡');
  return event.requestId;
}

async function authorizeTask(harness: ReturnType<typeof createHarness>): Promise<void> {
  const event = harness.events.filter(event => event.type === 'capability_authorization_required').at(-1);
  if (!event || event.type !== 'capability_authorization_required') return;
  await harness.coordinator.resolveCapabilityAuthorization(event.requestId, 'confirm');
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe('ConversationCoordinator', () => {
  test('只有当前真实任务事件才更新任务表现事实，聊天终态不冒充结果', async () => {
    const recorded: string[] = [];
    const harness = createHarness([任务模型()], {
      behavior: behaviorPortDouble({ handleCapabilityTaskPhase: phase => { recorded.push(phase); } })
    });
    await harness.coordinator.submit('看看目录');
    expect(recorded).toEqual([]);
    await authorizeTask(harness);
    harness.fileTasks.publish({ type: 'phase', phase: 'thinking' }, 'old-generation');
    expect(recorded).toEqual([]);
    harness.fileTasks.publish({ type: 'phase', phase: 'thinking' }, 'generation-current');
    harness.fileTasks.publish({ type: 'phase', phase: 'awaiting_confirmation' }, 'generation-current');
    harness.fileTasks.publish({ type: 'phase', phase: 'success' }, 'generation-current');
    expect(recorded).toEqual(['running', 'waiting', 'success']);
    await harness.coordinator.close();
  });

  test('范围卡出现后接纳同轮迟到表现，且授权之前不执行文件', async () => {
    let release!: (response: ModelResponse) => void;
    const pending = new Promise<ModelResponse>(resolve => { release = resolve; });
    const script: ProviderScript = { requests: [], signals: [], provider: { respond: async (request, signal) => {
      script.requests.push(request); script.signals.push(signal);
      return request.responseContract ? pending : 申请任务();
    } } };
    const accepted: string[] = [];
    const behavior = behaviorPortDouble({ completeUserPrompt: async reply => { accepted.push(reply.eventId); } });
    const harness = createHarness([{ profileId: 'chat', providerIdentity: 'openai', providerName: 'Chat', script }], { behavior });
    const submitted = harness.coordinator.submit('看看目录');
    await vi.waitFor(() => expect(harness.events.some(event => event.type === 'capability_authorization_required')).toBe(true));
    expect(harness.fileTasks.submissions).toEqual([]);
    release({ type: 'structured', structured_output: 表现选择() });
    await submitted;
    await vi.waitFor(() => expect(accepted).toEqual([expect.stringMatching(/^assistant-.+/u)]));
    await harness.coordinator.close();
  });

  test('取消范围授权会终止同轮表现，不接纳随后完成的响应', async () => {
    let release!: (response: ModelResponse) => void;
    const pending = new Promise<ModelResponse>(resolve => { release = resolve; });
    let expressionSignal: AbortSignal | undefined;
    const script: ProviderScript = { requests: [], signals: [], provider: { respond: async (request, signal) => {
      if (request.responseContract) { expressionSignal = signal; return pending; }
      return 申请任务();
    } } };
    const accepted: string[] = [];
    const harness = createHarness([{ profileId: 'chat', providerIdentity: 'openai', providerName: 'Chat', script }], {
      behavior: behaviorPortDouble({ completeUserPrompt: async reply => { accepted.push(reply.eventId); } })
    });
    const submitted = harness.coordinator.submit('看看目录');
    await vi.waitFor(() => expect(harness.events.some(event => event.type === 'capability_authorization_required')).toBe(true));
    await harness.coordinator.resolveCapabilityAuthorization(scopeId(harness), 'cancel');
    expect(expressionSignal?.aborted).toBe(true);
    release({ type: 'structured', structured_output: 表现选择() });
    await submitted;
    expect(accepted).toEqual([]);
    expect(harness.fileTasks.submissions).toEqual([]);
    await harness.coordinator.close();
  });

  test('单一发送允许自然问句原生申请且 Core 保留当前原文', async () => {
    const script = scriptedProvider({ type: 'tool_request', request: { requestId: 'request-1', toolName: 'request_task_authorization', arguments: {} } });
    const behavior = behaviorPortDouble({ prepareUserPrompt: vi.fn(async text => ({ originalText: text, capabilityText: '角色改写文本', explicitDirective: null })) });
    const harness = createHarness([{ profileId: 'chat', providerIdentity: 'openai', providerName: 'Chat', script }], { behavior });
    await harness.coordinator.submit('note.txt 里面写了什么？');
    expect(harness.events).toContainEqual(expect.objectContaining({ type: 'capability_authorization_required' }));
    expect(script.requests.filter(request => !request.responseContract)).toHaveLength(1);
    expect(harness.fileTasks.activationCalls).toBe(0);
    expect(harness.fileTasks.submissions).toEqual([]);
    expect(behavior.completeUserPrompt).toHaveBeenCalledWith(expect.objectContaining({ expressionStatus: 'no_match' }));
    await authorizeTask(harness);
    expect(harness.fileTasks.submissions).toEqual([expect.objectContaining({ text: 'note.txt 里面写了什么？' })]);
  });

  test('坏表现不阻断正文并向 Director 明确传递失败状态', async () => {
    const script: ProviderScript = { requests: [], signals: [], provider: { respond: async (request, signal) => {
      script.requests.push(request); script.signals.push(signal);
      return request.responseContract ? { type: 'text', text: '坏格式' } : { type: 'text', text: '有效正文' };
    } } };
    const harness = createHarness([{ profileId: 'chat', providerIdentity: 'openai', providerName: 'Chat', script }]);
    await harness.coordinator.submit('你好');
    expect(harness.events).toContainEqual({ type: 'message', role: 'assistant', text: '有效正文' });
    await vi.waitFor(() => expect(harness.behavior.completeUserPrompt).toHaveBeenCalledWith(expect.objectContaining({ expressionStatus: 'failed' })));
    expect(harness.fileTasks.submissions).toHaveLength(0);
  });

  test('目录讨论后同意查看使用连续历史申请新范围，旧许可不继承', async () => {
    const first = scriptedProvider({ type: 'text', text: '我还没有查看目录，可以先看看吗？' });
    const next = scriptedProvider(申请任务());
    const harness = createHarness([
      { profileId: 'chat', providerIdentity: 'openai', providerName: 'Chat', script: first },
      { profileId: 'chat', providerIdentity: 'openai', providerName: 'Chat', script: next },
      任务模型()
    ]);
    await harness.coordinator.submit('目录是不是很乱？');
    expect(harness.fileTasks.preparedGenerations).toHaveLength(0);
    await harness.coordinator.submit('可以，先看看');
    expect(next.requests[0]?.messages.slice(-3)).toEqual([
      { role: 'user', content: '目录是不是很乱？' },
      { role: 'assistant', content: '我还没有查看目录，可以先看看吗？' },
      { role: 'user', content: '可以，先看看' }
    ]);
    expect(harness.fileTasks.submissions).toHaveLength(0);
    await authorizeTask(harness);
    expect(harness.fileTasks.submissions[0]).toMatchObject({ text: '可以，先看看', visibleHistory: next.requests[0]?.messages.slice(-3, -1) });
    harness.fileTasks.publish({ type: 'phase', phase: 'success' }, 'generation-current');
    await harness.coordinator.submit('再看看');
    expect(harness.fileTasks.submissions).toHaveLength(1);
    await harness.coordinator.resolveCapabilityAuthorization(scopeId(harness), 'cancel');
    expect(harness.fileTasks.submissions).toHaveLength(1);
  });

  test('Main 可信标记只收紧第二次表现请求并传回成功空计划', async () => {
    const script = scriptedProvider({ type: 'text', text: '继续陪你。', structured_output: { movementControl: { kind: 'move_once', target: 'left', distance: 'near' } } });
    const behavior = behaviorPortDouble({ prepareUserPrompt: vi.fn(async text => ({ originalText: text, capabilityText: text,
      explicitDirective: { kind: 'play' as const, target: { kind: 'action_name' as const, name: '散步' } }, explicitPlaybackToken: 'main-started'
    })) });
    const harness = createHarness([{ profileId: 'chat', providerIdentity: 'openai', providerName: '聊天', script }], { behavior });
    await harness.coordinator.submit('播放散步动作');
    expect(script.requests).toHaveLength(2);
    expect(script.requests[0]!.responseContract).toBeUndefined();
    expect(script.requests[1]).toMatchObject({ tools: [], toolChoice: 'none' });
    await vi.waitFor(() => expect(behavior.completeUserPrompt).toHaveBeenCalledWith(expect.objectContaining({ expressionStatus: 'no_match', movementControl: { kind: 'keep' } })));
    expect(harness.events).toContainEqual({ type: 'message', role: 'assistant', text: '继续陪你。' });
    expect(harness.fileTasks.submissions).toEqual([]);
  });
  test.each(['cancel', 'reset', 'close'] as const)('正文独立交付后 %s 仍使迟到表现失效', async action => {
    let resolveExpression!: (response: ModelResponse) => void;
    const expression = new Promise<ModelResponse>(resolve => { resolveExpression = resolve; });
    const script: ProviderScript = { requests: [], signals: [], provider: { respond: async (request, signal) => {
      script.requests.push(request); script.signals.push(signal);
      return request.responseContract ? expression : { type: 'text', text: '已独立交付的正文' };
    } } };
    const harness = createHarness([{ profileId: 'chat', providerIdentity: 'openai', providerName: 'Chat', script }]);
    const running = harness.coordinator.submit('等表现');
    await vi.waitFor(() => expect(script.requests).toHaveLength(2));
    await running;
    expect(harness.events).toContainEqual(expect.objectContaining({ text: '已独立交付的正文' }));
    if (action === 'cancel') await harness.coordinator.cancelActive();
    else if (action === 'reset') await harness.coordinator.resetConversation();
    else await harness.coordinator.close();
    resolveExpression({ type: 'structured', structured_output: 表现选择() });
    await running;
    expect(script.signals[1]?.aborted).toBe(true);
    expect(harness.history.turns()).toHaveLength(action === 'reset' ? 0 : 1);
    expect(harness.behavior.completeUserPrompt).not.toHaveBeenCalled();
  });

  test('等待具体许可时继续追问只提示原确认卡，不再次请求模型或执行', async () => {
    const harness = createHarness([任务模型()]);
    await harness.coordinator.submit('读取 note.txt');
    await authorizeTask(harness);
    harness.fileTasks.publish({ type: 'phase', phase: 'awaiting_confirmation' }, 'generation-current');
    await harness.coordinator.submit('继续');
    expect(harness.events).toContainEqual({ type: 'message', role: 'assistant', text: '请先处理当前权限确认卡。' });
    expect(harness.factoryCallCount()).toBe(1);
    expect(harness.fileTasks.submissions).toHaveLength(1);
  });

  test('普通聊天传回请求前表达修订，接纳完成只发专用 response 事实', async () => {
    const script = deferredProvider();
    const original = { contextRevision: 1, moodRevision: 1, instance: Symbol('request') };
    const captureExpressionContext = vi.fn(() => original);
    const handleChatResponseFinished = vi.fn();
    const behavior = behaviorPortDouble({ captureExpressionContext, handleChatResponseFinished });
    const harness = createHarness([{ profileId: 'chat', providerIdentity: 'openai', providerName: '聊天', script }], { behavior });
    const pending = harness.coordinator.submit('普通问候');
    await vi.waitFor(() => expect(script.requests.filter(request => !request.responseContract)).toHaveLength(1));
    captureExpressionContext.mockReturnValue({ ...original, contextRevision: 2 });
    script.resolve({ type: 'text', text: '你好', structured_output: { movementControl: { kind: 'keep' }, capabilityPlan: { kind: 'chat' } } });
    await pending;
    expect(behavior.completeUserPrompt).toHaveBeenCalledWith(expect.objectContaining({ context: original, eventId: expect.stringMatching(/^assistant-.+/u) }));
    expect(captureExpressionContext).toHaveBeenCalledOnce();
    expect(handleChatResponseFinished).toHaveBeenCalledOnce();
    expect(JSON.stringify(script.requests)).not.toContain('contextRevision');
  });
  test.each(['cancel', 'reset', 'close'] as const)('原生申请范围在 %s 后不能以旧确认激活', async action => {
    const script = scriptedProvider(申请任务());
    const harness = createHarness([{ profileId: 'chat', providerIdentity: 'openai', providerName: 'Chat', script }]);
    await harness.coordinator.submit('note.txt 里面写了什么？');
    const requestId = scopeId(harness);
    if (action === 'cancel') await harness.coordinator.resolveCapabilityAuthorization(requestId, 'cancel');
    else if (action === 'close') await harness.coordinator.close();
    else await harness.coordinator.resetConversation();
    await expect(harness.coordinator.resolveCapabilityAuthorization(requestId, 'confirm')).rejects.toBeDefined();
    expect(harness.fileTasks.activationCalls).toBe(0);
    expect(harness.fileTasks.submissions).toHaveLength(0);
    expect(script.requests.filter(request => !request.responseContract)).toHaveLength(1);
  });

  test('状态追问只使用当前代有限工具事实，重置后不保留旧结果', async () => {
    const harness = createHarness([任务模型(), 任务模型()]);
    await harness.coordinator.submit('执行 PowerShell 测试');
    expect(harness.fileTasks.submissions).toHaveLength(0);
    await authorizeTask(harness);
    harness.fileTasks.publishTrustedToolResult({ toolName: 'bash', ok: false, relativePaths: [], exit: 1 }, 'generation-current');
    harness.fileTasks.publishTrustedToolResult({ toolName: 'bash', ok: true, relativePaths: [], exit: 0 }, 'generation-current');
    harness.fileTasks.publish({ type: 'phase', phase: 'success' }, 'generation-current');
    await harness.coordinator.submit('上一个任务完成了吗');
    expect(harness.factoryCallCount()).toBe(1);
    expect(harness.fileTasks.submissions).toHaveLength(1);
    expect(harness.events).toContainEqual(expect.objectContaining({ type: 'message', role: 'assistant', text: expect.stringContaining('最近命令退出码：0') }));
    await harness.coordinator.resetConversation();
    await harness.coordinator.submit('上一个任务完成了吗');
    expect(harness.factoryCallCount()).toBe(2);
    expect(harness.fileTasks.submissions).toHaveLength(1);
  });
  test('原生申请发布独立任务授权且确认前不激活 Agent', async () => {
    const requests: ModelRequest[] = [];
    const script: ProviderScript = {
      requests,
      signals: [],
      provider: {
        async respond(request, signal) {
          requests.push(request);
          script.signals.push(signal);
          request.onTextDelta?.('文件已经');
          request.onTextDelta?.('创建完成');
          return 申请任务();
        }
      }
    };
    const harness = createHarness([{
      profileId: 'chat-profile', providerIdentity: 'openai', providerName: 'Chat', script
    }]);

    await harness.coordinator.submit('请整理当前目录并生成说明');

    expect(harness.events).toContainEqual({
      type: 'capability_authorization_required',
      requestId: expect.any(String),
      capability: 'file',
      requestSummary: '请整理当前目录并生成说明',
      targetProviderName: 'OpenAI Agent',
      directory: 'D:\\authorized', modelId: 'model-test', actions: ['read', 'create', 'edit'], approvedCommands: [],
      expiresAt: expect.any(String)
    });
    expect(harness.fileTasks.activationCalls).toBe(0);
    expect(harness.fileTasks.submissions).toHaveLength(0);
    expect(harness.events.filter(event => event.type.startsWith('assistant_message_'))).toEqual([]);
    expect(JSON.stringify(harness.events)).not.toContain('文件已经创建完成');

    await harness.coordinator.resolveCapabilityAuthorization(scopeId(harness), 'confirm');
    expect(harness.fileTasks.activationCalls).toBe(1);
    expect(harness.fileTasks.submissions).toHaveLength(1);
  });

  test('任务级授权到期后拒绝激活、清理快照并发布可清卡终态', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-27T12:00:00.000Z'));
    try {
      const script = scriptedProvider(申请任务());
      const harness = createHarness([{
        profileId: 'chat-profile', providerIdentity: 'openai', providerName: 'Chat', script
      }]);

      await harness.coordinator.submit('请完成这个本地任务');
      expect(harness.events).toContainEqual(expect.objectContaining({
        type: 'capability_authorization_required',
        expiresAt: '2026-08-27T12:02:00.000Z'
      }));
      await vi.advanceTimersByTimeAsync(120_001);

      await expect(harness.coordinator.resolveCapabilityAuthorization(scopeId(harness), 'confirm'))
        .rejects.toMatchObject({ code: 'ACTION_EXPIRED' });
      expect(harness.fileTasks.activationCalls).toBe(0);
      expect(harness.fileTasks.cancelCalls).toBe(1);
      expect(phases(harness.events).at(-1)).toBe('error');
    } finally {
      vi.useRealTimers();
    }
  });

  test('取消任务级授权只显示宿主固定未执行文案，不公开模型口头结论', async () => {
    const script = scriptedProvider(申请任务());
    const harness = createHarness([{
      profileId: 'chat-profile', providerIdentity: 'openai', providerName: 'Chat', script
    }]);

    await harness.coordinator.submit('请帮我完成一个本地整理任务');
    await harness.coordinator.resolveCapabilityAuthorization(scopeId(harness), 'cancel');

    expect(JSON.stringify(harness.events)).not.toContain('文件已经成功删除');
    expect(harness.events).toContainEqual({
      type: 'message', role: 'assistant', text: '已取消进入本地任务，未执行任何操作。'
    });
    expect(harness.fileTasks.activationCalls).toBe(0);
    expect(phases(harness.events).at(-1)).toBe('cancelled');
  });

  test('等待显式 Gate 后主模型申请仍把当前完整原文交给 Core', async () => {
    const release = deferredVoid();
    const behavior = behaviorPortDouble({
      prepareUserPrompt: vi.fn(async (text: string) => {
        await release.promise;
        return {
          originalText: text,
          capabilityText: '删除 old.txt',
          explicitDirective: { kind: 'stop_movement' as const }
        };
      })
    });
    const harness = createHarness([任务模型(), 任务模型()], { behavior });
    const pending = harness.coordinator.submit('停下并删除 old.txt');
    await Promise.resolve();

    expect(harness.fileTasks.preparedGenerations).toEqual([]);
    expect(harness.factoryCallCount()).toBe(0);
    release.resolve();
    await pending;
    await authorizeTask(harness);

    expect(harness.fileTasks.submissions).toEqual([expect.objectContaining({
      text: '停下并删除 old.txt'
    })]);
    expect(harness.events).toContainEqual({
      type: 'message', role: 'user', text: '停下并删除 old.txt'
    });
  });

  test('普通聊天在披露确认后重新读取必填行为上下文并提交同轮计划', async () => {
    const first = scriptedProvider({ type: 'text', text: '第一轮回复' });
    const second = scriptedProvider({
      type: 'text',
      text: '开始散步',
      structured_output: 完整聊天控制({
        text: '开始散步',
        requestKind: 'movement',
        expressionPlan: { states: [{ stateId: 'state-1355', score: 1, activity: 'moving',
          actions: [{ actionId: 'action-1413', score: 1 }] }] },
        movementControl: { kind: 'move_once', target: 'right', distance: 'near' },
        capabilityPlan: { kind: 'chat' }
      })
    });
    let mode: 'assistive' | 'autonomous' = 'assistive';
    const behavior = behaviorPortDouble({
      getChatContext: vi.fn(() => ({ ...behaviorContext, proactivityMode: mode }))
    });
    const harness = createHarness([
      {
        profileId: 'profile-openai', providerIdentity: 'openai',
        providerName: 'OpenAI', script: first
      },
      {
        profileId: 'profile-anthropic', providerIdentity: 'anthropic',
        providerName: 'Anthropic', script: second
      }
    ], { behavior });
    await harness.coordinator.submit('第一轮');
    await authorizeTask(harness);
    await harness.coordinator.submit('第二轮');
    await authorizeTask(harness);

    expect(second.requests).toEqual([]);
    mode = 'autonomous';
    await harness.coordinator.resolveHistoryDisclosure('request-2', 'share_once');

    expect(second.requests[1]?.messages.map(message => message.content).join('')).toContain(
      '"movementMode":2'
    );
    expect(behavior.getChatContext).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(behavior.completeUserPrompt).toHaveBeenLastCalledWith(expect.objectContaining({
      generation: 'generation-current',
      explicitDirective: null,
      movementControl: { kind: 'move_once', target: 'right', distance: 'near' }
    })));
  });

  test.each(['你好', '你好呀', '聊天呀', '我想和你聊天', '帮我整理一下'])(
    '默认聊天“%s”只创建聊天目标且不触碰文件端口',
    async text => {
      const script = scriptedProvider({ type: 'text', text: '自然回复' });
      const harness = createHarness([{
        profileId: 'profile-openai',
        providerIdentity: 'openai',
        providerName: 'OpenAI',
        script
      }]);

      await harness.coordinator.submit(text);
    await authorizeTask(harness);

      expect(harness.factoryCallCount()).toBe(1);
      expect(harness.fileTasks.preparedGenerations).toEqual([]);
      expect(harness.fileTasks.submissions).toEqual([]);
      expect(script.requests).toHaveLength(2);
      expect(script.requests[0]).toMatchObject({ toolChoice: 'auto' });
      expect(script.requests[1]).toMatchObject({ tools: [], toolChoice: 'none' });
    }
  );

  test('文件目标准备期间取消会释放文件 owner，并允许下一次文件请求立即进入准备', async () => {
    const fileTasks = new CapturingCapabilityTasks();
    const barrier = deferredVoid();
    fileTasks.prepareBarrier = barrier.promise;
    const harness = createHarness([任务模型(), 任务模型()], { fileTasks });
    const first = harness.coordinator.submit('读取 old.txt');
    await vi.waitFor(() => expect(fileTasks.preparedGenerations).toHaveLength(1));

    harness.coordinator.cancelActive();
    await expect(harness.coordinator.submit('读取 new.txt')).resolves.toBeUndefined();
    await authorizeTask(harness);

    expect(fileTasks.cancelCalls).toBe(1);
    expect(fileTasks.preparedGenerations).toEqual([
      'generation-current',
      'generation-current'
    ]);
    expect(fileTasks.submissions).toEqual([expect.objectContaining({ text: '读取 new.txt' })]);

    barrier.resolve();
    await expect(first).resolves.toBeUndefined();
    expect(fileTasks.submissions).toHaveLength(1);
  });

  test('普通聊天只广播一次用户消息并形成完整历史回合', async () => {
    const script = scriptedProvider({
      type: 'text',
      text: '  **我在这里。**\n',
      emotion: 'calm'
    });
    const { coordinator, events, fileTasks, history } = createHarness([{
      profileId: 'profile-openai',
      providerIdentity: 'openai',
      providerName: 'OpenAI',
      script
    }]);

    await coordinator.submit('  今天有点累  ');

    expect(events.filter(event => event.type === 'message' && event.role === 'user')).toEqual([
      { type: 'message', role: 'user', text: '今天有点累' }
    ]);
    expect(phases(events)).toEqual(['listening', 'thinking', 'success']);
    expect(events).toContainEqual({
      type: 'message',
      role: 'assistant',
      text: '  **我在这里。**\n'
    });
    expect(events.some(event => event.type === 'character_emotion')).toBe(false);
    expect(history.turns()).toEqual([{
      userText: '今天有点累',
      assistantText: '  **我在这里。**\n',
      providerIdentity: 'openai'
    }]);
    expect(fileTasks.submissions).toEqual([]);
  });

  test('普通正文在表现结束后一次交付且历史只保存完整正文', async () => {
    const script = scriptedProvider({ type: 'text', text: '你好' });
    const behavior = behaviorPortDouble({ completeUserPrompt: vi.fn(async () => {
      expect(harness.events.some(event => event.type === 'message' && event.role === 'assistant')).toBe(false);
    }) });
    const harness = createHarness([{ profileId: 'chat', providerIdentity: 'openai', providerName: '聊天', script }], { behavior });
    await harness.coordinator.submit('你好呀');
    expect(harness.events.filter(event => event.type === 'message' && event.role === 'assistant')).toEqual([{ type: 'message', role: 'assistant', text: '你好' }]);
    expect(harness.history.turns()).toEqual([{ userText: '你好呀', assistantText: '你好', providerIdentity: 'openai' }]);
    await vi.waitFor(() => expect(behavior.completeUserPrompt).toHaveBeenCalledWith(expect.objectContaining({ expressionStatus: 'no_match', requestKind: 'ambient' })));
  });

  test('持久化流式回复后重建协调器继续聊天，旧新回复与上下文均保留', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ai-pet-conversation-restart-'));
    const file = join(directory, 'conversation.json');
    const encryption = {
      isEncryptionAvailable: () => true,
      encryptString: async (value: string) => Buffer.from(value, 'utf8').reverse(),
      decryptString: async (value: Buffer) => Buffer.from(value).reverse().toString('utf8')
    };
    const actualRespond = ConversationChatAdapter.prototype.respond;
    // 当前 Adapter 未向 Provider 转发增量；仅模拟其流式回调，正文与历史仍经过真实 Adapter。
    const streamedReply = vi.spyOn(ConversationChatAdapter.prototype, 'respond').mockImplementation(function (
      this: ConversationChatAdapter,
      input
    ) {
      input.onTextDelta?.('待提交片段');
      return actualRespond.call(this, input);
    });
    try {
      const before = new ConversationSessionStore(file, encryption);
      await before.initialize('model:a');
      const first = createHarness([{ profileId: 'chat', providerIdentity: 'openai', providerName: '聊天',
        script: scriptedProvider({ type: 'text', text: '重启前的完整回复' }) }], {
        history: before.history,
        onEmit: event => before.observe(event)
      });
      await first.coordinator.submit('重启前的问题');
      expect(first.events.some(event => event.type === 'assistant_message_commit')).toBe(true);
      await first.coordinator.close();
      await before.flush();

      const after = new ConversationSessionStore(file, encryption);
      await after.initialize('model:a');
      const nextScript = scriptedProvider({ type: 'text', text: '重启后的完整回复' });
      const second = createHarness([{ profileId: 'chat', providerIdentity: 'openai', providerName: '聊天', script: nextScript }], {
        history: after.history,
        onEmit: event => after.observe(event)
      });
      await second.coordinator.submit('接着上一轮聊');
      await second.coordinator.close();
      await after.flush();
      const restored = new ConversationSessionStore(file, encryption);
      await restored.initialize('model:a');
      expect(restored.snapshot().messages.map(message => [message.role, message.text])).toEqual([
        ['user', '重启前的问题'], ['assistant', '重启前的完整回复'],
        ['user', '接着上一轮聊'], ['assistant', '重启后的完整回复']
      ]);
      expect(nextScript.requests.find(request => !request.responseContract)?.messages.slice(-3).map(message => message.content)).toEqual([
        '重启前的问题', '重启前的完整回复', '接着上一轮聊'
      ]);
    } finally {
      streamedReply.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('取消后丢弃不服从 AbortSignal 的迟到增量与 commit', async () => {
    let emitLateDelta: (() => void) | undefined;
    const script = deferredProvider();
    script.provider.respond = async (request, signal) => {
      script.requests.push(request);
      script.signals.push(signal);
      if (request.responseContract) return { type: 'structured', structured_output: 表现选择() };
      request.onTextDelta?.('草稿');
      emitLateDelta = () => request.onTextDelta?.('迟到');
      return new Promise<ModelResponse>(resolve => {
        script.resolve = resolve;
      });
    };
    const { coordinator, events } = createHarness([{
      profileId: 'profile-local', providerIdentity: 'local',
      providerName: '本地模型', script
    }]);
    const pending = coordinator.submit('取消流式');
    await vi.waitFor(() => expect(emitLateDelta).toBeTypeOf('function'));

    coordinator.cancelActive();
    emitLateDelta?.();
    script.resolve({
      type: 'text', text: '草稿迟到', structured_output: 完整聊天控制()
    });
    await pending;

    expect(events.filter(event => event.type.startsWith('assistant_message_'))).toEqual([]);
    expect(JSON.stringify(events)).not.toContain('迟到');
    expect(events).not.toContainEqual(expect.objectContaining({
      type: 'assistant_message_commit'
    }));
  });

  test('自然文本回复形成完整历史回合且不调用文件端口', async () => {
    const script = scriptedProvider({
      type: 'text',
      text: '你希望我怎么帮你？'
    });
    const { coordinator, events, fileTasks, history } = createHarness([{
      profileId: 'profile-openai',
      providerIdentity: 'openai',
      providerName: 'OpenAI',
      script
    }]);

    await coordinator.submit('帮帮我');

    expect(phases(events)).toEqual(['listening', 'thinking', 'success']);
    expect(history.turns()).toEqual([{
      userText: '帮帮我',
      assistantText: '你希望我怎么帮你？',
      providerIdentity: 'openai'
    }]);
    expect(fileTasks.submissions).toEqual([]);
  });

  test('活动请求期间第二次提交稳定失败且不重复广播用户消息', async () => {
    const script = deferredProvider();
    const { coordinator, events } = createHarness([{
      profileId: 'profile-openai',
      providerIdentity: 'openai',
      providerName: 'OpenAI',
      script
    }]);
    const first = coordinator.submit('第一条');
    await Promise.resolve();
    await Promise.resolve();

    await expect(coordinator.submit('第二条')).rejects.toSatisfy(
      error => errorCode(error) === 'TASK_ALREADY_ACTIVE'
    );
    await expect(coordinator.submit('')).rejects.toSatisfy(
      error => errorCode(error) === 'TASK_ALREADY_ACTIVE'
    );
    await expect(coordinator.submit('🐾'.repeat(4_001))).rejects.toSatisfy(
      error => errorCode(error) === 'TASK_ALREADY_ACTIVE'
    );
    expect(events.filter(event => event.type === 'message' && event.role === 'user')).toEqual([
      { type: 'message', role: 'user', text: '第一条' }
    ]);
    expect(phases(events)).toEqual(['listening', 'thinking']);
    expect(events.filter(event => event.type === 'error')).toEqual([]);

    script.resolve({ type: 'text', text: '完成' });
    await first;
  });

  test('Provider 异常只走公开错误边界且不升级为文件任务', async () => {
    const providerError = Object.assign(new Error('provider failed'), {
      code: 'PROVIDER_SERVER_ERROR'
    });
    const { coordinator, events, fileTasks, history } = createHarness([{
      profileId: 'profile-openai',
      providerIdentity: 'openai',
      providerName: 'OpenAI',
      script: scriptedProvider(providerError)
    }]);

    const rejection = await coordinator.submit('你好').catch(error => error);

    expect(rejection).not.toBe(providerError);
    expect(errorCode(rejection)).toBe('PROVIDER_SERVER_ERROR');
    expect((rejection as Error).message).toBe('模型服务发生错误，请稍后重试。');
    expect(events).toContainEqual(expect.objectContaining({
      type: 'error',
      code: 'PROVIDER_SERVER_ERROR'
    }));
    expect(phases(events)).toEqual(['listening', 'thinking', 'error']);
    expect(fileTasks.submissions).toEqual([]);
    expect(history.turns()).toEqual([]);
  });

  test('Provider 格式子码只在 Main 内诊断且公开为既有通用格式错误', async () => {
    const providerError = new ProviderResponseError('HTTP_BODY_NOT_JSON', 'transport');
    const { coordinator, events } = createHarness([{
      profileId: 'profile-openai',
      providerIdentity: 'openai',
      providerName: 'OpenAI',
      script: scriptedProvider(providerError)
    }]);

    const rejection = await coordinator.submit('你好').catch(error => error);

    expect(errorCode(rejection)).toBe('PROVIDER_MALFORMED_RESPONSE');
    expect((rejection as Error).message).toBe('模型响应格式不兼容，请重试。');
    expect(events).toContainEqual(expect.objectContaining({
      type: 'error',
      code: 'PROVIDER_MALFORMED_RESPONSE'
    }));
  });

  test.each<[string, ModelResponse]>([
    ['纯文本', { type: 'text', text: '普通纯文本' }],
    ['只有正文', { type: 'text', text: '只有正文', structured_output: { text: '只有正文' } }],
    ['非法隐藏控制', {
      type: 'text',
      text: '正文仍然有效。',
      structured_output: {
        text: '正文仍然有效。',
        movementControl: { kind: 'move_once', target: { x: 1, y: 2 }, distance: 'far' }
      }
    }],
    ['截断后恢复正文', {
      type: 'text',
      text: '截断前的正文',
      structured_output: { text: '截断前的正文' }
    }]
  ])('普通聊天%s成功时不创建 Agent 且不发布任务执行失败', async (_shape, response) => {
    const harness = createHarness([{
      profileId: 'profile-openai',
      providerIdentity: 'openai',
      providerName: 'OpenAI',
      script: scriptedProvider(response, _shape === '纯文本')
    }]);

    await expect(harness.coordinator.submit('你好')).resolves.toBeUndefined();

    expect(harness.fileTasks.activationCalls).toBe(0);
    expect(harness.fileTasks.submissions).toEqual([]);
    expect(JSON.stringify(harness.events)).not.toContain('任务执行失败');
  });

  test('主请求空正文直接公开格式错误且不创建 Agent', async () => {
    const malformed = Object.assign(new Error('PROVIDER_MALFORMED_RESPONSE'), {
      code: 'PROVIDER_MALFORMED_RESPONSE'
    });
    const harness = createHarness([{
      profileId: 'profile-openai',
      providerIdentity: 'openai',
      providerName: 'OpenAI',
      script: scriptedProvider(malformed)
    }]);

    await expect(harness.coordinator.submit('你好')).rejects.toMatchObject({
      code: 'PROVIDER_MALFORMED_RESPONSE',
      message: '模型响应格式不兼容，请重试。'
    });
    expect(harness.fileTasks.activationCalls).toBe(0);
    expect(harness.fileTasks.submissions).toEqual([]);
    expect(JSON.stringify(harness.events)).not.toContain('任务执行失败');
  });

  test.each<[string, ModelResponse]>([
    ['工具请求', {
      type: 'tool_request',
      request: {
        requestId: 'tool-request',
        toolName: 'read_text_file',
        arguments: {}
      }
    }],
    ['空白正文', { type: 'text', text: '   ' }],
    ['超长正文', { type: 'text', text: '长'.repeat(8_001) }]
  ])('聊天适配器拒绝%s后回到 idle、历史不追加且允许重试', async (_name, response) => {
    const harness = createHarness([
      {
        profileId: 'profile-openai',
        providerIdentity: 'openai',
        providerName: 'OpenAI',
        script: scriptedProvider(response)
      },
      {
        profileId: 'profile-openai',
        providerIdentity: 'openai',
        providerName: 'OpenAI',
        script: scriptedProvider({ type: 'text', text: '重试成功' })
      }
    ]);

    await expect(harness.coordinator.submit('第一次')).rejects.toMatchObject({
      code: 'PROVIDER_MALFORMED_RESPONSE',
      message: '模型响应格式不兼容，请重试。'
    });
    expect(harness.history.turns()).toEqual([]);
    expect(harness.fileTasks.preparedGenerations).toEqual([]);

    await expect(harness.coordinator.submit('重试')).resolves.toBeUndefined();
    expect(harness.history.turns()).toEqual([{
      userText: '重试',
      assistantText: '重试成功',
      providerIdentity: 'openai'
    }]);
  });

  test.each([
    ['普通异常', new Error('raw-secret')],
    ['伪造错误码', Object.assign(new Error('raw-secret'), { code: 'PATH_OUTSIDE_ROOT' })]
  ])('将工厂的%s归一化且不泄露原始错误', async (_name, rawError) => {
    const { coordinator, events } = createHarness([任务模型(), 任务模型()], { factoryError: rawError });

    const rejection = await coordinator.submit('你好').catch(error => error);

    expect(rejection).not.toBe(rawError);
    expect(errorCode(rejection)).toBe('AGENT_INTERNAL_ERROR');
    expect((rejection as Error).message).toBe('任务执行失败，请重试。');
    expect(JSON.stringify(events)).not.toContain('raw-secret');
    expect(events).toContainEqual({
      type: 'error',
      code: 'AGENT_INTERNAL_ERROR',
      message: '任务执行失败，请重试。'
    });
  });

  test('将 Disclosure Adapter 原始异常归一化为内部错误', async () => {
    const rawError = Object.assign(new Error('raw-disclosure-secret'), {
      code: 'DISCLOSURE_CROSS_PROVIDER_NOT_AUTHORIZED'
    });
    const harness = createHarness([{
      profileId: 'profile-openai',
      providerIdentity: 'openai',
      providerName: 'OpenAI',
      script: scriptedProvider({
        type: 'text',
        text: '不应调用'
      })
    }]);
    harness.disclosureAdapter.prepare = () => {
      throw rawError;
    };

    const rejection = await harness.coordinator.submit('你好').catch(error => error);

    expect(rejection).not.toBe(rawError);
    expect(errorCode(rejection)).toBe('AGENT_INTERNAL_ERROR');
    expect(JSON.stringify(harness.events)).not.toContain('raw-disclosure-secret');
  });

  test('跨 Provider 历史先暂停确认且确认后不重复用户消息', async () => {
    const first = scriptedProvider({
      type: 'text',
      text: '第一轮回复'
    });
    const second = scriptedProvider({
      type: 'text',
      text: '第二轮回复'
    });
    const { coordinator, events, history } = createHarness([
      {
        profileId: 'profile-openai',
        providerIdentity: 'openai',
        providerName: 'OpenAI',
        script: first
      },
      {
        profileId: 'profile-anthropic',
        providerIdentity: 'anthropic',
        providerName: 'Anthropic',
        script: second
      }
    ]);
    await coordinator.submit('第一轮');

    const pending = coordinator.submit('第二轮');
    await pending;

    expect(second.requests).toEqual([]);
    expect(events).toContainEqual({
      type: 'history_disclosure_required',
      requestId: 'request-2',
      targetProviderName: 'Anthropic',
      messageCount: 2,
      characterCount: 8
    });
    await expect(coordinator.submit('并发消息')).rejects.toSatisfy(
      error => errorCode(error) === 'TASK_ALREADY_ACTIVE'
    );
    await expect(coordinator.resolveHistoryDisclosure('expired', 'share_once')).rejects
      .toSatisfy(error => errorCode(error) === 'DISCLOSURE_REQUEST_EXPIRED');
    await expect(coordinator.resolveFileAction('action-1', 'confirm')).rejects
      .toSatisfy(error => errorCode(error) === 'ACTION_EXPIRED');
    expect(phases(events).slice(-2)).toEqual(['listening', 'thinking']);
    expect(events.filter(event => event.type === 'error')).toEqual([]);

    await coordinator.resolveHistoryDisclosure('request-2', 'share_once');

    expect(second.requests).toHaveLength(2);
    expect(second.requests[0]?.messages).toContainEqual({
      role: 'assistant',
      content: '第一轮回复'
    });
    expect(events.filter(event => event.type === 'message' && event.role === 'user')).toEqual([
      { type: 'message', role: 'user', text: '第一轮' },
      { type: 'message', role: 'user', text: '第二轮' }
    ]);
    expect(history.turns()).toHaveLength(2);
  });

  test('取消后忽略不服从 AbortSignal 的旧模型响应', async () => {
    const script = deferredProvider();
    const { coordinator, events, history, behavior } = createHarness([{
      profileId: 'profile-openai',
      providerIdentity: 'openai',
      providerName: 'OpenAI',
      script
    }]);
    const pending = coordinator.submit('旧消息');
    await Promise.resolve();
    await Promise.resolve();

    coordinator.cancelActive();
    script.resolve({ type: 'text', text: '旧回复' });
    await pending;

    expect(history.turns()).toEqual([]);
    expect(behavior.cancelActive).toHaveBeenCalledOnce();
    expect(events).not.toContainEqual({ type: 'message', role: 'assistant', text: '旧回复' });
    expect(phases(events)).toEqual(['listening', 'thinking', 'cancelled']);
  });

  test.each(['cancel', 'close'] as const)('%s 后静默收敛迟到的原始拒绝', async action => {
    const script = deferredProvider();
    const { coordinator, events } = createHarness([{
      profileId: 'profile-openai',
      providerIdentity: 'openai',
      providerName: 'OpenAI',
      script
    }]);
    const pending = coordinator.submit('旧消息');
    await Promise.resolve();
    await Promise.resolve();

    if (action === 'cancel') coordinator.cancelActive();
    else await coordinator.close();
    script.reject(Object.assign(new Error('raw-late-error'), { code: 'FORGED_CODE' }));

    await expect(pending).resolves.toBeUndefined();
    expect(JSON.stringify(events)).not.toContain('raw-late-error');
  });

  test('用户消息监听器同步取消后不再发布阶段或创建模型', async () => {
      const script = scriptedProvider({
        type: 'text',
        text: '不应出现'
      });
    let cancelled = false;
    const { coordinator, events, factoryCallCount, history } = createHarness([{
      profileId: 'profile-openai',
      providerIdentity: 'openai',
      providerName: 'OpenAI',
      script
    }], {
      onEmit: (event, target) => {
        if (event.type === 'message' && event.role === 'user' && !cancelled) {
          cancelled = true;
          target.cancelActive();
        }
      }
    });

    await coordinator.submit('同步取消');

    expect(events).toEqual([
      { type: 'message', role: 'user', text: '同步取消' },
      { type: 'phase', phase: 'cancelled' }
    ]);
    expect(factoryCallCount()).toBe(0);
    expect(script.requests).toEqual([]);
    expect(history.turns()).toEqual([]);
  });

  test('abort 监听器同步 close 后旧取消栈不发布 cancelled', async () => {
    const script = deferredProvider();
    const { coordinator, events } = createHarness([{
      profileId: 'profile-openai',
      providerIdentity: 'openai',
      providerName: 'OpenAI',
      script
    }]);
    const pending = coordinator.submit('将被关闭');
    await Promise.resolve();
    await Promise.resolve();
    script.signals[0]?.addEventListener('abort', () => {
      void coordinator.close();
    });

    coordinator.cancelActive();

    expect(phases(events)).toEqual(['listening', 'thinking']);
    await expect(coordinator.submit('不得重开')).rejects.toSatisfy(
      error => errorCode(error) === 'CONVERSATION_CLOSED'
    );
    script.resolve({ type: 'text', text: '迟到' });
    await pending;
  });

  test('abort 监听器同步开始新请求后旧取消栈不污染新阶段', async () => {
    const oldScript = deferredProvider();
    const newScript = scriptedProvider({
      type: 'text',
      text: '新回复'
    });
    const { coordinator, events } = createHarness([
      {
        profileId: 'profile-openai',
        providerIdentity: 'openai',
        providerName: 'OpenAI',
        script: oldScript
      },
      {
        profileId: 'profile-openai',
        providerIdentity: 'openai',
        providerName: 'OpenAI',
        script: newScript
      }
    ]);
    const oldPending = coordinator.submit('旧请求');
    await Promise.resolve();
    await Promise.resolve();
    let newPending!: Promise<void>;
    oldScript.signals[0]?.addEventListener('abort', () => {
      newPending = coordinator.submit('新请求');
    });

    coordinator.cancelActive();
    oldScript.resolve({ type: 'text', text: '旧回复' });
    await oldPending;
    await newPending;

    expect(phases(events)).toEqual([
      'listening',
      'thinking',
      'listening',
      'thinking',
      'success'
    ]);
    expect(events).not.toContainEqual({ type: 'phase', phase: 'cancelled' });
  });

  test.each(['cancel', 'close'] as const)(
    'Disclosure resolve 同步 %s 后不调用 Provider',
    async action => {
      const script = scriptedProvider({
        type: 'text',
        text: '不应出现'
      });
      const harness = createHarness([{
        profileId: 'profile-anthropic',
        providerIdentity: 'anthropic',
        providerName: 'Anthropic',
        script
      }]);
      harness.history.append({
        userText: '旧用户',
        assistantText: '旧助手',
        providerIdentity: 'openai'
      });
      await harness.coordinator.submit('新消息');
    await authorizeTask(harness);
      harness.disclosureAdapter.resolve = () => {
        if (action === 'cancel') harness.coordinator.cancelActive();
        else void harness.coordinator.close();
        return [
          { role: 'user', content: '不得发送的历史' },
          { role: 'assistant', content: '不得发送的历史' }
        ];
      };

      await harness.coordinator.resolveHistoryDisclosure('request-1', 'share_once');

      expect(script.requests).toEqual([]);
      expect(harness.history.turns()).toHaveLength(1);
    }
  );

  test('History append 同步 close 时助手已公开且不会覆盖 closed', async () => {
    const script = scriptedProvider({
      type: 'text',
      text: '不得公开'
    });
    const harness = createHarness([{
      profileId: 'profile-openai',
      providerIdentity: 'openai',
      providerName: 'OpenAI',
      script
    }]);
    const append = harness.history.append.bind(harness.history);
    harness.history.append = turn => {
      append(turn);
      void harness.coordinator.close();
    };

    await harness.coordinator.submit('追加后关闭');
    await authorizeTask(harness);

    expect(harness.history.turns()).toEqual([{
      userText: '追加后关闭',
      assistantText: '不得公开',
      providerIdentity: 'openai'
    }]);
    expect(harness.events).toContainEqual({
      type: 'message',
      role: 'assistant',
      text: '不得公开'
    });
    await expect(harness.coordinator.submit('不得重开')).rejects.toSatisfy(
      error => errorCode(error) === 'CONVERSATION_CLOSED'
    );
  });

  test.each(['cancel', 'reset', 'close'] as const)(
    '助手消息监听器同步 %s 后不写历史或覆盖新状态',
    async action => {
    const script = scriptedProvider({
      type: 'text',
      text: '已可见回复',
      emotion: 'calm'
    });
    let acted = false;
    let lifecycle = Promise.resolve();
    const { coordinator, events, history } = createHarness([{
      profileId: 'profile-openai',
      providerIdentity: 'openai',
      providerName: 'OpenAI',
      script
    }], {
      onEmit: (event, target) => {
        if (event.type === 'message' && event.role === 'assistant' && !acted) {
          acted = true;
          if (action === 'cancel') target.cancelActive();
          else lifecycle = action === 'reset'
            ? target.resetConversation()
            : target.close();
        }
      }
    });

    await coordinator.submit('同步关闭');
    await lifecycle;

    expect(history.turns()).toEqual([]);
    expect(events).toContainEqual({
      type: 'message',
      role: 'assistant',
      text: '已可见回复'
    });
    expect(events).not.toContainEqual({ type: 'character_emotion', label: 'calm' });
    expect(phases(events)).not.toContain('success');
    if (action === 'close') {
      await expect(coordinator.submit('关闭后消息')).rejects.toSatisfy(
        error => errorCode(error) === 'CONVERSATION_CLOSED'
      );
    }
  });

  test('助手消息公开失败时不写历史并回到公开错误边界', async () => {
    const rawError = new Error('renderer-send-private-error');
    const harness = createHarness([{
      profileId: 'profile-openai',
      providerIdentity: 'openai',
      providerName: 'OpenAI',
      script: scriptedProvider({ type: 'text', text: '不得写入历史' })
    }], {
      onEmit: event => {
        if (event.type === 'message' && event.role === 'assistant') throw rawError;
      }
    });

    await expect(harness.coordinator.submit('触发公开失败')).rejects.toMatchObject({
      code: 'AGENT_INTERNAL_ERROR',
      message: '任务执行失败，请重试。'
    });

    expect(harness.history.turns()).toEqual([]);
    expect(JSON.stringify(harness.events)).not.toContain('renderer-send-private-error');
  });

  test('close 先封闭状态并在清理失败时继续全部清理', async () => {
    const script = deferredProvider();
    const fileTasks = new CapturingCapabilityTasks();
    fileTasks.unsubscribeError = new Error('raw-unsubscribe-error');
    const harness = createHarness([{
      profileId: 'profile-openai',
      providerIdentity: 'openai',
      providerName: 'OpenAI',
      script
    }], { fileTasks });
    let resetCalls = 0;
    harness.disclosureAdapter.reset = () => {
      resetCalls += 1;
      throw new Error('raw-reset-error');
    };
    const pending = harness.coordinator.submit('关闭中的消息');
    await Promise.resolve();
    await Promise.resolve();

    const rejection = await harness.coordinator.close().catch(error => error);

    expect(errorCode(rejection)).toBe('AGENT_INTERNAL_ERROR');
    expect((rejection as Error).message).toBe('任务执行失败，请重试。');
    expect(fileTasks.unsubscribeCalls).toBe(1);
    expect(fileTasks.closeCalls).toBe(1);
    expect(resetCalls).toBe(1);
    expect(script.signals[0]?.aborted).toBe(true);
    await expect(harness.coordinator.submit('不得重开')).rejects.toSatisfy(
      error => errorCode(error) === 'CONVERSATION_CLOSED'
    );

    script.reject(new Error('raw-late-error'));
    await expect(pending).resolves.toBeUndefined();
  });

  test('close 等待文件端口不可逆执行屏障收敛且并发关闭共享同一结果', async () => {
    const fileTasks = new CapturingCapabilityTasks();
    const barrier = deferredVoid();
    fileTasks.closeBarrier = barrier.promise;
    const { coordinator } = createHarness([任务模型(), 任务模型()], { fileTasks });
    let settled = false;

    const first = coordinator.close().then(() => { settled = true; });
    const second = coordinator.close();
    await Promise.resolve();

    expect(settled).toBe(false);
    await vi.waitFor(() => expect(fileTasks.closeCalls).toBe(1));
    barrier.resolve();
    await Promise.all([first, second]);
    expect(settled).toBe(true);
  });

  test('只转发当前会话 generation 的文件端口事件', async () => {
    const script = scriptedProvider({
      type: 'text',
      text: '回复'
    });
    const { coordinator, events, fileTasks } = createHarness([{
      profileId: 'profile-openai',
      providerIdentity: 'openai',
      providerName: 'OpenAI',
      script
    }]);

    fileTasks.publish({ type: 'phase', phase: 'acting' }, 'generation-old');
    fileTasks.publish({ type: 'phase', phase: 'acting' }, 'generation-current');

    expect(phases(events)).toEqual(['acting']);
    await coordinator.close();
    fileTasks.publish({ type: 'phase', phase: 'success' }, 'generation-current');
    expect(phases(events)).toEqual(['acting']);
  });

  test('按 Unicode 字符校验并规范化一到四千字符输入', async () => {
    const script = scriptedProvider({
      type: 'text',
      text: '收到'
    });
    const { coordinator, events } = createHarness([{
      profileId: 'profile-openai',
      providerIdentity: 'openai',
      providerName: 'OpenAI',
      script
    }]);

    await coordinator.submit(`  ${'🐾'.repeat(4_000)}  `);
    expect(script.requests[0]?.messages.at(-1)).toEqual({
      role: 'user',
      content: '🐾'.repeat(4_000)
    });

    await expect(coordinator.submit('🐾'.repeat(4_001))).rejects.toSatisfy(
      error => errorCode(error) === 'INPUT_INVALID'
    );
    expect(events.filter(event => event.type === 'message' && event.role === 'user')).toHaveLength(1);
  });

  test('主模型申请后准备目标并把同一目标快照提交给文件端口', async () => {
    const harness = createHarness([任务模型(), 任务模型()]);
    harness.history.append({
      userText: '旧问题',
      assistantText: '旧回答',
      providerIdentity: 'openai'
    });

    const submitting = harness.coordinator.submit('整理文件');
    await submitting;
    await authorizeTask(harness);
    await vi.waitFor(() => expect(harness.fileTasks.submissions).toHaveLength(1));
    harness.fileTasks.publish({ type: 'message', role: 'assistant', text: '整理完成' }, 'generation-current');
    harness.fileTasks.publish({ type: 'phase', phase: 'success' }, 'generation-current');
    await submitting;

    expect(harness.fileTasks.preparedGenerations).toEqual(['generation-current']);
    expect(harness.fileTasks.submissions).toEqual([{
      text: '整理文件',
      visibleHistory: [
        { role: 'user', content: '旧问题' },
        { role: 'assistant', content: '旧回答' }
      ],
      generation: 'generation-current',
      taskKind: 'file'
    }]);
    expect(harness.history.turns().at(-1)).toEqual({
      userText: '整理文件',
      assistantText: '整理完成',
      providerIdentity: 'openai'
    });
  });

  test('文件目标预检缺少授权时稳定失败，且不降级为聊天成功', async () => {
    const fileTasks = new CapturingCapabilityTasks();
    fileTasks.prepareError = Object.assign(new Error('FILE_AUTHORIZATION_REQUIRED'), {
      code: 'FILE_AUTHORIZATION_REQUIRED'
    });
    const harness = createHarness([任务模型(), 任务模型()], { fileTasks });

    await expect(harness.coordinator.submit('整理文件')).rejects.toSatisfy(
      error => errorCode(error) === 'FILE_AUTHORIZATION_REQUIRED'
    );

    expect(fileTasks.submissions).toEqual([]);
    expect(harness.events).toContainEqual(expect.objectContaining({
      type: 'error',
      code: 'FILE_AUTHORIZATION_REQUIRED'
    }));
    expect(phases(harness.events)).not.toContain('success');
  });

  test('文件任务 phase:error 公开失败后释放状态、允许再次提交且不写历史', async () => {
    const harness = createHarness([任务模型(), 任务模型()]);
    await harness.coordinator.submit('读取 失败.txt');
    await authorizeTask(harness);

    harness.fileTasks.publish({
      type: 'error',
      code: 'PATH_INVALID',
      message: '文件路径无效。'
    }, 'generation-current');
    harness.fileTasks.publish({ type: 'phase', phase: 'error' }, 'generation-current');

    expect(harness.events).toContainEqual({
      type: 'error',
      code: 'PATH_INVALID',
      message: '文件路径无效。'
    });
    expect(harness.history.turns()).toEqual([]);
    await expect(harness.coordinator.submit('读取 重试.txt')).resolves.toBeUndefined();
    await authorizeTask(harness);
    expect(harness.fileTasks.submissions).toHaveLength(2);
  });

  test.each([
    ['share_once', [
      { role: 'user', content: '旧问题' },
      { role: 'assistant', content: '旧回答' }
    ]],
    ['current_message_only', []],
  ] as const)('文件目标跨 Provider 时 %s 后只恢复一次原提交 %#', async (decision, expectedHistory) => {
    const harness = createHarness([任务模型(), 任务模型()]);
    harness.fileTasks.target = Object.freeze({
      profileId: 'profile-anthropic-agent',
      providerIdentity: 'anthropic',
      providerName: 'Anthropic Agent',
      capabilityRevision: 'revision-anthropic',
    directory: 'D:\\authorized', modelId: 'model-test', approvedCommands: [],
    });
    harness.history.append({
      userText: '旧问题',
      assistantText: '旧回答',
      providerIdentity: 'openai'
    });

    await harness.coordinator.submit('整理文件');
    await authorizeTask(harness);

    expect(harness.fileTasks.submissions).toEqual([]);
    expect(harness.events).toContainEqual({
      type: 'history_disclosure_required',
      requestId: 'request-2',
      targetProviderName: 'Anthropic Agent',
      messageCount: 2,
      characterCount: 6
    });
    await expect(harness.coordinator.resolveHistoryDisclosure('forged', decision)).rejects
      .toSatisfy(error => errorCode(error) === 'DISCLOSURE_REQUEST_EXPIRED');

    await harness.coordinator.resolveHistoryDisclosure('request-2', decision);
    await authorizeTask(harness);

    expect(harness.fileTasks.submissions).toEqual([{
      text: '整理文件',
      visibleHistory: expectedHistory,
      generation: 'generation-current',
      taskKind: 'file'
    }]);
    await expect(harness.coordinator.resolveHistoryDisclosure('request-2', decision)).rejects
      .toSatisfy(error => errorCode(error) === 'DISCLOSURE_REQUEST_EXPIRED');
  });

  test('配置失效保留已完成上下文，同时取消请求并隔离迟到回复', async () => {
    const oldProvider = deferredProvider();
    const harness = createHarness([{ profileId: 'profile-openai', providerIdentity: 'openai', providerName: 'OpenAI', script: oldProvider }]);
    harness.history.append({ userText: '需要保留的问题', assistantText: '需要保留的回答', providerIdentity: 'openai' });
    const running = harness.coordinator.submit('正在处理的问题');
    await vi.waitFor(() => expect(oldProvider.requests.some(request => !request.responseContract)).toBe(true));
    await harness.coordinator.resetConversation({ preserveMessages: true });
    oldProvider.resolve({ type: 'text', text: '迟到正文不能接纳' });
    await running;
    expect(harness.history.turns()).toEqual([{ userText: '需要保留的问题', assistantText: '需要保留的回答', providerIdentity: 'openai' }]);
    expect(oldProvider.signals[0]?.aborted).toBe(true);
    expect(harness.fileTasks.resetCalls).toBe(1);
    expect(harness.events).toContainEqual({ type: 'conversation_reset', generation: 'request-2', preserveMessages: true });
    expect(harness.events.some(event => event.type === 'message' && event.text === '迟到正文不能接纳')).toBe(false);
    await harness.coordinator.close();
  });

  test('重置先更换 generation，再按顺序清理并隔离旧 Provider 迟到回复', async () => {
    const oldProvider = deferredProvider();
    const harness = createHarness([{
      profileId: 'profile-openai',
      providerIdentity: 'openai',
      providerName: 'OpenAI',
      script: oldProvider
    }]);
    harness.history.append({
      userText: '旧问题',
      assistantText: '旧回答',
      providerIdentity: 'openai'
    });
    const order: string[] = [];
    const disclosureReset = harness.disclosureAdapter.reset.bind(harness.disclosureAdapter);
    harness.disclosureAdapter.reset = () => {
      order.push('disclosure');
      disclosureReset();
    };
    harness.fileTasks.resetForNewConversation = async () => {
      order.push('file');
    };
    const historyClear = harness.history.clear.bind(harness.history);
    harness.history.clear = () => {
      order.push('history');
      historyClear();
    };
    const running = harness.coordinator.submit('旧消息');
    await vi.waitFor(() => expect(oldProvider.requests.filter(request => !request.responseContract)).toHaveLength(1));

    const resetting = harness.coordinator.resetConversation();
    oldProvider.resolve({ type: 'text', text: '不得进入新会话' });
    await resetting;
    await running;

    expect(order).toEqual(['disclosure', 'file', 'history']);
    expect(oldProvider.signals[0]?.aborted).toBe(true);
    expect(harness.events).toContainEqual({
      type: 'conversation_reset',
      generation: 'request-2'
    });
    expect(harness.events).not.toContainEqual(expect.objectContaining({
      text: '不得进入新会话'
    }));
    expect(harness.history.turns()).toEqual([]);
  });

  test('等待文件披露时 reset 使旧 requestId 失效且绝不提交旧目标', async () => {
    const harness = createHarness([任务模型(), 任务模型()]);
    harness.fileTasks.target = Object.freeze({
      profileId: 'profile-anthropic-agent',
      providerIdentity: 'anthropic',
      providerName: 'Anthropic Agent',
      capabilityRevision: 'revision-anthropic',
    directory: 'D:\\authorized', modelId: 'model-test', approvedCommands: [],
    });
    harness.history.append({
      userText: '旧问题',
      assistantText: '旧回答',
      providerIdentity: 'openai'
    });
    await harness.coordinator.submit('整理文件');

    const disclosure = harness.events.find(event => event.type === 'history_disclosure_required');
    if (disclosure?.type !== 'history_disclosure_required') throw new Error('缺少实际披露请求');
    const requestId = disclosure.requestId;
    await harness.coordinator.resetConversation();

    await expect(harness.coordinator.resolveHistoryDisclosure(requestId, 'share_once')).rejects
      .toSatisfy(error => errorCode(error) === 'DISCLOSURE_REQUEST_EXPIRED');
    expect(harness.fileTasks.submissions).toEqual([]);
    expect(harness.events).toContainEqual({
      type: 'conversation_reset',
      generation: 'request-3'
    });
  });

  test('等待具体许可时 reset 委托文件清理并使旧 actionId 失效', async () => {
    const fileTasks = new CapturingCapabilityTasks();
    fileTasks.submit = async input => {
      fileTasks.submissions.push(input);
      fileTasks.publish({ type: 'phase', phase: 'awaiting_confirmation' }, input.generation);
      return { kind: 'completed', acted: true };
    };
    const harness = createHarness([任务模型(), 任务模型()], { fileTasks });

    await harness.coordinator.submit('创建文件');
    await harness.coordinator.resetConversation();

    expect(fileTasks.resetCalls).toBe(1);
    await expect(harness.coordinator.resolveFileAction('old-action', 'confirm')).rejects
      .toSatisfy(error => errorCode(error) === 'ACTION_EXPIRED');
  });

  test('任一重置清理失败后保持 resetting 并永久拒绝旧 generation 与新提交', async () => {
    const harness = createHarness([任务模型(), 任务模型()]);
    harness.fileTasks.resetError = new Error('raw-reset-failure');

    await expect(harness.coordinator.resetConversation()).rejects.toSatisfy(
      error => errorCode(error) === 'AGENT_INTERNAL_ERROR'
    );

    harness.fileTasks.publish({ type: 'message', role: 'assistant', text: '旧事件' }, 'generation-current');
    await expect(harness.coordinator.submit('不得提交')).rejects.toSatisfy(
      error => errorCode(error) === 'TASK_ALREADY_ACTIVE'
    );
    expect(harness.events).not.toContainEqual(expect.objectContaining({ text: '旧事件' }));
  });
});

test('Core 终态到达后立即撤销运行中表现，即使提交尚未结算', async () => {
  let release!: (value: ModelResponse) => void;
  let expressionSignal: AbortSignal | undefined;
  const expression = new Promise<ModelResponse>(resolve => { release = resolve; });
  const script: ProviderScript = { requests: [], signals: [], provider: { respond: async (request, signal) => {
    if (request.responseContract) { expressionSignal = signal; return expression; }
    return 申请任务();
  } } };
  const barrier = deferredVoid();
  const fileTasks = new CapturingCapabilityTasks();
  fileTasks.submit = async input => { fileTasks.submissions.push(input); await barrier.promise; return { kind: 'completed', acted: false }; };
  const accepted: string[] = [];
  const harness = createHarness([{ profileId: 'chat', providerIdentity: 'openai', providerName: 'Chat', script }], {
    fileTasks, behavior: behaviorPortDouble({ completeUserPrompt: async input => { accepted.push(input.eventId); } })
  });
  await harness.coordinator.submit('检查文件');
  await authorizeTask(harness);
  fileTasks.publish({ type: 'phase', phase: 'success' }, 'generation-current');
  const abortedAtTerminal = expressionSignal?.aborted;
  release({ type: 'structured', structured_output: 表现选择() });
  for (let index = 0; index < 20; index++) await Promise.resolve();
  const acceptedAtTerminal = [...accepted];
  barrier.resolve();
  await harness.coordinator.close();
  expect({ abortedAtTerminal, acceptedAtTerminal }).toEqual({ abortedAtTerminal: true, acceptedAtTerminal: [] });
});

test('可选任务表现异常不能阻止已授权 Core 提交', async () => {
  const presentation = vi.fn(async () => { throw new Error('播放模块发布失败'); });
  const reportFailure = vi.fn();
  const releasePreparation = vi.fn();
  const harness = createHarness([任务模型()], { singleSlot: true, behavior: behaviorPortDouble({
    prepareTaskPresentation: presentation, reportTaskPresentationFailure: reportFailure, cancelTaskPreparation: releasePreparation
  }) });
  await harness.coordinator.submit('检查文件');
  await authorizeTask(harness);
  const submissions = harness.fileTasks.submissions.length;
  await harness.coordinator.close();
  expect(presentation).toHaveBeenCalledTimes(1);
  expect(submissions).toBe(1);
  expect(reportFailure).toHaveBeenCalledTimes(1);
  expect(releasePreparation).toHaveBeenCalled();
});

test('文件历史披露不应丢失本轮 Qwen 首帧准备所有权', async () => {
  const presentation = vi.fn(async () => {});
  const harness = createHarness([任务模型()], { singleSlot: true, behavior: behaviorPortDouble({ prepareTaskPresentation: presentation }) });
  harness.fileTasks.target = Object.freeze({ ...harness.fileTasks.target, providerIdentity: 'anthropic', profileId: 'other-agent' });
  harness.history.append({ userText: '先前输入', assistantText: '先前回复', providerIdentity: 'openai' });
  await harness.coordinator.submit('检查文件');
  const disclosure = harness.events.find(event => event.type === 'history_disclosure_required');
  if (disclosure?.type !== 'history_disclosure_required') throw new Error('缺少文件披露');
  await harness.coordinator.resolveHistoryDisclosure(disclosure.requestId, 'share_once');
  await authorizeTask(harness);
  const submissions = harness.fileTasks.submissions.length;
  await harness.coordinator.close();
  expect(submissions).toBe(1);
  expect(presentation).toHaveBeenCalledTimes(1);
});

test('角色生命周期变化撤销独立表现，普通活动通知不撤销且关闭解除订阅', async () => {
  let lifecycle = 0;
  let notify!: () => void;
  const unsubscribe = vi.fn();
  const barrier = deferredVoid();
  let expressionSignal: AbortSignal | undefined;
  const script: ProviderScript = { requests: [], signals: [], provider: { respond: async (request, signal) => {
    if (!request.responseContract) return { type: 'text', text: '正文已交付' };
    expressionSignal = signal; await barrier.promise;
    return { type: 'structured', structured_output: 表现选择() };
  } } };
  const accepted = vi.fn();
  const harness = createHarness([{ profileId: 'chat', providerIdentity: 'openai', providerName: 'Chat', script }], {
    behavior: behaviorPortDouble({ completeUserPrompt: accepted, getBehaviorLifecycleGeneration: () => lifecycle,
      subscribeActivityBlockers: listener => { notify = listener; return unsubscribe; } })
  });
  await harness.coordinator.submit('你好');
  notify?.();
  expect(expressionSignal?.aborted).toBe(false);
  lifecycle++;
  notify?.();
  const aborted = expressionSignal?.aborted;
  barrier.resolve();
  for (let index = 0; index < 20; index++) await Promise.resolve();
  await harness.coordinator.close();
  expect(aborted).toBe(true);
  expect(accepted).not.toHaveBeenCalled();
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});

test('终态通过真实事件用途表现，提交结算后不再发起第二次推理', async () => {
  const script = scriptedProvider(申请任务());
  const barrier = deferredVoid();
  const fileTasks = new CapturingCapabilityTasks();
  fileTasks.submit = async () => { await barrier.promise; return { kind: 'completed', acted: false }; };
  const accepted = vi.fn();
  const harness = createHarness([{ profileId: 'chat', providerIdentity: 'openai', providerName: 'Chat', script }], {
    fileTasks, behavior: behaviorPortDouble({ completeUserPrompt: accepted,
      captureExpressionContext: () => ({ instance: Symbol.for('角色'), contextRevision: 0, moodRevision: 0 }) })
  });
  await harness.coordinator.submit('检查文件');
  await authorizeTask(harness);
  fileTasks.publish({ type: 'phase', phase: 'success' }, 'generation-current');
  expect(script.requests.filter(request => request.responseContract)).toHaveLength(1);
  barrier.resolve();
  await vi.waitFor(() => expect(harness.events).toContainEqual({ type: 'phase', phase: 'success' }));
  expect(script.requests.filter(request => request.responseContract)).toHaveLength(1);
  await harness.coordinator.close();
  expect(accepted.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
  expect(accepted).toHaveBeenCalledTimes(1);
});

test('终态后提交结算前角色变化撤销待启动反应，不能复活已失效owner', async () => {
  let lifecycle = 0;
  let notify!: () => void;
  const script = scriptedProvider(申请任务());
  const barrier = deferredVoid();
  const fileTasks = new CapturingCapabilityTasks();
  fileTasks.submit = async () => { await barrier.promise; return { kind: 'completed', acted: false }; };
  const harness = createHarness([{ profileId: 'chat', providerIdentity: 'openai', providerName: 'Chat', script }], {
    fileTasks, behavior: behaviorPortDouble({ getBehaviorLifecycleGeneration: () => lifecycle,
      subscribeActivityBlockers: listener => { notify = listener; return () => {}; },
      captureExpressionContext: () => ({ instance: Symbol.for('角色'), contextRevision: 0, moodRevision: 0 }) })
  });
  await harness.coordinator.submit('检查文件');
  await authorizeTask(harness);
  fileTasks.publish({ type: 'phase', phase: 'success' }, 'generation-current');
  lifecycle++;
  notify();
  barrier.resolve();
  for (let index = 0; index < 20; index++) await Promise.resolve();
  await harness.coordinator.close();
  expect(script.requests.filter(request => request.responseContract)).toHaveLength(1);
});
