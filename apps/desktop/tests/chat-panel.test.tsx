// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ChatPanel } from '../src/renderer/src/chat/ChatPanel';
import { taskStore } from '../src/renderer/src/stores/task-store';
import { ConfirmationCard } from '../src/renderer/src/chat/ConfirmationCard';
import type { SettingsDashboardDto } from '../src/shared/myself-api';
import type { LocalModelPublicStatus } from '../src/shared/local-model-ipc';

function dashboardWithLocalModel(localModel: LocalModelPublicStatus): SettingsDashboardDto {
  return {
    catalog: [],
    profiles: [],
    route: {
      primaryProfileId: null,
      chatProfileId: null,
      agentProfileId: null,
      visionProfileId: null,
      fallbackProfileIds: [],
      allowCrossProviderFallback: false
    },
    privacy: {
      dataCategories: { memory: false },
      longTermMemory: false,
      proactivityMode: 'assistive'
    },
    privacyRuntimeSupport: {
      dataCategories: { memory: false },
      longTermMemory: false,
      proactivity: false
    },
    petAlwaysOnTop: false,
    localModel,
    authorizedRoot: null
  };
}

afterEach(() => {
  cleanup();
  act(() => taskStore.getState().apply({ type: 'conversation_reset', generation: 'chat-panel-cleanup' }));
  vi.restoreAllMocks();
});

