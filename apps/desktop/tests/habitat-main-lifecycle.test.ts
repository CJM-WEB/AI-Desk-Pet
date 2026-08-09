import { describe, expect, test } from 'vitest';

type LifecycleModule = {
  createForegroundFullscreenBlocker?(probe: {
    sample(): Promise<boolean>;
    close?(): Promise<void>;
  }, options?: {
    now(): number;
    ttlMs: number;
  }): {
    sampleIfEligible?(eligible: boolean): Promise<boolean>;
    refresh?(): Promise<boolean>;
    current(): boolean;
    close?(): Promise<void>;
  };
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
    seal?(): void;
  };
  createApplicationQuitCoordinator?(options: {
    cleanupBootstrap(): Promise<void>;
    quit(): void;
    onError?(error: unknown): void;
  }): {
    handle(event: { preventDefault(): void }): Promise<void>;
    activateNormal(shutdown: () => Promise<void>): boolean;
    exitAfterStartupFailure(): Promise<void>;
    quitRequested(): boolean;
  };
  createAsyncActivityBlocker?(): {
    run<T>(operation: () => Promise<T>): Promise<T>;
    current(): boolean;
  };
  createCharacterActivationCoordinator?(options: {
    activateInStore(characterId: string, confirmIncomplete?: boolean): Promise<void>;
    reloadBehavior(): Promise<void>;
  }): {
    activate(characterId: string, confirmIncomplete?: boolean): Promise<void>;
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
    let now = 0;
    const blocker = module?.createForegroundFullscreenBlocker?.({
      sample: async () => {
        if (reject) throw new Error('PRIVATE_PROBE');
        return false;
      },
      close: async () => undefined
    }, { now: () => now, ttlMs: 10 });

    expect(blocker?.current()).toBe(true);
    expect(await blocker?.sampleIfEligible?.(true)).toBe(false);
    expect(blocker?.current()).toBe(false);
    reject = true;
    now = 11;
    expect(await blocker?.sampleIfEligible?.(true)).toBe(true);
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
      },
      close: async () => undefined
    });

    const first = blocker?.sampleIfEligible?.(true);
    const second = blocker?.sampleIfEligible?.(true);
    expect(sampleCount).toBe(1);
    finishSample(false);
    await expect(Promise.all([first, second])).resolves.toEqual([false, false]);
  });

  test('自动藏身廉价资格不满足时不采样，满足后在 TTL 内复用且 close 后失败关闭', async () => {
    const module = await loadLifecycle();
    let now = 0;
    let sampleCount = 0;
    let closeCount = 0;
    const blocker = module?.createForegroundFullscreenBlocker?.({
      sample: async () => { sampleCount += 1; return false; },
      close: async () => { closeCount += 1; }
    }, { now: () => now, ttlMs: 2_000 });

    expect(await blocker?.sampleIfEligible?.(false)).toBe(true);
    expect(sampleCount).toBe(0);
    expect(await blocker?.sampleIfEligible?.(true)).toBe(false);
    now = 1_999;
    expect(await blocker?.sampleIfEligible?.(true)).toBe(false);
    expect(sampleCount).toBe(1);
    now = 2_001;
    expect(await blocker?.sampleIfEligible?.(true)).toBe(false);
    expect(sampleCount).toBe(2);
    await blocker?.close?.();
    expect(closeCount).toBe(1);
    expect(await blocker?.sampleIfEligible?.(true)).toBe(true);
    expect(sampleCount).toBe(2);
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
    stack.seal?.();

    await expect(stack.run()).rejects.toThrow('STARTUP_CLEANUP_INCOMPLETE');
    await expect(stack.run()).rejects.toThrow('STARTUP_CLEANUP_INCOMPLETE');

    expect(order).toEqual(['behavior', 'bridge', 'pet']);
  });

  test('Renderer 或回放挂起期间 quit 会等待已取得资源逆序关闭且不会 ABA 或双 quit', async () => {
    const module = await loadLifecycle();
    const cleanup = module?.createStartupCleanupStack?.();
    expect(cleanup).toBeDefined();
    if (!cleanup) return;
    let finishExplorer = (): void => {};
    let finishProbe = (): void => {};
    const explorerClosed = new Promise<void>(resolve => { finishExplorer = resolve; });
    const probeClosed = new Promise<void>(resolve => { finishProbe = resolve; });
    const order: string[] = [];
    cleanup.add(async () => {
      order.push('explorer:start');
      await explorerClosed;
      order.push('explorer:end');
    });
    cleanup.add(async () => {
      order.push('probe:start');
      await probeClosed;
      order.push('probe:end');
    });
    let quitCount = 0;
    let prevented = 0;
    const coordinator = module?.createApplicationQuitCoordinator?.({
      cleanupBootstrap: () => cleanup.run(),
      quit: () => { quitCount += 1; }
    });

    const firstQuit = coordinator?.handle({ preventDefault: () => { prevented += 1; } });
    const repeatedQuit = coordinator?.handle({ preventDefault: () => { prevented += 1; } });
    await Promise.resolve();
    expect(order).toEqual(['probe:start']);
    expect(quitCount).toBe(0);
    expect(coordinator?.activateNormal(async () => { order.push('normal'); })).toBe(false);
    finishProbe();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['probe:start', 'probe:end', 'explorer:start']);
    expect(quitCount).toBe(0);
    finishExplorer();
    cleanup.seal?.();
    await Promise.all([firstQuit, repeatedQuit]);

    expect(order).toEqual(['probe:start', 'probe:end', 'explorer:start', 'explorer:end']);
    expect(prevented).toBe(2);
    expect(quitCount).toBe(1);
    await coordinator?.exitAfterStartupFailure();
    expect(quitCount).toBe(1);
  });

  test('bootstrap cleanup 持续接管初始化恢复后的迟到资源并等待启动协程终止', async () => {
    const module = await loadLifecycle();
    const cleanup = module?.createStartupCleanupStack?.();
    expect(cleanup).toBeDefined();
    if (!cleanup) return;
    let finishExplorer = (): void => {};
    const explorerClosed = new Promise<void>(resolve => { finishExplorer = resolve; });
    let markSettingsCleaned = (): void => {};
    const settingsCleaned = new Promise<void>(resolve => { markSettingsCleaned = resolve; });
    const order: string[] = [];
    cleanup.add(async () => {
      order.push('explorer:start');
      await explorerClosed;
      order.push('explorer:end');
    });
    let resumeInitialization = (): void => {};
    const initialization = new Promise<void>(resolve => { resumeInitialization = resolve; });
    const startup = (async () => {
      try {
        await initialization;
        cleanup.add(async () => { order.push('settings'); markSettingsCleaned(); });
        cleanup.add(async () => { order.push('probe'); throw new Error('PRIVATE_LATE_CLOSE'); });
        cleanup.add(() => { order.push('timer'); });
      } finally {
        cleanup.seal?.();
      }
    })();
    let quitCount = 0;
    let reported = 0;
    const coordinator = module?.createApplicationQuitCoordinator?.({
      cleanupBootstrap: () => cleanup.run(),
      quit: () => { quitCount += 1; },
      onError: () => { reported += 1; }
    });

    const quitting = coordinator?.handle({ preventDefault: () => undefined });
    await Promise.resolve();
    expect(order).toEqual(['explorer:start']);
    resumeInitialization();
    await startup;
    expect(quitCount).toBe(0);
    finishExplorer();
    await settingsCleaned;

    expect(order).toEqual([
      'explorer:start',
      'explorer:end',
      'timer',
      'probe',
      'settings'
    ]);
    expect(quitCount).toBe(0);
    await expect(quitting).resolves.toBeUndefined();
    expect(reported).toBe(1);
    expect(quitCount).toBe(1);
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

  test('角色 Store 提交后仍等待延迟 Behavior runtime 加载完成再释放 blocker', async () => {
    const module = await loadLifecycle();
    let finishBehavior = (): void => {};
    const behaviorPending = new Promise<void>(resolve => { finishBehavior = resolve; });
    const order: string[] = [];
    let runtime = 'old';
    const coordinator = module?.createCharacterActivationCoordinator?.({
      activateInStore: async () => { order.push('store'); },
      reloadBehavior: async () => {
        order.push('behavior:start');
        await behaviorPending;
        runtime = 'new';
        order.push('behavior:end');
      }
    });

    const switching = coordinator?.activate('nova');
    await Promise.resolve();
    expect(order).toEqual(['store', 'behavior:start']);
    expect(runtime).toBe('old');
    expect(coordinator?.current()).toBe(true);
    finishBehavior();
    await switching;

    expect(runtime).toBe('new');
    expect(order).toEqual(['store', 'behavior:start', 'behavior:end']);
    expect(coordinator?.current()).toBe(false);
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
