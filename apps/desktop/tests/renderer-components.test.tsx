import { describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  PetCharacter,
  PetOpenChatButton,
  PetView
} from '../src/renderer/src/pet/PetView';
import { ConfirmationCard } from '../src/renderer/src/chat/ConfirmationCard';
import { SettingsWorkspace } from '../src/renderer/src/settings/SettingsView';
import { mountTaskEventsIfAvailable } from '../src/renderer/src/App';

type ClickableElement = {
  props: {
    onClick(): void;
  };
};

async function loadRendererCommandButtons(): Promise<{
  ChatCloseButton?: () => ClickableElement;
  PetOpenChatButton?: (props: { children?: unknown }) => ClickableElement;
}> {
  const [chat, pet] = await Promise.all([
    import('../src/renderer/src/chat/ChatPanel'),
    import('../src/renderer/src/pet/PetView')
  ]);
  return {
    ChatCloseButton: 'ChatCloseButton' in chat
      ? chat.ChatCloseButton as () => ClickableElement
      : undefined,
    PetOpenChatButton: 'PetOpenChatButton' in pet
      ? pet.PetOpenChatButton as (props: { children?: unknown }) => ClickableElement
      : undefined
  };
}

describe('Renderer 可见组件', () => {
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

  test('桌宠打开按钮保留正式聊天入口', () => {
    const markup = renderToStaticMarkup(
      <PetOpenChatButton>角色</PetOpenChatButton>
    );
    expect(markup).toContain('pet-open-chat');
    expect(markup).toContain('打开与 AI Pet 的聊天');
  });

  test('重命名确认卡片只展示自然语言和相对路径', () => {
    const markup = renderToStaticMarkup(
      <ConfirmationCard
        action={{
          actionId: 'action-1',
          conversationId: 'conversation-1',
          risk: 'write',
          summary: '将 notes.md 重命名为 ideas.md',
          sourceRelativePath: 'notes.md',
          targetRelativePath: 'ideas.md',
          createdAt: '2026-07-20T12:00:00.000Z',
          expiresAt: '2026-07-20T12:02:00.000Z'
        }}
        busy={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    expect(markup).toContain('notes.md');
    expect(markup).toContain('ideas.md');
    expect(markup).toContain('确认重命名');
    expect(markup).toContain('先不重命名');
    expect(markup).toContain('不会覆盖已有文件');
    expect(markup).not.toContain('C:\\');
    expect(markup).not.toContain('rename_entry');
  });

  test('设置工作区提供模型、工具、隐私和本地数据导航', () => {
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
          mcpServers: [],
          privacy: {
            dataCategories: {
              file: false,
              screenshot: false,
              clipboard: false,
              memory: false
            },
            longTermMemory: false,
            proactivityMode: 'assistive'
          },
          privacyRuntimeSupport: {
            dataCategories: {
              file: true,
              screenshot: false,
              clipboard: false,
              memory: false
            },
            longTermMemory: false,
            proactivity: false
          },
          authorizedRoot: null
        }}
        activeTab="local"
        busy={false}
        notice={null}
        onTabChange={vi.fn()}
        onClose={vi.fn()}
        providerActions={{
          onSave: vi.fn(),
          onTest: vi.fn(),
          onRouteSave: vi.fn(),
          onDelete: vi.fn()
        }}
        mcpActions={{
          launchSummary: null,
          onCancelLaunch: vi.fn(),
          onUpsert: vi.fn(),
          onConfirmLaunch: vi.fn(),
          onTest: vi.fn(),
          onToggleServer: vi.fn(),
          onToggleTool: vi.fn(),
          onAuthorizeReadOnly: vi.fn(),
          onRevokeReadOnly: vi.fn(),
          onDelete: vi.fn()
        }}
        privacyActions={{
          incognito: false,
          onSave: vi.fn(),
          onIncognitoChange: vi.fn(),
          onChooseRoot: vi.fn(),
          onRevokeRoot: vi.fn()
        }}
        onClear={vi.fn()}
      />
    );

    expect(markup).toContain('模型');
    expect(markup).toContain('工具');
    expect(markup).toContain('隐私');
    expect(markup).toContain('清除全部本地数据');
  });
});

describe('桌宠播放器接入', () => {
  test('保留拖动区域和聊天入口并以正式角色播放器作为视觉主体', () => {
    vi.stubGlobal('window', {
      myself: {},
      matchMedia: vi.fn()
    });
    try {
      const markup = renderToStaticMarkup(<PetView />);
      expect(markup).toContain('pet-drag-hint');
      expect(markup).toContain('pet-open-chat');
      expect(markup).toContain('character-player');
      expect(markup).not.toContain('pet-character');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('180x220 桌宠窗口具有不塌缩的完整高度链', () => {
    const styles = readFileSync(
      resolve(process.cwd(), 'src/renderer/src/styles.css'),
      'utf8'
    );

    expect(styles).toMatch(
      /\.pet-shell\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\)/s
    );
    expect(styles).toMatch(
      /\.pet-open-chat\s*\{[^}]*align-self:\s*stretch/s
    );
    expect(styles).toMatch(
      /\.pet-open-chat\s*\{[^}]*justify-self:\s*stretch/s
    );
  });
});
