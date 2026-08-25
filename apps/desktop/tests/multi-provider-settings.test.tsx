// @vitest-environment jsdom

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, expectTypeOf, test, vi } from 'vitest';
import type { SettingsDashboardDto } from '../src/shared/myself-api';
import { ProviderSettings } from '../src/renderer/src/settings/ProviderSettings';
import { PrivacySettings } from '../src/renderer/src/settings/PrivacySettings';
import {
  availableSettingsTabs,
  SettingsWorkspace,
  type SettingsTab,
  type SettingsWorkspaceProps
} from '../src/renderer/src/settings/SettingsView';

const dashboard: SettingsDashboardDto = {
  catalog: [{
    catalogVersion: 1,
    providerId: 'openai',
    displayName: 'OpenAI',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    modelDiscoveryUrl: null,
    models: [{
      modelId: 'gpt-tools',
      displayName: 'GPT Tools',
      capabilities: ['chat', 'tools', 'vision']
    }, {
      modelId: 'gpt-chat',
      displayName: 'GPT Chat',
      capabilities: ['chat']
    }],
    apiKeyHelpUrl: 'https://platform.openai.com/api-keys',
    requestLimits: {},
    compatibilityNotes: []
  }, {
    catalogVersion: 1,
    providerId: 'deepseek',
    displayName: 'DeepSeek',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    modelDiscoveryUrl: null,
    models: [{
      modelId: 'deepseek-chat',
      displayName: 'DeepSeek Chat',
      capabilities: ['chat', 'tools']
    }],
    apiKeyHelpUrl: 'https://platform.deepseek.com/api_keys',
    requestLimits: {},
    compatibilityNotes: []
  }],
  profiles: [{
    id: 'openai-main',
    displayName: 'OpenAI 主档案',
    mode: 'preset',
    providerId: 'openai',
    modelId: 'gpt-tools',
    hasStoredSecret: true
  }, {
    id: 'chat-only',
    displayName: '仅聊天',
    mode: 'custom',
    protocol: 'openai-compatible',
    baseUrl: 'https://chat.example.com/v1',
    modelId: 'chat-only',
    additionalParameters: {},
    capabilities: ['chat'],
    hasStoredSecret: false
  }],
  route: {
    primaryProfileId: 'openai-main',
    chatProfileId: null,
    agentProfileId: 'openai-main',
    visionProfileId: null,
    fallbackProfileIds: [],
    allowCrossProviderFallback: false
  },
  privacy: {
    dataCategories: {
      file: true,
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
  petAlwaysOnTop: false,
  authorizedRoot: {
    id: 'root-1',
    displayName: 'workspace',
    pathHint: 'D:\\…\\workspace'
  }
};

afterEach(cleanup);

describe('多 Provider 设置组件', () => {
  test('设置工作区不再公开工具标签或 MCP 操作 Props', () => {
    expectTypeOf<'tools'>().not.toMatchTypeOf<SettingsTab>();
    expectTypeOf<SettingsWorkspaceProps>().not.toHaveProperty('mcpActions');
  });

  test('普通模式聚焦 Provider、Model 和 API Key，高级字段折叠', () => {
    const markup = renderToStaticMarkup(
      <ProviderSettings
        dashboard={dashboard}
        busy={false}
        onSave={vi.fn()}
        onTest={vi.fn()}
        onRouteSave={vi.fn()}
        onDelete={vi.fn()}
      />
    );

    expect(markup).toContain('提供商');
    expect(markup).toContain('模型');
    expect(markup).toContain('API Key');
    expect(markup).toContain('<details');
    expect(markup).toContain('高级设置');
    expect(markup).toContain('Base URL');
    expect(markup).toContain('tools');
  });

  test('预置模型输入提示可直接填写服务商公布的模型 ID', () => {
    render(
      <ProviderSettings
        dashboard={dashboard}
        busy={false}
        onSave={vi.fn()}
        onTest={vi.fn()}
        onRouteSave={vi.fn()}
        onDelete={vi.fn()}
      />
    );

    expect(screen.getByText(/可直接输入服务商公布的模型 ID/u)).toBeTruthy();
  });

  test('提交目录外预置模型时保存保守聊天能力', () => {
    const onSave = vi.fn();
    render(
      <ProviderSettings
        dashboard={dashboard}
        busy={false}
        onSave={onSave}
        onTest={vi.fn()}
        onRouteSave={vi.fn()}
        onDelete={vi.fn()}
      />
    );

    const modelInput = screen.getByRole('combobox', { name: '模型' });
    fireEvent.change(modelInput, { target: { value: 'provider-new-model' } });
    fireEvent.click(screen.getByRole('button', { name: /保存档案/u }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      profile: expect.objectContaining({
        mode: 'preset',
        modelId: 'provider-new-model',
        capabilities: ['chat']
      })
    }));
  });

  test('目录外预置档案按显式能力参与路由选项校验', () => {
    const unknownProfileDashboard: SettingsDashboardDto = {
      ...dashboard,
      profiles: [...dashboard.profiles, {
        id: 'openai-new-chat',
        displayName: 'OpenAI 新聊天模型',
        mode: 'preset',
        providerId: 'openai',
        modelId: 'provider-new-chat',
        capabilities: ['chat'],
        hasStoredSecret: true
      }]
    };
    render(
      <ProviderSettings
        dashboard={unknownProfileDashboard}
        busy={false}
        onSave={vi.fn()}
        onTest={vi.fn()}
        onRouteSave={vi.fn()}
        onDelete={vi.fn()}
      />
    );

    const chatOption = screen.getByLabelText('对话模型')
      .querySelector<HTMLOptionElement>('option[value="openai-new-chat"]');
    const agentOption = screen.getByLabelText('Agent 模型')
      .querySelector<HTMLOptionElement>('option[value="openai-new-chat"]');
    expect(chatOption?.disabled).toBe(false);
    expect(agentOption?.disabled).toBe(true);
  });

  test('未知预置提供商即使声明能力也不能参与 Agent 路由', () => {
    const unknownProviderDashboard: SettingsDashboardDto = {
      ...dashboard,
      profiles: [...dashboard.profiles, {
        id: 'unknown-agent',
        displayName: '未知 Agent',
        mode: 'preset',
        providerId: 'unknown',
        modelId: 'unknown-agent-model',
        capabilities: ['chat', 'tools'],
        hasStoredSecret: true
      }]
    };
    render(
      <ProviderSettings
        dashboard={unknownProviderDashboard}
        busy={false}
        onSave={vi.fn()}
        onTest={vi.fn()}
        onRouteSave={vi.fn()}
        onDelete={vi.fn()}
      />
    );

    const agentOption = screen.getByLabelText('Agent 模型')
      .querySelector<HTMLOptionElement>('option[value="unknown-agent"]');
    expect(agentOption?.disabled).toBe(true);
  });

  test('无 tools 档案不能选择为 Agent 且显示跨提供商授权提示', () => {
    const markup = renderToStaticMarkup(
      <ProviderSettings
        dashboard={dashboard}
        busy={false}
        onSave={vi.fn()}
        onTest={vi.fn()}
        onRouteSave={vi.fn()}
        onDelete={vi.fn()}
      />
    );

    expect(markup).toMatch(/<option[^>]*value="chat-only"[^>]*disabled=""/u);
    expect(markup).toContain('备用模型');
    expect(markup).toContain('允许跨提供商备用');
    expect(markup).toContain('会把必要上下文发送给另一家提供商');
  });

  test('隐私类别独立开关、主动性分段控件和权限撤销均可访问', () => {
    const onPetAlwaysOnTopChange = vi.fn();
    const markup = renderToStaticMarkup(
      <PrivacySettings
        privacy={dashboard.privacy}
        runtimeSupport={dashboard.privacyRuntimeSupport}
        authorizedRoot={dashboard.authorizedRoot}
        busy={false}
        incognito={false}
        petAlwaysOnTop={false}
        onSave={vi.fn()}
        onPetAlwaysOnTopChange={onPetAlwaysOnTopChange}
        onIncognitoChange={vi.fn()}
        onChooseRoot={vi.fn()}
        onRevokeRoot={vi.fn()}
      />
    );

    expect(markup).toContain('文件');
    expect(markup).toContain('截图');
    expect(markup).toContain('剪贴板');
    expect(markup).toContain('长期记忆');
    expect(markup).toContain('被动');
    expect(markup).toContain('辅助');
    expect(markup).toContain('自主');
    expect(markup).toContain('撤销目录权限');
    expect(markup).toContain('无痕会话');
    expect(markup).toContain('桌宠始终置顶');
    expect(markup).toContain('aria-label="桌宠始终置顶"');

    render(
      <PrivacySettings
        privacy={dashboard.privacy}
        runtimeSupport={dashboard.privacyRuntimeSupport}
        authorizedRoot={dashboard.authorizedRoot}
        busy={false}
        incognito={false}
        petAlwaysOnTop={false}
        onSave={vi.fn()}
        onPetAlwaysOnTopChange={onPetAlwaysOnTopChange}
        onIncognitoChange={vi.fn()}
        onChooseRoot={vi.fn()}
        onRevokeRoot={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('checkbox', { name: '桌宠始终置顶' }));
    expect(onPetAlwaysOnTopChange).toHaveBeenCalledExactlyOnceWith(true);
  });

  test('设置 UI 不保留匿名模型的专属状态或文案', async () => {
    const desktopRoot = process.cwd().replaceAll('\\', '/').endsWith('/apps/desktop')
      ? process.cwd()
      : join(process.cwd(), 'apps/desktop');
    const source = await readFile(
      join(desktopRoot, 'src/renderer/src/settings/ProviderSettings.tsx'),
      'utf8'
    );

    expect(source).not.toMatch(/anonymous|OpenCode Zen|匿名试用/u);
  });

  test('设置导航只公开三个现行分类', () => {
    expect(availableSettingsTabs()).toEqual(['models', 'privacy', 'local']);

    const markup = renderToStaticMarkup(
      <SettingsWorkspace
        dashboard={dashboard}
        activeTab="models"
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

    expect(markup).toContain('模型档案');
    expect(markup).not.toContain('工具');
  });

  test('角色工作室入口保留可见文案并使用专属布局职责', () => {
    const markup = renderToStaticMarkup(
      <SettingsWorkspace
        dashboard={dashboard}
        activeTab="models"
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

    expect(markup).toContain('class="settings-workshop-button"');
    expect(markup).toContain('角色工作室</button>');
  });
});
