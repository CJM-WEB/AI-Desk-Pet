import { describe, expect, test, vi } from 'vitest';
import type { IpcMain } from 'electron';
import {
  registerAdvancedSettingsIpc,
  registerSettingsIpc
} from '../src/main/ipc/register-ipc';
import { ipcChannels } from '../src/shared/ipc-channels';
import { DEFAULT_WORKSHOP_LAYOUT } from '../src/shared/workshop-layout-ipc';

import { ModelChangeCoordinator } from '../src/main/settings/model-change-coordinator';

function modelChanges(confirm = true) {
  return new ModelChangeCoordinator({
    readConfiguration: async () => ({ localModelEnabled: false, profiles: [], route: {
      primaryProfileId: null, chatProfileId: null, agentProfileId: null, visionProfileId: null,
      fallbackProfileIds: [], allowCrossProviderFallback: false
    } }), confirmModelChange: async () => confirm,
    invalidateConfiguration: async () => undefined, onModelChanged: async () => undefined
  });
}

type Handler = (event: unknown, input?: unknown) => unknown;

function createIpcMain() {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    removeHandler: (channel: string) => handlers.delete(channel),
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler)
  } as unknown as IpcMain;
  return { handlers, ipcMain };
}

function publicSettings(hasStoredSecret: boolean) {
  return {
    version: 1 as const,
    provider: {
      id: 'default',
      displayName: '示例服务',
      baseUrl: 'https://api.example.com/v1',
      model: 'example-model',
      hasStoredSecret
    },
    authorizedRoot: null,
    fileDisclosureAccepted: false
  };
}

