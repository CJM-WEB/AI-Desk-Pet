import { afterAll, describe, expect, test, vi } from 'vitest';
import type { MyselfApi } from '../src/shared/myself-api';

let exposedApi: MyselfApi | undefined;
const originalArgv = [...process.argv];
process.argv = process.argv.filter(argument => argument !== '--myself-e2e-probe');

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, api: MyselfApi) => {
      exposedApi = api;
    }
  },
  ipcRenderer: {
    invoke: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn()
  }
}));

await import('../src/preload/index');

afterAll(() => {
  process.argv = originalArgv;
});

describe('生产 preload 探针边界', () => {
  test('缺少 E2E 固定参数时不暴露桌宠交互探针', () => {
    expect(exposedApi).toBeDefined();
    expect(exposedApi).not.toHaveProperty('getPetInteractionProbe');
    expect(exposedApi).not.toHaveProperty('getCharacterBehaviorProbe');
    expect(exposedApi).toHaveProperty('reportCharacterActionMilestone');
    expect(exposedApi).not.toHaveProperty('getFileTaskTransactionSnapshot');
    expect(exposedApi).not.toHaveProperty('moveToRecycleBin');
    expect(exposedApi).not.toHaveProperty('getVerifiedWriteAction');
    expect(exposedApi).not.toHaveProperty('getAuthorizedRootPath');
    expect(exposedApi).not.toHaveProperty('getE2eRecycleBinProbe');
  });

  test('生产 API 不暴露目录绝对路径、句柄、私有身份、桥状态或 fake 控制', () => {
    expect(exposedApi).toBeDefined();
    const apiKeys = Object.keys(exposedApi ?? {});
    const removedHabitatKeys = [
      'getHabitatDashboard',
      'chooseAndAddHabitatDirectory',
      'setHabitatDirectoryEnabled',
      'removeHabitatDirectory',
      'saveHabitatPreferences',
      'enterHabitatDirectory',
      'summonHabitat',
      'recallHabitat'
    ];

    expect(apiKeys).not.toEqual(expect.arrayContaining([
      ...removedHabitatKeys,
      'getHabitatAbsolutePath',
      'getExplorerHwnd',
      'getHabitatPrivateIdentity',
      'getExplorerBridgeState',
      'injectExplorerSnapshot',
      'crashExplorerBridge',
      'getHabitatE2eControl'
    ]));
    for (const removedKey of removedHabitatKeys) expect(apiKeys).not.toContain(removedKey);
    expect(apiKeys.join('\n')).not.toMatch(
      /absolutePath|hwnd|privateIdentity|bridgeState|injectExplorer|crashExplorer|HabitatE2e/iu
    );
  });
});
