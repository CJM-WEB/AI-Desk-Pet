import type { ProviderSettingsSnapshot } from '../src/main/storage/settings-store';
import type { LocalModelPublicStatus } from '../src/shared/local-model-ipc';
import { describe, expect, test, vi } from 'vitest';
import {
  LocalModelService,
  type LocalModelServiceRuntime
} from '../src/main/local-model/local-model-service';
import { BUILTIN_LOCAL_PROFILE_ID } from '../src/main/local-model/local-model-route';

const cloudSettings: ProviderSettingsSnapshot = {
  profiles: [{
    id: 'cloud-chat',
    displayName: '云端聊天',
    mode: 'custom',
    protocol: 'openai-compatible',
    baseUrl: 'https://cloud.example/v1',
    modelId: 'cloud-model',
    additionalParameters: {},
    capabilities: ['chat', 'tools'],
    hasStoredSecret: true
  }],
  route: {
    primaryProfileId: 'cloud-chat',
    chatProfileId: 'cloud-chat',
    agentProfileId: 'cloud-chat',
    visionProfileId: null,
    fallbackProfileIds: [],
    allowCrossProviderFallback: false
  }
};

function status(
  enabled: boolean,
  phase: LocalModelPublicStatus['phase'],
  reasonCode: LocalModelPublicStatus['reasonCode'] = null
): LocalModelPublicStatus {
  return { enabled, phase, backend: null, reasonCode };
}

function runtimeDouble(input: {
  order?: string[];
  start?: () => Promise<void>;
  stop?: () => Promise<void>;
} = {}) {
  let current = status(false, 'disabled');
  const listeners = new Set<(value: LocalModelPublicStatus) => void>();
  const runtime: LocalModelServiceRuntime = {
    start: vi.fn(input.start ?? (async () => { input.order?.push('start'); })),
    stop: vi.fn(input.stop ?? (async () => { input.order?.push('stop'); })),
    close: vi.fn(async () => { input.order?.push('close'); }),
    getStatus: vi.fn(() => current),
    subscribe: vi.fn(listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    })
  };
  return {
    runtime,
    emit(next: LocalModelPublicStatus): void {
      current = next;
      for (const listener of listeners) listener(next);
    }
  };
}

function createHarness(input: {
  enabled: boolean;
  order?: string[];
  start?: () => Promise<void>;
  stop?: () => Promise<void>;
  reset?: () => Promise<void>;
}) {
  const runtime = runtimeDouble(input);
  const published: LocalModelPublicStatus[] = [];
  const saveEnabled = vi.fn(async (enabled: boolean) => {
    input.order?.push(`save:${enabled}`);
  });
  const resetForConfigurationChange = vi.fn(input.reset ?? (async () => {
    input.order?.push('reset');
  }));
  const service = new LocalModelService({
    initialEnabled: input.enabled,
    runtime: runtime.runtime,
    readCloudProviderSettings: async () => structuredClone(cloudSettings),
    saveEnabled,
    resetForConfigurationChange,
    publishStatus: value => published.push(value)
  });
  return { published, resetForConfigurationChange, runtime, saveEnabled, service };
}

