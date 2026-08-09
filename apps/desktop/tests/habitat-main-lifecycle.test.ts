import { describe, expect, test } from 'vitest';

type LifecycleModule = {
  createForegroundFullscreenBlocker?(options: {
    sample(): Promise<boolean>;
  }): { refresh(): Promise<boolean>; current(): boolean };
  createExplorerObservationRelay?<T>(): {
    accept(value: T): Promise<void>;
    attach(consumer: (value: T) => Promise<void>): Promise<void>;
  };
  createStartupVisibilityGate?(options: {
    window: { isVisible(): boolean; hide(): void; show(): void };
    readState(): 'desktop' | 'folder-hidden' | 'folder-visible' | 'folder-lost';
  }): { show(): void; hide(): void; toggle(): void; markReady(): void };
  createStateGuardedPetVisibilityCommand?(options: {
    window: { isVisible(): boolean; hide(): void; show(): void };
    readState(): 'desktop' | 'folder-hidden' | 'folder-visible' | 'folder-lost';
  }): () => void;
  createTrayRefreshController?<T>(options: {
    build(): Promise<T>;
    publish(value: T): void;
  }): { refresh(): Promise<void> };
  refreshAfter?<T>(operation: () => Promise<T>, refresh: () => Promise<void>): Promise<T>;
  createIntegrityCheckedExplorerPort?(options: {
    verify(): Promise<void>;
    explorer: {
      start(): Promise<void>;
      startObserving(): Promise<{ ok: true }>;
      stopObserving(): Promise<{ ok: true }>;
      close(): Promise<void>;
    };
  }): {
    start(): Promise<void>;
    startObserving(): Promise<{ ok: true }>;
    stopObserving(): Promise<{ ok: true }>;
    close(): Promise<void>;
  };
  createStartupCleanupStack?(): {
    add(cleanup: () => Promise<void> | void): void;
    run(): Promise<void>;
    dismiss(): void;
  };
  createAsyncActivityBlocker?(): {
    run<T>(operation: () => Promise<T>): Promise<T>;
    current(): boolean;
  };
  runMainEventSafely?(
    operation: () => Promise<void>,
    report: (code: 'HABITAT_EVENT_FAILED') => void
  ): Promise<void>;
};

async function loadLifecycle(): Promise<LifecycleModule | null> {
  try {
    return await import('../src/main/habitat/habitat-main-lifecycle');
  } catch {
    return null;
  }
}

