import { describe, expect, test, vi } from 'vitest';
import type { IpcMain } from 'electron';
import { registerSettingsIpc } from '../src/main/ipc/register-ipc';
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
    petPosition: null,
    fileDisclosureAccepted: false
  };
}

describe('设置 IPC', () => {
  test('保存时校验输入并确保公开返回值不包含密钥', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const settings = {
      getPublic: vi.fn(async () => publicSettings(true)),
      saveProviderMetadata: vi.fn(async () => undefined)
    };
    const secrets = {
      save: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined)
    };
    const lifecycle = { onProviderChanged: vi.fn(() => undefined) };
    registerSettingsIpc(ipcMain, settings, secrets, lifecycle);

    const result = await handlers.get(ipcChannels.settingsSaveProvider)?.({}, {
      displayName: '示例服务',
      baseUrl: 'https://api.example.com/v1',
      model: 'example-model',
      secret: 'sk-ipc-fixture',
      persistSecret: true
    });

    expect(secrets.save).toHaveBeenCalledWith('sk-ipc-fixture', true);
    expect(settings.saveProviderMetadata).toHaveBeenCalledWith({
      id: 'default',
      displayName: '示例服务',
      baseUrl: 'https://api.example.com/v1',
      model: 'example-model'
    });
    expect(lifecycle.onProviderChanged).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain('sk-ipc-fixture');
  });

  test.each([
    'http://api.example.com/v1',
    'ftp://localhost/provider',
    'not-a-url'
  ])('拒绝不安全的服务地址：%s', async baseUrl => {
    const { handlers, ipcMain } = createIpcMain();
    const settings = {
      getPublic: vi.fn(async () => publicSettings(false)),
      saveProviderMetadata: vi.fn(async () => undefined)
    };
    const secrets = {
      save: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined)
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
      saveProviderMetadata: vi.fn(async () => undefined)
    };
    const secrets = {
      save: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined)
    };
    registerSettingsIpc(ipcMain, settings, secrets);

    await expect(handlers.get(ipcChannels.settingsSaveProvider)?.({}, {
      displayName: '本地服务',
      baseUrl: 'http://localhost:11434/v1',
      model: 'local-model',
      secret: 'local-secret',
      persistSecret: false
    })).resolves.toEqual(publicSettings(false));
  });

  test('清除 secret 范围会删除密钥并返回公开设置', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const settings = {
      getPublic: vi.fn(async () => publicSettings(false)),
      saveProviderMetadata: vi.fn(async () => undefined)
    };
    const secrets = {
      save: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined)
    };
    const lifecycle = { onProviderChanged: vi.fn(() => undefined) };
    registerSettingsIpc(ipcMain, settings, secrets, lifecycle);

    await handlers.get(ipcChannels.settingsClearLocalData)?.({}, { scope: 'secret' });

    expect(secrets.clear).toHaveBeenCalledOnce();
    expect(lifecycle.onProviderChanged).toHaveBeenCalledOnce();
  });
});
