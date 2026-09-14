// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { App, currentView } from '../src/renderer/src/App';
afterEach(() => { cleanup(); window.history.replaceState({}, '', '/'); });

test('头顶视图不挂载完整任务订阅或恢复会话', () => {
  window.history.replaceState({}, '', '/?view=bubble');
  const onTaskEvent = vi.fn(), getConversationSnapshot = vi.fn();
  Object.defineProperty(window, 'myself', { configurable: true, value: {
    onTaskEvent, getConversationSnapshot,
    chatPresentation: { onSnapshot: vi.fn(() => vi.fn()), onCommand: vi.fn(() => vi.fn()), ready: vi.fn().mockResolvedValue({ epoch: 'test', revisionFloor: 0 }), setLayout: vi.fn().mockResolvedValue(undefined) }
  } });
  expect(currentView()).toBe('bubble');
  render(<App />);
  expect(onTaskEvent).not.toHaveBeenCalled();
  expect(getConversationSnapshot).not.toHaveBeenCalled();
});
