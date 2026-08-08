import type { TaskEvent } from '@myself/shared-types';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { HabitatService, type HabitatBlockerSnapshot } from '../src/main/habitat/habitat-service';
import type { ExplorerSnapshot } from '../src/main/habitat/explorer-space-protocol';
import type { FolderIdentityResolution } from '../src/main/habitat/folder-identity-resolver';
import type {
  HabitatDirectoryAvailability,
  HabitatDirectoryRecord,
  PetHabitatSnapshot
} from '../src/main/habitat/pet-habitat-store';

const DESKTOP_POSITION = { x: 120, y: 240 };
const LOCAL_OFFSET = { x: 18, y: 26 };

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function desktopSnapshot(): PetHabitatSnapshot {
  return {
    version: 1,
    preferences: { autoHideEnabled: true, idleDelayMs: 30_000 },
    directories: [{
      id: 'directory-1',
      displayName: 'Project',
      pathHint: 'Project',
      absolutePath: 'C:\\Users\\pet\\Project',
      identity: { dev: 7, ino: 11 },
      enabled: true
    }],
    location: { kind: 'desktop', position: DESKTOP_POSITION }
  };
}

function folderSnapshot(): PetHabitatSnapshot {
  return {
    ...desktopSnapshot(),
    location: {
      kind: 'folder',
      directoryId: 'directory-1',
      enteredAt: '2026-08-08T00:00:00.000Z',
      previousDesktopPosition: DESKTOP_POSITION,
      localOffset: LOCAL_OFFSET
    }
  };
}

function readySnapshot(input: {
  sequence?: number;
  instanceId?: string;
  hwnd?: string;
  path?: string;
} = {}): ExplorerSnapshot {
  return {
    version: 1,
    type: 'explorer-snapshot',
    nonce: 'a'.repeat(32),
    sequence: input.sequence ?? 10,
    status: 'ready',
    windowType: 'explorer',
    instanceId: input.instanceId ?? 'instance-current',
    hwnd: input.hwnd ?? '101',
    path: input.path ?? 'C:\\Users\\pet\\Project',
    rect: { x: 0, y: 0, width: 800, height: 600 },
    foreground: true,
    minimized: false,
    search: false
  };
}

const CLEAR_BLOCKERS: HabitatBlockerSnapshot = {
  fileTaskActive: false,
  characterSwitching: false,
  dragging: false,
  chatInteracting: false,
  appQuitting: false,
  foregroundFullscreen: false,
  proactivityMode: 'autonomous'
};

function createHarness(input: {
  initialSnapshot?: PetHabitatSnapshot;
  blockers?: Partial<HabitatBlockerSnapshot>;
  now?: () => number;
} = {}) {
  let persisted = structuredClone(input.initialSnapshot ?? desktopSnapshot());
  const order: string[] = [];
  const store = {
    load: vi.fn(async () => structuredClone(persisted)),
    save: vi.fn(async (next: PetHabitatSnapshot) => {
      order.push(`save:${next.location.kind}`);
      persisted = structuredClone(next);
    })
  };
  const directoryPolicy = {
    availability: vi.fn<
      (directory: HabitatDirectoryRecord) => Promise<HabitatDirectoryAvailability>
    >(async () => 'available')
  };
  const identityResolver = {
    resolve: vi.fn<(candidatePath: string) => Promise<FolderIdentityResolution>>(
      async () => ({ status: 'matched', directoryId: 'directory-1' })
    )
  };
  const explorer = {
    start: vi.fn(async () => undefined),
    startObserving: vi.fn(async () => {
      order.push('start-observing');
      return { ok: true as const };
    }),
    stopObserving: vi.fn(async () => {
      order.push('stop-observing');
      return { ok: true as const };
    })
  };
  const layer = {
    activate: vi.fn(async ({ explorerHwnd }: { explorerHwnd: string }) => {
      order.push(`activate:${explorerHwnd}`);
    }),
    invalidate: vi.fn(async (reason: string) => {
      order.push(`invalidate:${reason}`);
    })
  };
  const petWindow = {
    getPosition: vi.fn(() => ({ ...DESKTOP_POSITION })),
    getLocalOffset: vi.fn(() => ({ ...LOCAL_OFFSET })),
    setPosition: vi.fn((x: number, y: number) => {
      order.push(`position:${x},${y}`);
    }),
    hide: vi.fn(() => {
      order.push('hide');
    }),
    show: vi.fn(() => {
      order.push('show');
    }),
    focus: vi.fn(() => {
      order.push('focus');
    })
  };
  const openDirectory = vi.fn(async (path: string) => {
    order.push(`open:${path}`);
  });
  const blockers = { ...CLEAR_BLOCKERS, ...input.blockers };
  const service = new HabitatService({
    initialSnapshot: structuredClone(persisted),
    store,
    directoryPolicy,
    identityResolver,
    explorer,
    layer,
    petWindow,
    openDirectory,
    readBlockers: () => ({ ...blockers }),
    now: input.now ?? (() => Date.parse('2026-08-08T01:02:03.000Z'))
  });
  return {
    service,
    store,
    directoryPolicy,
    identityResolver,
    explorer,
    layer,
    petWindow,
    openDirectory,
    blockers,
    order,
    persisted: () => structuredClone(persisted),
    replacePersisted: (next: PetHabitatSnapshot) => {
      persisted = structuredClone(next);
    }
  };
}

