import { describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  PetCharacter,
  PetView
} from '../src/renderer/src/pet/PetView';
import { ConfirmationCard } from '../src/renderer/src/chat/ConfirmationCard';
import {
  availableSettingsTabs,
  SettingsWorkspace
} from '../src/renderer/src/settings/SettingsView';
import { mountTaskEventsIfAvailable } from '../src/renderer/src/App';

type ClickableElement = {
  props: {
    onClick(): void;
  };
};

async function loadRendererCommandButtons(): Promise<{
  ChatCloseButton?: () => ClickableElement;
}> {
  const chat = await import('../src/renderer/src/chat/ChatPanel');
  return {
    ChatCloseButton: 'ChatCloseButton' in chat
      ? chat.ChatCloseButton as () => ClickableElement
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

  test('重命名确认卡片只展示自然语言和相对路径', () => {
    const markup = renderToStaticMarkup(
      <ConfirmationCard
        action={{
          actionId: 'action-1',
          conversationId: 'conversation-1',
          risk: 'write',
          operation: 'rename_entry',
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

  test('回收站确认卡按 operation 显示可恢复危险提示', () => {
    const markup = renderToStaticMarkup(
      <ConfirmationCard
        action={{
          actionId: 'action-recycle',
          conversationId: 'conversation-1',
          risk: 'write',
          operation: 'move_to_recycle_bin',
          summary: '备份目录',
          targetRelativePath: 'docs/backup',
          createdAt: '2026-08-07T12:00:00.000Z',
          expiresAt: '2026-08-07T12:02:00.000Z'
        }}
        busy={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    expect(markup).toContain('移入 Windows 回收站，可从回收站恢复');
    expect(markup).toContain('待移入项目');
    expect(markup).not.toContain('目标位置');
    expect(markup).toContain('确认移入回收站');
    expect(markup).toContain('先不移入');
    expect(markup).toContain('danger-button');
    expect(markup).not.toContain('永久删除');
    expect(markup).not.toContain('move_to_recycle_bin');
  });

  test('创建目录确认卡不依赖 summary 关键字', () => {
    const markup = renderToStaticMarkup(
      <ConfirmationCard
        action={{
          actionId: 'action-directory',
          conversationId: 'conversation-1',
          risk: 'write',
          operation: 'create_directory',
          summary: '新建一个收纳位置',
          targetRelativePath: 'archive',
          createdAt: '2026-08-07T12:00:00.000Z',
          expiresAt: '2026-08-07T12:02:00.000Z'
        }}
        busy={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    expect(markup).toContain('确认创建目录');
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
        onOpenCharacterWorkshop={vi.fn()}
      />
    );

    expect(markup).toContain('模型');
    expect(markup).toContain('隐私');
    expect(markup).toContain('清除全部本地数据');
    expect(availableSettingsTabs()).not.toContain('tools');
  });
});

describe('桌宠播放器接入', () => {
  test('左键表面只保留拖动提示并以正式角色播放器作为视觉主体', () => {
    vi.stubGlobal('window', {
      myself: {},
      matchMedia: vi.fn()
    });
    try {
      const markup = renderToStaticMarkup(<PetView />);
      expect(markup).toContain('pet-drag-hint');
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
