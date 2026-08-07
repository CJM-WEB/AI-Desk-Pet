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
});
