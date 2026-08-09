import type { ModelProvider, ModelRequest, ModelResponse } from '@myself/agent-core';
import type { TaskEvent } from '@myself/shared-types';
import { describe, expect, test } from 'vitest';
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
import { ConversationTurnAdapter } from '../src/main/conversation/conversation-turn-adapter';

interface ProviderScript {
  requests: ModelRequest[];
  signals: AbortSignal[];
  provider: ModelProvider;
}

class CapturingFileTasks implements ConversationFileTaskPort {
  readonly submissions: Array<Parameters<ConversationFileTaskPort['submit']>[0]> = [];
  unsubscribeCalls = 0;
  unsubscribeError: Error | null = null;
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

  cancelActive(): void {}

  async resolveAction(): Promise<void> {}

  async resetForNewConversation(): Promise<void> {}

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
      resolveProfileProvider: profileId => providers.get(profileId) ?? null,
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
        adapter: new ConversationTurnAdapter(item.script.provider),
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
  test('普通聊天只广播一次用户消息并形成完整历史回合', async () => {
    const script = scriptedProvider({
      type: 'text',
      text: '{"kind":"chat_reply","text":"我在这里。","emotion":"calm"}'
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
    expect(events).toContainEqual({ type: 'message', role: 'assistant', text: '我在这里。' });
    expect(events).toContainEqual({ type: 'character_emotion', label: 'calm' });
    expect(history.turns()).toEqual([{
      userText: '今天有点累',
      assistantText: '我在这里。',
      providerIdentity: 'openai'
    }]);
    expect(fileTasks.submissions).toEqual([]);
  });

  test('澄清回复形成完整历史回合且不调用文件端口', async () => {
    const script = scriptedProvider({
      type: 'text',
      text: '{"kind":"clarify","question":"你希望我怎么帮你？"}'
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

    script.resolve({ type: 'text', text: '{"kind":"chat_reply","text":"完成"}' });
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
        text: '{"kind":"chat_reply","text":"不应调用"}'
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
      text: '{"kind":"chat_reply","text":"第一轮回复"}'
    });
    const second = scriptedProvider({
      type: 'text',
      text: '{"kind":"chat_reply","text":"第二轮回复"}'
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
      .toSatisfy(error => errorCode(error) === 'FILE_TASK_ROUTE_NOT_READY');
    await expect(coordinator.resetConversation()).rejects
      .toSatisfy(error => errorCode(error) === 'CONVERSATION_RESET_NOT_READY');
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
    script.resolve({ type: 'text', text: '{"kind":"chat_reply","text":"旧回复"}' });
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
      text: '{"kind":"chat_reply","text":"不应出现"}'
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
    script.resolve({ type: 'text', text: '{"kind":"chat_reply","text":"迟到"}' });
    await pending;
  });

  test('abort 监听器同步开始新请求后旧取消栈不污染新阶段', async () => {
    const oldScript = deferredProvider();
    const newScript = scriptedProvider({
      type: 'text',
      text: '{"kind":"chat_reply","text":"新回复"}'
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
    oldScript.resolve({ type: 'text', text: '{"kind":"chat_reply","text":"旧回复"}' });
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
        text: '{"kind":"chat_reply","text":"不应出现"}'
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

  test('History append 同步 close 后不发布 assistant 或覆盖 closed', async () => {
    const script = scriptedProvider({
      type: 'text',
      text: '{"kind":"chat_reply","text":"不得公开"}'
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
    expect(harness.events).not.toContainEqual({
      type: 'message',
      role: 'assistant',
      text: '不得公开'
    });
    await expect(harness.coordinator.submit('不得重开')).rejects.toSatisfy(
      error => errorCode(error) === 'CONVERSATION_CLOSED'
    );
  });

  test('助手消息监听器同步关闭后保留已可见回合且不覆盖 closed', async () => {
    const script = scriptedProvider({
      type: 'text',
      text: '{"kind":"chat_reply","text":"已可见回复","emotion":"calm"}'
    });
    let closed = false;
    const { coordinator, events, history } = createHarness([{
      profileId: 'profile-openai',
      providerIdentity: 'openai',
      providerName: 'OpenAI',
      script
    }], {
      onEmit: (event, target) => {
        if (event.type === 'message' && event.role === 'assistant' && !closed) {
          closed = true;
          void target.close();
        }
      }
    });

    await coordinator.submit('同步关闭');

    expect(history.turns()).toEqual([{
      userText: '同步关闭',
      assistantText: '已可见回复',
      providerIdentity: 'openai'
    }]);
    expect(events.at(-1)).toEqual({
      type: 'message',
      role: 'assistant',
      text: '已可见回复'
    });
    expect(events).not.toContainEqual({ type: 'character_emotion', label: 'calm' });
    expect(phases(events)).not.toContain('success');
    await expect(coordinator.submit('关闭后消息')).rejects.toSatisfy(
      error => errorCode(error) === 'CONVERSATION_CLOSED'
    );
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
    expect(resetCalls).toBe(1);
    expect(script.signals[0]?.aborted).toBe(true);
    await expect(harness.coordinator.submit('不得重开')).rejects.toSatisfy(
      error => errorCode(error) === 'CONVERSATION_CLOSED'
    );

    script.reject(new Error('raw-late-error'));
    await expect(pending).resolves.toBeUndefined();
  });

  test('只转发当前会话 generation 的文件端口事件', async () => {
    const script = scriptedProvider({
      type: 'text',
      text: '{"kind":"chat_reply","text":"回复"}'
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
      text: '{"kind":"chat_reply","text":"收到"}'
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

  test('任务 7 尚未接管的文件路径与公开方法明确失败', async () => {
    const script = scriptedProvider({
      type: 'text',
      text: '{"kind":"file_task"}'
    });
    const { coordinator, events, fileTasks } = createHarness([{
      profileId: 'profile-openai',
      providerIdentity: 'openai',
      providerName: 'OpenAI',
      script
    }]);

    await expect(coordinator.submit('整理文件')).rejects.toSatisfy(
      error => errorCode(error) === 'FILE_TASK_ROUTE_NOT_READY'
    );
    await expect(coordinator.resolveFileAction('action-1', 'confirm')).rejects.toSatisfy(
      error => errorCode(error) === 'FILE_TASK_ROUTE_NOT_READY'
    );
    await expect(coordinator.resetConversation()).rejects.toSatisfy(
      error => errorCode(error) === 'CONVERSATION_RESET_NOT_READY'
    );

    expect(events).toContainEqual(expect.objectContaining({
      type: 'error',
      code: 'FILE_TASK_ROUTE_NOT_READY'
    }));
    expect(fileTasks.submissions).toEqual([]);
  });
});
