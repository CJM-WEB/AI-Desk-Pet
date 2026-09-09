import { realpathSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

type BoundaryModule = {
  createCoalescedAsyncPublisher(
    operation: () => Promise<void>
  ): {
    publish(): Promise<void>;
    close(): Promise<void>;
  };
  resolveMainE2eBoundary(options: {
    appIsPackaged: boolean;
    env: NodeJS.ProcessEnv;
    temporaryDirectory?: string;
  }): {
    userDataDirectory: string;
    authorizedRootDirectory: string;
    explorerEventFile: string;
    mainStateFile: string;
    recycleBinDirectory: string;
  } | null;
  createMainE2eExplorerBridge(options: {
    eventFile: string;
    pollIntervalMs?: number;
  }): {
    on(event: 'snapshot', listener: (snapshot: {
      sequence: number;
      foreground?: boolean;
      hwnd?: string;
    }) => void): void;
    snapshot(): { state: string; errorCode?: string };
    start(): Promise<void>;
    startObserving(): Promise<{ ok: true }>;
    stopObserving(): Promise<{ ok: true }>;
    close(): Promise<void>;
  };
};

test('E2E 状态刷新在慢读盘期间只合并一次最新发布', async () => {
  const boundary = await loadBoundaryModule();
  if (!boundary) return;
  let releaseFirst!: () => void;
  const first = new Promise<void>(resolveFirst => {
    releaseFirst = resolveFirst;
  });
  let calls = 0;
  const publisher = boundary.createCoalescedAsyncPublisher(async () => {
    calls += 1;
    if (calls === 1) await first;
  });

  const initial = publisher.publish();
  const repeated = Array.from({ length: 50 }, () => publisher.publish());
  await Promise.resolve();
  expect(calls).toBe(1);

  releaseFirst();
  await Promise.all([initial, ...repeated]);
  expect(calls).toBe(2);
  await publisher.close();
});

test('E2E 状态发布临时失败后不阻断显式重试或关闭', async () => {
  const boundary = await loadBoundaryModule();
  if (!boundary) return;
  let calls = 0;
  const publisher = boundary.createCoalescedAsyncPublisher(async () => {
    calls += 1;
    if (calls === 1) throw new Error('WRITE_FAILED');
  });

  await expect(publisher.publish()).resolves.toBeUndefined();
  await expect(publisher.publish()).resolves.toBeUndefined();
  expect(calls).toBe(2);
  await expect(publisher.close()).resolves.toBeUndefined();
});

test('E2E 状态发布首轮失败时仍处理在途期间合并的最新信号', async () => {
  const boundary = await loadBoundaryModule();
  if (!boundary) return;
  let releaseFirst!: () => void;
  const first = new Promise<void>(resolveFirst => {
    releaseFirst = resolveFirst;
  });
  let calls = 0;
  const publisher = boundary.createCoalescedAsyncPublisher(async () => {
    calls += 1;
    if (calls === 1) {
      await first;
      throw new Error('WRITE_FAILED');
    }
  });

  const initial = publisher.publish();
  const latest = publisher.publish();
  releaseFirst();

  await expect(Promise.all([initial, latest])).resolves.toEqual([undefined, undefined]);
  expect(calls).toBe(2);
  await expect(publisher.close()).resolves.toBeUndefined();
});

async function loadBoundaryModule(): Promise<BoundaryModule | null> {
  try {
    return await import(new URL('../src/main/e2e-boundary.ts', import.meta.url).href) as BoundaryModule;
  } catch {
    return null;
  }
}

let testBaseDirectory = '';
let temporaryDirectory = '';
let userDataDirectory = '';
let authorizedRootDirectory = '';
let recycleBinDirectory = '';

function validEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    MYSELF_E2E: '1',
    MYSELF_E2E_FAKE_EXPLORER_BRIDGE: '1',
    MYSELF_E2E_USER_DATA: userDataDirectory,
    MYSELF_E2E_AUTHORIZED_ROOT: authorizedRootDirectory,
    MYSELF_E2E_RECYCLE_BIN: recycleBinDirectory,
    MYSELF_E2E_CHARACTER_ASSETS: join(temporaryDirectory, 'character-assets'),
    MYSELF_E2E_SAFE_CHARACTER_PACKAGE: join(
      temporaryDirectory,
      'packages',
      'safe-character.zip'
    ),
    MYSELF_E2E_MALICIOUS_CHARACTER_PACKAGE: join(
      temporaryDirectory,
      'packages',
      'malicious-character.zip'
    ),
    MYSELF_E2E_CHARACTER_EXPORT: join(
      temporaryDirectory,
      'exports',
      'exported-character.zip'
    ),
    ...overrides
  };
}

