import { describe, expect, test, vi } from 'vitest';

type HabitatState = 'desktop' | 'folder-hidden' | 'folder-visible' | 'folder-lost';
type HabitatSnapshot = {
  state: HabitatState;
  directoryId: string | null;
};

type DirectoryOpenRequest = {
  directory: Readonly<{
    absolutePath: string;
  }>;
  signal: AbortSignal;
};

type TrayItem = {
  label?: string;
  enabled?: boolean;
  submenu?: TrayItem[];
  click?: () => void;
};

type PetSummonModule = {
  createVerifiedDirectoryOpener(
    openPath: (absolutePath: string) => Promise<string>
  ): (request: DirectoryOpenRequest) => Promise<void>;
  createPetSummonController(options: {
    habitat: {
      snapshot(): HabitatSnapshot;
      summon(signal: AbortSignal): Promise<unknown>;
    };
    waitForExactExplorer(
      directoryId: string,
      timeoutMs: number,
      signal: AbortSignal
    ): Promise<boolean>;
    timeoutMs?: number;
  }): {
    summon(): Promise<
      | { status: 'visible' }
      | { status: 'error'; errorCode: string; canRecall: true }
    >;
  };
  buildHabitatTrayMenu(options: {
    snapshot: HabitatSnapshot;
    directories: Array<{ id: string; displayName: string; enabled: boolean }>;
    enterDirectory(directoryId: string): Promise<unknown>;
    summon(): Promise<
      | { status: 'visible' }
      | { status: 'error'; errorCode: string; canRecall: true }
    >;
    recall(): Promise<unknown>;
    togglePetVisibility(): void;
    reportError(code: string): void;
  }): TrayItem[];
};

