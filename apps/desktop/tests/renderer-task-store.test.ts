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
      actionId: 'action-1',
      conversationId: 'conversation-1',
      risk: 'write' as const,
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
