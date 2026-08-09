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
  provider: ModelProvider;
}

class CapturingFileTasks implements ConversationFileTaskPort {
  readonly submissions: Array<Parameters<ConversationFileTaskPort['submit']>[0]> = [];
  private listener: Parameters<ConversationFileTaskPort['onEvent']>[0] | null = null;

  onEvent(listener: Parameters<ConversationFileTaskPort['onEvent']>[0]): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = null;
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
  return {
    requests,
    provider: {
      async respond(request) {
        requests.push(request);
        if (response instanceof Error) throw response;
        return response;
      }
    }
  };
}

function deferredProvider(): ProviderScript & { resolve(response: ModelResponse): void } {
  const requests: ModelRequest[] = [];
  let resolve!: (response: ModelResponse) => void;
  const response = new Promise<ModelResponse>(done => {
    resolve = done;
  });
  return {
    requests,
    resolve,
    provider: {
      async respond(request) {
        requests.push(request);
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
}>) {
  const history = new ConversationHistory();
  const events: TaskEvent[] = [];
  const fileTasks = new CapturingFileTasks();
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
  const chatTurnFactory: ChatTurnFactory = {
    async create() {
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
  const coordinator = new ConversationCoordinator({
    history,
    chatTurnFactory,
    disclosureAdapter,
    fileTasks,
    emit: event => events.push(event),
    createId: () => ids.shift() ?? 'request-fallback'
  });
  return { coordinator, events, fileTasks, history };
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
    expect(events.filter(event => event.type === 'message' && event.role === 'user')).toEqual([
      { type: 'message', role: 'user', text: '第一条' }
    ]);

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

    await expect(coordinator.submit('你好')).rejects.toBe(providerError);

    expect(events).toContainEqual(expect.objectContaining({
      type: 'error',
      code: 'PROVIDER_SERVER_ERROR'
    }));
    expect(phases(events)).toEqual(['listening', 'thinking', 'error']);
    expect(fileTasks.submissions).toEqual([]);
    expect(history.turns()).toEqual([]);
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
