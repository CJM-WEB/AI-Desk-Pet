import { afterEach, describe, expect, test, vi } from 'vitest';
import type { TaskEvent } from '@myself/shared-types';
import {
  createTaskEventSubscription,
  createTaskStore
} from '../src/renderer/src/stores/task-store';

afterEach(() => {
  vi.useRealTimers();
});

describe('Renderer 任务视图状态', () => {
  test('持久化故障提示与正文恢复不撤销仍有效的交互卡或流式回复', () => {
    const store = createTaskStore();
    store.getState().apply({ type: 'history_disclosure_required', requestId: 'pending', targetProviderName: '测试', messageCount: 2, characterCount: 10 });
    store.getState().restoreTranscript({
      messages: [{ id: 'assistant-stream-live', role: 'assistant', text: '正在回复' }],
      nextMessageId: 0, activeAssistantStreamTurnId: 'live', persistenceError: 'CONVERSATION_SAVE_FAILED'
    });
    expect(store.getState().persistenceError).toBe('CONVERSATION_SAVE_FAILED');
    expect(store.getState().pendingHistoryDisclosure?.requestId).toBe('pending');
    store.getState().apply({ type: 'assistant_message_commit', turnId: 'live', text: '完整回复' });
    expect(store.getState().messages.map(message => message.text)).toEqual(['完整回复']);
  });

  test.each(['新对话', '卸载'] as const)('恢复失败晚于%s时不污染后续视图', async boundary => {
    const store = createTaskStore();
    let rejectRestore!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, reject) => { rejectRestore = reject; });
    const release = createTaskEventSubscription(store).mount({
      onTaskEvent: () => () => undefined,
      onConversationSnapshot: () => () => undefined,
      restoreConversation: () => pending
    }, true);
    if (boundary === '新对话') store.getState().apply({ type: 'conversation_reset', generation: 'new' });
    else release();
    rejectRestore(new Error('晚到失败'));
    await pending.catch(() => undefined);
    expect(store.getState().messages).toEqual([]);
    release();
  });

  test('聊天订阅按Main投递顺序恢复，迟到的恢复确认不会覆盖新对话', async () => {
    const store = createTaskStore();
    const subscription = createTaskEventSubscription(store);
    let emit!: (event: TaskEvent) => void;
    let snapshot!: (value: { messages: Array<{ id: string; role: 'user'; text: string }>; nextMessageId: number; activeAssistantStreamTurnId: null }) => void;
    let acknowledge!: () => void;
    const ack = new Promise<void>(resolve => { acknowledge = resolve; });
    const api = {
      onTaskEvent: (listener: typeof emit) => { emit = listener; return () => undefined; },
      onConversationSnapshot: (listener: typeof snapshot) => { snapshot = listener; return () => undefined; },
      restoreConversation: () => {
        snapshot({ messages: [{ id: 'message-1', role: 'user', text: '之前保存的聊天' }], nextMessageId: 1, activeAssistantStreamTurnId: null });
        return ack;
      }
    };
    const release = subscription.mount(api, true);
    expect(store.getState().messages.map(message => message.text)).toEqual(['之前保存的聊天']);
    emit({ type: 'conversation_reset', generation: 'new' });
    emit({ type: 'message', role: 'user', text: '新对话里的文字' });
    acknowledge();
    await ack;
    expect(store.getState().messages.map(message => message.text)).toEqual(['新对话里的文字']);
    release();
  });

  test('配置失效只清旧交互卡和运行态，保留用户及助手文字', () => {
    const store = createTaskStore();
    store.getState().apply({ type: 'message', role: 'user', text: '保留我的话' });
    store.getState().apply({ type: 'message', role: 'assistant', text: '保留这句回复' });
    store.getState().apply({ type: 'history_disclosure_required', requestId: 'old', targetProviderName: '模型', messageCount: 2, characterCount: 10 });
    store.getState().apply({ type: 'conversation_reset', generation: 'next', preserveMessages: true });
    expect(store.getState().messages.map(message => message.text)).toEqual(['保留我的话', '保留这句回复']);
    expect(store.getState().pendingHistoryDisclosure).toBeNull();
    expect(store.getState().conversationRevision).toBe(1);
    expect(store.getState().phase).toBe('idle');
  });

  test('披露事件保存不可变展示摘要且不覆盖待处理请求', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = createTaskStore();
    store.getState().apply({
      type: 'history_disclosure_required',
      requestId: 'disclosure-1',
      targetProviderName: 'OpenAI',
      messageCount: 4,
      characterCount: 120
    });

    const firstDisclosure = store.getState().pendingHistoryDisclosure;
    expect(firstDisclosure).toEqual({
      requestId: 'disclosure-1',
      targetProviderName: 'OpenAI',
      messageCount: 4,
      characterCount: 120
    });
    expect(Object.isFrozen(firstDisclosure)).toBe(true);

    store.getState().apply({
      type: 'history_disclosure_required',
      requestId: 'disclosure-2',
      targetProviderName: 'Anthropic',
      messageCount: 2,
      characterCount: 80
    });
    store.getState().apply({ type: 'phase', phase: 'thinking' });

    expect(store.getState().pendingHistoryDisclosure).toBe(firstDisclosure);
    expect(warn).toHaveBeenCalledExactlyOnceWith('HISTORY_DISCLOSURE_ALREADY_PENDING');
  });

  test('只有同一请求的成功披露决策才能移除卡片', () => {
    const store = createTaskStore();
    store.getState().apply({
      type: 'history_disclosure_required',
      requestId: 'disclosure-owner',
      targetProviderName: 'OpenAI',
      messageCount: 1,
      characterCount: 20
    });

    store.getState().completeHistoryDisclosure('stale-request');
    expect(store.getState().pendingHistoryDisclosure?.requestId).toBe('disclosure-owner');
    store.getState().completeHistoryDisclosure('disclosure-owner');
    expect(store.getState().pendingHistoryDisclosure).toBeNull();
  });

  test('披露决策握手只在 Main 下游失败时清卡', () => {
    const store = createTaskStore();
    store.getState().apply({
      type: 'history_disclosure_required',
      requestId: 'disclosure-handshake',
      targetProviderName: 'OpenAI',
      messageCount: 1,
      characterCount: 20
    });

    store.getState().apply({
      type: 'error',
      code: 'IPC_REQUEST_FAILED',
      message: '普通错误不得误清披露卡。'
    });
    expect(store.getState().pendingHistoryDisclosure?.requestId).toBe('disclosure-handshake');
    expect(store.getState().beginHistoryDisclosureResolution('stale-request')).toBe(false);
    expect(store.getState().beginHistoryDisclosureResolution('disclosure-handshake')).toBe(true);
    expect(store.getState().resolvingHistoryDisclosureRequestId).toBe('disclosure-handshake');

    store.getState().apply({ type: 'phase', phase: 'thinking' });
    expect(store.getState().pendingHistoryDisclosure?.requestId).toBe('disclosure-handshake');
    store.getState().apply({ type: 'phase', phase: 'error' });
    expect(store.getState().pendingHistoryDisclosure).toBeNull();
    expect(store.getState().resolvingHistoryDisclosureRequestId).toBeNull();
  });

  test('披露传输失败可释放握手并保留原卡重试', () => {
    const store = createTaskStore();
    store.getState().apply({
      type: 'history_disclosure_required',
      requestId: 'disclosure-retry',
      targetProviderName: 'OpenAI',
      messageCount: 1,
      characterCount: 20
    });
    expect(store.getState().beginHistoryDisclosureResolution('disclosure-retry')).toBe(true);

    store.getState().releaseHistoryDisclosureResolution('disclosure-retry');

    expect(store.getState().pendingHistoryDisclosure?.requestId).toBe('disclosure-retry');
    expect(store.getState().resolvingHistoryDisclosureRequestId).toBeNull();
    expect(store.getState().beginHistoryDisclosureResolution('disclosure-retry')).toBe(true);
  });

  test('会话重置原子清空视图状态并使旧终态定时器失效', () => {
    vi.useFakeTimers();
    const store = createTaskStore();
    store.getState().apply({ type: 'message', role: 'assistant', text: '旧会话' });
    store.getState().apply({
      type: 'history_disclosure_required',
      requestId: 'disclosure-1',
      targetProviderName: 'OpenAI',
      messageCount: 1,
      characterCount: 3
    });
    store.getState().apply({ type: 'phase', phase: 'success' });

    store.getState().apply({ type: 'conversation_reset', generation: 'generation-2' });
    expect(store.getState()).toMatchObject({
      conversationRevision: 1,
      phase: 'idle',
      messages: [],
      pendingHistoryDisclosure: null,
      characterState: { stateId: 'idle', source: 'main' }
    });

    store.getState().apply({ type: 'phase', phase: 'thinking' });
    vi.advanceTimersByTime(1_500);
    expect(store.getState().phase).toBe('thinking');

    store.getState().apply({ type: 'conversation_reset', generation: 'untrusted-generation-value' });
    expect(store.getState().conversationRevision).toBe(2);
  });

  test('错误消息保留稳定错误码而不派生内部正文', () => {
    const store = createTaskStore();
    store.getState().apply({
      type: 'error',
      code: 'FILE_AUTHORIZATION_REQUIRED',
      message: '请先在设置中授权文件目录。'
    });

    expect(store.getState().messages.at(-1)).toMatchObject({
      role: 'error',
      code: 'FILE_AUTHORIZATION_REQUIRED',
      text: '请先在设置中授权文件目录。'
    });
  });

  test('完整消息历史不再按原有百条上限裁剪', () => {
    const store = createTaskStore();

    for (let index = 0; index < 105; index += 1) {
      store.getState().apply({ type: 'message', role: 'user', text: `消息 ${index}` });
    }

    expect(store.getState().messages).toHaveLength(105);
    expect(store.getState().messages[0]?.text).toBe('消息 0');
    expect(store.getState().messages.at(-1)?.text).toBe('消息 104');
  });

  test('流式消息在同一条记录原位追加并由 commit 校正最终正文', () => {
    const store = createTaskStore();
    store.getState().apply({ type: 'assistant_message_start', turnId: 'turn-1' });
    store.getState().apply({ type: 'assistant_message_delta', turnId: 'turn-1', delta: '草' });
    store.getState().apply({ type: 'assistant_message_delta', turnId: 'turn-1', delta: '稿' });

    expect(store.getState().messages).toEqual([{
      id: 'assistant-stream-turn-1', role: 'assistant', text: '草稿'
    }]);

    store.getState().apply({
      type: 'assistant_message_commit', turnId: 'turn-1', text: '最终正文'
    });
    expect(store.getState().messages).toEqual([{
      id: 'assistant-stream-turn-1', role: 'assistant', text: '最终正文'
    }]);
  });

  test('错误、取消与 reset 清除未 commit 草稿并忽略未知 turnId 的迟到事件', () => {
    for (const terminal of ['error', 'cancelled'] as const) {
      const store = createTaskStore();
      store.getState().apply({ type: 'assistant_message_start', turnId: `turn-${terminal}` });
      store.getState().apply({
        type: 'assistant_message_delta', turnId: `turn-${terminal}`, delta: '未完成'
      });
      store.getState().apply({ type: 'phase', phase: terminal });
      expect(store.getState().messages).toEqual([]);
      store.getState().apply({
        type: 'assistant_message_delta', turnId: `turn-${terminal}`, delta: '迟到'
      });
      store.getState().apply({
        type: 'assistant_message_commit', turnId: `turn-${terminal}`, text: '迟到完成'
      });
      expect(store.getState().messages).toEqual([]);
    }

    const resetStore = createTaskStore();
    resetStore.getState().apply({ type: 'assistant_message_start', turnId: 'turn-reset' });
    resetStore.getState().apply({ type: 'conversation_reset', generation: 'generation-next' });
    resetStore.getState().apply({
      type: 'assistant_message_delta', turnId: 'turn-reset', delta: '迟到'
    });
    expect(resetStore.getState().messages).toEqual([]);
  });

  test('多条合法 delta 累计超过正文预算时 fail-close 并拒绝同 turn 迟到 commit', () => {
    const store = createTaskStore();
    store.getState().apply({ type: 'assistant_message_start', turnId: 'turn-budget' });
    store.getState().apply({
      type: 'assistant_message_delta', turnId: 'turn-budget', delta: 'a'.repeat(3_000)
    });
    store.getState().apply({
      type: 'assistant_message_delta', turnId: 'turn-budget', delta: 'b'.repeat(2_000)
    });
    store.getState().apply({
      type: 'assistant_message_commit', turnId: 'turn-budget', text: '不应恢复'
    });

    expect(store.getState().messages).toEqual([]);
  });

  test('任务级授权卡保存有效期并在所有终止阶段清除', () => {
    for (const phase of ['success', 'error', 'cancelled', 'idle'] as const) {
      const store = createTaskStore();
      store.getState().apply({
        type: 'capability_authorization_required',
      directory: 'D:\\authorized', modelId: 'model-test', actions: ['read', 'create', 'edit'], approvedCommands: [],
        requestId: `capability-${phase}`,
        capability: 'file',
        requestSummary: '整理当前目录',
        targetProviderName: 'DeepSeek',
        expiresAt: '2026-08-27T12:02:00.000Z'
      });
      expect(store.getState().pendingCapabilityAuthorization?.expiresAt)
        .toBe('2026-08-27T12:02:00.000Z');

      store.getState().apply({ type: 'phase', phase });

      expect(store.getState().pendingCapabilityAuthorization).toBeNull();
    }
  });

  test('成功和错误阶段在 1500 毫秒后回到 idle 且保留消息', () => {
    vi.useFakeTimers();
    const store = createTaskStore();
    store.getState().apply({ type: 'message', role: 'assistant', text: '操作完成' });
    store.getState().apply({ type: 'phase', phase: 'success' });

    vi.advanceTimersByTime(1_499);
    expect(store.getState().phase).toBe('success');
    vi.advanceTimersByTime(1);

    expect(store.getState().phase).toBe('idle');
    expect(store.getState().messages.map(message => message.text)).toEqual(['操作完成']);
  });

  test('新任务阶段会中断尚未结束的一次性状态', () => {
    vi.useFakeTimers();
    const store = createTaskStore();
    store.getState().apply({ type: 'phase', phase: 'error' });

    store.getState().beginListening();
    vi.advanceTimersByTime(1_500);

    expect(store.getState().phase).toBe('listening');
  });

  test('Main 自定义状态不被聊天正文、旧情绪或任务阶段覆盖', () => {
    const store = createTaskStore();
    store.getState().applyCharacterPlayback('quiet-afternoon');
    store.getState().apply({ type: 'message', role: 'user', text: '挥手 开心 思考' });
    store.getState().apply({ type: 'character_emotion', label: 'happy' });
    store.getState().apply({ type: 'phase', phase: 'thinking' });
    expect(store.getState().characterState).toEqual({ stateId: 'quiet-afternoon', source: 'main' });
  });

  test('事件订阅只建立一次并在最后一个使用者卸载时释放', () => {
    const store = createTaskStore();
    const listeners: Array<(event: TaskEvent) => void> = [];
    const release = vi.fn();
    const api = {
      onTaskEvent: vi.fn((nextListener: (event: TaskEvent) => void) => {
        listeners.push(nextListener);
        return release;
      })
    };
    const subscription = createTaskEventSubscription(store);

    const unmountFirst = subscription.mount(api);
    const unmountSecond = subscription.mount(api);
    listeners[0]?.({ type: 'phase', phase: 'thinking' });

    expect(api.onTaskEvent).toHaveBeenCalledOnce();
    expect(store.getState().phase).toBe('thinking');
    unmountFirst();
    expect(release).not.toHaveBeenCalled();
    unmountSecond();
    expect(release).toHaveBeenCalledOnce();
  });
});