describe('聊天面板本地模型状态', () => {
  test('单一发送按钮和 Enter 共用仅含文本的 API', async () => {
    const api = { submitMessage: vi.fn().mockResolvedValue(undefined), cancelTask: vi.fn().mockResolvedValue(undefined) };
    render(<ChatPanel api={api as never} />);
    expect(screen.queryByRole('button', { name: '作为任务发送' })).toBeNull();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  note.txt 里面写了什么？  ' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '发送给 AI Pet' })));
    expect(api.submitMessage).toHaveBeenCalledExactlyOnceWith('note.txt 里面写了什么？');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '停止当前任务' })));
    expect(api.cancelTask).toHaveBeenCalledOnce();
    act(() => taskStore.getState().apply({ type: 'phase', phase: 'success' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '你好' } });
    await act(async () => fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', code: 'Enter' }));
    expect(api.submitMessage).toHaveBeenLastCalledWith('你好');
    expect(api.submitMessage).toHaveBeenCalledTimes(2);
  });

  test('单一发送在许可等待期间禁用', () => {
    const api = { submitMessage: vi.fn() };
    render(<ChatPanel api={api as never} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'note.txt 里面写了什么？' } });
    act(() => taskStore.getState().apply({ type: 'task_permission_required', actionId: 'pending', summary: '覆盖文件', request: { action: 'overwrite', resources: ['note.txt'] } }));
    const button = screen.getByRole('button', { name: '发送给 AI Pet' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(api.submitMessage).not.toHaveBeenCalled();
  });

  test('循环确认卡明确一次放行与结束整项任务，终态清除所有卡片', async () => {
    const confirm = vi.fn();
    const cancel = vi.fn();
    const loop = { type: 'task_permission_required', actionId: 'loop-1', summary: '重复操作保护', request: { action: 'doom_loop', tool: 'read', repeatCount: 3 } } as const;
    render(<ConfirmationCard action={loop as never} busy={false} onConfirm={confirm} onCancel={cancel} />);
    expect(screen.getByText('重复操作保护')).toBeDefined();
    expect(screen.getByText('read')).toBeDefined();
    expect(screen.getByText(/连续 3 次/u)).toBeDefined();
    expect(screen.getByText('同一操作连续重复；继续仅放行本次，原文件和命令许可仍有效。')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: '仅继续这一次' }));
    fireEvent.click(screen.getByRole('button', { name: '结束当前任务' }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: '拒绝本次操作' })).toBeNull();
    act(() => {
      taskStore.getState().apply(loop as never);
      taskStore.getState().apply({ type: 'task_permission_required', actionId: 'ordinary', summary: '覆盖', request: { action: 'overwrite', resources: ['目标'] } });
    });
    expect(taskStore.getState().pendingPermissions).toHaveLength(2);
    act(() => taskStore.getState().apply({ type: 'phase', phase: 'cancelled' }));
    expect(taskStore.getState().pendingPermissions).toHaveLength(0);
  });
  test('范围确认返回后可回复多张具体许可，只移除已接纳的当前项', async () => {
    const api = {
      submitMessage: vi.fn().mockResolvedValue(undefined), cancelTask: vi.fn().mockResolvedValue(undefined),
      confirmAction: vi.fn().mockResolvedValue(undefined), cancelAction: vi.fn().mockResolvedValue(undefined),
      resetConversation: vi.fn().mockResolvedValue(undefined), resolveHistoryDisclosure: vi.fn().mockResolvedValue(undefined),
      resolveCapabilityAuthorization: vi.fn().mockResolvedValue(undefined), openSettings: vi.fn(), hideChat: vi.fn(),
      getSettingsDashboard: vi.fn().mockResolvedValue(dashboardWithLocalModel({ enabled: true, phase: 'ready', backend: 'cpu', reasonCode: null })),
      onLocalModelStatus: vi.fn(() => vi.fn())
    };
    render(<ChatPanel api={api as never} />);
    await act(async () => { await Promise.resolve(); });
    act(() => taskStore.getState().apply({ type: 'capability_authorization_required', requestId: 'scope-1', capability: 'file', requestSummary: '检查项目', targetProviderName: 'DeepSeek', directory: 'D:\\project', modelId: 'model-test', actions: ['read', 'create', 'edit'], approvedCommands: ['pnpm.cmd run test'], expiresAt: new Date(Date.now() + 120000).toISOString() }));
    expect(screen.getByText('D:\\project')).toBeDefined();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '授权并开始任务' })));
    act(() => {
      for (const actionId of ['permission-1', 'permission-2']) taskStore.getState().apply({ type: 'task_permission_required', actionId, summary: `运行命令 ${actionId}`, request: { action: 'bash', command: 'pnpm.cmd lint', cwd: 'D:\\project', resources: ['command-sha256:fixture'] } });
    });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '确认运行命令' })));
    expect(api.confirmAction).toHaveBeenCalledWith('permission-1');
    expect(screen.getByText('运行命令 permission-2')).toBeDefined();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '拒绝本次操作' })));
    expect(api.cancelAction).toHaveBeenCalledWith('permission-2');
    expect(taskStore.getState().phase).not.toBe('cancelled');
    act(() => taskStore.getState().apply({ type: 'phase', phase: 'success' }));
    expect(screen.queryByRole('button', { name: '确认运行命令' })).toBeNull();
  });

  test('首次状态事件前，Dashboard 的 loading 快照会禁发并给出文字反馈', async () => {
    const api = {
      submitMessage: vi.fn().mockResolvedValue(undefined),
      cancelTask: vi.fn().mockResolvedValue(undefined),
      confirmAction: vi.fn().mockResolvedValue(undefined),
      cancelAction: vi.fn().mockResolvedValue(undefined),
      resetConversation: vi.fn().mockResolvedValue(undefined),
      resolveHistoryDisclosure: vi.fn().mockResolvedValue(undefined),
      openSettings: vi.fn().mockResolvedValue(undefined),
      hideChat: vi.fn().mockResolvedValue(undefined),
      getSettingsDashboard: vi.fn().mockResolvedValue(dashboardWithLocalModel({
        enabled: true,
        phase: 'loading',
        backend: null,
        reasonCode: null
      })),
      onLocalModelStatus: vi.fn(() => vi.fn())
    };
    render(<ChatPanel api={api as never} />);

    fireEvent.change(screen.getByRole('textbox', { name: '和我说点什么' }), {
      target: { value: '你好' }
    });
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByRole('status').textContent).toContain('本地模型加载中');
    expect((screen.getByRole('button', { name: '发送给 AI Pet' }) as HTMLButtonElement).disabled).toBe(true);
  });

  test('首次状态事件前，Dashboard 的 faulted 快照会禁发并给出故障原因', async () => {
    const api = {
      submitMessage: vi.fn().mockResolvedValue(undefined),
      cancelTask: vi.fn().mockResolvedValue(undefined),
      confirmAction: vi.fn().mockResolvedValue(undefined),
      cancelAction: vi.fn().mockResolvedValue(undefined),
      resetConversation: vi.fn().mockResolvedValue(undefined),
      resolveHistoryDisclosure: vi.fn().mockResolvedValue(undefined),
      openSettings: vi.fn().mockResolvedValue(undefined),
      hideChat: vi.fn().mockResolvedValue(undefined),
      getSettingsDashboard: vi.fn().mockResolvedValue(dashboardWithLocalModel({
        enabled: true,
        phase: 'faulted',
        backend: null,
        reasonCode: 'VULKAN_UNAVAILABLE'
      })),
      onLocalModelStatus: vi.fn(() => vi.fn())
    };
    render(<ChatPanel api={api as never} />);

    fireEvent.change(screen.getByRole('textbox', { name: '和我说点什么' }), {
      target: { value: '你好' }
    });
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByRole('alert').textContent).toContain('Vulkan 不可用');
    expect((screen.getByRole('button', { name: '发送给 AI Pet' }) as HTMLButtonElement).disabled).toBe(true);
  });

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
