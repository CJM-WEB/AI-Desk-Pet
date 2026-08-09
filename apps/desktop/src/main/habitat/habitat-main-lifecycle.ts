import type { ForegroundFullscreenProbe } from './foreground-fullscreen-probe';

type StableHabitatState = 'desktop' | 'folder-hidden' | 'folder-visible' | 'folder-lost';

interface VisibilityWindow {
  isVisible(): boolean;
  hide(): void;
  show(): void;
}

/** 自动藏身按资格懒采样；未完成、关闭或失败的探针一律保持阻止状态。 */
export function createForegroundFullscreenBlocker(
  probe: ForegroundFullscreenProbe,
  options: { now(): number; ttlMs: number } = { now: Date.now, ttlMs: 2_000 }
): {
  sampleIfEligible(eligible: boolean): Promise<boolean>;
  current(): boolean;
  close(): Promise<void>;
} {
  let blocking = true;
  let sampledAt: number | undefined;
  let refreshing: Promise<boolean> | undefined;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  return {
    sampleIfEligible(eligible): Promise<boolean> {
      if (closed || !eligible) return Promise.resolve(true);
      const now = options.now();
      if (sampledAt !== undefined && now - sampledAt < options.ttlMs) {
        return Promise.resolve(blocking);
      }
      if (refreshing) return refreshing;
      let sampled: Promise<boolean>;
      try {
        sampled = probe.sample();
      } catch {
        sampled = Promise.resolve(true);
      }
      const current = sampled.then(
        value => (blocking = closed ? true : value),
        () => (blocking = true)
      );
      refreshing = current;
      void current.then(() => {
        if (!closed) sampledAt = options.now();
        if (refreshing === current) refreshing = undefined;
      });
      return current;
    },
    current: () => blocking,
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closed = true;
      blocking = true;
      closePromise = (async () => {
        await probe.close();
        await refreshing;
      })();
      return closePromise;
    }
  };
}

/** 先用内存事实排除不可能自动藏身的 tick，避免无意义启动平台探针。 */
export function shouldSampleForegroundFullscreen(input: {
  enabled: boolean;
  autoHideEnabled: boolean;
  proactivityMode: 'passive' | 'assistive' | 'autonomous';
  habitatState: StableHabitatState;
  hasEnabledDirectory: boolean;
  idle: boolean;
  idleDurationMs: number;
  idleDelayMs: number;
  blockers: Record<string, boolean>;
}): boolean {
  return input.enabled
    && input.autoHideEnabled
    && input.proactivityMode === 'autonomous'
    && input.habitatState === 'desktop'
    && input.hasEnabledDirectory
    && input.idle
    && input.idleDurationMs >= input.idleDelayMs
    && !Object.values(input.blockers).some(Boolean);
}

/** 桥接消费者发布前仅保留最新事实；发布后所有回放与新事件共用同一串行队列。 */
export function createExplorerObservationRelay<T>(): {
  accept(value: T): Promise<void>;
  attach(consumer: (value: T) => Promise<void>): Promise<void>;
} {
  let latest: T | undefined;
  let hasLatest = false;
  let consumer: ((value: T) => Promise<void>) | undefined;
  let queue = Promise.resolve();
  const enqueue = (value: T): Promise<void> => {
    const consume = consumer;
    if (!consume) return Promise.resolve();
    const run = queue.then(() => consume(value));
    queue = run.catch(() => undefined);
    return run;
  };
  return {
    accept(value: T): Promise<void> {
      latest = value;
      hasLatest = true;
      return enqueue(value);
    },
    attach(nextConsumer: (value: T) => Promise<void>): Promise<void> {
      consumer = nextConsumer;
      return hasLatest ? enqueue(latest as T) : Promise.resolve();
    }
  };
}

/** 所有启动期显示请求先进入门控，ready 后才依据稳定状态触碰窗口可见性。 */
export function createStartupVisibilityGate(options: {
  window: VisibilityWindow;
  readState(): StableHabitatState;
}): { show(): void; hide(): void; toggle(): void; markReady(): void } {
  let ready = false;
  let intent: 'show' | 'hide' | undefined;
  const canShow = (): boolean => {
    const state = options.readState();
    return state === 'desktop' || state === 'folder-visible';
  };
  return {
    show(): void {
      if (!ready) {
        intent = 'show';
        return;
      }
      if (canShow()) options.window.show();
      else options.window.hide();
    },
    hide(): void {
      if (!ready) {
        intent = 'hide';
        return;
      }
      options.window.hide();
    },
    toggle(): void {
      if (!ready) {
        intent = intent === 'show' ? 'hide' : 'show';
        return;
      }
      if (!canShow() || options.window.isVisible()) options.window.hide();
      else options.window.show();
    },
    markReady(): void {
      if (ready) return;
      ready = true;
      if (canShow() && intent !== 'hide') options.window.show();
      else options.window.hide();
    }
  };
}

/** 托盘项可能已陈旧，执行时必须读取当前稳定状态而不是复用构建期快照。 */
export function createStateGuardedPetVisibilityCommand(options: {
  window: VisibilityWindow;
  readState(): StableHabitatState;
}): () => void {
  return () => {
    if (options.readState() !== 'desktop') {
      options.window.hide();
      return;
    }
    if (options.window.isVisible()) options.window.hide();
    else options.window.show();
  };
}

/** 多个状态变化共用串行刷新，后发生的构建结果不会被旧 Promise 覆盖。 */
export function createTrayRefreshController<T>(options: {
  build(): Promise<T>;
  publish(value: T): void;
}): { refresh(): Promise<void> } {
  let queue = Promise.resolve();
  return {
    refresh(): Promise<void> {
      const run = queue.then(async () => options.publish(await options.build()));
      queue = run.catch(() => undefined);
      return run;
    }
  };
}

