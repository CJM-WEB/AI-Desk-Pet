import type { ModelProvider, ModelRequest, ModelResponse } from '@myself/agent-core';
import type { TaskEvent } from '@myself/shared-types';
import { describe, expect, test, vi } from 'vitest';
import {
  DisclosurePolicy,
  PrivacySessionRegistry
} from '../src/main/agent/disclosure-policy';
import {
  ConversationCoordinator,
  type ChatTurnFactory,
  type ConversationFileTaskPort
} from '../src/main/conversation/conversation-coordinator';
import { ConversationDisclosureAdapter } from '../src/main/conversation/conversation-disclosure-adapter';
import { ConversationHistory } from '../src/main/conversation/conversation-history';
import { ConversationChatAdapter } from '../src/main/conversation/conversation-chat-adapter';

interface ProviderScript {
  requests: ModelRequest[];
  signals: AbortSignal[];
  provider: ModelProvider;
}

class CapturingFileTasks implements ConversationFileTaskPort {
  readonly submissions: Array<Parameters<ConversationFileTaskPort['submit']>[0]> = [];
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
  target: {
    profileId: string;
    providerIdentity: string;
    providerName: string;
  } = Object.freeze({
    profileId: 'profile-agent',
    providerIdentity: 'openai',
    providerName: 'OpenAI Agent'
  });
  private listener: Parameters<ConversationFileTaskPort['onEvent']>[0] | null = null;

  onEvent(listener: Parameters<ConversationFileTaskPort['onEvent']>[0]): () => void {
    this.listener = listener;
    return () => {
      this.unsubscribeCalls += 1;
      if (this.listener === listener) this.listener = null;
      if (this.unsubscribeError) throw this.unsubscribeError;
    };
  }

  async submit(input: Parameters<ConversationFileTaskPort['submit']>[0]): Promise<void> {
    this.submissions.push(input);
  }

  async prepareTarget(generation: string) {
    this.preparedGenerations.push(generation);
    const barrier = this.prepareBarrier;
    this.prepareBarrier = null;
    if (barrier) await barrier;
    if (this.prepareError) throw this.prepareError;
    return this.target;
  }

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
}