describe('LocalModelService', () => {
  test('默认开启时立即使用内存本地路由，并仅在 Main 明确启动后预热 Runtime', async () => {
    const order: string[] = [];
    const harness = createHarness({ enabled: true, order });

    const initial = await harness.service.providerSettingsSnapshot();
    expect(initial.route.primaryProfileId).toBe(BUILTIN_LOCAL_PROFILE_ID);
    expect(harness.runtime.runtime.start).not.toHaveBeenCalled();

    order.push('windows-ready');
    await harness.service.start();

    expect(order).toEqual(['windows-ready', 'start']);
    expect(harness.saveEnabled).not.toHaveBeenCalled();
  });

  test('关闭严格执行会话失效、停止 Runtime、保存设置后才恢复云路由', async () => {
    const order: string[] = [];
    const harness = createHarness({ enabled: true, order });

    await harness.service.setEnabled(false);

    expect(order).toEqual(['reset', 'stop', 'save:false']);
    expect(await harness.service.providerSettingsSnapshot()).toEqual(cloudSettings);
  });

  test('开启严格执行会话失效、内存覆盖、启动 Runtime，且切换期间冻结新请求', async () => {
    const order: string[] = [];
    let releaseReset!: () => void;
    const resetBarrier = new Promise<void>(resolve => { releaseReset = resolve; });
    let service!: LocalModelService;
    const harness = createHarness({
      enabled: false,
      order,
      reset: async () => {
        order.push('reset');
        await resetBarrier;
      },
      start: async () => {
        order.push('start');
        throw new Error('START_FAILED');
      }
    });
    service = harness.service;

    const switching = service.setEnabled(true);
    await expect(service.providerSettingsSnapshot()).rejects.toMatchObject({
      code: 'LOCAL_MODEL_SWITCHING'
    });
    releaseReset();
    await expect(switching).rejects.toThrow('START_FAILED');

    expect(order).toEqual(['reset', 'save:true', 'start']);
    expect((await service.providerSettingsSnapshot()).route.primaryProfileId)
      .toBe(BUILTIN_LOCAL_PROFILE_ID);
  });

  test('切换串行执行；停止或启动失败时保持本地路由并绝不回退云端', async () => {
    const order: string[] = [];
    const stopFailure = new Error('STOP_FAILED');
    const stopHarness = createHarness({
      enabled: true,
      order,
      stop: async () => { order.push('stop'); throw stopFailure; }
    });

    await expect(stopHarness.service.setEnabled(false)).rejects.toBe(stopFailure);
    expect((await stopHarness.service.providerSettingsSnapshot()).route.primaryProfileId)
      .toBe(BUILTIN_LOCAL_PROFILE_ID);
    expect(stopHarness.saveEnabled).not.toHaveBeenCalled();

    const serialOrder: string[] = [];
    const serial = createHarness({ enabled: false, order: serialOrder });
    await Promise.all([
      serial.service.setEnabled(true),
      serial.service.setEnabled(false)
    ]);
    expect(serialOrder).toEqual([
      'reset', 'save:true', 'start',
      'reset', 'stop', 'save:false'
    ]);
  });

  test('关闭切换已停止 Runtime 但仍在保存时，并发 start 不得复活本地进程', async () => {
    let releaseSave!: () => void;
    const saveBarrier = new Promise<void>(resolve => { releaseSave = resolve; });
    const harness = createHarness({ enabled: true });
    harness.saveEnabled.mockImplementation(async () => saveBarrier);

    const disabling = harness.service.setEnabled(false);
    await vi.waitFor(() => expect(harness.saveEnabled).toHaveBeenCalledExactlyOnceWith(false));
    const lateStart = harness.service.start();

    expect(harness.runtime.runtime.start).not.toHaveBeenCalled();
    releaseSave();
    await Promise.all([disabling, lateStart]);
    expect(harness.runtime.runtime.start).not.toHaveBeenCalled();
    expect((await harness.service.providerSettingsSnapshot()).route.primaryProfileId)
      .toBe('cloud-chat');
  });

  test('reset 或设置保存失败时不越过对应提交点，也不改变当前路由', async () => {
    const resetFailure = new Error('RESET_FAILED');
    const resetHarness = createHarness({
      enabled: true,
      reset: async () => { throw resetFailure; }
    });
    await expect(resetHarness.service.setEnabled(false)).rejects.toBe(resetFailure);
    expect(resetHarness.runtime.runtime.stop).not.toHaveBeenCalled();
    expect(resetHarness.saveEnabled).not.toHaveBeenCalled();
    expect((await resetHarness.service.providerSettingsSnapshot()).route.primaryProfileId)
      .toBe(BUILTIN_LOCAL_PROFILE_ID);

    const disableSaveFailure = new Error('DISABLE_SAVE_FAILED');
    const disableHarness = createHarness({ enabled: true });
    disableHarness.saveEnabled.mockRejectedValue(disableSaveFailure);
    await expect(disableHarness.service.setEnabled(false)).rejects.toBe(disableSaveFailure);
    expect(disableHarness.runtime.runtime.stop).toHaveBeenCalledOnce();
    expect((await disableHarness.service.providerSettingsSnapshot()).route.primaryProfileId)
      .toBe(BUILTIN_LOCAL_PROFILE_ID);

    const enableSaveFailure = new Error('ENABLE_SAVE_FAILED');
    const enableHarness = createHarness({ enabled: false });
    enableHarness.saveEnabled.mockRejectedValue(enableSaveFailure);
    await expect(enableHarness.service.setEnabled(true)).rejects.toBe(enableSaveFailure);
    expect(enableHarness.runtime.runtime.start).not.toHaveBeenCalled();
    expect((await enableHarness.service.providerSettingsSnapshot()).route.primaryProfileId)
      .toBe('cloud-chat');
  });

  test('Runtime 状态只经 Main 发布端口广播，关闭会中止半途启动并保持幂等', async () => {
    let rejectStart!: (error: Error) => void;
    const starting = new Promise<void>((_resolve, reject) => { rejectStart = reject; });
    const order: string[] = [];
    const harness = createHarness({ enabled: true, order, start: () => starting });
    harness.runtime.runtime.close = vi.fn(async () => {
      order.push('close');
      rejectStart(new Error('START_ABORTED'));
    });

    const start = harness.service.start().then(() => null, error => error as Error);
    await vi.waitFor(() => expect(harness.runtime.runtime.start).toHaveBeenCalledOnce());
    harness.runtime.emit(status(true, 'loading'));
    expect(harness.published.at(-1)).toEqual(status(true, 'loading'));

    await Promise.all([harness.service.close(), harness.service.close()]);
    expect(await start).toMatchObject({ message: 'START_ABORTED' });
    expect(harness.runtime.runtime.close).toHaveBeenCalledOnce();
    expect(order).toEqual(['close']);
  });
});