describe('Habitat Main 真实生命周期', () => {
  test('Main blocker 初始与探针失败都失败关闭，成功采样后才允许自动藏身', async () => {
    const module = await loadLifecycle();
    let reject = false;
    const blocker = module?.createForegroundFullscreenBlocker?.({
      sample: async () => {
        if (reject) throw new Error('PRIVATE_PROBE');
        return false;
      }
    });

    expect(blocker?.current()).toBe(true);
    expect(await blocker?.refresh()).toBe(false);
    expect(blocker?.current()).toBe(false);
    reject = true;
    expect(await blocker?.refresh()).toBe(true);
    expect(blocker?.current()).toBe(true);
  });

  test('Main blocker 合并并发刷新，避免重复启动系统探针', async () => {
    const module = await loadLifecycle();
    let sampleCount = 0;
    let finishSample = (_value: boolean): void => {};
    const sampled = new Promise<boolean>(resolve => { finishSample = resolve; });
    const blocker = module?.createForegroundFullscreenBlocker?.({
      sample: async () => {
        sampleCount += 1;
        return sampled;
      }
    });

    const first = blocker?.refresh();
    const second = blocker?.refresh();
    expect(sampleCount).toBe(1);
    finishSample(false);
    await expect(Promise.all([first, second])).resolves.toEqual([false, false]);
  });

  test('消费者就绪后先串行回放最新缓存快照，再处理后续快照', async () => {
    const module = await loadLifecycle();
    const relay = module?.createExplorerObservationRelay?.<number>();
    expect(relay).toBeDefined();
    if (!relay) return;
    const order: string[] = [];
    let releaseFirst = (): void => {};
    const firstPending = new Promise<void>(resolve => { releaseFirst = resolve; });
    await relay.accept(1);

    const attaching = relay.attach(async value => {
      order.push(`start:${value}`);
      if (value === 1) await firstPending;
      order.push(`end:${value}`);
    });
    const second = relay.accept(2);
    await Promise.resolve();
    expect(order).toEqual(['start:1']);
    releaseFirst();
    await Promise.all([attaching, second]);

    expect(order).toEqual(['start:1', 'end:1', 'start:2', 'end:2']);
  });

  test('startupReady 前的显示与 toggle 只记录意图，ready 后仍按稳定状态兑现', async () => {
    const module = await loadLifecycle();
    let state: 'desktop' | 'folder-hidden' | 'folder-visible' = 'folder-hidden';
    let visible = false;
    const effects: string[] = [];
    const gate = module?.createStartupVisibilityGate?.({
      window: {
        isVisible: () => visible,
        hide: () => { visible = false; effects.push('hide'); },
        show: () => { visible = true; effects.push('show'); }
      },
      readState: () => state
    });
    expect(gate).toBeDefined();
    if (!gate) return;

    gate.show();
    gate.toggle();
    expect(effects).toEqual([]);
    gate.markReady();
    expect(visible).toBe(false);
    state = 'folder-visible';
    gate.show();
    expect(visible).toBe(true);
  });

  test('陈旧 desktop 菜单命令执行时复核状态，folder-hidden 绝不直接 show', async () => {
    const module = await loadLifecycle();
    let state: 'desktop' | 'folder-hidden' = 'desktop';
    let visible = false;
    const effects: string[] = [];
    const staleCommand = module?.createStateGuardedPetVisibilityCommand?.({
      window: {
        isVisible: () => visible,
        hide: () => { visible = false; effects.push('hide'); },
        show: () => { visible = true; effects.push('show'); }
      },
      readState: () => state
    });
    expect(staleCommand).toBeDefined();
    if (!staleCommand) return;
    state = 'folder-hidden';

    staleCommand();

    expect(effects).toEqual(['hide']);
    expect(visible).toBe(false);
  });

  test('Habitat 或目录配置变化后刷新并发布最新托盘结果', async () => {
    const module = await loadLifecycle();
    let current = 'desktop:1';
    const published: string[] = [];
    const controller = module?.createTrayRefreshController?.({
      build: async () => current,
      publish: value => published.push(value)
    });
    expect(controller).toBeDefined();
    expect(module?.refreshAfter).toBeDefined();
    if (!controller || !module?.refreshAfter) return;

    await controller.refresh();
    current = 'folder-hidden:2';
    await module.refreshAfter(async () => undefined, () => controller.refresh());

    expect(published).toEqual(['desktop:1', 'folder-hidden:2']);
  });

  test('Habitat 命令失败但稳定状态已收敛时仍刷新托盘且保留原错误', async () => {
    const module = await loadLifecycle();
    expect(module?.refreshAfter).toBeDefined();
    if (!module?.refreshAfter) return;
    const refreshed: string[] = [];

    await expect(module.refreshAfter(
      async () => {
        throw new Error('HABITAT_DIRECTORY_UNAVAILABLE');
      },
      async () => { refreshed.push('refreshed'); }
    )).rejects.toThrow('HABITAT_DIRECTORY_UNAVAILABLE');

    expect(refreshed).toEqual(['refreshed']);
  });

  test('真实 explorer 每次 start 前都重新校验，第二次校验失败不得 spawn', async () => {
    const module = await loadLifecycle();
    let valid = true;
    let starts = 0;
    const port = module?.createIntegrityCheckedExplorerPort?.({
      verify: async () => {
        if (!valid) throw new Error('INTEGRITY_FAILED');
      },
      explorer: {
        start: async () => { starts += 1; },
        startObserving: async () => ({ ok: true }),
        stopObserving: async () => ({ ok: true }),
        close: async () => undefined
      }
    });
    expect(port).toBeDefined();
    if (!port) return;
    await port.start();
    valid = false;

    await expect(port.start()).rejects.toThrow('INTEGRITY_FAILED');
    expect(starts).toBe(1);
  });

  test('启动失败按资源创建逆序等待清理，重复 run 不重复释放', async () => {
    const module = await loadLifecycle();
    const stack = module?.createStartupCleanupStack?.();
    expect(stack).toBeDefined();
    if (!stack) return;
    const order: string[] = [];
    stack.add(async () => { order.push('pet'); });
    stack.add(async () => { order.push('bridge'); throw new Error('PRIVATE_CLOSE'); });
    stack.add(async () => { order.push('behavior'); });

    await expect(stack.run()).rejects.toThrow('STARTUP_CLEANUP_INCOMPLETE');
    await expect(stack.run()).rejects.toThrow('STARTUP_CLEANUP_INCOMPLETE');

    expect(order).toEqual(['behavior', 'bridge', 'pet']);
  });

  test('重叠角色切换全部结束前 blocker 始终为 true，失败也会释放', async () => {
    const module = await loadLifecycle();
    const blocker = module?.createAsyncActivityBlocker?.();
    expect(blocker).toBeDefined();
    if (!blocker) return;
    let release = (): void => {};
    const pending = new Promise<void>(resolve => { release = resolve; });
    const first = blocker.run(() => pending);
    const second = blocker.run(async () => { throw new Error('SWITCH_FAILED'); });
    expect(blocker.current()).toBe(true);
    await expect(second).rejects.toThrow('SWITCH_FAILED');
    expect(blocker.current()).toBe(true);
    release();
    await first;
    expect(blocker.current()).toBe(false);
  });

  test('Main 事件清理失败只报告稳定码且 Promise 正常收敛', async () => {
    const module = await loadLifecycle();
    const reports: string[] = [];
    expect(module?.runMainEventSafely).toBeDefined();
    if (!module?.runMainEventSafely) return;
    await expect(module.runMainEventSafely(
      async () => { throw new Error('PRIVATE_LAYER_FAILURE'); },
      code => reports.push(code)
    )).resolves.toBeUndefined();

    expect(reports).toEqual(['HABITAT_EVENT_FAILED']);
  });
});
