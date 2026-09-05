// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  PetCharacter,
  PetView
} from '../src/renderer/src/pet/PetView';
import { ConfirmationCard } from '../src/renderer/src/chat/ConfirmationCard';
import { HistoryDisclosureCard } from '../src/renderer/src/chat/HistoryDisclosureCard';
import { ChatPanel } from '../src/renderer/src/chat/ChatPanel';
import { taskStore } from '../src/renderer/src/stores/task-store';
import {
  availableSettingsTabs,
  SettingsWorkspace
} from '../src/renderer/src/settings/SettingsView';
import { PrivacySettings } from '../src/renderer/src/settings/PrivacySettings';
import { mountTaskEventsIfAvailable } from '../src/renderer/src/App';

type ClickableElement = {
  props: {
    onClick(): void;
  };
};

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function installMyselfApi(overrides: Record<string, unknown> = {}) {
  const api = {
    submitMessage: vi.fn().mockResolvedValue(undefined),
    cancelTask: vi.fn().mockResolvedValue(undefined),
    confirmAction: vi.fn().mockResolvedValue(undefined),
    cancelAction: vi.fn().mockResolvedValue(undefined),
    resetConversation: vi.fn().mockResolvedValue(undefined),
    resolveHistoryDisclosure: vi.fn().mockResolvedValue(undefined),
    openSettings: vi.fn().mockResolvedValue(undefined),
    hideChat: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
  Object.defineProperty(window, 'myself', {
    configurable: true,
    value: api
  });
  return api;
}

afterEach(() => {
  cleanup();
  act(() => {
    taskStore.getState().apply({ type: 'conversation_reset', generation: 'test-cleanup' });
  });
  vi.restoreAllMocks();
});

async function loadRendererCommandButtons(): Promise<{
  ChatCloseButton: (() => ClickableElement) | undefined;
}> {
  const chat = await import('../src/renderer/src/chat/ChatPanel');
  return {
    ChatCloseButton: 'ChatCloseButton' in chat
      ? chat.ChatCloseButton as () => ClickableElement
      : undefined
  };
}

describe('Renderer 可见组件', () => {
  test('历史披露卡只展示最小摘要并提交两种固定决策', () => {
    const onShareOnce = vi.fn();
    const onCurrentMessageOnly = vi.fn();
    render(
      <HistoryDisclosureCard
        disclosure={{
          requestId: 'disclosure-1',
          targetProviderName: 'OpenAI',
          messageCount: 4,
          characterCount: 120
        }}
        busyDecision={null}
        disabled={false}
        onShareOnce={onShareOnce}
        onCurrentMessageOnly={onCurrentMessageOnly}
      />
    );

    expect(screen.getByRole('heading', { name: '是否共享当前会话历史？' })).toBeTruthy();
    expect(screen.getByText('OpenAI')).toBeTruthy();
    expect(screen.getByText('4 条消息')).toBeTruthy();
    expect(screen.getByText('120 个字符')).toBeTruthy();
    expect(document.body.textContent).not.toContain('不得显示的历史正文');

    fireEvent.click(screen.getByRole('button', { name: '仅本次共享历史' }));
    fireEvent.click(screen.getByRole('button', { name: '仅发送当前消息' }));
    expect(onShareOnce).toHaveBeenCalledOnce();
    expect(onCurrentMessageOnly).toHaveBeenCalledOnce();
    cleanup();
  });

  test('历史披露卡在异步处理时禁用两个入口并公开中文忙碌反馈', () => {
    render(
      <HistoryDisclosureCard
        disclosure={{
          requestId: 'disclosure-1',
          targetProviderName: 'OpenAI',
          messageCount: 4,
          characterCount: 120
        }}
        busyDecision="share_once"
        disabled={false}
        onShareOnce={vi.fn()}
        onCurrentMessageOnly={vi.fn()}
      />
    );

    expect((screen.getByRole('button', { name: '正在共享历史…' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '仅发送当前消息' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('status').textContent).toContain('正在处理你的选择');
    cleanup();
  });

  test('聊天面板把披露请求绑定到两种固定 preload 决策', async () => {
    const api = installMyselfApi();
    act(() => {
      taskStore.getState().apply({
        type: 'history_disclosure_required',
        requestId: 'disclosure-share',
        targetProviderName: 'OpenAI',
        messageCount: 4,
        characterCount: 120
      });
    });
    render(<ChatPanel />);

    fireEvent.click(screen.getByRole('button', { name: '仅本次共享历史' }));
    await waitFor(() => {
      expect(api.resolveHistoryDisclosure).toHaveBeenCalledWith(
        'disclosure-share',
        'share_once'
      );
      expect(screen.queryByRole('button', { name: '仅本次共享历史' })).toBeNull();
    });

    act(() => {
      taskStore.getState().apply({
        type: 'history_disclosure_required',
        requestId: 'disclosure-current',
        targetProviderName: 'Anthropic',
        messageCount: 2,
        characterCount: 60
      });
    });
    fireEvent.click(screen.getByRole('button', { name: '仅发送当前消息' }));
    await waitFor(() => {
      expect(api.resolveHistoryDisclosure).toHaveBeenCalledWith(
        'disclosure-current',
        'current_message_only'
      );
    });
  });

  test('披露处理防止重复提交并将 reject 收敛为稳定中文错误', async () => {
    const disclosure = deferred<void>();
    const api = installMyselfApi({
      resolveHistoryDisclosure: vi.fn().mockReturnValue(disclosure.promise)
    });
    act(() => {
      taskStore.getState().apply({
        type: 'history_disclosure_required',
        requestId: 'disclosure-busy',
        targetProviderName: 'OpenAI',
        messageCount: 1,
        characterCount: 20
      });
    });
    render(<ChatPanel />);
    fireEvent.change(screen.getByLabelText('和我说点什么'), { target: { value: '你好' } });

    fireEvent.click(screen.getByRole('button', { name: '仅本次共享历史' }));
    expect((screen.getByRole('button', { name: '正在共享历史…' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '仅发送当前消息' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '发送给 AI Pet' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '正在共享历史…' }));
    expect(api.resolveHistoryDisclosure).toHaveBeenCalledOnce();

    await act(async () => {
      disclosure.reject(new Error('不得暴露的内部错误'));
      await disclosure.promise.catch(() => undefined);
    });
    expect((await screen.findByRole('alert')).textContent).toContain('未能处理历史披露，请重试。');
    expect(document.body.textContent).not.toContain('不得暴露的内部错误');
  });

  test.each(['resolve', 'reject'] as const)(
    '外部会话重置后旧披露 %s 不清理同 ID 新卡或写入错误',
    async outcome => {
      const oldDisclosure = deferred<void>();
      installMyselfApi({
        resolveHistoryDisclosure: vi.fn().mockReturnValue(oldDisclosure.promise)
      });
      act(() => {
        taskStore.getState().apply({
          type: 'history_disclosure_required',
          requestId: 'reused-request-id',
          targetProviderName: '旧 Provider',
          messageCount: 1,
          characterCount: 20
        });
      });
      render(<ChatPanel />);
      fireEvent.click(screen.getByRole('button', { name: '仅本次共享历史' }));

      act(() => {
        taskStore.getState().apply({ type: 'conversation_reset', generation: 'generation-new' });
        taskStore.getState().apply({
          type: 'history_disclosure_required',
          requestId: 'reused-request-id',
          targetProviderName: '新 Provider',
          messageCount: 2,
          characterCount: 40
        });
      });
      expect((screen.getByRole('button', { name: '仅本次共享历史' }) as HTMLButtonElement).disabled).toBe(false);

      await act(async () => {
        if (outcome === 'resolve') oldDisclosure.resolve();
        else oldDisclosure.reject(new Error('旧会话披露失败'));
        await oldDisclosure.promise.catch(() => undefined);
      });
      expect(screen.getByText('新 Provider')).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
      expect((screen.getByRole('button', { name: '仅本次共享历史' }) as HTMLButtonElement).disabled).toBe(false);
    }
  );

  test('Main 下游失败清除已消费披露卡且不叠加通用 IPC 错误', async () => {
    const disclosure = deferred<void>();
    installMyselfApi({
      resolveHistoryDisclosure: vi.fn().mockReturnValue(disclosure.promise)
    });
    act(() => {
      taskStore.getState().apply({
        type: 'history_disclosure_required',
        requestId: 'downstream-failure',
        targetProviderName: 'OpenAI',
        messageCount: 1,
        characterCount: 20
      });
    });
    render(<ChatPanel />);
    fireEvent.click(screen.getByRole('button', { name: '仅本次共享历史' }));

    act(() => {
      taskStore.getState().apply({
        type: 'error',
        code: 'CHAT_SETTINGS_REQUIRED',
        message: '请在设置中配置对话模型。'
      });
    });
    expect(screen.queryByRole('button', { name: '仅本次共享历史' })).toBeNull();
    await act(async () => {
      disclosure.reject(new Error('下游已公开失败'));
      await disclosure.promise.catch(() => undefined);
    });

    expect(screen.getByText('请在设置中配置对话模型。')).toBeTruthy();
    expect(screen.queryByText('未能处理历史披露，请重试。')).toBeNull();
  });

  test('外部会话重置后旧文件确认 reject 不锁定或污染新交互', async () => {
    const oldAction = deferred<void>();
    const confirmAction = vi.fn()
      .mockReturnValueOnce(oldAction.promise)
      .mockResolvedValueOnce(undefined);
    installMyselfApi({ confirmAction });
    act(() => {
      taskStore.getState().apply({
        type: 'task_permission_required', actionId: 'old-action', summary: '覆盖文件', request: { action: 'overwrite', resources: ['old.txt'] }
      });
    });
    render(<ChatPanel />);
    fireEvent.click(screen.getByRole('button', { name: '确认覆盖文件' }));

    act(() => {
      taskStore.getState().apply({ type: 'conversation_reset', generation: 'generation-new' });
      taskStore.getState().apply({
        type: 'task_permission_required', actionId: 'new-action', summary: '覆盖文件', request: { action: 'overwrite', resources: ['new'] }
      });
    });
    const newConfirm = screen.getByRole('button', { name: '确认覆盖文件' }) as HTMLButtonElement;
    expect(newConfirm.disabled).toBe(false);
    fireEvent.click(newConfirm);
    await waitFor(() => expect(confirmAction).toHaveBeenCalledTimes(2));

    await act(async () => {
      oldAction.reject(new Error('旧操作失败'));
      await oldAction.promise.catch(() => undefined);
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('外部会话重置后旧消息提交 reject 不追加错误或改写新阶段', async () => {
    const oldSubmit = deferred<void>();
    installMyselfApi({ submitMessage: vi.fn().mockReturnValue(oldSubmit.promise) });
    render(<ChatPanel />);
    fireEvent.change(screen.getByLabelText('和我说点什么'), { target: { value: '旧消息' } });
    fireEvent.click(screen.getByRole('button', { name: '发送给 AI Pet' }));

    act(() => {
      taskStore.getState().apply({ type: 'conversation_reset', generation: 'generation-new' });
    });
    const input = screen.getByLabelText('和我说点什么') as HTMLTextAreaElement;
    expect(input.disabled).toBe(false);
    fireEvent.change(input, { target: { value: '新消息' } });
    await act(async () => {
      oldSubmit.reject(new Error('旧提交失败'));
      await oldSubmit.promise.catch(() => undefined);
    });

    expect(taskStore.getState().phase).toBe('idle');
    expect(taskStore.getState().messages).toEqual([]);
    expect(input.value).toBe('新消息');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('外部会话重置立即解除旧 reset busy 且旧 reject 不写错', async () => {
    const oldReset = deferred<void>();
    installMyselfApi({ resetConversation: vi.fn().mockReturnValue(oldReset.promise) });
    render(<ChatPanel />);
    fireEvent.click(screen.getByRole('button', { name: '新对话' }));

    act(() => {
      taskStore.getState().apply({ type: 'conversation_reset', generation: 'generation-new' });
    });
    expect((screen.getByRole('button', { name: '新对话' }) as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      oldReset.reject(new Error('旧重置失败'));
      await oldReset.promise.catch(() => undefined);
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('新对话等待期禁用交互且只在 Main 广播后清空视图', async () => {
    const reset = deferred<void>();
    const api = installMyselfApi({
      resetConversation: vi.fn().mockReturnValue(reset.promise)
    });
    act(() => {
      taskStore.getState().apply({ type: 'message', role: 'assistant', text: '保留到广播' });
      taskStore.getState().apply({
        type: 'task_permission_required', actionId: 'action-reset', summary: '覆盖文件', request: { action: 'overwrite', resources: ['notes.md'] }
      });
    });
    render(<ChatPanel />);

    fireEvent.click(screen.getByRole('button', { name: '新对话' }));
    expect(api.resetConversation).toHaveBeenCalledOnce();
    expect((screen.getByRole('button', { name: '正在新建…' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('textbox', { name: '和我说点什么' }) as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '正在处理…' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('保留到广播')).toBeTruthy();

    await act(async () => {
      reset.resolve();
      await reset.promise;
    });
    expect(screen.getByText('保留到广播')).toBeTruthy();
    act(() => {
      taskStore.getState().apply({ type: 'conversation_reset', generation: 'generation-2' });
    });
    expect(screen.queryByText('保留到广播')).toBeNull();
    expect(screen.queryByRole('button', { name: '确认覆盖文件' })).toBeNull();
  });

  test('新对话 IPC 失败不伪造重置成功', async () => {
    installMyselfApi({
      resetConversation: vi.fn().mockRejectedValue(new Error('内部重置失败'))
    });
    act(() => {
      taskStore.getState().apply({ type: 'message', role: 'assistant', text: '原会话仍在' });
    });
    render(<ChatPanel />);

    fireEvent.click(screen.getByRole('button', { name: '新对话' }));
    expect((await screen.findByRole('alert')).textContent).toContain('未能新建对话，请稍后重试。');
    expect(screen.getByText('原会话仍在')).toBeTruthy();
    expect(document.body.textContent).not.toContain('内部重置失败');
  });

  test('文件授权错误只提供打开设置且聊天表单保持单输入', () => {
    const api = installMyselfApi();
    act(() => {
      taskStore.getState().apply({
        type: 'error',
        code: 'FILE_AUTHORIZATION_REQUIRED',
        message: '请先在设置中授权文件目录。'
      });
    });
    render(<ChatPanel />);

    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    expect(screen.getByLabelText('和我说点什么').tagName).toBe('TEXTAREA');
    fireEvent.click(screen.getByRole('button', { name: '打开设置' }));
    expect(api.openSettings).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toContain('此电脑');
    expect(screen.queryByRole('button', { name: /Chat|Work|路由|Provider/u })).toBeNull();
  });

  test('超长 Provider 名称在摘要行内可换行而不撑破小窗口', () => {
    const styles = readFileSync(
      resolve(import.meta.dirname, '../src/renderer/src/styles.css'),
      'utf8'
    );
    expect(styles).toMatch(
      /\.path-row\s+strong\s*\{[^}]*min-width:\s*0[^}]*overflow-wrap:\s*anywhere/s
    );
  });

  test('普通浏览器预览缺少预加载 API 时不会白屏', () => {
    expect(mountTaskEventsIfAvailable(undefined)).toBeUndefined();
  });

  test('桌宠以温暖陪伴角色呈现思考状态和静态降级模式', () => {
    const markup = renderToStaticMarkup(
      <PetCharacter state="thinking" motionMode="static" />
    );

    expect(markup).toContain('data-state="thinking"');
    expect(markup).toContain('data-motion="static"');
    expect(markup).toContain('正在认真想');
    expect(markup).toContain('AI Pet');
  });

  test('聊天关闭按钮调用正式 window.myself.hideChat', async () => {
    const buttons = await loadRendererCommandButtons();
    expect(typeof buttons.ChatCloseButton).toBe('function');
    if (!buttons.ChatCloseButton) return;

    const hideChat = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('window', { myself: { hideChat } });
    try {
      buttons.ChatCloseButton().props.onClick();
      expect(hideChat).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test.each(['delete', 'overwrite', 'external_directory'] as const)('具体 %s 许可显示准确路径和固定操作含义', action => {
    const markup = renderToStaticMarkup(<ConfirmationCard action={{ type: 'task_permission_required', actionId: 'permission-1', summary: '核对目标', request: { action, resources: ['D:\\project\\note.txt'] } }} busy={false} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(markup).toContain('D:\\project\\note.txt');
    expect(markup).toContain(action === 'delete' ? 'Windows 回收站' : action === 'overwrite' ? '覆盖已有文件' : '超出原授权目录');
    expect(markup).toContain('拒绝本次操作');
  });

  test('设置工作区仅提供模型、隐私和本地数据导航', () => {
    const markup = renderToStaticMarkup(
      <SettingsWorkspace
        dashboard={{
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
            dataCategories: {
              memory: false
            },
            longTermMemory: false,
            proactivityMode: 'assistive'
          },
          privacyRuntimeSupport: {
            dataCategories: {
              memory: false
            },
            longTermMemory: false,
            proactivity: false
          },
          petAlwaysOnTop: false,
          localModel: {
            enabled: true,
            phase: 'loading',
            backend: null,
            reasonCode: null
          },
          authorizedRoot: null
        }}
        activeTab="local"
        busy={false}
        notice={null}
        onDismissNotice={vi.fn()}
        onTabChange={vi.fn()}
        onClose={vi.fn()}
        providerActions={{
          onSave: vi.fn(),
          onTest: vi.fn(),
          onRouteSave: vi.fn(),
          onDelete: vi.fn()
        }}
        privacyActions={{
          incognito: false,
          onSave: vi.fn(),
          onPetAlwaysOnTopChange: vi.fn(),
          onIncognitoChange: vi.fn(),
          onChooseRoot: vi.fn(),
          onRevokeRoot: vi.fn()
        }}
        onClear={vi.fn()}
        onOpenCharacterWorkshop={vi.fn()}
      />
    );

    expect(markup).toContain('模型');
    expect(markup).toContain('隐私');
    expect(markup).toContain('清除全部本地数据');
    expect(markup).not.toContain('notice-success');
    expect(markup).not.toContain('transient-toast-layer');
    expect(availableSettingsTabs()).not.toContain('tools');
  });

  test('隐私设置不展示已退役文件、截图与剪贴板授权开关', () => {
    const markup = renderToStaticMarkup(
      <PrivacySettings
        privacy={{
          dataCategories: { file: false, memory: false },
          longTermMemory: false,
          proactivityMode: 'assistive'
        } as never}
        runtimeSupport={{
          dataCategories: { file: true, memory: false },
          longTermMemory: false,
          proactivity: false
        } as never}
        authorizedRoot={null}
        busy={false}
        incognito={false}
        petAlwaysOnTop={false}
        onSave={vi.fn()}
        onPetAlwaysOnTopChange={vi.fn()}
        onIncognitoChange={vi.fn()}
        onChooseRoot={vi.fn()}
        onRevokeRoot={vi.fn()}
      />
    );

    expect(markup).not.toContain('截图数据授权');
    expect(markup).not.toContain('剪贴板数据授权');
    expect(markup).not.toContain('文件数据授权');
  });
});

describe('桌宠播放器接入', () => {
  test('左键表面以正式角色播放器作为视觉主体', () => {
    vi.stubGlobal('window', {
      myself: {},
      matchMedia: vi.fn()
    });
    try {
      const markup = renderToStaticMarkup(<PetView />);
      expect(markup).toContain('character-player');
      expect(markup).not.toContain('class="pet-character"');
      expect(markup).not.toContain('打开与 AI Pet 的聊天');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('180x220 桌宠窗口具有不塌缩的完整高度链', () => {
    const styles = readFileSync(
      resolve(import.meta.dirname, '../src/renderer/src/styles.css'),
      'utf8'
    );

    expect(styles).toMatch(
      /\.pet-shell\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\)/s
    );
    expect(styles).toMatch(
      /\.pet-character-surface\s*\{[^}]*align-self:\s*stretch/s
    );
    expect(styles).toMatch(
      /\.pet-character-surface\s*\{[^}]*justify-self:\s*stretch/s
    );
  });
});
