import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ipcChannels } from '../src/shared/ipc-channels';
import type { MyselfApi } from '../src/shared/myself-api';

const invoke = vi.fn(async () => undefined);
let exposedApi: MyselfApi | undefined;

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, api: MyselfApi) => {
      exposedApi = api;
    }
  },
  ipcRenderer: { invoke }
}));

await import('../src/preload/index');

beforeEach(() => {
  invoke.mockClear();
});

describe('preload 清除本地数据转发', () => {
  test('传入档案标识时将其发送到固定 IPC 通道', async () => {
    await exposedApi?.clearLocalData('secret', 'alpha');

    expect(invoke).toHaveBeenCalledWith(ipcChannels.settingsClearLocalData, {
      scope: 'secret',
      profileId: 'alpha'
    });
  });

  test('省略档案标识时保持旧版默认档案负载', async () => {
    await exposedApi?.clearLocalData('secret');

    expect(invoke).toHaveBeenCalledWith(ipcChannels.settingsClearLocalData, { scope: 'secret' });
  });

  test('高级设置只通过固定白名单通道转发', async () => {
    await exposedApi?.getSettingsDashboard();
    await exposedApi?.saveModelRoute({
      primaryProfileId: null,
      chatProfileId: null,
      agentProfileId: null,
      visionProfileId: null,
      fallbackProfileIds: [],
      allowCrossProviderFallback: false
    });
    await exposedApi?.setIncognitoSession(true);
    await exposedApi?.authorizeMcpToolReadOnly('local-tools', 'echo');
    await exposedApi?.revokeMcpToolReadOnly('local-tools', 'echo');

    expect(invoke).toHaveBeenNthCalledWith(1, ipcChannels.settingsDashboardGet);
    expect(invoke).toHaveBeenNthCalledWith(2, ipcChannels.settingsRouteSave, {
      route: {
        primaryProfileId: null,
        chatProfileId: null,
        agentProfileId: null,
        visionProfileId: null,
        fallbackProfileIds: [],
        allowCrossProviderFallback: false
      }
    });
    expect(invoke).toHaveBeenNthCalledWith(3, ipcChannels.settingsIncognitoSet, {
      incognito: true
    });
    expect(invoke).toHaveBeenNthCalledWith(4, ipcChannels.settingsMcpToolAuthorizeRead, {
      serverId: 'local-tools',
      toolName: 'echo'
    });
    expect(invoke).toHaveBeenNthCalledWith(5, ipcChannels.settingsMcpToolRevokeRead, {
      serverId: 'local-tools',
      toolName: 'echo'
    });
  });
});