describe('Main E2E 安全边界', () => {
  beforeEach(async () => {
    testBaseDirectory = await mkdtemp(join(tmpdir(), 'myself-boundary-test-'));
    temporaryDirectory = join(testBaseDirectory, 'temporary-root');
    userDataDirectory = join(temporaryDirectory, 'user-data');
    authorizedRootDirectory = join(temporaryDirectory, 'authorized-root');
    recycleBinDirectory = join(temporaryDirectory, 'recycle-bin');
    await Promise.all([
      mkdir(userDataDirectory, { recursive: true }),
      mkdir(authorizedRootDirectory, { recursive: true }),
      mkdir(recycleBinDirectory, { recursive: true }),
      mkdir(join(temporaryDirectory, 'character-assets'), { recursive: true }),
      mkdir(join(temporaryDirectory, 'packages'), { recursive: true }),
      mkdir(join(temporaryDirectory, 'exports'), { recursive: true })
    ]);
    await Promise.all([
      writeFile(
        join(temporaryDirectory, 'packages', 'safe-character.zip'),
        'safe'
      ),
      writeFile(
        join(temporaryDirectory, 'packages', 'malicious-character.zip'),
        'malicious'
      )
    ]);
  });

  afterEach(async () => {
    await rm(testBaseDirectory, { recursive: true, force: true });
  });

  test('仅在未打包、开关严格为 1 且所有测试资源都位于系统临时目录下时启用', async () => {
    const boundary = await loadBoundaryModule();
    expect(boundary, '应提供独立的 Main E2E 边界解析模块').not.toBeNull();
    if (!boundary) return;

    expect(boundary.resolveMainE2eBoundary({
      appIsPackaged: false,
      env: validEnvironment(),
      temporaryDirectory
    })).toEqual({
      userDataDirectory: realpathSync.native(userDataDirectory),
      authorizedRootDirectory: realpathSync.native(authorizedRootDirectory),
      explorerEventFile: join(
        realpathSync.native(userDataDirectory),
        'main-e2e-explorer-events'
      ),
      mainStateFile: join(realpathSync.native(userDataDirectory), 'main-e2e-state.json'),
      recycleBinDirectory: realpathSync.native(recycleBinDirectory),
      characterAssetsDirectory: realpathSync.native(
        join(temporaryDirectory, 'character-assets')
      ),
      safeCharacterPackage: realpathSync.native(
        join(temporaryDirectory, 'packages', 'safe-character.zip')
      ),
      maliciousCharacterPackage: realpathSync.native(
        join(temporaryDirectory, 'packages', 'malicious-character.zip')
      ),
      characterExportDestination: join(
        realpathSync.native(join(temporaryDirectory, 'exports')),
        'exported-character.zip'
      )
    });
  });

  test('角色测试资产必须全部位于同一临时根，且导出目标必须尚不存在', async () => {
    const boundary = await loadBoundaryModule();
    expect(boundary).not.toBeNull();
    if (!boundary) return;

    const outsideFile = join(testBaseDirectory, 'outside.png');
    await writeFile(outsideFile, 'outside');
    expect(boundary.resolveMainE2eBoundary({
      appIsPackaged: false,
      env: validEnvironment({ MYSELF_E2E_SAFE_CHARACTER_PACKAGE: outsideFile }),
      temporaryDirectory
    })).toBeNull();

    const exportTarget = join(temporaryDirectory, 'exports', 'exported-character.zip');
    await writeFile(exportTarget, 'occupied');
    expect(boundary.resolveMainE2eBoundary({
      appIsPackaged: false,
      env: validEnvironment(),
      temporaryDirectory
    })).toBeNull();
  });

  test('E2E 只取得 Main 内部 fake bridge，不启动真实 Explorer', async () => {
    const boundary = await loadBoundaryModule();
    expect(boundary).not.toBeNull();
    if (!boundary) return;

    const fake = boundary.createMainE2eExplorerBridge({
      eventFile: join(userDataDirectory, 'main-e2e-explorer-events')
    });
    await expect(fake.start()).resolves.toBeUndefined();
    await expect(fake.startObserving()).resolves.toEqual({ ok: true });
    await expect(fake.stopObserving()).resolves.toEqual({ ok: true });
    await expect(fake.close()).resolves.toBeUndefined();
  });

  test('Main E2E 边界拒绝任意旧控制令牌', async () => {
    const boundary = await loadBoundaryModule();
    expect(boundary).not.toBeNull();
    if (!boundary) return;
    const eventFile = join(userDataDirectory, 'main-e2e-explorer-events');
    const fake = boundary.createMainE2eExplorerBridge({
      eventFile,
      pollIntervalMs: 1
    }) as ReturnType<typeof boundary.createMainE2eExplorerBridge> & {
      inspection(): { eventRevision: number };
    };
    await fake.start();
    await fake.startObserving();
    await appendFile(eventFile, 'removed-control\n', 'utf8');
    await vi.waitFor(() => expect(fake.snapshot()).toMatchObject({
      state: 'failed', errorCode: 'E2E_BRIDGE_EVENT_INVALID'
    }));
    await fake.close();
  });

  test('旧序列进入真实观察链且 fatal 后 fake 资源收敛为空闲', async () => {
    const boundary = await loadBoundaryModule();
    expect(boundary).not.toBeNull();
    if (!boundary) return;
    const eventFile = join(userDataDirectory, 'main-e2e-explorer-events');
    const fake = boundary.createMainE2eExplorerBridge({
      eventFile,
      pollIntervalMs: 1
    }) as ReturnType<typeof boundary.createMainE2eExplorerBridge> & {
      inspection(): {
        state: string;
        observing: boolean;
        polling: boolean;
      };
    };
    const snapshots: Array<{ sequence: number; foreground?: boolean; hwnd?: string }> = [];
    fake.on('snapshot', snapshot => snapshots.push(snapshot));

    await fake.start();
    await fake.startObserving();
    await appendFile(eventFile, 'stale-sequence\ncrash\n', 'utf8');
    await vi.waitFor(() => expect(fake.snapshot()).toMatchObject({ state: 'failed' }));

    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toMatchObject({ foreground: true, hwnd: '9003' });
    expect(snapshots[1]).toMatchObject({ foreground: true, hwnd: '9002' });
    expect(snapshots[1]?.sequence).toBe(snapshots[0]?.sequence);
    expect(fake.inspection()).toEqual({
      state: 'failed',
      observing: false,
      polling: false,
      eventRevision: 2
    });
    await fake.close();
  });

  test.each([
    ['已打包应用', true, () => validEnvironment()],
    ['开关缺失', false, () => validEnvironment({ MYSELF_E2E: undefined })],
    ['开关不是严格的 1', false, () => validEnvironment({ MYSELF_E2E: 'true' })],
    ['用户数据目录是相对路径', false, () => validEnvironment({
      MYSELF_E2E_USER_DATA: 'relative-user-data'
    })],
    ['授权目录是相对路径', false, () => validEnvironment({
      MYSELF_E2E_AUTHORIZED_ROOT: 'relative-authorized-root'
    })],
    ['用户数据目录逃逸临时目录', false, () => validEnvironment({
      MYSELF_E2E_USER_DATA: join(testBaseDirectory, 'outside-user-data')
    })],
    ['授权目录逃逸临时目录', false, () => validEnvironment({
      MYSELF_E2E_AUTHORIZED_ROOT: join(testBaseDirectory, 'outside-authorized-root')
    })],
    ['隔离回收站逃逸临时目录', false, () => validEnvironment({
      MYSELF_E2E_RECYCLE_BIN: join(testBaseDirectory, 'outside-recycle-bin')
    })],
    ['隔离回收站与授权目录重合', false, () => validEnvironment({
      MYSELF_E2E_RECYCLE_BIN: authorizedRootDirectory
    })],
  ] as const)('完整忽略无效边界：%s', async (_name, appIsPackaged, environment) => {
    const boundary = await loadBoundaryModule();
    expect(boundary, '应提供独立的 Main E2E 边界解析模块').not.toBeNull();
    if (!boundary) return;

    expect(boundary.resolveMainE2eBoundary({
      appIsPackaged,
      env: environment(),
      temporaryDirectory
    })).toBeNull();
  });

  test('拒绝文件、不存在目录和临时根名称前缀碰撞', async () => {
    const boundary = await loadBoundaryModule();
    expect(boundary).not.toBeNull();
    if (!boundary) return;

    const filePath = join(temporaryDirectory, 'not-a-directory.txt');
    const missingPath = join(temporaryDirectory, 'missing-directory');
    const collisionDirectory = `${temporaryDirectory}-collision`;
    await Promise.all([
      writeFile(filePath, '不是目录', 'utf8'),
      mkdir(collisionDirectory)
    ]);

    for (const candidate of [filePath, missingPath, collisionDirectory]) {
      expect(boundary.resolveMainE2eBoundary({
        appIsPackaged: false,
        env: validEnvironment({ MYSELF_E2E_USER_DATA: candidate }),
        temporaryDirectory
      })).toBeNull();
    }
  });

  test.runIf(process.platform === 'win32')('拒绝解析到临时根外的真实 Windows Junction', async ({ skip }) => {
    const boundary = await loadBoundaryModule();
    expect(boundary).not.toBeNull();
    if (!boundary) return;

    const outsideDirectory = join(testBaseDirectory, 'junction-target-outside');
    const junctionDirectory = join(temporaryDirectory, 'junction-user-data');
    await mkdir(outsideDirectory);
    try {
      await symlink(outsideDirectory, junctionDirectory, 'junction');
    } catch (error) {
      if (error instanceof Error && 'code' in error
        && (error.code === 'EPERM' || error.code === 'EACCES')) {
        skip(`Windows 不允许创建 Junction：${String(error.code)}`);
        return;
      }
      throw error;
    }

    expect(boundary.resolveMainE2eBoundary({
      appIsPackaged: false,
      env: validEnvironment({ MYSELF_E2E_USER_DATA: junctionDirectory }),
      temporaryDirectory
    })).toBeNull();
  });

  test('userData 与测试硬件加速策略在 whenReady 前生效且授权根只替代 Main 内部目录选择结果', async () => {
    const main = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    const setPathIndex = main.indexOf("app.setPath('userData'");
    const disableHardwareAccelerationIndex = main.indexOf('app.disableHardwareAcceleration()');
    const singleInstanceLockIndex = main.indexOf('configureSingleInstance(');
    const whenReadyIndex = main.indexOf('app.whenReady()');

    expect(setPathIndex).toBeGreaterThanOrEqual(0);
    expect(setPathIndex).toBeLessThan(whenReadyIndex);
    expect(disableHardwareAccelerationIndex).toBeGreaterThanOrEqual(0);
    expect(disableHardwareAccelerationIndex).toBeLessThan(whenReadyIndex);
    expect(singleInstanceLockIndex).toBeGreaterThanOrEqual(0);
    expect(singleInstanceLockIndex).toBeLessThan(whenReadyIndex);
    expect(singleInstanceLockIndex).toBeLessThan(main.lastIndexOf('createApplicationWindows('));
    expect(main).toContain('e2eBoundary.authorizedRootDirectory');
    expect(main).toContain('dialog.showOpenDialog');
  });

  test('新 Core 工厂复用既有 E2E 隔离回收站宿主端口，正常运行仍使用系统回收站', async () => {
    const main = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    const factory = main.slice(main.indexOf('createCodingTaskService: ({ snapshot'), main.indexOf('const conversationCoordinator'));
    expect(factory).toContain('new CodingTaskService(');
    expect(factory).toMatch(/trashFile:\s*absolutePath\s*=>\s*e2eBoundary\s*\?\s*moveToE2eRecycleBin\(absolutePath\)\s*:\s*shell\.trashItem\(absolutePath\)/u);
    expect(main).toContain("'.force-failure'");
    expect(main).toContain('e2eBoundary.recycleBinDirectory');
  });

  test('不向 Renderer、preload 或共享白名单暴露 E2E 路径与控制能力', async () => {
    const sources = await Promise.all([
      '../src/preload/index.ts',
      '../src/shared/myself-api.ts',
      '../src/shared/ipc-channels.ts',
      '../src/renderer/src/App.tsx'
    ].map(path => readFile(new URL(path, import.meta.url), 'utf8')));

    expect(sources.join('\n')).not.toMatch(
      /MYSELF_E2E|E2E_USER_DATA|E2E_AUTHORIZED_ROOT|E2E_RECYCLE_BIN|FAKE_EXPLORER/u
    );
  });

  test('几何探针只发布已收敛且与实际窗口尺寸一致的同一 revision 快照', async () => {
    const main = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    const probeStart = main.indexOf('inspectPetGeometryForE2e = async () => {');
    const probeEnd = main.indexOf('const persistMovedPetGeometry', probeStart);
    const probe = main.slice(probeStart, probeEnd);
    const boundsReadIndex = probe.indexOf('const actualBounds = pet.getBounds();');

    expect(probeStart).toBeGreaterThanOrEqual(0);
    expect(probeEnd).toBeGreaterThan(probeStart);
    expect(probe).toContain('petGeometry.isLayoutInFlight()');
    expect(probe).toContain('!relative.settled');
    expect(boundsReadIndex).toBeGreaterThanOrEqual(0);
    expect(probe.lastIndexOf('petGeometryAuthority.getSnapshot()')).toBeGreaterThan(
      boundsReadIndex
    );
    expect(probe.lastIndexOf('petGeometry.inspectRelativeGeometry()')).toBeGreaterThan(
      boundsReadIndex
    );
    expect(probe).toContain('!currentRelative.settled');
    expect(probe).toContain('actualBounds.width !== currentSnapshot.windowBoundsDip.width');
    expect(probe).toContain('actualBounds.height !== currentSnapshot.windowBoundsDip.height');
  });

  test('几何探针仅以 1e-6 数值容差判断可见矩形是否越界', async () => {
    const main = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    const probeStart = main.indexOf('inspectPetGeometryForE2e = async () => {');
    const probeEnd = main.indexOf('const persistMovedPetGeometry', probeStart);
    const probe = main.slice(probeStart, probeEnd);

    expect(probe).toContain('const boundsEpsilonDip = 1e-6;');
    expect(probe).toContain('globalVisual.x >= display.workArea.x - boundsEpsilonDip');
    expect(probe).toContain('globalVisual.y >= display.workArea.y - boundsEpsilonDip');
    expect(probe).toContain(
      'globalVisual.x + globalVisual.width <= display.workArea.x + display.workArea.width + boundsEpsilonDip'
    );
    expect(probe).toContain(
      'globalVisual.y + globalVisual.height <= display.workArea.y + display.workArea.height + boundsEpsilonDip'
    );
  });
});