async function loadModule(): Promise<PetSummonModule | null> {
  try {
    return await import(new URL(
      '../src/main/windows/window-commands.ts',
      import.meta.url
    ).href) as PetSummonModule;
  } catch {
    return null;
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('托盘呼唤与召回', () => {
  test('目录打开器把 Main 内部绝对路径原样交给 openPath', async () => {
    const module = await loadModule();
    expect(module, '应提供受限目录打开器').not.toBeNull();
    if (!module) return;
    const openPath = vi.fn(async () => '');
    const openDirectory = module.createVerifiedDirectoryOpener(openPath);

    const signal = new AbortController().signal;
    await openDirectory({
      directory: { absolutePath: 'C:\\Private Habitat\\Exact' },
      signal
    });

    expect(openPath).toHaveBeenCalledWith('C:\\Private Habitat\\Exact');
    expect(openPath).toHaveBeenCalledOnce();
  });

  test.each([
    ['非空返回', vi.fn(async () => 'The system cannot find the path specified.')],
    ['调用拒绝', vi.fn(async () => { throw new Error('C:\\Private\\Secret'); })]
  ])('openPath %s时只暴露稳定失败码', async (_label, openPath) => {
    const module = await loadModule();
    expect(module).not.toBeNull();
    if (!module) return;
    const openDirectory = module.createVerifiedDirectoryOpener(openPath);

    await expect(openDirectory({
      directory: { absolutePath: 'C:\\Private\\Exact' },
      signal: new AbortController().signal
    })).rejects.toMatchObject({
      message: 'HABITAT_SUMMON_FAILED'
    });
  });

  test('目录打开器收到已取消请求时不调用 openPath', async () => {
    const module = await loadModule();
    expect(module).not.toBeNull();
    if (!module) return;
    const openPath = vi.fn(async () => '');
    const openDirectory = module.createVerifiedDirectoryOpener(openPath);
    const abort = new AbortController();
    abort.abort();

    await expect(openDirectory({
      directory: { absolutePath: 'C:\\Private\\Exact' },
      signal: abort.signal
    })).rejects.toThrow('HABITAT_SUMMON_FAILED');
    expect(openPath).not.toHaveBeenCalled();
  });

  test('folder 呼唤先监听同目录准确事件，再执行打开并等待可见', async () => {
    const module = await loadModule();
    expect(module).not.toBeNull();
    if (!module) return;
    const order: string[] = [];
    const matched = deferred<boolean>();
    let state: HabitatSnapshot = {
      state: 'folder-hidden', directoryId: 'directory-exact'
    };
    const controller = module.createPetSummonController({
      habitat: {
        snapshot: () => state,
        summon: async signal => {
          expect(signal.aborted).toBe(false);
          order.push('summon');
        }
      },
      waitForExactExplorer: (directoryId, timeoutMs) => {
        order.push(`wait:${directoryId}:${timeoutMs}`);
        return matched.promise;
      }
    });

    const result = controller.summon();
    await vi.waitFor(() => expect(order).toEqual([
      'wait:directory-exact:5000', 'summon'
    ]));
    state = { state: 'folder-visible', directoryId: 'directory-exact' };
    matched.resolve(true);

    await expect(result).resolves.toEqual({ status: 'visible' });
  });

  test('固定超时后保持 folder-hidden 并提示可召回', async () => {
    vi.useFakeTimers();
    const module = await loadModule();
    expect(module).not.toBeNull();
    if (!module) {
      vi.useRealTimers();
      return;
    }
    const state: HabitatSnapshot = {
      state: 'folder-hidden', directoryId: 'directory-exact'
    };
    let aborted = false;
    const controller = module.createPetSummonController({
      habitat: {
        snapshot: () => state,
        summon: vi.fn(signal => new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('ABORTED')), { once: true });
        }))
      },
      waitForExactExplorer: vi.fn((_directoryId, _timeoutMs, signal) => (
        new Promise<boolean>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('PRIVATE_ABORT_REJECTION'));
          }, { once: true });
        })
      )),
      timeoutMs: 2_000
    });

    try {
      const result = controller.summon();
      let settled = false;
      void result.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(1_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      await expect(result).resolves.toEqual({
        status: 'error', errorCode: 'HABITAT_SUMMON_FAILED', canRecall: true
      });
      expect(aborted).toBe(true);
      expect(state).toEqual({ state: 'folder-hidden', directoryId: 'directory-exact' });
    } finally {
      vi.useRealTimers();
    }
  });

  test('总超时先取消底层 summon，并等待其取消清理收敛后才返回', async () => {
    vi.useFakeTimers();
    const module = await loadModule();
    expect(module).not.toBeNull();
    if (!module) {
      vi.useRealTimers();
      return;
    }
    const cleanup = deferred<void>();
    let aborted = false;
    const controller = module.createPetSummonController({
      habitat: {
        snapshot: () => ({ state: 'folder-hidden', directoryId: 'directory-exact' }),
        summon: signal => new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            void cleanup.promise.then(() => reject(new Error('ABORTED')));
          }, { once: true });
        })
      },
      waitForExactExplorer: (_directoryId, _timeoutMs, signal) => (
        new Promise<boolean>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('ABORTED')), { once: true });
        })
      ),
      timeoutMs: 2_000
    });

    try {
      const result = controller.summon();
      let settled = false;
      void result.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(aborted).toBe(true);
      expect(settled).toBe(false);

      cleanup.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await expect(result).resolves.toEqual({
        status: 'error', errorCode: 'HABITAT_SUMMON_FAILED', canRecall: true
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test('准确事件监听器同步失败时仍返回稳定错误并执行 abort 清理', async () => {
    const module = await loadModule();
    expect(module).not.toBeNull();
    if (!module) return;
    let aborted = false;
    const summon = vi.fn(async (_signal: AbortSignal) => undefined);
    const controller = module.createPetSummonController({
      habitat: {
        snapshot: () => ({ state: 'folder-hidden', directoryId: 'directory-exact' }),
        summon
      },
      waitForExactExplorer: (_directoryId, _timeoutMs, signal) => {
        signal.addEventListener('abort', () => { aborted = true; }, { once: true });
        throw new Error('PRIVATE_WATCHER_FAILURE');
      }
    });

    await expect(controller.summon()).resolves.toEqual({
      status: 'error', errorCode: 'HABITAT_SUMMON_FAILED', canRecall: true
    });
    expect(aborted).toBe(true);
    expect(summon).not.toHaveBeenCalled();
  });

  test('准确事件 Promise 拒绝时不等待悬挂 summon 或超时才结算', async () => {
    vi.useFakeTimers();
    const module = await loadModule();
    expect(module).not.toBeNull();
    if (!module) {
      vi.useRealTimers();
      return;
    }
    const watcher = deferred<boolean>();
    const controller = module.createPetSummonController({
      habitat: {
        snapshot: () => ({ state: 'folder-hidden', directoryId: 'directory-exact' }),
        summon: signal => new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('ABORTED')), { once: true });
        })
      },
      waitForExactExplorer: () => watcher.promise
    });

    const result = controller.summon();
    let settled = false;
    void result.then(() => { settled = true; });
    watcher.reject(new Error('PRIVATE_WATCHER_REJECTION'));
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(true);
      await expect(result).resolves.toEqual({
        status: 'error', errorCode: 'HABITAT_SUMMON_FAILED', canRecall: true
      });
    } finally {
      await vi.advanceTimersByTimeAsync(5_000);
      vi.useRealTimers();
    }
  });

  test('同名但非同 directoryId 的事件不能完成呼唤', async () => {
    const module = await loadModule();
    expect(module).not.toBeNull();
    if (!module) return;
    let state: HabitatSnapshot = {
      state: 'folder-hidden', directoryId: 'directory-exact'
    };
    const controller = module.createPetSummonController({
      habitat: {
        snapshot: () => state,
        summon: vi.fn(async (_signal: AbortSignal) => undefined)
      },
      waitForExactExplorer: vi.fn(async () => {
        state = { state: 'folder-visible', directoryId: 'same-title-other-id' };
        return true;
      })
    });

    await expect(controller.summon()).resolves.toEqual({
      status: 'error', errorCode: 'HABITAT_SUMMON_FAILED', canRecall: true
    });
  });

  test('lost 呼唤返回稳定不可用错误且不打开目录', async () => {
    const module = await loadModule();
    expect(module).not.toBeNull();
    if (!module) return;
    const summon = vi.fn(async (_signal: AbortSignal) => undefined);
    const waitForExactExplorer = vi.fn(async () => true);
    const controller = module.createPetSummonController({
      habitat: {
        snapshot: () => ({ state: 'folder-lost', directoryId: 'directory-exact' }),
        summon
      },
      waitForExactExplorer
    });

    await expect(controller.summon()).resolves.toEqual({
      status: 'error', errorCode: 'HABITAT_DIRECTORY_UNAVAILABLE', canRecall: true
    });
    expect(summon).not.toHaveBeenCalled();
    expect(waitForExactExplorer).not.toHaveBeenCalled();
  });

  test('desktop 托盘显示藏到目录子菜单和普通显示隐藏', async () => {
    const module = await loadModule();
    expect(module).not.toBeNull();
    if (!module) return;
    const enterDirectory = vi.fn(async () => undefined);
    const items = module.buildHabitatTrayMenu({
      snapshot: { state: 'desktop', directoryId: null },
      directories: [
        { id: 'enabled', displayName: '可用目录', enabled: true },
        { id: 'disabled', displayName: '停用目录', enabled: false }
      ],
      enterDirectory,
      summon: vi.fn(async () => ({ status: 'visible' as const })),
      recall: vi.fn(async () => undefined),
      togglePetVisibility: vi.fn(),
      reportError: vi.fn()
    });

    expect(items.map(item => item.label)).toEqual(['藏到目录', '显示/隐藏桌宠']);
    expect(items[0]?.submenu?.map(item => item.label)).toEqual(['可用目录']);
    items[0]?.submenu?.[0]?.click?.();
    await vi.waitFor(() => expect(enterDirectory).toHaveBeenCalledWith('enabled'));
  });

  test.each([
    ['folder-hidden', ['呼唤桌宠', '召回桌面']],
    ['folder-visible', ['呼唤桌宠', '召回桌面']],
    ['folder-lost', ['呼唤桌宠', '召回桌面']]
  ] as const)('%s 托盘只显示呼唤和召回入口', async (state, labels) => {
    const module = await loadModule();
    expect(module).not.toBeNull();
    if (!module) return;
    const summon = vi.fn(async () => ({ status: 'visible' as const }));
    const recall = vi.fn(async () => undefined);
    const reportError = vi.fn();
    const items = module.buildHabitatTrayMenu({
      snapshot: { state, directoryId: 'directory-exact' },
      directories: [],
      enterDirectory: vi.fn(async () => undefined),
      summon,
      recall,
      togglePetVisibility: vi.fn(),
      reportError
    });

    expect(items.map(item => item.label)).toEqual(labels);
    items[0]?.click?.();
    items[1]?.click?.();
    await vi.waitFor(() => expect(recall).toHaveBeenCalledOnce());
    if (state === 'folder-lost') {
      expect(summon).not.toHaveBeenCalled();
      expect(reportError).toHaveBeenCalledWith('HABITAT_DIRECTORY_UNAVAILABLE');
    } else {
      expect(summon).toHaveBeenCalledOnce();
    }
  });
});
