import { describe, expect, test, vi } from 'vitest';

import { ExplorerPetLayerCoordinator } from '../src/main/explorer/explorer-pet-layer-coordinator';

const nonceA = 'a'.repeat(32);
const nonceB = 'b'.repeat(32);

describe('ExplorerPetLayerCoordinator', () => {
  test('全局置顶期间忽略 ready，关闭后由新鲜 ready 恢复相邻图层', async () => {
    const activate = vi.fn(async () => undefined);
    const setAlwaysOnTop = vi.fn();
    const coordinator = new ExplorerPetLayerCoordinator({
      layer: { activate, dispose: async () => undefined },
      setAlwaysOnTop,
      reportError: vi.fn()
    });

    await coordinator.setPetAlwaysOnTop(true);
    await coordinator.accept({
      nonce: nonceA, sequence: 1, status: 'ready', instanceId: 'i-1',
      hwnd: '101', foreground: true, minimized: false
    });
    expect(setAlwaysOnTop).toHaveBeenLastCalledWith(true);
    expect(activate).not.toHaveBeenCalled();

    await coordinator.setPetAlwaysOnTop(false);
    await coordinator.accept({
      nonce: nonceA, sequence: 2, status: 'ready', instanceId: 'i-1',
      hwnd: '101', foreground: true, minimized: false
    });
    expect(setAlwaysOnTop).toHaveBeenLastCalledWith(false);
    expect(activate).toHaveBeenCalledExactlyOnceWith({ explorerHwnd: '101' });
  });

  test('切换原生置顶失败时保持原动态图层门状态', async () => {
    const activate = vi.fn(async () => undefined);
    const coordinator = new ExplorerPetLayerCoordinator({
      layer: { activate, dispose: async () => undefined },
      setAlwaysOnTop: () => { throw new Error('NATIVE_TOPMOST_FAILED'); },
      reportError: vi.fn()
    });

    await expect(coordinator.setPetAlwaysOnTop(true)).rejects.toThrow('NATIVE_TOPMOST_FAILED');
    await coordinator.accept({
      nonce: nonceA, sequence: 1, status: 'ready', instanceId: 'i-1',
      hwnd: '101', foreground: true, minimized: false
    });
    expect(activate).toHaveBeenCalledExactlyOnceWith({ explorerHwnd: '101' });
  });
  test('只有当前代次内递增的准确前台 Explorer 才调整层级', async () => {
    const effects: string[] = [];
    const coordinator = new ExplorerPetLayerCoordinator({
      layer: {
        activate: async ({ explorerHwnd }) => { effects.push(`move:${explorerHwnd}`); },
        dispose: async () => { effects.push('dispose'); }
      },
      setAlwaysOnTop: vi.fn(),
      reportError: code => effects.push(`error:${code}`)
    });

    await coordinator.accept({
      nonce: nonceA, sequence: 1, status: 'ready', instanceId: 'i-1',
      hwnd: '101', foreground: true, minimized: false
    });
    await coordinator.accept({
      nonce: nonceA, sequence: 1, status: 'ready', instanceId: 'i-1',
      hwnd: '101', foreground: true, minimized: false
    });
    await coordinator.accept({ nonce: nonceA, sequence: 2, status: 'none' });

    expect(effects).toEqual(['move:101']);
  });

  test('新 nonce 会重置序号水位', async () => {
    const activate = vi.fn(async () => undefined);
    const coordinator = new ExplorerPetLayerCoordinator({
      layer: { activate, dispose: async () => undefined },
      setAlwaysOnTop: vi.fn(),
      reportError: vi.fn()
    });

    await coordinator.accept({
      nonce: nonceA, sequence: 9, status: 'ready', instanceId: 'i-a',
      hwnd: '101', foreground: true, minimized: false
    });
    await coordinator.accept({
      nonce: nonceB, sequence: 1, status: 'ready', instanceId: 'i-b',
      hwnd: '202', foreground: true, minimized: false
    });

    expect(activate).toHaveBeenNthCalledWith(1, { explorerHwnd: '101' });
    expect(activate).toHaveBeenNthCalledWith(2, { explorerHwnd: '202' });
  });

  test('旧异步层级完成后由新窗口保持最终层级', async () => {
    const effects: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstActivation = new Promise<void>(resolve => { releaseFirst = resolve; });
    const coordinator = new ExplorerPetLayerCoordinator({
      layer: {
        activate: async ({ explorerHwnd }) => {
          effects.push(`start:${explorerHwnd}`);
          if (explorerHwnd === '101') await firstActivation;
          effects.push(`finish:${explorerHwnd}`);
        },
        dispose: async () => undefined
      },
      setAlwaysOnTop: vi.fn(),
      reportError: vi.fn()
    });

    const oldCall = coordinator.accept({
      nonce: nonceA, sequence: 1, status: 'ready', instanceId: 'i-a',
      hwnd: '101', foreground: true, minimized: false
    });
    const newCall = coordinator.accept({
      nonce: nonceA, sequence: 2, status: 'ready', instanceId: 'i-b',
      hwnd: '202', foreground: true, minimized: false
    });
    await vi.waitFor(() => expect(effects).toEqual(['start:101']));
    releaseFirst?.();
    await Promise.all([oldCall, newCall]);

    expect(effects).toEqual(['start:101', 'finish:101', 'start:202', 'finish:202']);
  });

  test('非准确前台、歧义、不可用和桥错误均不调整层级', async () => {
    const activate = vi.fn(async () => undefined);
    const coordinator = new ExplorerPetLayerCoordinator({
      layer: { activate, dispose: async () => undefined },
      setAlwaysOnTop: vi.fn(),
      reportError: vi.fn()
    });

    await coordinator.accept({
      nonce: nonceA, sequence: 1, status: 'ready', instanceId: 'i-1',
      hwnd: '101', foreground: false, minimized: false
    });
    await coordinator.accept({
      nonce: nonceA, sequence: 2, status: 'ready', instanceId: 'i-1',
      hwnd: '101', foreground: true, minimized: true
    });
    await coordinator.accept({ nonce: nonceA, sequence: 3, status: 'ready' });
    await coordinator.accept({ nonce: nonceA, sequence: 4, status: 'ambiguous' });
    await coordinator.accept({ nonce: nonceA, sequence: 5, status: 'unavailable' });
    await coordinator.accept(new Error('BRIDGE_FAILED'));

    expect(activate).not.toHaveBeenCalled();
  });

  test('层级激活失败只报告错误，不尝试改变可见性', async () => {
    const reportError = vi.fn();
    const coordinator = new ExplorerPetLayerCoordinator({
      layer: {
        activate: async () => { throw new Error('native failure'); },
        dispose: async () => undefined
      },
      setAlwaysOnTop: vi.fn(),
      reportError
    });

    await coordinator.accept({
      nonce: nonceA, sequence: 1, status: 'ready', instanceId: 'i-1',
      hwnd: '101', foreground: true, minimized: false
    });

    expect(reportError).toHaveBeenCalledExactlyOnceWith('EXPLORER_LAYER_FAILED');
  });

  test('close 等待当前调用并拒绝后续动作', async () => {
    let releaseActivation: (() => void) | undefined;
    const activation = new Promise<void>(resolve => { releaseActivation = resolve; });
    const dispose = vi.fn(async () => undefined);
    const activate = vi.fn(async () => activation);
    const setAlwaysOnTop = vi.fn();
    const coordinator = new ExplorerPetLayerCoordinator({
      layer: {
        activate,
        dispose
      },
      setAlwaysOnTop,
      reportError: vi.fn()
    });

    const pending = coordinator.accept({
      nonce: nonceA, sequence: 1, status: 'ready', instanceId: 'i-1',
      hwnd: '101', foreground: true, minimized: false
    });
    await vi.waitFor(() => expect(activate).toHaveBeenCalledOnce());
    const topmost = coordinator.setPetAlwaysOnTop(true);
    const close = coordinator.close();
    await expect(coordinator.accept({ nonce: nonceA, sequence: 2, status: 'none' }))
      .rejects.toThrow('EXPLORER_LAYER_CLOSED');
    releaseActivation?.();
    await Promise.all([pending, topmost, close]);

    expect(setAlwaysOnTop).toHaveBeenCalledExactlyOnceWith(true);
    expect(dispose).toHaveBeenCalledOnce();
    await expect(coordinator.setPetAlwaysOnTop(false))
      .rejects.toThrow('EXPLORER_LAYER_CLOSED');
  });
});
