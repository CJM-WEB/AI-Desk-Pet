import { realpathSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

type BoundaryModule = {
  resolveMainE2eBoundary(options: {
    appIsPackaged: boolean;
    env: NodeJS.ProcessEnv;
    temporaryDirectory?: string;
  }): {
    userDataDirectory: string;
    authorizedRootDirectory: string;
    habitatDirectory: string;
    explorerEventFile: string;
    mainStateFile: string;
    recycleBinDirectory: string;
  } | null;
  createMainE2eExplorerBridge(options: {
    eventFile: string;
    habitatDirectory: string;
    wrongDirectory: string;
    pollIntervalMs?: number;
  }): {
    on(event: 'snapshot', listener: (snapshot: {
      sequence: number;
      foreground?: boolean;
      hwnd?: string;
    }) => void): void;
    on(event: 'tray-summon', listener: (payload: unknown) => void): void;
    snapshot(): { state: string; errorCode?: string };
    start(): Promise<void>;
    startObserving(): Promise<{ ok: true }>;
    stopObserving(): Promise<{ ok: true }>;
    close(): Promise<void>;
  };
};

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
let habitatDirectory = '';
let recycleBinDirectory = '';

function validEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    MYSELF_E2E: '1',
    MYSELF_E2E_FAKE_EXPLORER_BRIDGE: '1',
    MYSELF_E2E_USER_DATA: userDataDirectory,
    MYSELF_E2E_AUTHORIZED_ROOT: authorizedRootDirectory,
    MYSELF_E2E_HABITAT_DIRECTORY: habitatDirectory,
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
    habitatDirectory = join(temporaryDirectory, 'habitat-directory');
    recycleBinDirectory = join(temporaryDirectory, 'recycle-bin');
    await Promise.all([
      mkdir(userDataDirectory, { recursive: true }),
      mkdir(authorizedRootDirectory, { recursive: true }),
      mkdir(habitatDirectory, { recursive: true }),
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

  test('仅在未打包、开关严格为 1 且两个绝对路径都位于系统临时目录下时启用', async () => {
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
      habitatDirectory: realpathSync.native(habitatDirectory),
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
      eventFile: join(userDataDirectory, 'main-e2e-explorer-events'),
      habitatDirectory,
      wrongDirectory: authorizedRootDirectory
    });
    await expect(fake.start()).resolves.toBeUndefined();
    await expect(fake.startObserving()).resolves.toEqual({ ok: true });
    await expect(fake.stopObserving()).resolves.toEqual({ ok: true });
    await expect(fake.close()).resolves.toBeUndefined();
  });

  test('Main E2E 边界不再派发目录空间托盘召回事件', async () => {
    const boundary = await loadBoundaryModule();
    expect(boundary).not.toBeNull();
    if (!boundary) return;
    const eventFile = join(userDataDirectory, 'main-e2e-explorer-events');
    const fake = boundary.createMainE2eExplorerBridge({
      eventFile,
      habitatDirectory,
      wrongDirectory: authorizedRootDirectory,
      pollIntervalMs: 1
    }) as ReturnType<typeof boundary.createMainE2eExplorerBridge> & {
      inspection(): { eventRevision: number };
    };
    const listener = vi.fn();
    fake.on('tray-summon', listener);

    await fake.start();
    await fake.startObserving();
    await appendFile(eventFile, 'tray-summon\n', 'utf8');
    await vi.waitFor(() => expect(fake.inspection().eventRevision).toBe(1));

    expect(listener).not.toHaveBeenCalled();
    await fake.close();
  });

  test('旧序列进入真实观察链且 fatal 后 fake 资源收敛为空闲', async () => {
    const boundary = await loadBoundaryModule();
    expect(boundary).not.toBeNull();
    if (!boundary) return;
    const eventFile = join(userDataDirectory, 'main-e2e-explorer-events');
    const fake = boundary.createMainE2eExplorerBridge({
      eventFile,
      habitatDirectory,
      wrongDirectory: authorizedRootDirectory,
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
    await appendFile(eventFile, 'stale-revision\ncrash\n', 'utf8');
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
    ['藏身目录逃逸临时目录', false, () => validEnvironment({
      MYSELF_E2E_HABITAT_DIRECTORY: join(testBaseDirectory, 'outside-habitat')
    })],
    ['隔离回收站逃逸临时目录', false, () => validEnvironment({
      MYSELF_E2E_RECYCLE_BIN: join(testBaseDirectory, 'outside-recycle-bin')
    })],
    ['隔离回收站与授权目录重合', false, () => validEnvironment({
      MYSELF_E2E_RECYCLE_BIN: authorizedRootDirectory
    })],
    ['藏身目录与授权目录重合', false, () => validEnvironment({
      MYSELF_E2E_HABITAT_DIRECTORY: authorizedRootDirectory
    })]
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
});
