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
    store.getState().apply({
      type: 'pending_action',
      action: {
        category: 'file',
        actionId: 'action-reset',
        conversationId: 'conversation-1',
        risk: 'write',
        operation: 'create_file',
        summary: '创建文件',
        targetRelativePath: 'notes.md',
        createdAt: '2026-08-10T12:00:00.000Z',
        expiresAt: '2026-08-10T12:02:00.000Z'
      }
    });
    store.getState().apply({ type: 'phase', phase: 'success' });

    store.getState().apply({ type: 'conversation_reset', generation: 'generation-2' });
    expect(store.getState()).toMatchObject({
      conversationRevision: 1,
      phase: 'idle',
      messages: [],
      pendingAction: null,
      pendingHistoryDisclosure: null,
      characterState: { stateId: 'idle', source: 'system' }
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

  test('消息历史只保留最近 100 条', () => {
    const store = createTaskStore();

    for (let index = 0; index < 105; index += 1) {
      store.getState().apply({ type: 'message', role: 'user', text: `消息 ${index}` });
    }

    expect(store.getState().messages).toHaveLength(100);
    expect(store.getState().messages[0]?.text).toBe('消息 5');
    expect(store.getState().messages.at(-1)?.text).toBe('消息 104');
  });

  test('待确认动作在成功、错误或取消终止阶段被清除', () => {
    const action = {
      category: 'file' as const,
      actionId: 'action-1',
      conversationId: 'conversation-1',
      risk: 'write' as const,
      operation: 'create_file' as const,
      summary: '创建文件 notes.md',
      targetRelativePath: 'notes.md',
      createdAt: '2026-07-20T12:00:00.000Z',
      expiresAt: '2026-07-20T12:02:00.000Z'
    };

    for (const phase of ['success', 'error', 'cancelled'] as const) {
      const store = createTaskStore();
      store.getState().apply({ type: 'pending_action', action });
      expect(store.getState().pendingAction).toEqual(action);

      store.getState().apply({ type: 'phase', phase });

      expect(store.getState().pendingAction).toBeNull();
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

  test('扩展请求由既有仲裁器处理，可信任务阶段立即抢占且文案不推导结果', () => {
    const store = createTaskStore();
    store.getState().requestCharacterState({
      type: 'extension',
      stateId: 'custom:wave'
    });
    expect(store.getState().characterState).toEqual({
      stateId: 'custom:wave',
      source: 'extension'
    });

    store.getState().apply({
      type: 'message',
      role: 'assistant',
      text: '这段可见文案声称成功，但不是可信状态事件'
    });
    expect(store.getState().characterState.stateId).toBe('custom:wave');

    store.getState().apply({ type: 'phase', phase: 'acting' });
    expect(store.getState().characterState).toEqual({
      stateId: 'acting',
      source: 'system'
    });
  });

  test('运动经过仲裁且停止后恢复当前任务阶段或 idle', () => {
    const store = createTaskStore();
    store.getState().applyCharacterMotion({ moving: true, carrying: false });
    expect(store.getState().characterState.stateId).toBe('moving');
    store.getState().applyCharacterMotion({ moving: false, carrying: false });
    expect(store.getState().characterState.stateId).toBe('idle');

    store.getState().apply({ type: 'phase', phase: 'thinking' });
    store.getState().applyCharacterMotion({ moving: true, carrying: false });
    expect(store.getState().characterState.stateId).toBe('thinking');
    store.getState().applyCharacterMotion({ moving: false, carrying: false });
    expect(store.getState().characterState.stateId).toBe('thinking');

    store.getState().applyCharacterMotion({ moving: true, carrying: true });
    expect(store.getState().characterState.stateId).toBe('carrying');
    store.getState().applyCharacterMotion({ moving: false, carrying: false });
    expect(store.getState().characterState.stateId).toBe('thinking');
  });

  test('pending_action 通过仲裁器进入 listening 状态', () => {
    const store = createTaskStore();
    store.getState().apply({
      type: 'pending_action',
      action: {
        category: 'file',
        actionId: 'a',
        conversationId: 'c',
        risk: 'write',
        operation: 'create_file',
        summary: '确认',
        targetRelativePath: 'a.txt',
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-01T00:01:00.000Z'
      }
    });
    expect(store.getState().characterState).toEqual({
      stateId: 'listening',
      source: 'system'
    });
  });

  test('生产扩展规则统一处理关键词、指针、idle 和可信 LLM 标识', () => {
    const store = createTaskStore();
    store.getState().configureCharacterExtensions([{
      stateId: 'custom:wave',
      triggers: ['single_click', 'idle'],
      keywords: ['你好'],
      emotions: ['happy']
    }]);
    store.getState().apply({ type: 'message', role: 'user', text: '你好' });
    expect(store.getState().characterState.stateId).toBe('custom:wave');
    store.getState().requestCharacterState({ type: 'reset' });
    store.getState().triggerCharacterPointer('single_click');
    expect(store.getState().characterState.stateId).toBe('custom:wave');
    store.getState().requestCharacterState({ type: 'reset' });
    store.getState().triggerCharacterIdle();
    expect(store.getState().characterState.stateId).toBe('custom:wave');
    store.getState().requestCharacterState({ type: 'reset' });
    store.getState().apply({
      type: 'character_emotion',
      label: 'calm'
    });
    expect(store.getState().characterState.stateId).toBe('idle');
    store.getState().apply({
      type: 'character_emotion',
      label: 'happy'
    });
    expect(store.getState().characterState.stateId).toBe('custom:wave');
  });

  test('核心任务状态期间只排队最新有效情绪并在回到 idle 后重放', () => {
    vi.useFakeTimers();
    const store = createTaskStore();
    store.getState().configureCharacterExtensions([
      {
        stateId: 'custom:wave',
        triggers: [],
        keywords: [],
        emotions: ['happy']
      },
      {
        stateId: 'custom:calm',
        triggers: [],
        keywords: [],
        emotions: ['calm']
      }
    ]);

    store.getState().apply({ type: 'phase', phase: 'thinking' });
    store.getState().apply({ type: 'character_emotion', label: 'happy' });
    store.getState().apply({ type: 'character_emotion', label: 'calm' });
    expect(store.getState().characterState.stateId).toBe('thinking');

    store.getState().apply({ type: 'phase', phase: 'success' });
    expect(store.getState().characterState.stateId).toBe('success');
    vi.advanceTimersByTime(1_499);
    expect(store.getState().characterState.stateId).toBe('success');
    vi.advanceTimersByTime(1);
    expect(store.getState().characterState).toEqual({
      stateId: 'custom:calm',
      source: 'extension'
    });
  });

  test('未知情绪、新任务与角色扩展变更不会重放过期请求', () => {
    vi.useFakeTimers();
    const store = createTaskStore();
    store.getState().configureCharacterExtensions([{
      stateId: 'custom:wave',
      triggers: [],
      keywords: [],
      emotions: ['happy']
    }]);
    store.getState().apply({ type: 'phase', phase: 'thinking' });
    store.getState().apply({ type: 'character_emotion', label: 'calm' });
    store.getState().apply({ type: 'character_emotion', label: 'happy' });

    store.getState().beginListening();
    store.getState().apply({ type: 'phase', phase: 'success' });
    vi.advanceTimersByTime(1_500);
    expect(store.getState().characterState.stateId).toBe('idle');

    store.getState().apply({ type: 'phase', phase: 'thinking' });
    store.getState().apply({ type: 'character_emotion', label: 'happy' });
    store.getState().configureCharacterExtensions([]);
    store.getState().apply({ type: 'phase', phase: 'success' });
    vi.advanceTimersByTime(1_500);
    expect(store.getState().characterState.stateId).toBe('idle');
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
