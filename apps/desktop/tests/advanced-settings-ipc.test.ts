import type { IpcMain } from 'electron';
import { describe, expect, test, vi } from 'vitest';
import { registerAdvancedSettingsIpc } from '../src/main/ipc/register-ipc';
import { ipcChannels } from '../src/shared/ipc-channels';
import { DEFAULT_WORKSHOP_LAYOUT } from '../src/shared/workshop-layout-ipc';

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
    savePrivacySettings: vi.fn(async () => ({ marker: 'privacy' })),
    getWorkshopLayout: vi.fn(async () => DEFAULT_WORKSHOP_LAYOUT),
    saveWorkshopLayout: vi.fn(async () => DEFAULT_WORKSHOP_LAYOUT),
    savePetAlwaysOnTop: vi.fn(async () => ({ marker: 'topmost' })),
    setLocalModelEnabled: vi.fn(async () => ({ marker: 'local-model' })),
    setIncognitoSession: vi.fn(async () => ({ incognito: true })),
    revokeAuthorizedRoot: vi.fn(async () => ({ marker: 'root-revoked' }))
  };
}

describe('高级设置白名单 IPC', () => {
  test('不注册 MCP 高级设置 handler', () => {
    const { handlers, ipcMain } = createIpcMain();
    const service = serviceDouble();
    registerAdvancedSettingsIpc(ipcMain, service);
    const removedChannels = [
      'settings:mcp-upsert',
      'settings:mcp-confirm-launch',
      'settings:mcp-test',
      'settings:mcp-server-toggle',
      'settings:mcp-tool-toggle',
      'settings:mcp-tool-authorize-read',
      'settings:mcp-tool-revoke-read',
      'settings:mcp-delete'
    ];

    for (const channel of removedChannels) expect(handlers.has(channel)).toBe(false);
    expect(removedChannels.filter(channel => handlers.has(channel))).toEqual([]);
  });

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

  test('本地模型开关只接受严格布尔负载且不重复触发通用配置重置', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const service = serviceDouble();
    const lifecycle = { onConfigurationChanged: vi.fn() };
    registerAdvancedSettingsIpc(ipcMain, service, lifecycle);

    await expect(handlers.get(ipcChannels.settingsLocalModelEnabledSet)?.({}, {
      enabled: true
    })).resolves.toEqual({ marker: 'local-model' });
    expect(service.setLocalModelEnabled).toHaveBeenCalledExactlyOnceWith(true);
    expect(lifecycle.onConfigurationChanged).not.toHaveBeenCalled();

    await expect(handlers.get(ipcChannels.settingsLocalModelEnabledSet)?.({}, {
      enabled: false,
      injected: 'forbidden'
    })).rejects.toMatchObject({ code: 'SETTINGS_INPUT_INVALID' });
    await expect(handlers.get(ipcChannels.settingsLocalModelEnabledSet)?.({}, {
      enabled: 'true'
    })).rejects.toMatchObject({ code: 'SETTINGS_INPUT_INVALID' });
    expect(service.setLocalModelEnabled).toHaveBeenCalledExactlyOnceWith(true);
  });

  test('隐私保存负载拒绝混入桌宠窗口偏好', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const service = serviceDouble();
    registerAdvancedSettingsIpc(ipcMain, service);

    await expect(handlers.get(ipcChannels.settingsPrivacySave)?.({}, {
      dataCategories: { memory: false },
      longTermMemory: false,
      proactivityMode: 'assistive',
      petAlwaysOnTop: true
    })).rejects.toMatchObject({ code: 'SETTINGS_INPUT_INVALID' });
    expect(service.savePrivacySettings).not.toHaveBeenCalled();
  });

  test('隐私保存负载拒绝混入停止锁，不向 Renderer 暴露写入通道', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const service = serviceDouble();
    registerAdvancedSettingsIpc(ipcMain, service);

    await expect(handlers.get(ipcChannels.settingsPrivacySave)?.({}, {
      dataCategories: { memory: false },
      longTermMemory: false,
      proactivityMode: 'assistive',
      movementStopped: true
    })).rejects.toMatchObject({ code: 'SETTINGS_INPUT_INVALID' });
    expect(service.savePrivacySettings).not.toHaveBeenCalled();
    expect(Object.values(ipcChannels).some(channel => channel.includes('movement-stopped'))).toBe(false);
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
    expect(lifecycle.onConfigurationChanged).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('sk-private-value');
  });

  test('无痕变更等待旧运行与持久化生命周期完成才返回', async () => {
    const { handlers, ipcMain } = createIpcMain(); const service = serviceDouble();
    let release!: () => void; let settled = false;
    const lifecycle = { onConfigurationChanged: vi.fn(async () => new Promise<void>(resolve => { release = resolve; })) };
    registerAdvancedSettingsIpc(ipcMain, service, lifecycle);
    const saving = Promise.resolve(handlers.get(ipcChannels.settingsIncognitoSet)?.({}, { incognito: true })).then(() => { settled = true; });
    await vi.waitFor(() => expect(lifecycle.onConfigurationChanged).toHaveBeenCalledOnce());
    expect(settled).toBe(false); release(); await saving;
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

});