describe('设置 IPC', () => {
  test('保存时校验输入并确保公开返回值不包含密钥', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const settings = {
      getPublic: vi.fn(async () => publicSettings(true)),
      saveProviderMetadata: vi.fn(async () => undefined),
      clearAll: vi.fn(async () => undefined)
    };
    const secrets = {
      save: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
      clearAll: vi.fn(async () => undefined)
    };
    const lifecycle = { onProviderChanged: vi.fn(() => undefined) };
    registerSettingsIpc(ipcMain, settings, secrets, lifecycle, undefined, modelChanges());

    const result = await handlers.get(ipcChannels.settingsSaveProvider)?.({}, {
      displayName: '示例服务',
      baseUrl: 'https://api.example.com/v1',
      model: 'example-model',
      secret: 'sk-ipc-fixture',
      persistSecret: true
    });

    expect(secrets.save).toHaveBeenCalledWith('default', 'sk-ipc-fixture', true);
    expect(settings.saveProviderMetadata).toHaveBeenCalledWith({
      id: 'default',
      displayName: '示例服务',
      baseUrl: 'https://api.example.com/v1',
      model: 'example-model'
    });
    expect(lifecycle.onProviderChanged).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('sk-ipc-fixture');
  });

  test('旧保存入口也在确认取消时不写档案和密钥、不触发生命周期', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const settings = { getPublic: vi.fn(async () => publicSettings(true)), saveProviderMetadata: vi.fn(), clearAll: vi.fn() };
    const secrets = { save: vi.fn(), clear: vi.fn(), clearAll: vi.fn() };
    const lifecycle = { onProviderChanged: vi.fn() };
    registerSettingsIpc(ipcMain, settings, secrets, lifecycle, undefined, modelChanges(false));
    await expect(handlers.get(ipcChannels.settingsSaveProvider)?.({}, { displayName: '新模型', baseUrl: 'https://example.com/v1', model: 'new-model', secret: 'private', persistSecret: true })).rejects.toMatchObject({ code: 'MODEL_CHANGE_CANCELLED' });
    expect(settings.saveProviderMetadata).not.toHaveBeenCalled(); expect(secrets.save).not.toHaveBeenCalled();
    expect(lifecycle.onProviderChanged).not.toHaveBeenCalled();
  });

  test.each(['conversation', 'all'])('明确清除%s等待当前会话清空后才返回', async scope => {
    const { handlers, ipcMain } = createIpcMain();
    const settings = { getPublic: vi.fn(async () => publicSettings(true)), saveProviderMetadata: vi.fn(), clearAll: vi.fn() };
    const secrets = { save: vi.fn(), clear: vi.fn(), clearAll: vi.fn() };
    let release!: () => void; let settled = false;
    const lifecycle = { onProviderChanged: vi.fn(), onConversationCleared: vi.fn(async () => new Promise<void>(resolve => { release = resolve; })) };
    registerSettingsIpc(ipcMain, settings, secrets, lifecycle);
    const clearing = Promise.resolve(handlers.get(ipcChannels.settingsClearLocalData)?.({}, { scope })).then(() => { settled = true; });
    await vi.waitFor(() => expect(lifecycle.onConversationCleared).toHaveBeenCalledOnce());
    expect(settled).toBe(false); release(); await clearing;
  });

  test.each([
    'http://api.example.com/v1',
    'ftp://localhost/provider',
    'not-a-url'
  ])('拒绝不安全的服务地址：%s', async baseUrl => {
    const { handlers, ipcMain } = createIpcMain();
    const settings = {
      getPublic: vi.fn(async () => publicSettings(false)),
      saveProviderMetadata: vi.fn(async () => undefined),
      clearAll: vi.fn(async () => undefined)
    };
    const secrets = {
      save: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
      clearAll: vi.fn(async () => undefined)
    };
    registerSettingsIpc(ipcMain, settings, secrets);

    await expect(handlers.get(ipcChannels.settingsSaveProvider)?.({}, {
      displayName: '示例服务',
      baseUrl,
      model: 'example-model',
      secret: 'sk-rejected',
      persistSecret: true
    })).rejects.toThrow();
    expect(secrets.save).not.toHaveBeenCalled();
  });

  test('允许 localhost 使用 HTTP 开发服务', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const settings = {
      getPublic: vi.fn(async () => publicSettings(false)),
      saveProviderMetadata: vi.fn(async () => undefined),
      clearAll: vi.fn(async () => undefined)
    };
    const secrets = {
      save: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
      clearAll: vi.fn(async () => undefined)
    };
    registerSettingsIpc(ipcMain, settings, secrets, undefined, undefined, modelChanges());

    await expect(handlers.get(ipcChannels.settingsSaveProvider)?.({}, {
      displayName: '本地服务',
      baseUrl: 'http://localhost:11434/v1',
      model: 'local-model',
      secret: 'local-secret',
      persistSecret: false
    })).resolves.toEqual(publicSettings(false));
  });

  test('清除 secret 范围省略档案标识时删除默认密钥并返回公开设置', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const settings = {
      getPublic: vi.fn(async () => publicSettings(false)),
      saveProviderMetadata: vi.fn(async () => undefined),
      clearAll: vi.fn(async () => undefined)
    };
    const secrets = {
      save: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
      clearAll: vi.fn(async () => undefined)
    };
    const lifecycle = { onProviderChanged: vi.fn(() => undefined) };
    registerSettingsIpc(ipcMain, settings, secrets, lifecycle);

    await handlers.get(ipcChannels.settingsClearLocalData)?.({}, { scope: 'secret' });

    expect(secrets.clear).toHaveBeenCalledWith('default');
    expect(secrets.clearAll).not.toHaveBeenCalled();
    expect(settings.clearAll).not.toHaveBeenCalled();
    expect(lifecycle.onProviderChanged).toHaveBeenCalledOnce();
  });

  test('清除 secret 范围显式指定档案时只删除精确密钥', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const settings = {
      getPublic: vi.fn(async () => publicSettings(false)),
      saveProviderMetadata: vi.fn(async () => undefined),
      clearAll: vi.fn(async () => undefined)
    };
    const secrets = {
      save: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
      clearAll: vi.fn(async () => undefined)
    };
    const lifecycle = { onProviderChanged: vi.fn(() => undefined) };
    registerSettingsIpc(ipcMain, settings, secrets, lifecycle);

    await handlers.get(ipcChannels.settingsClearLocalData)?.({}, {
      scope: 'secret',
      profileId: 'provider-main'
    });

    expect(secrets.clear).toHaveBeenCalledWith('provider-main');
    expect(secrets.clearAll).not.toHaveBeenCalled();
    expect(settings.clearAll).not.toHaveBeenCalled();
    expect(lifecycle.onProviderChanged).toHaveBeenCalledOnce();
  });

  test('测试连接通过固定动作返回公开结果', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const settings = {
      getPublic: vi.fn(async () => publicSettings(true)),
      saveProviderMetadata: vi.fn(async () => undefined),
      clearAll: vi.fn(async () => undefined)
    };
    const secrets = {
      save: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
      clearAll: vi.fn(async () => undefined)
    };
    const actions = {
      testProvider: vi.fn(async () => ({ ok: true, message: '连接成功。' })),
      chooseAuthorizedRoot: vi.fn(async () => undefined)
    };
    registerSettingsIpc(ipcMain, settings, secrets, undefined, actions);

    await expect(handlers.get(ipcChannels.settingsTestProvider)?.({})).resolves.toEqual({
      ok: true,
      message: '连接成功。'
    });
    expect(actions.testProvider).toHaveBeenCalledOnce();
  });

  test('选择授权目录后清除旧确认状态并返回公开设置', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const settings = {
      getPublic: vi.fn(async () => publicSettings(true)),
      saveProviderMetadata: vi.fn(async () => undefined),
      clearAll: vi.fn(async () => undefined)
    };
    const secrets = {
      save: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
      clearAll: vi.fn(async () => undefined)
    };
    const lifecycle = {
      onProviderChanged: vi.fn(() => undefined),
      onAuthorizedRootChanged: vi.fn(() => undefined)
    };
    const actions = {
      testProvider: vi.fn(async () => ({ ok: true, message: '连接成功。' })),
      chooseAuthorizedRoot: vi.fn(async () => undefined)
    };
    registerSettingsIpc(ipcMain, settings, secrets, lifecycle, actions);

    await expect(handlers.get(ipcChannels.settingsChooseRoot)?.({})).resolves.toEqual(
      publicSettings(true)
    );
    expect(actions.chooseAuthorizedRoot).toHaveBeenCalledOnce();
    expect(lifecycle.onAuthorizedRootChanged).toHaveBeenCalledOnce();
  });

  test('清除 all 会同时清除设置、密钥和相关确认状态', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const settings = {
      getPublic: vi.fn(async () => publicSettings(false)),
      saveProviderMetadata: vi.fn(async () => undefined),
      clearAll: vi.fn(async () => undefined)
    };
    const secrets = {
      save: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
      clearAll: vi.fn(async () => undefined)
    };
    const lifecycle = {
      onProviderChanged: vi.fn(() => undefined),
      onAuthorizedRootChanged: vi.fn(() => undefined)
    };
    registerSettingsIpc(ipcMain, settings, secrets, lifecycle);

    await handlers.get(ipcChannels.settingsClearLocalData)?.({}, { scope: 'all' });

    expect(settings.clearAll).toHaveBeenCalledOnce();
    expect(secrets.clearAll).toHaveBeenCalledOnce();
    expect(lifecycle.onProviderChanged).toHaveBeenCalledOnce();
    expect(lifecycle.onAuthorizedRootChanged).toHaveBeenCalledOnce();
  });

  test('工作台布局读取走固定通道并返回严格解析后的结果', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const service = {
      getDashboard: vi.fn(async () => ({ marker: 'dashboard' })),
      saveProviderProfile: vi.fn(async () => ({ marker: 'saved' })),
      deleteProviderProfile: vi.fn(async () => ({ marker: 'deleted' })),
      saveModelRoute: vi.fn(async () => ({ marker: 'route' })),
      testProviderProfile: vi.fn(async () => ({ ok: true, message: '连接成功。' })),
      savePrivacySettings: vi.fn(async () => ({ marker: 'privacy' })),
      savePetAlwaysOnTop: vi.fn(async () => ({ marker: 'topmost' })),
      setLocalModelEnabled: vi.fn(async () => ({ marker: 'local-model' })),
      setIncognitoSession: vi.fn(async () => ({ incognito: true })),
      revokeAuthorizedRoot: vi.fn(async () => ({ marker: 'root-revoked' })),
      getWorkshopLayout: vi.fn(async () => DEFAULT_WORKSHOP_LAYOUT),
      saveWorkshopLayout: vi.fn(async () => DEFAULT_WORKSHOP_LAYOUT)
    };
    registerAdvancedSettingsIpc(ipcMain, service);

    await expect(
      handlers.get(ipcChannels.settingsWorkshopLayoutGet)?.({}, {})
    ).resolves.toEqual(DEFAULT_WORKSHOP_LAYOUT);
    expect(service.getWorkshopLayout).toHaveBeenCalledOnce();
  });

  test('工作台布局保存先严格解析 payload，再交给服务', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const service = {
      getDashboard: vi.fn(async () => ({ marker: 'dashboard' })),
      saveProviderProfile: vi.fn(async () => ({ marker: 'saved' })),
      deleteProviderProfile: vi.fn(async () => ({ marker: 'deleted' })),
      saveModelRoute: vi.fn(async () => ({ marker: 'route' })),
      testProviderProfile: vi.fn(async () => ({ ok: true, message: '连接成功。' })),
      savePrivacySettings: vi.fn(async () => ({ marker: 'privacy' })),
      savePetAlwaysOnTop: vi.fn(async () => ({ marker: 'topmost' })),
      setLocalModelEnabled: vi.fn(async () => ({ marker: 'local-model' })),
      setIncognitoSession: vi.fn(async () => ({ incognito: true })),
      revokeAuthorizedRoot: vi.fn(async () => ({ marker: 'root-revoked' })),
      getWorkshopLayout: vi.fn(async () => DEFAULT_WORKSHOP_LAYOUT),
      saveWorkshopLayout: vi.fn(async input => input)
    };
    registerAdvancedSettingsIpc(ipcMain, service);

    const input = {
      leftWidth: 320,
      rightWidth: 280,
      sidebarTopHeight: 260,
      stageHeight: 420
    };
    await expect(
      handlers.get(ipcChannels.settingsWorkshopLayoutSave)?.({}, input)
    ).resolves.toEqual(input);
    expect(service.saveWorkshopLayout).toHaveBeenCalledExactlyOnceWith(input);

    await expect(
      handlers.get(ipcChannels.settingsWorkshopLayoutSave)?.({}, {
        ...input,
        rightWidth: Number.POSITIVE_INFINITY
      })
    ).rejects.toMatchObject({ code: 'SETTINGS_INPUT_INVALID' });
    await expect(
      handlers.get(ipcChannels.settingsWorkshopLayoutSave)?.({}, {
        ...input,
        injected: 'forbidden'
      })
    ).rejects.toMatchObject({ code: 'SETTINGS_INPUT_INVALID' });
    expect(service.saveWorkshopLayout).toHaveBeenCalledExactlyOnceWith(input);
  });
});
