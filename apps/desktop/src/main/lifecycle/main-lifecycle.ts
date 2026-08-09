/** 多个状态变化共用串行刷新，避免旧构建结果覆盖新菜单。 */
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

interface ExplorerLifecyclePort {
  start(): Promise<void>;
  startObserving(): Promise<{ ok: true }>;
  stopObserving(): Promise<{ ok: true }>;
  close(): Promise<void>;
}

/** 每次启动真实桥接进程前重新验证固定资源，避免复用过期结论。 */
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

/** 启动事务持续接管迟到资源，封口后按严格逆序释放。 */
export function createStartupCleanupStack(): {
  add(cleanup: () => Promise<void> | void): void;
  run(): Promise<void>;
  dismiss(): void;
  seal(): void;
} {
  const cleanups: Array<() => Promise<void> | void> = [];
  let dismissed = false;
  let sealed = false;
  let wake: (() => void) | undefined;
  let runPromise: Promise<void> | undefined;
  const signal = (): void => {
    wake?.();
    wake = undefined;
  };
  return {
    add(cleanup): void {
      if (dismissed || sealed) return;
      cleanups.push(cleanup);
      signal();
    },
    run(): Promise<void> {
      if (runPromise) return runPromise;
      runPromise = (async () => {
        if (dismissed) return;
        const errors: unknown[] = [];
        while (!dismissed) {
          const cleanup = cleanups.pop();
          if (!cleanup) {
            if (sealed) break;
            await new Promise<void>(resolve => { wake = resolve; });
            continue;
          }
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
      signal();
    },
    seal(): void {
      sealed = true;
      signal();
    }
  };
}

/** 启动期和正常期共用退出入口，确保关闭事务与 app.quit 各执行一次。 */
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
      try { options.onError?.(error); } catch { /* 日志失败不能阻止退出。 */ }
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

/** 关闭顺序是资源依赖的一部分；单点失败只记录，不阻断后续释放。 */
export function createMainShutdownTransaction(options: {
  coordinator: { close(): Promise<void> };
  bridge: { close(): Promise<void> };
  position: { freezeAndFlush(): Promise<void> };
  services: ReadonlyArray<() => Promise<void> | void>;
}): () => Promise<void> {
  let active: Promise<void> | undefined;
  const runSafely = async (
    operation: () => Promise<void> | void,
    errors: unknown[]
  ): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      errors.push(error);
    }
  };
  return (): Promise<void> => {
    active ??= (async () => {
      const errors: unknown[] = [];
      await runSafely(() => options.coordinator.close(), errors);
      await runSafely(() => options.bridge.close(), errors);
      await runSafely(() => options.position.freezeAndFlush(), errors);
      for (const service of options.services) await runSafely(service, errors);
      if (errors.length > 0) {
        throw new AggregateError(errors, 'APPLICATION_SHUTDOWN_INCOMPLETE');
      }
    })();
    return active;
  };
}

/** 用计数器收敛重叠异步活动，失败也会可靠释放活动标记。 */
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

/** 角色提交与运行时加载属于同一切换事务。 */
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
