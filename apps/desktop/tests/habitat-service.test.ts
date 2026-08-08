import type { TaskEvent } from '@myself/shared-types';
import { describe, expect, test, vi } from 'vitest';

import {
  HabitatService,
  type ExplorerAuthoritySnapshot,
  type HabitatBlockerSnapshot
} from '../src/main/habitat/habitat-service';
import type { ExplorerSnapshot } from '../src/main/habitat/explorer-space-protocol';
import type { FolderIdentityResolution } from '../src/main/habitat/folder-identity-resolver';
import type {
  HabitatDirectoryAvailability,
  HabitatDirectoryRecord,
  HabitatLocation,
  HabitatLocationExpectation,
  HabitatLocationUpdate,
  HabitatLocationUpdateResult,
  PetHabitatSnapshot
} from '../src/main/habitat/pet-habitat-store';

const DESKTOP_POSITION = { x: 120, y: 240 };
const LOCAL_OFFSET = { x: 18, y: 26 };
const BRIDGE_NONCE = 'a'.repeat(32);

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
  nonce?: string;
  sequence?: number;
  instanceId?: string;
  hwnd?: string;
  path?: string;
} = {}): Extract<ExplorerSnapshot, { status: 'ready' }> {
  return {
    version: 1,
    type: 'explorer-snapshot',
    nonce: input.nonce ?? BRIDGE_NONCE,
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

function matchesExpected(
  location: HabitatLocation,
  expected: HabitatLocationExpectation
): boolean {
  return location.kind === expected.kind && (
    location.kind === 'desktop'
    || (expected.kind === 'folder' && location.directoryId === expected.directoryId)
  );
}

function sameTarget(left: HabitatLocation, right: HabitatLocation): boolean {
  return left.kind === right.kind && (
    left.kind === 'desktop'
    || (right.kind === 'folder' && left.directoryId === right.directoryId)
  );
}

function createHarness(input: {
  initialSnapshot?: PetHabitatSnapshot;
  blockers?: Partial<HabitatBlockerSnapshot>;
  now?: () => number;
} = {}) {
  let persisted = structuredClone(input.initialSnapshot ?? desktopSnapshot());
  const order: string[] = [];
  const blockers = { ...CLEAR_BLOCKERS, ...input.blockers };
  let authority: ExplorerAuthoritySnapshot = {
    nonce: BRIDGE_NONCE,
    revision: 10,
    instanceId: 'instance-current'
  };
  const store = {
    load: vi.fn(async () => structuredClone(persisted)),
    save: vi.fn(async (next: PetHabitatSnapshot) => {
      order.push(`legacy-save:${next.location.kind}`);
      persisted = structuredClone(next);
    }),
    updateLocation: vi.fn<(update: HabitatLocationUpdate) => Promise<HabitatLocationUpdateResult>>(
      async update => {
        order.push(`location:${update.location.kind}`);
        if (!matchesExpected(persisted.location, update.expected)) {
          return {
            status: sameTarget(persisted.location, update.location) ? 'unchanged' : 'conflict',
            snapshot: structuredClone(persisted)
          };
        }
        if (update.location.kind === 'folder') {
          const expected = update.expectedDirectory;
          const current = persisted.directories.find(directory => directory.id === expected?.id);
          if (
            expected === undefined
            || current === undefined
            || !current.enabled
            || current.identity.dev !== expected.identity.dev
            || current.identity.ino !== expected.identity.ino
            || current.absolutePath !== expected.absolutePath
          ) return { status: 'conflict', snapshot: structuredClone(persisted) };
        }
        persisted = { ...persisted, location: structuredClone(update.location) };
        return { status: 'updated', snapshot: structuredClone(persisted) };
      }
    )
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
    start: vi.fn(async () => {
      order.push('start');
    }),
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
    readExplorerAuthority: () => ({ ...authority }),
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
    },
    setAuthority: (next: ExplorerAuthoritySnapshot) => {
      authority = { ...next };
    }
  };
}

function setAuthorityFor(
  harness: ReturnType<typeof createHarness>,
  snapshot: Extract<ExplorerSnapshot, { status: 'ready' }>
): void {
  harness.setAuthority({
    nonce: snapshot.nonce,
    revision: snapshot.sequence,
    instanceId: snapshot.instanceId
  });
}

async function observeReady(
  harness: ReturnType<typeof createHarness>,
  snapshot = readySnapshot()
): Promise<void> {
  setAuthorityFor(harness, snapshot);
  await harness.service.observeExplorer(snapshot);
}

async function reveal(harness: ReturnType<typeof createHarness>): Promise<void> {
  await observeReady(harness);
  expect(harness.service.snapshot().state).toBe('folder-visible');
  harness.order.length = 0;
  vi.clearAllMocks();
}

describe('HabitatService 权威状态机', () => {
  test('只从稳定持久化快照恢复 desktop 或 folder-hidden', () => {
    expect(createHarness().service.snapshot()).toMatchObject({
      state: 'desktop', directoryId: null, operation: null, closed: false
    });
    expect(createHarness({ initialSnapshot: folderSnapshot() }).service.snapshot()).toMatchObject({
      state: 'folder-hidden', directoryId: 'directory-1', operation: null, closed: false
    });
  });

  test('enter 先复核目录与阻塞，再以条件 location 更新提交 folder，随后隐藏并观察', async () => {
    const harness = createHarness();

    await expect(harness.service.enterDirectory('directory-1', 'manual')).resolves.toMatchObject({
      state: 'folder-hidden'
    });

    expect(harness.store.save).not.toHaveBeenCalled();
    expect(harness.order).toEqual([
      'location:folder', 'hide', 'invalidate:leave', 'start', 'start-observing'
    ]);
    expect(harness.persisted().location).toEqual({
      kind: 'folder',
      directoryId: 'directory-1',
      enteredAt: '2026-08-08T01:02:03.000Z',
      previousDesktopPosition: DESKTOP_POSITION,
      localOffset: LOCAL_OFFSET
    });
  });

  test('enter 的依赖错误只暴露稳定码并恢复原稳定态', async () => {
    const harness = createHarness();
    harness.store.load.mockRejectedValueOnce(new Error('STORE_PRIVATE_PATH_C:\\secret'));

    await expect(harness.service.enterDirectory('directory-1', 'manual')).rejects.toMatchObject({
      code: 'HABITAT_STORAGE_FAILED', message: 'HABITAT_STORAGE_FAILED'
    });
    expect(harness.service.snapshot()).toMatchObject({
      state: 'desktop', directoryId: null, errorCode: 'HABITAT_STORAGE_FAILED'
    });
    expect(JSON.stringify(harness.service.snapshot())).not.toContain('PRIVATE');
  });

  test.each([
    ['文件任务', { fileTaskActive: true }],
    ['角色切换', { characterSwitching: true }],
    ['拖拽', { dragging: true }],
    ['聊天交互', { chatInteracting: true }],
    ['退出', { appQuitting: true }],
    ['全屏', { foregroundFullscreen: true }]
  ] as const)('%s 阻止 enter 且不提交 location', async (_name, blocker) => {
    const harness = createHarness({ blockers: blocker });
    await expect(harness.service.enterDirectory('directory-1', 'manual'))
      .rejects.toThrow('HABITAT_ENTRY_BLOCKED');
    expect(harness.store.updateLocation).not.toHaveBeenCalled();
  });

  test.each(['listening', 'thinking', 'awaiting_confirmation', 'acting'] as const)(
    'Agent %s 阶段阻止 enter',
    async phase => {
      const harness = createHarness();
      await harness.service.handleTaskEvent({ type: 'phase', phase } as TaskEvent);
      await expect(harness.service.enterDirectory('directory-1', 'manual'))
        .rejects.toThrow('HABITAT_ENTRY_BLOCKED');
    }
  );

  test.each(['passive', 'assistive'] as const)(
    '自动 enter 在 %s 模式失败关闭，手动 enter 不受主动性模式限制',
    async proactivityMode => {
      const automatic = createHarness({ blockers: { proactivityMode } });
      await expect(automatic.service.enterDirectory('directory-1', 'automatic'))
        .rejects.toThrow('HABITAT_AUTOMATION_BLOCKED');
      const manual = createHarness({ blockers: { proactivityMode } });
      await expect(manual.service.enterDirectory('directory-1', 'manual')).resolves.toBeDefined();
    }
  );

  test('重复 enter 在 location 已提交但 startObserving 未决时返回同一 Promise，其他命令 BUSY', async () => {
    const harness = createHarness();
    const observing = deferred<{ ok: true }>();
    harness.explorer.startObserving.mockReturnValueOnce(observing.promise);

    const first = harness.service.enterDirectory('directory-1', 'manual');
    await vi.waitFor(() => expect(harness.explorer.startObserving).toHaveBeenCalledOnce());
    const duplicate = harness.service.enterDirectory('directory-1', 'manual');
    expect(duplicate).toBe(first);
    await expect(harness.service.recallToDesktop()).rejects.toThrow('HABITAT_OPERATION_BUSY');
    await expect(harness.service.summon()).rejects.toThrow('HABITAT_OPERATION_BUSY');
    observing.resolve({ ok: true });
    await first;
    expect(harness.store.updateLocation).toHaveBeenCalledOnce();
  });

  test('enter 的 location 提交等待期间出现 thinking，提交后复核并补偿回 desktop', async () => {
    const harness = createHarness();
    const committing = deferred<void>();
    const updateLocation = harness.store.updateLocation.getMockImplementation()!;
    harness.store.updateLocation.mockImplementationOnce(async update => {
      await committing.promise;
      return updateLocation(update);
    });
    const entering = harness.service.enterDirectory('directory-1', 'manual');
    await vi.waitFor(() => expect(harness.store.updateLocation).toHaveBeenCalledOnce());
    await harness.service.handleTaskEvent({ type: 'phase', phase: 'thinking' });
    committing.resolve();

    await expect(entering).rejects.toThrow('HABITAT_ENTRY_BLOCKED');
    expect(harness.persisted().location.kind).toBe('desktop');
    expect(harness.store.updateLocation).toHaveBeenCalledTimes(2);
    expect(harness.explorer.start).not.toHaveBeenCalled();
  });

  test('enter 的 blocker 补偿写失败时采用已提交 folder authority 并隐藏', async () => {
    const harness = createHarness();
    const committing = deferred<void>();
    const updateLocation = harness.store.updateLocation.getMockImplementation()!;
    harness.store.updateLocation
      .mockImplementationOnce(async update => {
        await committing.promise;
        return updateLocation(update);
      })
      .mockRejectedValueOnce(new Error('STORE_PRIVATE_COMPENSATION'));
    const entering = harness.service.enterDirectory('directory-1', 'manual');
    await vi.waitFor(() => expect(harness.store.updateLocation).toHaveBeenCalledOnce());
    await harness.service.handleTaskEvent({ type: 'phase', phase: 'thinking' });
    committing.resolve();

    await expect(entering).rejects.toThrow('HABITAT_STORAGE_FAILED');
    expect(harness.persisted().location.kind).toBe('folder');
    expect(harness.service.snapshot()).toMatchObject({
      state: 'folder-hidden', directoryId: 'directory-1', errorCode: 'HABITAT_STORAGE_FAILED'
    });
    expect(harness.order.slice(-2)).toEqual(['hide', 'invalidate:leave']);
    expect(JSON.stringify(harness.service.snapshot())).not.toContain('PRIVATE');
  });

  test('重复 recall 在 desktop 已提交但层级恢复未决时返回同一 Promise且不重复写', async () => {
    const harness = createHarness({ initialSnapshot: folderSnapshot() });
    const invalidation = deferred<void>();
    harness.layer.invalidate.mockReturnValueOnce(invalidation.promise);

    const first = harness.service.recallToDesktop();
    await vi.waitFor(() => expect(harness.layer.invalidate).toHaveBeenCalledOnce());
    const duplicate = harness.service.recallToDesktop();
    expect(duplicate).toBe(first);
    invalidation.resolve();
    await first;
    expect(harness.store.updateLocation).toHaveBeenCalledOnce();
  });

  test('重复 summon 复用在途结果并与 enter/recall 互斥', async () => {
    const harness = createHarness({ initialSnapshot: folderSnapshot() });
    const opening = deferred<void>();
    harness.openDirectory.mockReturnValueOnce(opening.promise);

    const first = harness.service.summon();
    const duplicate = harness.service.summon();
    expect(duplicate).toBe(first);
    await expect(harness.service.recallToDesktop()).rejects.toThrow('HABITAT_OPERATION_BUSY');
    opening.resolve();
    await first;
    expect(harness.openDirectory).toHaveBeenCalledOnce();
  });

  test('recall 永不检查阻塞或目录可用性，并以 location CAS 保留最新配置', async () => {
    const harness = createHarness({
      initialSnapshot: folderSnapshot(),
      blockers: { fileTaskActive: true, appQuitting: true, proactivityMode: 'passive' }
    });
    const latest = folderSnapshot();
    latest.preferences.autoHideEnabled = false;
    latest.directories[0]!.enabled = false;
    harness.replacePersisted(latest);

    await harness.service.recallToDesktop();

    expect(harness.directoryPolicy.availability).not.toHaveBeenCalled();
    expect(harness.persisted()).toMatchObject({
      preferences: { autoHideEnabled: false },
      directories: [{ enabled: false }],
      location: { kind: 'desktop', position: DESKTOP_POSITION }
    });
    expect(harness.order).toEqual([
      'location:desktop', 'hide', 'invalidate:leave', 'position:120,240', 'show'
    ]);
  });

  test('recall desktop 提交后的层级失败留下可重试 recalling，第二次完成恢复且不重复写', async () => {
    const harness = createHarness({ initialSnapshot: folderSnapshot() });
    harness.layer.invalidate.mockRejectedValueOnce(new Error('LAYER_PRIVATE_HWND_123456'));

    await expect(harness.service.recallToDesktop()).rejects.toThrow('HABITAT_WINDOW_FAILED');
    expect(harness.service.snapshot()).toMatchObject({
      state: 'recalling', directoryId: null, errorCode: 'HABITAT_WINDOW_FAILED'
    });
    expect(harness.petWindow.setPosition).toHaveBeenCalledOnce();
    expect(harness.petWindow.show).toHaveBeenCalledOnce();

    await expect(harness.service.recallToDesktop()).resolves.toMatchObject({ state: 'desktop' });
    expect(harness.store.updateLocation).toHaveBeenCalledOnce();
    expect(JSON.stringify(harness.service.snapshot())).not.toContain('LAYER_PRIVATE');
  });

  test('旧 reveal A 卡在 activate 时，recall 完成后 A 返回无权隐藏、失效、显示或改状态', async () => {
    const harness = createHarness({ initialSnapshot: folderSnapshot() });
    const activation = deferred<void>();
    harness.layer.activate.mockReturnValueOnce(activation.promise);
    const snapshotA = readySnapshot({ sequence: 10, instanceId: 'instance-a', hwnd: '101' });
    setAuthorityFor(harness, snapshotA);
    const revealA = harness.service.observeExplorer(snapshotA);
    await vi.waitFor(() => expect(harness.service.snapshot().state).toBe('revealing'));

    await harness.service.recallToDesktop();
    const afterRecall = {
      hide: harness.petWindow.hide.mock.calls.length,
      invalidate: harness.layer.invalidate.mock.calls.length,
      show: harness.petWindow.show.mock.calls.length
    };
    activation.resolve();
    await revealA;

    expect(harness.service.snapshot().state).toBe('desktop');
    expect(harness.petWindow.hide).toHaveBeenCalledTimes(afterRecall.hide);
    expect(harness.layer.invalidate).toHaveBeenCalledTimes(afterRecall.invalidate);
    expect(harness.petWindow.show).toHaveBeenCalledTimes(afterRecall.show);
  });

  test('旧 reveal A 卡在 activate 时，新 reveal B 完成后 A 返回不能破坏 B', async () => {
    const harness = createHarness({ initialSnapshot: folderSnapshot() });
    const activationA = deferred<void>();
    harness.layer.activate
      .mockReturnValueOnce(activationA.promise)
      .mockImplementationOnce(async ({ explorerHwnd }) => {
        harness.order.push(`activate:${explorerHwnd}`);
      });
    const snapshotA = readySnapshot({ sequence: 10, instanceId: 'instance-a', hwnd: '101' });
    setAuthorityFor(harness, snapshotA);
    const revealA = harness.service.observeExplorer(snapshotA);
    await vi.waitFor(() => expect(harness.service.snapshot().state).toBe('revealing'));

    const snapshotB = readySnapshot({
      nonce: 'b'.repeat(32), sequence: 1, instanceId: 'instance-b', hwnd: '202'
    });
    await observeReady(harness, snapshotB);
    expect(harness.service.snapshot().state).toBe('folder-visible');
    const afterB = {
      hide: harness.petWindow.hide.mock.calls.length,
      invalidate: harness.layer.invalidate.mock.calls.length,
      show: harness.petWindow.show.mock.calls.length
    };
    activationA.resolve();
    await revealA;

    expect(harness.service.snapshot().state).toBe('folder-visible');
    expect(harness.petWindow.hide).toHaveBeenCalledTimes(afterB.hide);
    expect(harness.layer.invalidate).toHaveBeenCalledTimes(afterB.invalidate);
    expect(harness.petWindow.show).toHaveBeenCalledTimes(afterB.show);
  });

  test('目录进入 lost 会撤销卡在 activate 的 reveal，旧返回不得 show 或 visible', async () => {
    const harness = createHarness({ initialSnapshot: folderSnapshot() });
    const activation = deferred<void>();
    harness.layer.activate.mockReturnValueOnce(activation.promise);
    const revealing = observeReady(harness);
    await vi.waitFor(() => expect(harness.service.snapshot().state).toBe('revealing'));
    harness.directoryPolicy.availability.mockResolvedValueOnce('unavailable');

    await harness.service.handleDirectoryAvailability();
    activation.resolve();
    await revealing;

    expect(harness.service.snapshot().state).toBe('folder-lost');
    expect(harness.petWindow.show).not.toHaveBeenCalled();
  });

  test('thinking 事件在身份解析期间撤销 reveal，旧解析不得 activate 或 show', async () => {
    const harness = createHarness({ initialSnapshot: folderSnapshot() });
    const resolution = deferred<FolderIdentityResolution>();
    harness.identityResolver.resolve.mockReturnValueOnce(resolution.promise);
    const observing = observeReady(harness);
    await vi.waitFor(() => expect(harness.identityResolver.resolve).toHaveBeenCalledOnce());

    await harness.service.handleTaskEvent({ type: 'phase', phase: 'thinking' });
    resolution.resolve({ status: 'matched', directoryId: 'directory-1' });
    await observing;

    expect(harness.layer.activate).not.toHaveBeenCalled();
    expect(harness.petWindow.show).not.toHaveBeenCalled();
    expect(harness.service.snapshot().state).toBe('folder-hidden');
  });

  test('身份解析前完整动态 blocker 失败关闭，不调用 resolver', async () => {
    const harness = createHarness({
      initialSnapshot: folderSnapshot(), blockers: { dragging: true }
    });
    await observeReady(harness);
    expect(harness.identityResolver.resolve).not.toHaveBeenCalled();
    expect(harness.petWindow.show).not.toHaveBeenCalled();
    expect(harness.service.snapshot().state).toBe('folder-hidden');
  });

  test('activate 期间动态 blocker 变为活动，show 前复核并由当前 epoch 隐藏失效', async () => {
    const harness = createHarness({ initialSnapshot: folderSnapshot() });
    const activation = deferred<void>();
    harness.layer.activate.mockReturnValueOnce(activation.promise);
    const observing = observeReady(harness);
    await vi.waitFor(() => expect(harness.layer.activate).toHaveBeenCalledOnce());
    harness.blockers.chatInteracting = true;
    activation.resolve();
    await observing;

    expect(harness.petWindow.show).not.toHaveBeenCalled();
    expect(harness.service.snapshot().state).toBe('folder-hidden');
    expect(harness.order.slice(-2)).toEqual(['hide', 'invalidate:leave']);
  });

  test('用户交互在 activate 期间撤销 reveal，旧 continuation 不重复清理', async () => {
    const harness = createHarness({ initialSnapshot: folderSnapshot() });
    const activation = deferred<void>();
    harness.layer.activate.mockReturnValueOnce(activation.promise);
    const observing = observeReady(harness);
    await vi.waitFor(() => expect(harness.layer.activate).toHaveBeenCalledOnce());
    await harness.service.handleUserInteraction();
    const cleanupCount = harness.layer.invalidate.mock.calls.length;
    activation.resolve();
    await observing;
    expect(harness.layer.invalidate).toHaveBeenCalledTimes(cleanupCount);
    expect(harness.petWindow.show).not.toHaveBeenCalled();
  });

  test('旧 revision、旧 nonce 或旧 instance 晚到不进入解析，也不破坏当前可见实例', async () => {
    const harness = createHarness({ initialSnapshot: folderSnapshot() });
    const current = readySnapshot({
      nonce: 'b'.repeat(32), sequence: 20, instanceId: 'instance-b', hwnd: '202'
    });
    await observeReady(harness, current);
    expect(harness.service.snapshot().state).toBe('folder-visible');
    vi.clearAllMocks();

    await harness.service.observeExplorer(readySnapshot({
      nonce: BRIDGE_NONCE, sequence: 10, instanceId: 'instance-a', hwnd: '101'
    }));

    expect(harness.identityResolver.resolve).not.toHaveBeenCalled();
    expect(harness.layer.invalidate).not.toHaveBeenCalled();
    expect(harness.petWindow.hide).not.toHaveBeenCalled();
    expect(harness.service.snapshot().state).toBe('folder-visible');
  });

  test('authority 已换代但可见 binding 仍旧时，迟到旧事件必须隐藏并失效', async () => {
    const harness = createHarness({ initialSnapshot: folderSnapshot() });
    await reveal(harness);
    harness.setAuthority({
      nonce: 'b'.repeat(32), revision: 11, instanceId: 'instance-b'
    });

    await harness.service.observeExplorer(readySnapshot());

    expect(harness.order).toEqual(['hide', 'invalidate:tab-race']);
    expect(harness.service.snapshot().state).toBe('folder-hidden');
  });

  test('私有 layer 错误只映射封闭错误码，不进入 reject 或 snapshot', async () => {
    const harness = createHarness({ initialSnapshot: folderSnapshot() });
    harness.layer.activate.mockRejectedValueOnce(new Error('LAYER_PRIVATE_HWND_123456'));

    await expect(observeReady(harness)).rejects.toMatchObject({
      message: 'HABITAT_WINDOW_FAILED', code: 'HABITAT_WINDOW_FAILED'
    });
    const serialized = JSON.stringify(harness.service.snapshot());
    expect(serialized).toContain('HABITAT_WINDOW_FAILED');
    expect(serialized).not.toContain('PRIVATE');
    expect(serialized).not.toContain('123456');
  });

  test('activate 期间外部 authority 已换代时，当前 reveal 先隐藏失效且不得 show', async () => {
    const harness = createHarness({ initialSnapshot: folderSnapshot() });
    const activation = deferred<void>();
    harness.layer.activate.mockReturnValueOnce(activation.promise);
    const observing = observeReady(harness);
    await vi.waitFor(() => expect(harness.layer.activate).toHaveBeenCalledOnce());
    harness.order.length = 0;
    harness.setAuthority({
      nonce: 'b'.repeat(32), revision: 11, instanceId: 'instance-b'
    });

    activation.resolve();
    await observing;

    expect(harness.petWindow.show).not.toHaveBeenCalled();
    expect(harness.order.slice(-2)).toEqual(['hide', 'invalidate:tab-race']);
    expect(harness.service.snapshot().state).toBe('folder-hidden');
  });

  test('旧 reveal 的失败清理等待期间新 reveal 完成，旧尾部不得回写 errorCode', async () => {
    const harness = createHarness({ initialSnapshot: folderSnapshot() });
    const oldCleanup = deferred<void>();
    harness.layer.invalidate
      .mockImplementationOnce(async reason => { harness.order.push(`invalidate:${reason}`); })
      .mockImplementationOnce(async reason => {
        harness.order.push(`invalidate:${reason}`);
        await oldCleanup.promise;
      });
    harness.layer.activate.mockRejectedValueOnce(new Error('LAYER_PRIVATE_OLD'));
    const oldReveal = observeReady(harness);
    await vi.waitFor(() => expect(harness.layer.invalidate).toHaveBeenCalledTimes(2));

    const current = readySnapshot({
      nonce: 'b'.repeat(32), sequence: 11, instanceId: 'instance-b', hwnd: '202'
    });
    await observeReady(harness, current);
    expect(harness.service.snapshot().state).toBe('folder-visible');
    oldCleanup.resolve();
    await expect(oldReveal).rejects.toThrow('HABITAT_WINDOW_FAILED');

    expect(harness.service.snapshot()).toMatchObject({ state: 'folder-visible' });
    expect(harness.service.snapshot().errorCode).toBeUndefined();
  });

  test('观察时钟依赖异常映射为封闭错误且不泄漏内部消息', async () => {
    const harness = createHarness({
      initialSnapshot: folderSnapshot(),
      now: () => { throw new Error('CLOCK_PRIVATE_PATH_C:\\secret'); }
    });

    await expect(observeReady(harness)).rejects.toMatchObject({
      code: 'HABITAT_OBSERVER_FAILED', message: 'HABITAT_OBSERVER_FAILED'
    });
    expect(JSON.stringify(harness.service.snapshot())).not.toContain('PRIVATE');
  });

  test('availability 与 recall 使用同一操作串行，旧 folder 读取不能覆盖 desktop', async () => {
    const harness = createHarness({ initialSnapshot: folderSnapshot() });
    const loading = deferred<PetHabitatSnapshot>();
    harness.store.load.mockReturnValueOnce(loading.promise);
    const availability = harness.service.handleDirectoryAvailability();
    await expect(harness.service.recallToDesktop()).rejects.toThrow('HABITAT_OPERATION_BUSY');
    loading.resolve(folderSnapshot());
    harness.directoryPolicy.availability.mockResolvedValueOnce('unavailable');
    await availability;
    await harness.service.recallToDesktop();
    expect(harness.persisted().location.kind).toBe('desktop');
    expect(harness.service.snapshot().state).toBe('desktop');
  });

  test('availability 读到外部 desktop authority 时完成桌面窗口恢复', async () => {
    const harness = createHarness({ initialSnapshot: folderSnapshot() });
    await reveal(harness);
    harness.replacePersisted(desktopSnapshot());

    await harness.service.handleDirectoryAvailability();

    expect(harness.order).toEqual([
      'hide', 'invalidate:leave', 'position:120,240', 'show'
    ]);
    expect(harness.service.snapshot()).toMatchObject({
      state: 'desktop', directoryId: null
    });
  });

  test('availability 读到 position 为空的外部 desktop 时复用当前安全坐标并完成恢复', async () => {
    const harness = createHarness({ initialSnapshot: folderSnapshot() });
    await reveal(harness);
    const desktop = desktopSnapshot();
    desktop.location = { kind: 'desktop', position: null };
    harness.replacePersisted(desktop);

    await harness.service.handleDirectoryAvailability();

    expect(harness.order).toEqual([
      'hide', 'invalidate:leave', 'position:120,240', 'show'
    ]);
    expect(harness.service.snapshot()).toMatchObject({ state: 'desktop' });
  });

  test('availability 读到外部不同 folder authority 时先收敛旧绑定再恢复观察', async () => {
    const harness = createHarness({ initialSnapshot: folderSnapshot() });
    await reveal(harness);
    const next = folderSnapshot();
    next.directories.push({
      id: 'directory-2',
      displayName: 'Project B',
      pathHint: 'Project B',
      absolutePath: 'C:\\Users\\pet\\Project-B',
      identity: { dev: 7, ino: 12 },
      enabled: true
    });
    next.location = {
      kind: 'folder',
      directoryId: 'directory-2',
      enteredAt: '2026-08-08T02:00:00.000Z',
      previousDesktopPosition: DESKTOP_POSITION,
      localOffset: LOCAL_OFFSET
    };
    harness.replacePersisted(next);

    await harness.service.handleDirectoryAvailability();

    expect(harness.order).toEqual([
      'hide', 'invalidate:leave', 'start', 'start-observing'
    ]);
    expect(harness.service.snapshot()).toMatchObject({
      state: 'folder-hidden', directoryId: 'directory-2'
    });
  });

  test('close 在 explorer.start 未决时取消 enter，启动收敛后再次 stop 且不 startObserving', async () => {
    const harness = createHarness();
    const starting = deferred<void>();
    harness.explorer.start.mockImplementationOnce(async () => {
      harness.order.push('start');
      await starting.promise;
    });
    const entering = harness.service.enterDirectory('directory-1', 'manual');
    await vi.waitFor(() => expect(harness.explorer.start).toHaveBeenCalledOnce());
    const closing = harness.service.close();
    await vi.waitFor(() => expect(harness.explorer.stopObserving).toHaveBeenCalledOnce());
    starting.resolve();

    await expect(entering).rejects.toThrow('HABITAT_CLOSED');
    await closing;
    expect(harness.explorer.startObserving).not.toHaveBeenCalled();
    expect(harness.explorer.stopObserving).toHaveBeenCalledTimes(2);
    expect(harness.service.snapshot().errorCode).toBeUndefined();
  });

  test('close 在 startObserving 未决时等待其收敛并再次 stop', async () => {
    const harness = createHarness();
    const observing = deferred<{ ok: true }>();
    harness.explorer.startObserving.mockReturnValueOnce(observing.promise);
    const entering = harness.service.enterDirectory('directory-1', 'manual');
    await vi.waitFor(() => expect(harness.explorer.startObserving).toHaveBeenCalledOnce());
    const closing = harness.service.close();
    observing.resolve({ ok: true });

    await expect(entering).rejects.toThrow('HABITAT_CLOSED');
    await closing;
    expect(harness.explorer.stopObserving).toHaveBeenCalledTimes(2);
  });

  test('close 的 stopObserving 失败映射稳定错误但仍 hide 与 invalidate，重复 close 返回同一拒绝 Promise', async () => {
    const harness = createHarness({ initialSnapshot: folderSnapshot() });
    await harness.service.summon();
    harness.explorer.stopObserving.mockRejectedValue(new Error('BRIDGE_PRIVATE_NONCE'));
    harness.order.length = 0;

    const first = harness.service.close();
    const duplicate = harness.service.close();
    expect(duplicate).toBe(first);
    await expect(first).rejects.toThrow('HABITAT_OBSERVER_FAILED');

    expect(harness.order).toContain('hide');
    expect(harness.order).toContain('invalidate:leave');
    expect(harness.service.snapshot()).toMatchObject({
      closed: true, errorCode: 'HABITAT_OBSERVER_FAILED'
    });
    expect(JSON.stringify(harness.service.snapshot())).not.toContain('PRIVATE');
  });

  test('同一 Explorer 快照只采样一次时钟', async () => {
    let now = 1_000;
    const harness = createHarness({ initialSnapshot: folderSnapshot(), now: () => now++ });
    await observeReady(harness);
    expect(harness.service.snapshot().state).toBe('folder-visible');
  });
});
