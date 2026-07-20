import { describe, expect, test, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PetCharacter } from '../src/renderer/src/pet/PetView';
import { ConfirmationCard } from '../src/renderer/src/chat/ConfirmationCard';
import { SettingsForm } from '../src/renderer/src/settings/SettingsView';
import { mountTaskEventsIfAvailable } from '../src/renderer/src/App';

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
    expect(markup).toContain('Myself');
  });

  test('重命名确认卡片只展示自然语言和相对路径', () => {
    const markup = renderToStaticMarkup(
      <ConfirmationCard
        action={{
          actionId: 'action-1',
          conversationId: 'conversation-1',
          requestId: 'request-1',
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

  test('设置表单提供模型、目录、隐私和本地数据操作', () => {
    const markup = renderToStaticMarkup(
      <SettingsForm
        settings={{
          version: 1,
          provider: null,
          authorizedRoot: null,
          petPosition: null,
          fileDisclosureAccepted: false
        }}
        fields={{ displayName: '', baseUrl: '', model: '', secret: '', persistSecret: true }}
        busyAction={null}
        notice={null}
        onFieldChange={vi.fn()}
        onSave={vi.fn()}
        onTest={vi.fn()}
        onChooseRoot={vi.fn()}
        onClear={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(markup).toContain('模型伙伴');
    expect(markup).toContain('测试连接');
    expect(markup).toContain('选择工作目录');
    expect(markup).toContain('文件内容可能会发送给你配置的模型服务');
    expect(markup).toContain('清除全部本地数据');
  });
});