async function reveal(harness: ReturnType<typeof createHarness>): Promise<void> {
  await harness.service.observeExplorer(readySnapshot());
  expect(harness.service.snapshot().state).toBe('folder-visible');
  harness.order.length = 0;
  vi.clearAllMocks();
}

describe('HabitatService 权威状态机', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test('从稳定持久化快照恢复 desktop 或 folder-hidden，不恢复过渡态', () => {
    expect(createHarness().service.snapshot()).toMatchObject({
      state: 'desktop', directoryId: null, operation: null, closed: false
    });
    expect(createHarness({ initialSnapshot: folderSnapshot() }).service.snapshot()).toMatchObject({
      state: 'folder-hidden', directoryId: 'directory-1', operation: null, closed: false
    });
  });

  test('enter 重新验证身份与阻塞条件，先保存稳定 folder 再隐藏并启动观察', async () => {
    const harness = createHarness();

    const result = await harness.service.enterDirectory('directory-1', 'manual');

    expect(result.state).toBe('folder-hidden');
    expect(harness.directoryPolicy.availability).toHaveBeenCalledOnce();
    expect(harness.persisted().location).toEqual({
      kind: 'folder',
      directoryId: 'directory-1',
      enteredAt: '2026-08-08T01:02:03.000Z',
      previousDesktopPosition: DESKTOP_POSITION,
      localOffset: LOCAL_OFFSET
    });
    expect(harness.order).toEqual([
      'save:folder', 'hide', 'invalidate:leave', 'start-observing'
    ]);
  });

  test.each([
    ['文件任务事务', { fileTaskActive: true }],
    ['角色切换', { characterSwitching: true }],
    ['用户拖拽', { dragging: true }],
    ['聊天窗口交互', { chatInteracting: true }],
    ['应用退出', { appQuitting: true }],
    ['前台全屏', { foregroundFullscreen: true }]
  ] as const)('%s 阻止 enter 且不写状态或隐藏窗口', async (_name, blocker) => {
    const harness = createHarness({ blockers: blocker });

    await expect(harness.service.enterDirectory('directory-1', 'manual'))
      .rejects.toThrow('HABITAT_ENTRY_BLOCKED');

    expect(harness.store.save).not.toHaveBeenCalled();
    expect(harness.petWindow.hide).not.toHaveBeenCalled();
    expect(harness.service.snapshot().state).toBe('desktop');
  });

  test.each(['listening', 'thinking', 'awaiting_confirmation', 'acting'] as const)(
    'Agent %s 阶段阻止 enter，idle 后解除阻塞',
    async phase => {
      const harness = createHarness();
      await harness.service.handleTaskEvent({ type: 'phase', phase } as TaskEvent);
      await expect(harness.service.enterDirectory('directory-1', 'manual'))
        .rejects.toThrow('HABITAT_ENTRY_BLOCKED');

      await harness.service.handleTaskEvent({ type: 'phase', phase: 'idle' });
      await expect(harness.service.enterDirectory('directory-1', 'manual')).resolves.toMatchObject({
        state: 'folder-hidden'
      });
    }
  );

  test.each(['passive', 'assistive'] as const)(
    '自动 enter 在 %s 主动性模式失败关闭，手动 enter 不受此项限制',
    async proactivityMode => {
      const automatic = createHarness({ blockers: { proactivityMode } });
      await expect(automatic.service.enterDirectory('directory-1', 'automatic'))
        .rejects.toThrow('HABITAT_AUTOMATION_BLOCKED');
      expect(automatic.store.save).not.toHaveBeenCalled();

      const manual = createHarness({ blockers: { proactivityMode } });
      await expect(manual.service.enterDirectory('directory-1', 'manual')).resolves.toMatchObject({
        state: 'folder-hidden'
      });
    }
  );

  test('目录缺失、停用、身份不可用或持久化失败均不会产生伪藏身事实', async () => {
    const missing = createHarness();
    await expect(missing.service.enterDirectory('directory-missing', 'manual'))
      .rejects.toThrow('HABITAT_DIRECTORY_NOT_FOUND');
    expect(missing.petWindow.hide).not.toHaveBeenCalled();

    const disabledSnapshot = desktopSnapshot();
    disabledSnapshot.directories[0]!.enabled = false;
    const disabled = createHarness({ initialSnapshot: disabledSnapshot });
    await expect(disabled.service.enterDirectory('directory-1', 'manual'))
      .rejects.toThrow('HABITAT_DIRECTORY_NOT_FOUND');

    const unavailable = createHarness();
    unavailable.directoryPolicy.availability.mockResolvedValue('unavailable');
    await expect(unavailable.service.enterDirectory('directory-1', 'manual'))
      .rejects.toThrow('HABITAT_DIRECTORY_UNAVAILABLE');
    expect(unavailable.store.save).not.toHaveBeenCalled();

    const failedStore = createHarness();
    failedStore.store.save.mockRejectedValueOnce(new Error('HABITAT_STORAGE_FAILED'));
    await expect(failedStore.service.enterDirectory('directory-1', 'manual'))
      .rejects.toThrow('HABITAT_STORAGE_FAILED');
    expect(failedStore.petWindow.hide).not.toHaveBeenCalled();
    expect(failedStore.service.snapshot().state).toBe('desktop');
  });

  test('enter 观察启动失败时保持稳定 folder 持久化并收敛为 folder-lost 隐藏态', async () => {
    const harness = createHarness();
    harness.explorer.startObserving.mockRejectedValueOnce(new Error('BRIDGE_NOT_READY'));

    await expect(harness.service.enterDirectory('directory-1', 'manual'))
      .rejects.toThrow('HABITAT_OBSERVER_FAILED');

    expect(harness.persisted().location.kind).toBe('folder');
    expect(harness.service.snapshot()).toMatchObject({
      state: 'folder-lost', directoryId: 'directory-1', errorCode: 'HABITAT_OBSERVER_FAILED'
    });
    expect(harness.order).toEqual([
      'save:folder', 'hide', 'invalidate:leave', 'hide', 'invalidate:explorer-closed'
    ]);
  });

  test('同一 enter 重复命令复用当前结果且只写一次，不同操作并发被拒绝', async () => {
    const harness = createHarness();
    const gate = deferred<'available'>();
    harness.directoryPolicy.availability.mockReturnValueOnce(gate.promise);

    const first = harness.service.enterDirectory('directory-1', 'manual');
    const duplicate = harness.service.enterDirectory('directory-1', 'manual');
    await expect(harness.service.recallToDesktop()).rejects.toThrow('HABITAT_OPERATION_BUSY');
    gate.resolve('available');

    const [left, right] = await Promise.all([first, duplicate]);
    expect(left).toEqual(right);
    expect(harness.directoryPolicy.availability).toHaveBeenCalledOnce();
    expect(harness.store.save).toHaveBeenCalledOnce();

    await harness.service.enterDirectory('directory-1', 'manual');
    expect(harness.store.save).toHaveBeenCalledOnce();
  });

  test('manual recall 不检查任何阻塞或目录可用性，并先保存 desktop 再恢复坐标与显示', async () => {
    const harness = createHarness({
      initialSnapshot: folderSnapshot(),
      blockers: {
        fileTaskActive: true,
        characterSwitching: true,
        dragging: true,
        chatInteracting: true,
        appQuitting: true,
        foregroundFullscreen: true,
        proactivityMode: 'passive'
      }
    });
    harness.directoryPolicy.availability.mockResolvedValue('unavailable');

    const result = await harness.service.recallToDesktop();

    expect(result.state).toBe('desktop');
    expect(harness.directoryPolicy.availability).not.toHaveBeenCalled();
    expect(harness.persisted().location).toEqual({
      kind: 'desktop', position: DESKTOP_POSITION
    });
    expect(harness.order).toEqual([
      'save:desktop', 'stop-observing', 'hide', 'invalidate:leave',
      'position:120,240', 'show'
    ]);
  });

  test('重复 recall 返回当前 desktop 结果，不重复写状态或恢复坐标', async () => {
    const harness = createHarness({ initialSnapshot: folderSnapshot() });
    const gate = deferred<void>();
    harness.store.save.mockImplementationOnce(async (next: PetHabitatSnapshot) => {
      harness.order.push(`save:${next.location.kind}`);
      await gate.promise;
    });

    const first = harness.service.recallToDesktop();
    const duplicate = harness.service.recallToDesktop();
    gate.resolve();
    await Promise.all([first, duplicate]);
    expect(harness.store.save).toHaveBeenCalledOnce();

    await harness.service.recallToDesktop();
    expect(harness.store.save).toHaveBeenCalledOnce();
    expect(harness.petWindow.setPosition).toHaveBeenCalledOnce();
  });

  test('recall 持久化失败时不移动或显示，并恢复原稳定状态', async () => {
    const harness = createHarness({ initialSnapshot: folderSnapshot() });
    harness.store.save.mockRejectedValueOnce(new Error('HABITAT_STORAGE_FAILED'));

    await expect(harness.service.recallToDesktop()).rejects.toThrow('HABITAT_STORAGE_FAILED');

    expect(harness.petWindow.setPosition).not.toHaveBeenCalled();
    expect(harness.petWindow.show).not.toHaveBeenCalled();
    expect(harness.service.snapshot().state).toBe('folder-hidden');
  });

  test('recall 基于 Store 最新快照只替换 location，不覆盖并发偏好与目录停用', async () => {
    const harness = createHarness({ initialSnapshot: folderSnapshot() });
    const concurrent = folderSnapshot();
    concurrent.preferences.autoHideEnabled = false;
    concurrent.directories[0]!.enabled = false;
    harness.replacePersisted(concurrent);

    await harness.service.recallToDesktop();

    expect(harness.persisted()).toMatchObject({
      preferences: { autoHideEnabled: false },
      directories: [{ id: 'directory-1', enabled: false }],
      location: { kind: 'desktop', position: DESKTOP_POSITION }
    });
  });

  test('observeExplorer 只让当前 revision 与实例的身份解析结果恢复可见', async () => {
    const harness = createHarness({ initialSnapshot: folderSnapshot() });
    const oldResolution = deferred<{ status: 'matched'; directoryId: string }>();
    const currentResolution = deferred<{ status: 'matched'; directoryId: string }>();
    harness.identityResolver.resolve
      .mockReturnValueOnce(oldResolution.promise)
      .mockReturnValueOnce(currentResolution.promise);

    const oldObservation = harness.service.observeExplorer(readySnapshot({
      sequence: 10, instanceId: 'instance-old', hwnd: '101', path: 'C:\\old'
    }));
    const currentObservation = harness.service.observeExplorer(readySnapshot({
      sequence: 1, instanceId: 'instance-current', hwnd: '202', path: 'C:\\current'
    }));
    oldResolution.resolve({ status: 'matched', directoryId: 'directory-1' });
    await oldObservation;
    expect(harness.layer.activate).not.toHaveBeenCalled();
    expect(harness.petWindow.show).not.toHaveBeenCalled();

    currentResolution.resolve({ status: 'matched', directoryId: 'directory-1' });
    await currentObservation;
    expect(harness.order.slice(-2)).toEqual(['activate:202', 'show']);
    expect(harness.service.snapshot().state).toBe('folder-visible');
  });

  test('activate 等待期间到达的新快照会撤销旧 reveal，旧窗口不得迟到 show', async () => {
    const harness = createHarness({ initialSnapshot: folderSnapshot() });
    const activation = deferred<void>();
    harness.layer.activate.mockReturnValueOnce(activation.promise);

    const revealing = harness.service.observeExplorer(readySnapshot({ sequence: 10 }));
    await vi.waitFor(() => expect(harness.service.snapshot().state).toBe('revealing'));
    await harness.service.observeExplorer({
      version: 1,
      type: 'explorer-snapshot',
      nonce: 'a'.repeat(32),
      sequence: 11,
      status: 'ambiguous'
    });
    activation.resolve();
    await revealing;

    expect(harness.petWindow.show).not.toHaveBeenCalled();
    expect(harness.service.snapshot().state).toBe('folder-hidden');
  });

  test('同一 Explorer 快照只采样一次时钟，跨毫秒处理不得把候选误判为未来事件', async () => {
    let now = 1_000;
    const harness = createHarness({
      initialSnapshot: folderSnapshot(),
      now: () => now++
    });

    await harness.service.observeExplorer(readySnapshot());

    expect(harness.service.snapshot().state).toBe('folder-visible');
    expect(harness.petWindow.show).toHaveBeenCalledOnce();
  });

  test('错误目录匹配不能显示，异常、失焦和不确定观察均先 hide 再 invalidate 且不清 folder', async () => {
    const harness = createHarness({ initialSnapshot: folderSnapshot() });
    harness.identityResolver.resolve.mockResolvedValueOnce({
      status: 'matched', directoryId: 'directory-2'
    });
    await harness.service.observeExplorer(readySnapshot());
    expect(harness.petWindow.show).not.toHaveBeenCalled();

    for (const snapshot of [
      {
        version: 1, type: 'explorer-snapshot', nonce: 'a'.repeat(32),
        sequence: 11, status: 'none'
      },
      {
        version: 1, type: 'explorer-snapshot', nonce: 'a'.repeat(32),
        sequence: 12, status: 'ambiguous'
      },
      new Error('BRIDGE_PROCESS_EXITED')
    ] as const) {
      harness.order.length = 0;
      await harness.service.observeExplorer(snapshot);
      expect(harness.order[0]).toBe('hide');
      expect(harness.order[1]).toMatch(/^invalidate:/u);
      expect(harness.persisted().location.kind).toBe('folder');
      expect(harness.store.save).not.toHaveBeenCalled();
    }
  });

  test('观察不可用或目录复核不可用时进入 folder-lost，恢复可用后回到隐藏观察态', async () => {
    const observed = createHarness({ initialSnapshot: folderSnapshot() });
    await observed.service.observeExplorer({
      version: 1,
      type: 'explorer-snapshot',
      nonce: 'a'.repeat(32),
      sequence: 11,
      status: 'unavailable'
    });
    expect(observed.service.snapshot().state).toBe('folder-lost');

    const checked = createHarness({ initialSnapshot: folderSnapshot() });
    checked.directoryPolicy.availability.mockResolvedValueOnce('unavailable');
    await checked.service.handleDirectoryAvailability();
    expect(checked.service.snapshot().state).toBe('folder-lost');
    expect(checked.persisted().location.kind).toBe('folder');

    checked.directoryPolicy.availability.mockResolvedValueOnce('available');
    await checked.service.handleDirectoryAvailability();
    expect(checked.service.snapshot().state).toBe('folder-hidden');
    expect(checked.explorer.startObserving).toHaveBeenCalledOnce();
  });

  test('阻塞任务事件与用户交互立即把可见目录收敛为隐藏态', async () => {
    const taskHarness = createHarness({ initialSnapshot: folderSnapshot() });
    await reveal(taskHarness);
    await taskHarness.service.handleTaskEvent({ type: 'phase', phase: 'thinking' });
    expect(taskHarness.order.slice(0, 2)).toEqual(['hide', 'invalidate:leave']);
    expect(taskHarness.service.snapshot().state).toBe('folder-hidden');

    const interactionHarness = createHarness({ initialSnapshot: folderSnapshot() });
    await reveal(interactionHarness);
    await interactionHarness.service.handleUserInteraction();
    expect(interactionHarness.order.slice(0, 2)).toEqual(['hide', 'invalidate:leave']);
    expect(interactionHarness.service.snapshot().state).toBe('folder-hidden');
  });

  test('summon 在 desktop 显示并聚焦，在目录状态打开私有路径并确保观察，不写状态', async () => {
    const desktop = createHarness();
    await desktop.service.summon();
    expect(desktop.order).toEqual(['show', 'focus']);
    expect(desktop.store.save).not.toHaveBeenCalled();

    const folder = createHarness({ initialSnapshot: folderSnapshot() });
    await folder.service.summon();
    expect(folder.order).toEqual([
      'open:C:\\Users\\pet\\Project', 'start-observing'
    ]);
    expect(folder.store.save).not.toHaveBeenCalled();
  });

  test('close 按停止观察、hide、invalidate 顺序幂等关闭，并阻止未完成 reveal 显示', async () => {
    const harness = createHarness({ initialSnapshot: folderSnapshot() });
    const resolution = deferred<{ status: 'matched'; directoryId: string }>();
    harness.identityResolver.resolve.mockReturnValueOnce(resolution.promise);
    const pendingReveal = harness.service.observeExplorer(readySnapshot());
    harness.order.length = 0;

    const firstClose = harness.service.close();
    const duplicateClose = harness.service.close();
    expect(duplicateClose).toBe(firstClose);
    await firstClose;

    expect(harness.order).toEqual([
      'stop-observing', 'hide', 'invalidate:leave'
    ]);
    resolution.resolve({ status: 'matched', directoryId: 'directory-1' });
    await pendingReveal;
    expect(harness.petWindow.show).not.toHaveBeenCalled();
    expect(harness.service.snapshot().closed).toBe(true);
    await expect(harness.service.summon()).rejects.toThrow('HABITAT_CLOSED');
  });

  test('close 完成隐藏与失效后等待在途 enter 稳定写收敛，不在退出链后继续持久化', async () => {
    const harness = createHarness();
    const saveGate = deferred<void>();
    harness.store.save.mockImplementationOnce(async () => {
      harness.order.push('save:folder');
      await saveGate.promise;
    });
    const entering = harness.service.enterDirectory('directory-1', 'manual');
    await vi.waitFor(() => expect(harness.store.save).toHaveBeenCalledOnce());

    let closeSettled = false;
    const closing = harness.service.close().then(() => {
      closeSettled = true;
    });
    await vi.waitFor(() => expect(harness.layer.invalidate).toHaveBeenCalledOnce());
    expect(closeSettled).toBe(false);
    expect(harness.order.slice(-3)).toEqual([
      'stop-observing', 'hide', 'invalidate:leave'
    ]);

    saveGate.resolve();
    await expect(entering).rejects.toThrow('HABITAT_CLOSED');
    await closing;
    expect(closeSettled).toBe(true);
    expect(harness.explorer.startObserving).not.toHaveBeenCalled();
  });
});
