import { describe, expect, it, vi } from 'vitest';

import {
  ExplorerWindowLayerController,
  buildExplorerWindowMediaSourceId
} from '../src/main/explorer/explorer-window-layer-controller';

class FakeLayerWindow {
  readonly moveAbove = vi.fn<(mediaSourceId: string) => void>();
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

  it('构造器只接收层级所需窗口端口，activate 只调用 moveAbove', async () => {
    const window = new FakeLayerWindow();
    const controller = new ExplorerWindowLayerController({ window });

    await controller.activate({ explorerHwnd: '43210' });

    expect(window.moveAbove).toHaveBeenCalledExactlyOnceWith('window:43210:0');
  });

  it('dispose 幂等，释放后拒绝激活且不再触碰窗口', async () => {
    const window = new FakeLayerWindow();
    const controller = new ExplorerWindowLayerController({ window });
    await controller.activate({ explorerHwnd: '10' });

    const disposal = controller.dispose();
    expect(controller.dispose()).toBe(disposal);
    await disposal;
    await expect(controller.activate({ explorerHwnd: '20' }))
      .rejects.toThrow('EXPLORER_LAYER_DISPOSED');
    expect(window.moveAbove).toHaveBeenCalledOnce();
  });

  it('非法 HWND、topmost、窗口销毁与 moveAbove 异常均不调整层级', async () => {
    const invalidWindow = new FakeLayerWindow();
    await expect(new ExplorerWindowLayerController({ window: invalidWindow })
      .activate({ explorerHwnd: '01' })).rejects.toThrow('EXPLORER_LAYER_HWND_INVALID');
    expect(invalidWindow.moveAbove).not.toHaveBeenCalled();

    const topmostWindow = new FakeLayerWindow();
    topmostWindow.isAlwaysOnTop.mockReturnValue(true);
    await expect(new ExplorerWindowLayerController({ window: topmostWindow })
      .activate({ explorerHwnd: '10' })).rejects.toThrow('EXPLORER_LAYER_TOPMOST_FORBIDDEN');
    expect(topmostWindow.moveAbove).not.toHaveBeenCalled();

    const destroyedWindow = new FakeLayerWindow();
    destroyedWindow.isDestroyed.mockReturnValue(true);
    await expect(new ExplorerWindowLayerController({ window: destroyedWindow })
      .activate({ explorerHwnd: '10' })).rejects.toThrow('EXPLORER_LAYER_WINDOW_DESTROYED');
    expect(destroyedWindow.moveAbove).not.toHaveBeenCalled();

    const failedWindow = new FakeLayerWindow();
    failedWindow.moveAbove.mockImplementation(() => { throw new Error('native failure'); });
    await expect(new ExplorerWindowLayerController({ window: failedWindow })
      .activate({ explorerHwnd: '10' })).rejects.toThrow('native failure');
    expect(failedWindow.moveAbove).toHaveBeenCalledOnce();
  });
});
