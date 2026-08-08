import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  ExplorerWindowLayerController,
  buildExplorerWindowMediaSourceId,
  type ExplorerLayerUnsafeReason
} from '../src/main/habitat/explorer-window-layer-controller';

class FakeLayerWindow {
  readonly moveAbove = vi.fn<(mediaSourceId: string) => void>();
  readonly hide = vi.fn<() => void>();
  readonly isDestroyed = vi.fn(() => false);
  readonly isAlwaysOnTop = vi.fn(() => false);
}

describe('ExplorerWindowLayerController Electron-only', () => {
  it('只接受规范无符号十进制 HWND，并构造固定媒体源 ID', () => {
    expect(buildExplorerWindowMediaSourceId('18446744073709551615'))
      .toBe('window:18446744073709551615:0');
    for (const invalid of ['0', '01', '-1', '1.0', 'window:1:0', '18446744073709551616']) {
      expect(() => buildExplorerWindowMediaSourceId(invalid))
        .toThrow('EXPLORER_LAYER_HWND_INVALID');
    }
  });

  it('构造器只接收窗口，activate 只接收 Explorer HWND 并调用 moveAbove', async () => {
    const window = new FakeLayerWindow();
    const controller = new ExplorerWindowLayerController({ window });

    await controller.activate({ explorerHwnd: '43210' });

    expect(window.moveAbove).toHaveBeenCalledExactlyOnceWith('window:43210:0');
    expect(window.hide).not.toHaveBeenCalled();
  });

  it.each<ExplorerLayerUnsafeReason>([
    'explorer-blurred', 'explorer-minimized', 'explorer-closed',
    'tab-race', 'hwnd-invalid', 'leave'
  ])('%s 立即执行幂等安全隐藏，重复失效仍可覆盖外部重新显示', async reason => {
    const window = new FakeLayerWindow();
    const controller = new ExplorerWindowLayerController({ window });
    await controller.activate({ explorerHwnd: '43210' });

    await controller.invalidate(reason);
    await controller.invalidate(reason);

    expect(window.hide).toHaveBeenCalledTimes(2);
  });

  it('失效关闭后可由新快照重新建立 Electron 层级', async () => {
    const window = new FakeLayerWindow();
    const controller = new ExplorerWindowLayerController({ window });
    await controller.activate({ explorerHwnd: '10' });
    await controller.invalidate('explorer-blurred');
    await controller.activate({ explorerHwnd: '20' });

    expect(window.moveAbove).toHaveBeenNthCalledWith(1, 'window:10:0');
    expect(window.moveAbove).toHaveBeenNthCalledWith(2, 'window:20:0');
    expect(window.hide).toHaveBeenCalledOnce();
  });

  it('leave 与 dispose 幂等隐藏，释放后拒绝激活且不再触碰窗口', async () => {
    const window = new FakeLayerWindow();
    const controller = new ExplorerWindowLayerController({ window });
    await controller.activate({ explorerHwnd: '10' });
    await controller.leave();
    expect(window.hide).toHaveBeenCalledTimes(1);

    const disposal = controller.dispose();
    expect(controller.dispose()).toBe(disposal);
    await disposal;
    await controller.invalidate('tab-race');
    await controller.leave();
    await expect(controller.activate({ explorerHwnd: '20' }))
      .rejects.toThrow('EXPLORER_LAYER_DISPOSED');
    expect(window.hide).toHaveBeenCalledTimes(2);
  });

  it('外部重新显示后，失败激活与 dispose 每次都重新执行隐藏', async () => {
    const window = new FakeLayerWindow();
    const controller = new ExplorerWindowLayerController({ window });
    await controller.activate({ explorerHwnd: '10' });
    await controller.invalidate('explorer-blurred');
    expect(window.hide).toHaveBeenCalledTimes(1);

    window.isAlwaysOnTop.mockReturnValue(true);
    await expect(controller.activate({ explorerHwnd: '10' }))
      .rejects.toThrow('EXPLORER_LAYER_TOPMOST_FORBIDDEN');
    expect(window.hide).toHaveBeenCalledTimes(2);

    window.isAlwaysOnTop.mockReturnValue(false);
    window.moveAbove.mockImplementation(() => { throw new Error('native failure'); });
    await expect(controller.activate({ explorerHwnd: '10' })).rejects.toThrow('native failure');
    expect(window.hide).toHaveBeenCalledTimes(3);

    await controller.dispose();
    expect(window.hide).toHaveBeenCalledTimes(4);
  });

  it('非法 HWND、topmost、窗口销毁与 moveAbove 异常均失败关闭', async () => {
    const invalidWindow = new FakeLayerWindow();
    await expect(new ExplorerWindowLayerController({ window: invalidWindow })
      .activate({ explorerHwnd: '01' })).rejects.toThrow('EXPLORER_LAYER_HWND_INVALID');
    expect(invalidWindow.hide).toHaveBeenCalledOnce();

    const topmostWindow = new FakeLayerWindow();
    topmostWindow.isAlwaysOnTop.mockReturnValue(true);
    await expect(new ExplorerWindowLayerController({ window: topmostWindow })
      .activate({ explorerHwnd: '10' })).rejects.toThrow('EXPLORER_LAYER_TOPMOST_FORBIDDEN');
    expect(topmostWindow.hide).toHaveBeenCalledOnce();

    const destroyedWindow = new FakeLayerWindow();
    destroyedWindow.isDestroyed.mockReturnValue(true);
    await expect(new ExplorerWindowLayerController({ window: destroyedWindow })
      .activate({ explorerHwnd: '10' })).rejects.toThrow('EXPLORER_LAYER_WINDOW_DESTROYED');
    expect(destroyedWindow.moveAbove).not.toHaveBeenCalled();

    const failedWindow = new FakeLayerWindow();
    failedWindow.moveAbove.mockImplementation(() => { throw new Error('native failure'); });
    await expect(new ExplorerWindowLayerController({ window: failedWindow })
      .activate({ explorerHwnd: '10' })).rejects.toThrow('native failure');
    expect(failedWindow.hide).toHaveBeenCalledOnce();
  });

  it('生产控制器不包含 User32、客户端、置顶、截图或焦点能力', () => {
    const source = readFileSync(resolve(
      import.meta.dirname, '../src/main/habitat/explorer-window-layer-controller.ts'
    ), 'utf8');
    for (const forbidden of [
      'user32', 'User32', 'placeNear', 'removeLayer', 'ExplorerWindowLayerClient',
      'setAlwaysOnTop', 'HWND_TOPMOST', 'desktopCapturer', '.focus(', '.show(', 'Number('
    ]) expect(source).not.toContain(forbidden);
  });
});