export async function refreshAfter<T>(
  operation: () => Promise<T>,
  refresh: () => Promise<void>
): Promise<T> {
  let result: T;
  try {
    result = await operation();
  } catch (error) {
    await refresh().catch(() => undefined);
    throw error;
  }
  await refresh();
  return result;
}

interface ExplorerLifecyclePort {
  start(): Promise<void>;
  startObserving(): Promise<{ ok: true }>;
  stopObserving(): Promise<{ ok: true }>;
  close(): Promise<void>;
}

/** 每个真实 spawn 尝试都先重新校验固定资源，不缓存启动时结论。 */
export function createIntegrityCheckedExplorerPort(options: {
  verify(): Promise<void>;
  explorer: ExplorerLifecyclePort;
}): ExplorerLifecyclePort {
  return {
    async start(): Promise<void> {
      await options.verify();
      await options.explorer.start();
    },
    startObserving: () => options.explorer.startObserving(),
    stopObserving: () => options.explorer.stopObserving(),
    close: () => options.explorer.close()
  };
}

/** 启动事务按资源创建逆序释放；单点失败不短路，其结果保持幂等。 */
export function createStartupCleanupStack(): {
  add(cleanup: () => Promise<void> | void): void;
  run(): Promise<void>;
  dismiss(): void;
} {
  const cleanups: Array<() => Promise<void> | void> = [];
  let dismissed = false;
  let runPromise: Promise<void> | undefined;
  return {
    add(cleanup): void {
      if (!dismissed && runPromise === undefined) cleanups.push(cleanup);
    },
    run(): Promise<void> {
      if (runPromise) return runPromise;
      runPromise = (async () => {
        if (dismissed) return;
        const errors: unknown[] = [];
        for (const cleanup of cleanups.reverse()) {
          try {
            await cleanup();
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length > 0) {
          throw new AggregateError(errors, 'STARTUP_CLEANUP_INCOMPLETE');
        }
      })();
      return runPromise;
    },
    dismiss(): void {
      dismissed = true;
      cleanups.length = 0;
    }
  };
}

/** 启动期与正常期共用一个退出入口；启动清理开始后禁止再切回完整关闭事务。 */
export function createApplicationQuitCoordinator(options: {
  cleanupBootstrap(): Promise<void>;
  quit(): void;
  onError?(error: unknown): void;
}): {
  handle(event: { preventDefault(): void }): Promise<void>;
  activateNormal(shutdown: () => Promise<void>): boolean;
  exitAfterStartupFailure(): Promise<void>;
  quitRequested(): boolean;
} {
  let phase: 'bootstrap' | 'normal' | 'exiting' = 'bootstrap';
  let normalShutdown: (() => Promise<void>) | undefined;
  let active: Promise<void> | undefined;
  let quitIssued = false;
  const finish = async (shutdown: () => Promise<void>): Promise<void> => {
    try {
      await shutdown();
    } catch (error) {
      try { options.onError?.(error); } catch { /* 退出不能被日志端口阻断。 */ }
    }
    phase = 'exiting';
    if (!quitIssued) {
      quitIssued = true;
      options.quit();
    }
  };
  const start = (shutdown: () => Promise<void>): Promise<void> => {
    active ??= finish(shutdown);
    return active;
  };
  return {
    handle(event): Promise<void> {
      if (phase === 'exiting') return Promise.resolve();
      event.preventDefault();
      return start(phase === 'normal' && normalShutdown
        ? normalShutdown
        : options.cleanupBootstrap);
    },
    activateNormal(shutdown): boolean {
      if (phase !== 'bootstrap' || active) return false;
      normalShutdown = shutdown;
      phase = 'normal';
      return true;
    },
    exitAfterStartupFailure: () => start(options.cleanupBootstrap),
    quitRequested: () => active !== undefined || phase === 'exiting'
  };
}

/** 重叠异步活动以计数器收敛，任一失败也不会留下永久 blocker。 */
export function createAsyncActivityBlocker(): {
  run<T>(operation: () => Promise<T>): Promise<T>;
  current(): boolean;
} {
  let active = 0;
  return {
    async run<T>(operation: () => Promise<T>): Promise<T> {
      active += 1;
      try {
        return await operation();
      } finally {
        active -= 1;
      }
    },
    current: () => active > 0
  };
}

/** 角色提交与运行时加载属于同一切换事务，自动藏身只能在两者都结束后继续。 */
export function createCharacterActivationCoordinator(options: {
  activateInStore(characterId: string, confirmIncomplete?: boolean): Promise<void>;
  reloadBehavior(): Promise<void>;
}): {
  activate(characterId: string, confirmIncomplete?: boolean): Promise<void>;
  current(): boolean;
} {
  const activity = createAsyncActivityBlocker();
  return {
    activate: (characterId, confirmIncomplete) => activity.run(async () => {
      await options.activateInStore(characterId, confirmIncomplete);
      await options.reloadBehavior();
    }),
    current: activity.current
  };
}

/** Electron void 事件边界吞掉私有拒绝，只上报固定公开错误码。 */
export async function runMainEventSafely(
  operation: () => Promise<void>,
  report: (code: 'HABITAT_EVENT_FAILED') => void
): Promise<void> {
  try {
    await operation();
  } catch {
    try {
      report('HABITAT_EVENT_FAILED');
    } catch {
      // 错误上报本身不能重新制造未处理拒绝。
    }
  }
}
