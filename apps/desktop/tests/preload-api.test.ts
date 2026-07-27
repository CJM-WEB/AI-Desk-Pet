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
});
