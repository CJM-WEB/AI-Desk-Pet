import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import type { SettingsDashboardDto } from '../src/shared/myself-api';
import { ProviderSettings } from '../src/renderer/src/settings/ProviderSettings';
import { McpSettings } from '../src/renderer/src/settings/McpSettings';
import { PrivacySettings } from '../src/renderer/src/settings/PrivacySettings';
import {
  availableSettingsTabs,
  resolveSettingsTab,
  SettingsWorkspace
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
  mcpServers: [{
    id: 'notes',
    enabled: true,
    status: 'connected',
    transport: {
      type: 'stdio',
      summary: 'C:\\tools\\notes.exe --stdio',
      secretNames: ['TOKEN']
    },
    tools: [{
      name: 'read-note',
      description: '读取笔记',
      enabled: true,
      readOnly: true
    }, {
      name: 'delete-note',
      description: '删除笔记',
      enabled: false,
      readOnly: false
    }]
  }],
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
  authorizedRoot: {
    id: 'root-1',
    displayName: 'workspace',
    pathHint: 'D:\\…\\workspace'
  }
};

describe('多 Provider 设置组件', () => {
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

  test('MCP 展示状态、逐工具开关和未授权工具的确认入口', () => {
    const markup = renderToStaticMarkup(
      <McpSettings
        servers={dashboard.mcpServers}
        busy={false}
        launchSummary={null}
        onCancelLaunch={vi.fn()}
        onUpsert={vi.fn()}
        onConfirmLaunch={vi.fn()}
        onTest={vi.fn()}
        onToggleServer={vi.fn()}
        onToggleTool={vi.fn()}
        onAuthorizeReadOnly={vi.fn()}
        onRevokeReadOnly={vi.fn()}
        onDelete={vi.fn()}
      />
    );

    expect(markup).toContain('已连接');
    expect(markup).toContain('read-note');
    expect(markup).toContain('delete-note');
    expect(markup).toContain('只有经本机逐工具确认的只读工具才可启用');
    expect(markup).toContain('aria-label="授权 delete-note 为只读"');
    expect(markup).toContain('aria-label="撤销 read-note 只读授权"');
    expect(markup).toMatch(/aria-label="delete-note 工具开关"[^>]*>/u);
    expect(markup).not.toMatch(/aria-label="delete-note 工具开关"[^>]*disabled=""/u);
    expect(markup).not.toContain('private-token');
  });

  test('stdio 启动摘要明确展示命令、参数、目录和环境变量名', () => {
    const markup = renderToStaticMarkup(
      <McpSettings
        servers={[]}
        busy={false}
        launchSummary={{
          serverId: 'local',
          command: 'C:\\tools\\mcp.exe',
          args: ['--stdio'],
          cwd: 'C:\\workspace',
          explicitEnvNames: ['TOKEN'],
          inheritedEnvNames: [],
          fingerprint: 'fingerprint'
        }}
        onCancelLaunch={vi.fn()}
        onUpsert={vi.fn()}
        onConfirmLaunch={vi.fn()}
        onTest={vi.fn()}
        onToggleServer={vi.fn()}
        onToggleTool={vi.fn()}
        onAuthorizeReadOnly={vi.fn()}
        onRevokeReadOnly={vi.fn()}
        onDelete={vi.fn()}
      />
    );

    expect(markup).toContain('确认启动本地服务');
    expect(markup).toContain('C:\\tools\\mcp.exe');
    expect(markup).toContain('--stdio');
    expect(markup).toContain('C:\\workspace');
    expect(markup).toContain('TOKEN');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('取消');
    expect(markup).not.toContain('fingerprint');
  });

  test('隐私类别独立开关、主动性分段控件和权限撤销均可访问', () => {
    const markup = renderToStaticMarkup(
      <PrivacySettings
        privacy={dashboard.privacy}
        runtimeSupport={dashboard.privacyRuntimeSupport}
        authorizedRoot={dashboard.authorizedRoot}
        busy={false}
        incognito={false}
        onSave={vi.fn()}
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
  });

  test('MCP 禁用时设置导航不公开工具页且旧 tools 状态回退到模型档案', () => {
    expect(availableSettingsTabs()).toEqual(['models', 'privacy', 'local']);
    expect(resolveSettingsTab('tools')).toBe('models');

    const markup = renderToStaticMarkup(
      <SettingsWorkspace
        dashboard={dashboard}
        activeTab="tools"
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

    expect(markup).toContain('模型档案');
    expect(markup).not.toContain('MCP 服务');
  });
});
