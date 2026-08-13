import type { IpcMain } from 'electron';
import { describe, expect, test, vi } from 'vitest';
import { registerAdvancedSettingsIpc } from '../src/main/ipc/register-ipc';
import { ipcChannels } from '../src/shared/ipc-channels';

type Handler = (event: unknown, input?: unknown) => unknown;

function createIpcMain() {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    removeHandler: (channel: string) => handlers.delete(channel),
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler)
  } as unknown as IpcMain;
  return { handlers, ipcMain };
}

function serviceDouble() {
  return {
    getDashboard: vi.fn(async () => ({ marker: 'dashboard' })),
    saveProviderProfile: vi.fn(async () => ({ marker: 'saved' })),
    deleteProviderProfile: vi.fn(async () => ({ marker: 'deleted' })),
    saveModelRoute: vi.fn(async () => ({ marker: 'route' })),
    testProviderProfile: vi.fn(async () => ({ ok: true, message: '连接成功。' })),
    upsertMcpServer: vi.fn(async (): Promise<
      | { kind: 'saved' }
      | {
        kind: 'confirmation_required';
        summary: {
          command: string;
          args: string[];
          cwd: string;
          explicitEnvNames: string[];
          inheritedEnvNames: string[];
          fingerprint: string;
        };
      }
    > => ({ kind: 'saved' })),
    confirmMcpLaunch: vi.fn(async () => ({ marker: 'confirmed' })),
    testMcpServer: vi.fn(async () => ({ ok: true, message: '连接成功。' })),
    setMcpServerEnabled: vi.fn(async () => ({ marker: 'server-toggle' })),
    setMcpToolEnabled: vi.fn(async () => ({ marker: 'tool-toggle' })),
    authorizeMcpToolReadOnly: vi.fn(async () => ({ marker: 'tool-authorized' })),
    revokeMcpToolReadOnly: vi.fn(async () => ({ marker: 'tool-revoked' })),
    deleteMcpServer: vi.fn(async () => ({ marker: 'mcp-deleted' })),
    savePrivacySettings: vi.fn(async () => ({ marker: 'privacy' })),
    savePetAlwaysOnTop: vi.fn(async () => ({ marker: 'topmost' })),
    setIncognitoSession: vi.fn(async () => ({ incognito: true })),
    revokeAuthorizedRoot: vi.fn(async () => ({ marker: 'root-revoked' }))
  };
}

