import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createMainE2eExplorerBridge, resolveMainE2eBoundary } from '../src/main/e2e-boundary';
import { ExplorerPetLayerCoordinator } from '../src/main/explorer/explorer-pet-layer-coordinator';
import { parseBridgeLine } from '../src/main/explorer/explorer-space-protocol';
import { ExplorerWindowLayerController } from '../src/main/explorer/explorer-window-layer-controller';
import { buildApplicationTrayMenu } from '../src/main/windows/window-commands';
import { availableSettingsTabs } from '../src/renderer/src/settings/SettingsView';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, {
    recursive: true,
    force: true
  })));
});

async function createBoundaryFixture() {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'myself-layer-boundary-'));
  temporaryRoots.push(temporaryDirectory);
  const userDataDirectory = join(temporaryDirectory, 'user-data');
  const authorizedRootDirectory = join(temporaryDirectory, 'authorized-root');
  const recycleBinDirectory = join(temporaryDirectory, 'recycle-bin');
  const characterAssetsDirectory = join(temporaryDirectory, 'character-assets');
  const packagesDirectory = join(temporaryDirectory, 'packages');
  const exportsDirectory = join(temporaryDirectory, 'exports');
  await Promise.all([
    userDataDirectory, authorizedRootDirectory, recycleBinDirectory,
    characterAssetsDirectory, packagesDirectory, exportsDirectory
  ].map(path => mkdir(path)));
  const safePackage = join(packagesDirectory, 'safe.zip');
  const maliciousPackage = join(packagesDirectory, 'malicious.zip');
  await Promise.all([writeFile(safePackage, 'safe'), writeFile(maliciousPackage, 'malicious')]);
  return {
    temporaryDirectory,
    eventFile: join(userDataDirectory, 'main-e2e-explorer-events'),
    env: {
      MYSELF_E2E: '1',
      MYSELF_E2E_FAKE_EXPLORER_BRIDGE: '1',
      MYSELF_E2E_USER_DATA: userDataDirectory,
      MYSELF_E2E_AUTHORIZED_ROOT: authorizedRootDirectory,
      MYSELF_E2E_RECYCLE_BIN: recycleBinDirectory,
      MYSELF_E2E_CHARACTER_ASSETS: characterAssetsDirectory,
      MYSELF_E2E_SAFE_CHARACTER_PACKAGE: safePackage,
      MYSELF_E2E_MALICIOUS_CHARACTER_PACKAGE: maliciousPackage,
      MYSELF_E2E_CHARACTER_EXPORT: join(exportsDirectory, 'export.zip')
    }
  };
}

describe('Explorer 动态图层最终生产边界', () => {
  test('设置、托盘与打包资源只保留正式入口和固定 Explorer 资源', async () => {
    expect(availableSettingsTabs()).toEqual(['models', 'privacy', 'local']);
    const trayLabels = buildApplicationTrayMenu({
      togglePetVisibility: vi.fn(),
      openChat: vi.fn(),
      openCharacterWorkshop: vi.fn(),
      quickSwitchItems: [],
      openSettings: vi.fn(),
      quit: vi.fn()
    }).flatMap(item => typeof item.label === 'string' ? [item.label] : []);
    expect(trayLabels).toEqual([
      '显示/隐藏桌宠', '打开聊天', '角色工作室', '切换角色', '设置', '退出'
    ]);
    await expect(readdir(new URL('../resources/windows/', import.meta.url)))
      .resolves.toEqual([
        'explorer-space-bridge.ps1',
        'explorer-space-integrity.json',
        'explorer-space-shell-tab-helper.cs'
      ]);
  });

  test('E2E 边界不需要也不返回目录藏身路径，只接受固定图层事件', async () => {
    const fixture = await createBoundaryFixture();
    const boundary = resolveMainE2eBoundary({
      appIsPackaged: false,
      env: fixture.env,
      temporaryDirectory: fixture.temporaryDirectory
    });

    expect(boundary).not.toBeNull();
    expect(boundary).not.toHaveProperty('habitatDirectory');
    const bridge = createMainE2eExplorerBridge({
      eventFile: fixture.eventFile,
      pollIntervalMs: 1
    });
    const snapshots: unknown[] = [];
    bridge.on('snapshot', snapshot => snapshots.push(snapshot));
    await bridge.start();
    await bridge.startObserving();
    await writeFile(fixture.eventFile, 'foreground-explorer\n', 'utf8');
    await vi.waitFor(() => expect(snapshots).toHaveLength(1));
    expect(snapshots[0]).not.toHaveProperty('path');
    await bridge.close();
  });

  test('严格生产协议拒绝任何 Explorer 路径事实', () => {
    const ready = {
      version: 1,
      type: 'explorer-snapshot',
      nonce: 'a'.repeat(32),
      sequence: 1,
      status: 'ready',
      windowType: 'explorer',
      instanceId: 'explorer-1',
      hwnd: '101',
      rect: { x: 0, y: 0, width: 800, height: 600 },
      foreground: true,
      minimized: false
    };

    expect(parseBridgeLine(JSON.stringify(ready))).toEqual(ready);
    expect(() => parseBridgeLine(JSON.stringify({ ...ready, path: 'C:\\Private' })))
      .toThrow('BRIDGE_PROTOCOL_INVALID');
  });

  test('图层失败不改变窗口可见性且拒绝 topmost 窗口', async () => {
    let visible = true;
    let alwaysOnTop = false;
    const moveAbove = vi.fn(() => { throw new Error('MOVE_ABOVE_FAILED'); });
    const reportError = vi.fn();
    const window = {
      moveAbove,
      isDestroyed: () => false,
      isAlwaysOnTop: () => alwaysOnTop,
      isVisible: () => visible
    };
    const coordinator = new ExplorerPetLayerCoordinator({
      layer: new ExplorerWindowLayerController({ window }),
      setAlwaysOnTop: enabled => { alwaysOnTop = enabled; },
      reportError
    });

    await coordinator.accept({
      nonce: 'b'.repeat(32), sequence: 1, status: 'ready', instanceId: 'explorer-1',
      hwnd: '101', foreground: true, minimized: false
    });
    expect(window.isVisible()).toBe(true);
    expect(window.isAlwaysOnTop()).toBe(false);
    expect(reportError).toHaveBeenCalledWith('EXPLORER_LAYER_FAILED');

    alwaysOnTop = true;
    visible = true;
    await coordinator.accept({
      nonce: 'b'.repeat(32), sequence: 2, status: 'ready', instanceId: 'explorer-2',
      hwnd: '102', foreground: true, minimized: false
    });
    expect(moveAbove).toHaveBeenCalledTimes(1);
    expect(window.isVisible()).toBe(true);
    expect(window.isAlwaysOnTop()).toBe(true);
    await coordinator.close();
  });
});