function scriptedProvider(response: ModelResponse | Error): ProviderScript {
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
        return response;
      }
    }
  };
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
  factoryError?: Error;
  fileTasks?: CapturingFileTasks;
  onEmit?: (event: TaskEvent, coordinator: ConversationCoordinator) => void;
} = {}) {
  const history = new ConversationHistory();
  const events: TaskEvent[] = [];
  const fileTasks = options.fileTasks ?? new CapturingFileTasks();
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
  const chatTurnFactory: ChatTurnFactory = {
    async create() {
      factoryCalls += 1;
      if (options.factoryError) throw options.factoryError;
      const item = scripts[factoryIndex++];
      if (!item) throw new Error('UNEXPECTED_FACTORY_CALL');
      return {
        adapter: new ConversationChatAdapter(item.script.provider),
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
    fileTasks,
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

describe('ConversationCoordinator', () => {
  test.each(['你好', '聊天呀', '我想和你聊天', '帮我整理一下'])(
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

      expect(harness.factoryCallCount()).toBe(1);
      expect(harness.fileTasks.preparedGenerations).toEqual([]);
      expect(harness.fileTasks.submissions).toEqual([]);
    }
  );

  test.each(['读取 a.txt', '列出当前文件夹'])(
    '明确文件请求“%s”只进入文件链且不创建聊天目标',
    async text => {
      const harness = createHarness([]);

      await harness.coordinator.submit(text);

      expect(harness.factoryCallCount()).toBe(0);
      expect(harness.fileTasks.preparedGenerations).toEqual(['generation-current']);
      expect(harness.fileTasks.submissions).toEqual([{
        text,
        visibleHistory: [],
        generation: 'generation-current'
      }]);
    }
  );

  test('明确 PowerShell 请求稳定终止且不降级聊天、不执行文件任务和不写历史', async () => {
    const harness = createHarness([]);

    await expect(harness.coordinator.submit('执行这条命令 npm test')).rejects.toSatisfy(
      error => errorCode(error) === 'POWERSHELL_TASK_NOT_READY'
    );

    expect(harness.factoryCallCount()).toBe(0);
    expect(harness.fileTasks.preparedGenerations).toEqual([]);
    expect(harness.fileTasks.submissions).toEqual([]);
    expect(harness.history.turns()).toEqual([]);
    expect(harness.events).toContainEqual(expect.objectContaining({
      type: 'error',
      code: 'POWERSHELL_TASK_NOT_READY'
    }));
    expect(phases(harness.events)).not.toContain('success');
  });

  test('文件目标准备期间取消会释放文件 owner，并允许下一次文件请求立即进入准备', async () => {
    const fileTasks = new CapturingFileTasks();
    const barrier = deferredVoid();
    fileTasks.prepareBarrier = barrier.promise;
    const harness = createHarness([], { fileTasks });
    const first = harness.coordinator.submit('读取 old.txt');
    await vi.waitFor(() => expect(fileTasks.preparedGenerations).toHaveLength(1));

    harness.coordinator.cancelActive();
    await expect(harness.coordinator.submit('读取 new.txt')).resolves.toBeUndefined();

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
    expect(events).toContainEqual({ type: 'character_emotion', label: 'calm' });
    expect(history.turns()).toEqual([{
      userText: '今天有点累',
      assistantText: '  **我在这里。**\n',
      providerIdentity: 'openai'
    }]);
    expect(fileTasks.submissions).toEqual([]);
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
      code: 'AGENT_INTERNAL_ERROR',
      message: '任务执行失败，请重试。'
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
    const { coordinator, events } = createHarness([], { factoryError: rawError });

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

    expect(second.requests).toHaveLength(1);
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
    const { coordinator, events, history } = createHarness([{
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

  test('情绪公开失败时本回合不写历史并回到公开错误边界', async () => {
    const rawError = new Error('emotion-send-private-error');
    const harness = createHarness([{
      profileId: 'profile-openai',
      providerIdentity: 'openai',
      providerName: 'OpenAI',
      script: scriptedProvider({ type: 'text', text: '回复已公开', emotion: 'calm' })
    }], {
      onEmit: event => {
        if (event.type === 'character_emotion') throw rawError;
      }
    });

    await expect(harness.coordinator.submit('触发情绪公开失败')).rejects.toMatchObject({
      code: 'AGENT_INTERNAL_ERROR',
      message: '任务执行失败，请重试。'
    });

    expect(phases(harness.events)).toEqual(['listening', 'thinking', 'error']);
    expect(harness.history.turns()).toEqual([]);
    expect(JSON.stringify(harness.events)).not.toContain('emotion-send-private-error');
  });

  test('close 先封闭状态并在清理失败时继续全部清理', async () => {
    const script = deferredProvider();
    const fileTasks = new CapturingFileTasks();
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
    const fileTasks = new CapturingFileTasks();
    const barrier = deferredVoid();
    fileTasks.closeBarrier = barrier.promise;
    const { coordinator } = createHarness([], { fileTasks });
    let settled = false;

    const first = coordinator.close().then(() => { settled = true; });
    const second = coordinator.close();
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(fileTasks.closeCalls).toBe(1);
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

  test('明确文件请求直接准备目标并把同一目标快照提交给文件端口', async () => {
    const harness = createHarness([]);
    harness.history.append({
      userText: '旧问题',
      assistantText: '旧回答',
      providerIdentity: 'openai'
    });

    const submitting = harness.coordinator.submit('整理文件');
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
      generation: 'generation-current'
    }]);
    expect(harness.history.turns().at(-1)).toEqual({
      userText: '整理文件',
      assistantText: '整理完成',
      providerIdentity: 'openai'
    });
  });

  test('文件目标预检缺少授权时稳定失败，且不降级为聊天成功', async () => {
    const fileTasks = new CapturingFileTasks();
    fileTasks.prepareError = Object.assign(new Error('FILE_AUTHORIZATION_REQUIRED'), {
      code: 'FILE_AUTHORIZATION_REQUIRED'
    });
    const harness = createHarness([], { fileTasks });

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
    const harness = createHarness([]);
    await harness.coordinator.submit('读取 失败.txt');

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
    expect(harness.fileTasks.submissions).toHaveLength(2);
  });

  test('文件失败终态同步重入新提交时旧 reject 不覆盖新 owner 且不重复报错', async () => {
    const fileTasks = new CapturingFileTasks();
    const nextProvider = deferredProvider();
    let submissionCount = 0;
    fileTasks.submit = async input => {
      fileTasks.submissions.push(input);
      submissionCount += 1;
      if (submissionCount !== 1) return;
      fileTasks.publish({
        type: 'error',
        code: 'PATH_INVALID',
        message: '文件路径无效。'
      }, input.generation);
      fileTasks.publish({ type: 'phase', phase: 'error' }, input.generation);
      throw Object.assign(new Error('private-path-details'), { code: 'PATH_INVALID' });
    };
    let newPending: Promise<void> | null = null;
    const harness = createHarness([{
      profileId: 'profile-openai',
      providerIdentity: 'openai',
      providerName: 'OpenAI',
      script: nextProvider
    }], {
      fileTasks,
      onEmit: (event, coordinator) => {
        if (event.type === 'phase' && event.phase === 'error' && newPending === null) {
          newPending = coordinator.submit('同步重入的新任务');
        }
      }
    });

    await expect(harness.coordinator.submit('读取 失败.txt')).rejects
      .toSatisfy(error => errorCode(error) === 'PATH_INVALID');
    await vi.waitFor(() => expect(nextProvider.requests).toHaveLength(1));

    expect(harness.events.filter(event => event.type === 'error')).toEqual([{
      type: 'error',
      code: 'PATH_INVALID',
      message: '文件路径无效。'
    }]);
    expect(JSON.stringify(harness.events)).not.toContain('private-path-details');
    nextProvider.resolve({
      type: 'text',
      text: '新任务完成'
    });
    await newPending;
    expect(harness.events).toContainEqual({
      type: 'message',
      role: 'assistant',
      text: '新任务完成'
    });
  });

  test.each([
    ['share_once', [
      { role: 'user', content: '旧问题' },
      { role: 'assistant', content: '旧回答' }
    ]],
    ['current_message_only', []]
  ] as const)('文件目标跨 Provider 时 %s 后只恢复一次原提交', async (decision, expectedHistory) => {
    const harness = createHarness([]);
    harness.fileTasks.target = Object.freeze({
      profileId: 'profile-anthropic-agent',
      providerIdentity: 'anthropic',
      providerName: 'Anthropic Agent'
    });
    harness.history.append({
      userText: '旧问题',
      assistantText: '旧回答',
      providerIdentity: 'openai'
    });

    await harness.coordinator.submit('整理文件');

    expect(harness.fileTasks.submissions).toEqual([]);
    expect(harness.events).toContainEqual({
      type: 'history_disclosure_required',
      requestId: 'request-1',
      targetProviderName: 'Anthropic Agent',
      messageCount: 2,
      characterCount: 6
    });
    await expect(harness.coordinator.resolveHistoryDisclosure('forged', decision)).rejects
      .toSatisfy(error => errorCode(error) === 'DISCLOSURE_REQUEST_EXPIRED');

    await harness.coordinator.resolveHistoryDisclosure('request-1', decision);

    expect(harness.fileTasks.submissions).toEqual([{
      text: '整理文件',
      visibleHistory: expectedHistory,
      generation: 'generation-current'
    }]);
    await expect(harness.coordinator.resolveHistoryDisclosure('request-1', decision)).rejects
      .toSatisfy(error => errorCode(error) === 'DISCLOSURE_REQUEST_EXPIRED');
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
    await vi.waitFor(() => expect(oldProvider.requests).toHaveLength(1));

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
    const harness = createHarness([]);
    harness.fileTasks.target = Object.freeze({
      profileId: 'profile-anthropic-agent',
      providerIdentity: 'anthropic',
      providerName: 'Anthropic Agent'
    });
    harness.history.append({
      userText: '旧问题',
      assistantText: '旧回答',
      providerIdentity: 'openai'
    });
    await harness.coordinator.submit('整理文件');

    await harness.coordinator.resetConversation();

    await expect(harness.coordinator.resolveHistoryDisclosure('request-1', 'share_once')).rejects
      .toSatisfy(error => errorCode(error) === 'DISCLOSURE_REQUEST_EXPIRED');
    expect(harness.fileTasks.submissions).toEqual([]);
    expect(harness.events).toContainEqual({
      type: 'conversation_reset',
      generation: 'request-2'
    });
  });

  test('等待文件确认时 reset 委托文件清理并使旧 actionId 失效', async () => {
    const fileTasks = new CapturingFileTasks();
    fileTasks.submit = async input => {
      fileTasks.submissions.push(input);
      fileTasks.publish({
        type: 'pending_action',
        action: {
          category: 'file',
          actionId: 'old-action',
          conversationId: 'conversation-old',
          risk: 'write',
          operation: 'create_file',
          summary: '创建文件',
          targetRelativePath: 'result.txt',
          contentCharacters: 0, contentPreview: null, previewTruncated: false,
          createdAt: '2026-08-10T00:00:00.000Z',
          expiresAt: '2026-08-10T00:02:00.000Z'
        }
      }, input.generation);
      fileTasks.publish({ type: 'phase', phase: 'awaiting_confirmation' }, input.generation);
    };
    const harness = createHarness([], { fileTasks });

    await harness.coordinator.submit('创建文件');
    await harness.coordinator.resetConversation();

    expect(fileTasks.resetCalls).toBe(1);
    await expect(harness.coordinator.resolveFileAction('old-action', 'confirm')).rejects
      .toSatisfy(error => errorCode(error) === 'ACTION_EXPIRED');
  });

  test('任一重置清理失败后保持 resetting 并永久拒绝旧 generation 与新提交', async () => {
    const harness = createHarness([]);
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