describe('高级设置白名单 IPC', () => {
  test('桌宠置顶使用独立严格布尔通道', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const service = serviceDouble();
    const lifecycle = { onConfigurationChanged: vi.fn() };
    registerAdvancedSettingsIpc(ipcMain, service, lifecycle);

    await handlers.get(ipcChannels.settingsPetAlwaysOnTopSave)?.({}, { enabled: true });
    expect(service.savePetAlwaysOnTop).toHaveBeenCalledExactlyOnceWith(true);
    expect(lifecycle.onConfigurationChanged).not.toHaveBeenCalled();
    await expect(handlers.get(ipcChannels.settingsPetAlwaysOnTopSave)?.({}, {
      enabled: true,
      injected: 'forbidden'
    })).rejects.toMatchObject({ code: 'SETTINGS_INPUT_INVALID' });
  });

  test('隐私保存负载拒绝混入桌宠窗口偏好', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const service = serviceDouble();
    registerAdvancedSettingsIpc(ipcMain, service);

    await expect(handlers.get(ipcChannels.settingsPrivacySave)?.({}, {
      dataCategories: { file: false, screenshot: false, clipboard: false, memory: false },
      longTermMemory: false,
      proactivityMode: 'assistive',
      petAlwaysOnTop: true
    })).rejects.toMatchObject({ code: 'SETTINGS_INPUT_INVALID' });
    expect(service.savePrivacySettings).not.toHaveBeenCalled();
  });

  test('保存 Provider 档案时严格校验并仅把密钥交给 Main 服务', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const service = serviceDouble();
    const lifecycle = { onConfigurationChanged: vi.fn() };
    registerAdvancedSettingsIpc(ipcMain, service, lifecycle);

    const input = {
      profile: {
        id: 'openai-main',
        displayName: 'OpenAI',
        mode: 'preset',
        providerId: 'openai',
        modelId: 'gpt-5-mini'
      },
      secret: 'sk-private-value',
      persistSecret: true
    };
    const result = await handlers.get(ipcChannels.settingsProfileSave)?.({}, input);

    expect(service.saveProviderProfile).toHaveBeenCalledWith(input);
    expect(lifecycle.onConfigurationChanged).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain('sk-private-value');
  });

  test('未知字段在进入服务前被稳定拒绝', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const service = serviceDouble();
    registerAdvancedSettingsIpc(ipcMain, service);

    await expect(handlers.get(ipcChannels.settingsRouteSave)?.({}, {
      route: {
        primaryProfileId: null,
        chatProfileId: null,
        agentProfileId: null,
        visionProfileId: null,
        fallbackProfileIds: [],
        allowCrossProviderFallback: false
      },
      injected: 'not-allowed'
    })).rejects.toMatchObject({
      code: 'SETTINGS_INPUT_INVALID',
      message: 'SETTINGS_INPUT_INVALID'
    });
    expect(service.saveModelRoute).not.toHaveBeenCalled();
  });

  test.each([
    'http://provider.example.com/v1',
    'https://user:password@provider.example.com/v1'
  ])('拒绝不安全的 V2 Provider Base URL：%s', async baseUrl => {
    const { handlers, ipcMain } = createIpcMain();
    const service = serviceDouble();
    registerAdvancedSettingsIpc(ipcMain, service);

    await expect(handlers.get(ipcChannels.settingsProfileSave)?.({}, {
      profile: {
        id: 'unsafe-custom',
        displayName: '不安全服务',
        mode: 'custom',
        protocol: 'openai-compatible',
        baseUrl,
        modelId: 'model',
        additionalParameters: {}
      },
      persistSecret: true
    })).rejects.toMatchObject({
      code: 'SETTINGS_INPUT_INVALID',
      message: 'SETTINGS_INPUT_INVALID'
    });
    expect(service.saveProviderProfile).not.toHaveBeenCalled();
  });

  test('stdio MCP 先返回启动摘要，确认指纹后才允许测试连接', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const service = serviceDouble();
    service.upsertMcpServer.mockResolvedValueOnce({
      kind: 'confirmation_required',
      summary: {
        command: 'C:\\tools\\mcp.exe',
        args: ['--stdio'],
        cwd: 'C:\\work',
        explicitEnvNames: ['TOKEN'],
        inheritedEnvNames: [],
        fingerprint: 'fingerprint-1'
      }
    });
    registerAdvancedSettingsIpc(ipcMain, service);

    const saved = await handlers.get(ipcChannels.settingsMcpUpsert)?.({}, {
      id: 'local-tools',
      enabled: true,
      transport: {
        type: 'stdio',
        command: 'C:\\tools\\mcp.exe',
        args: ['--stdio'],
        cwd: 'C:\\work',
        env: { TOKEN: 'secret-token' },
        inheritEnv: []
      }
    });
    expect(saved).toMatchObject({ kind: 'confirmation_required' });
    expect(service.testMcpServer).not.toHaveBeenCalled();

    await handlers.get(ipcChannels.settingsMcpConfirmLaunch)?.({}, {
      serverId: 'local-tools',
      fingerprint: 'fingerprint-1'
    });
    expect(service.confirmMcpLaunch).toHaveBeenCalledWith(
      'local-tools',
      'fingerprint-1'
    );
  });

  test('MCP 本地只读授权使用严格 serverId/toolName 白名单输入', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const service = serviceDouble();
    registerAdvancedSettingsIpc(ipcMain, service);

    await handlers.get(ipcChannels.settingsMcpToolAuthorizeRead)?.({}, {
      serverId: 'local-tools',
      toolName: 'echo'
    });
    expect(service.authorizeMcpToolReadOnly).toHaveBeenCalledWith('local-tools', 'echo');

    await expect(handlers.get(ipcChannels.settingsMcpToolRevokeRead)?.({}, {
      serverId: 'local-tools',
      toolName: 'echo',
      injected: true
    })).rejects.toMatchObject({ code: 'SETTINGS_INPUT_INVALID' });
    expect(service.revokeMcpToolReadOnly).not.toHaveBeenCalled();
  });
});
