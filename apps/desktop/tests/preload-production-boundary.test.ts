import { afterAll, describe, expect, test, vi } from 'vitest';
import { ipcRenderer } from 'electron';
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
  test('生产 preload 不公开 MCP 方法', () => {
    const apiKeys = new Set(Object.keys(exposedApi ?? {}));
    const removedMcpKeys = [
      'upsertMcpServer',
      'confirmMcpLaunch',
      'testMcpServer',
      'setMcpServerEnabled',
      'setMcpToolEnabled',
      'authorizeMcpToolReadOnly',
      'revokeMcpToolReadOnly',
      'deleteMcpServer'
    ];

    for (const key of removedMcpKeys) expect(apiKeys.has(key)).toBe(false);
    expect(removedMcpKeys.filter(key => apiKeys.has(key))).toEqual([]);
  });

  test('缺少 E2E 固定参数时不暴露桌宠交互探针', () => {
    expect(exposedApi).toBeDefined();
    expect(exposedApi).not.toHaveProperty('getPetInteractionProbe');
    expect(exposedApi).not.toHaveProperty('recordPetInteractionProbeEvent');
    expect(exposedApi).not.toHaveProperty('getCharacterBehaviorProbe');
    expect(exposedApi).not.toHaveProperty('getCharacterMotionDeltaProbe');
    expect(exposedApi).not.toHaveProperty('reportCharacterActionMilestone');
    expect(exposedApi).not.toHaveProperty('getFileTaskTransactionSnapshot');
    expect(exposedApi).not.toHaveProperty('moveToRecycleBin');
    expect(exposedApi).not.toHaveProperty('getVerifiedWriteAction');
    expect(exposedApi).not.toHaveProperty('getAuthorizedRootPath');
    expect(exposedApi).not.toHaveProperty('getE2eRecycleBinProbe');
    expect(exposedApi).toHaveProperty('commitPetViewport');
    expect(exposedApi).toHaveProperty('onPetGeometryRender');
  });

  test('固定默认尺寸不再向 Renderer 暴露缩放能力', () => {
    expect(exposedApi).toBeDefined();
    expect(exposedApi).not.toHaveProperty('stepPetScale');
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
    expect(apiKeys.join('\n')).not.toMatch(/globalPosition|windowBounds|characterId|resourceHash/iu);
  });

  test('本地模型状态事件仅转发严格公开状态并精确移除监听器', () => {
    const listener = vi.fn();
    const unsubscribe = exposedApi?.onLocalModelStatus(listener);
    const subscription = vi.mocked(ipcRenderer.on).mock.calls.at(-1);
    const handler = subscription?.[1] as ((event: unknown, payload: unknown) => void) | undefined;
    const status = {
      enabled: true,
      phase: 'ready' as const,
      backend: 'vulkan' as const,
      reasonCode: null
    };

    expect(subscription?.[0]).toBe('local-model:status');
    handler?.({}, status);
    expect(listener).toHaveBeenCalledExactlyOnceWith(status);

    for (const privateField of ['port', 'token', 'path', 'pid', 'stderr']) {
      expect(() => handler?.({}, { ...status, [privateField]: 'private' })).toThrow();
    }
    expect(listener).toHaveBeenCalledExactlyOnceWith(status);

    unsubscribe?.();
    expect(ipcRenderer.removeListener).toHaveBeenLastCalledWith(
      'local-model:status',
      handler
    );
  });
});
