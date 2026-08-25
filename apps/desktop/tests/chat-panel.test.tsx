// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ChatPanel } from '../src/renderer/src/chat/ChatPanel';
import { taskStore } from '../src/renderer/src/stores/task-store';
import type { LocalModelPublicStatus } from '../src/shared/local-model-ipc';

afterEach(() => {
  cleanup();
  act(() => taskStore.getState().apply({ type: 'conversation_reset', generation: 'chat-panel-cleanup' }));
  vi.restoreAllMocks();
});

describe('聊天面板本地模型状态', () => {
  test('加载时禁发，ready 后恢复发送，并在卸载时精确取消订阅', () => {
    let statusListener: ((status: LocalModelPublicStatus) => void) | undefined;
    const unsubscribe = vi.fn();
    Object.defineProperty(window, 'myself', {
      configurable: true,
      value: {
        submitMessage: vi.fn().mockResolvedValue(undefined),
        cancelTask: vi.fn().mockResolvedValue(undefined),
        confirmAction: vi.fn().mockResolvedValue(undefined),
        cancelAction: vi.fn().mockResolvedValue(undefined),
        resetConversation: vi.fn().mockResolvedValue(undefined),
        resolveHistoryDisclosure: vi.fn().mockResolvedValue(undefined),
        openSettings: vi.fn().mockResolvedValue(undefined),
        hideChat: vi.fn().mockResolvedValue(undefined),
        onLocalModelStatus: vi.fn((listener: (status: LocalModelPublicStatus) => void) => {
          statusListener = listener;
          return unsubscribe;
        })
      }
    });

    const view = render(<ChatPanel />);
    expect(window.myself.onLocalModelStatus).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByRole('textbox', { name: '和我说点什么' }), {
      target: { value: '你好' }
    });

    act(() => statusListener?.({
      enabled: true,
      phase: 'loading',
      backend: null,
      reasonCode: null
    }));
    expect(screen.getByRole('status').textContent).toContain('本地模型加载中');
    expect((screen.getByRole('button', { name: '发送给 AI Pet' }) as HTMLButtonElement).disabled).toBe(true);

    act(() => statusListener?.({
      enabled: true,
      phase: 'ready',
      backend: 'vulkan',
      reasonCode: null
    }));
    expect((screen.getByRole('button', { name: '发送给 AI Pet' }) as HTMLButtonElement).disabled).toBe(false);

    view.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  test('故障状态提供稳定原因与设置入口，视觉不可用不只靠颜色说明', () => {
    let statusListener: ((status: LocalModelPublicStatus) => void) | undefined;
    const openSettings = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, 'myself', {
      configurable: true,
      value: {
        submitMessage: vi.fn().mockResolvedValue(undefined),
        cancelTask: vi.fn().mockResolvedValue(undefined),
        confirmAction: vi.fn().mockResolvedValue(undefined),
        cancelAction: vi.fn().mockResolvedValue(undefined),
        resetConversation: vi.fn().mockResolvedValue(undefined),
        resolveHistoryDisclosure: vi.fn().mockResolvedValue(undefined),
        openSettings,
        hideChat: vi.fn().mockResolvedValue(undefined),
        onLocalModelStatus: vi.fn((listener: (status: LocalModelPublicStatus) => void) => {
          statusListener = listener;
          return vi.fn();
        })
      }
    });
    render(<ChatPanel />);

    act(() => statusListener?.({
      enabled: true,
      phase: 'faulted',
      backend: null,
      reasonCode: 'VULKAN_UNAVAILABLE'
    }));
    expect(screen.getByRole('alert').textContent).toContain('Vulkan 不可用');
    expect(screen.getByText(/视觉暂不可用/u)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '打开模型设置' }));
    expect(openSettings).toHaveBeenCalledOnce();
  });
});
