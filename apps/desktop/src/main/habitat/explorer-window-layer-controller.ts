const MAX_NATIVE_HWND = '18446744073709551615';

export type ExplorerLayerUnsafeReason =
  | 'explorer-blurred'
  | 'explorer-minimized'
  | 'explorer-closed'
  | 'tab-race'
  | 'hwnd-invalid'
  | 'leave';

export interface ExplorerLayerWindow {
  moveAbove(mediaSourceId: string): void;
  isDestroyed(): boolean;
  isAlwaysOnTop(): boolean;
}

export interface ExplorerWindowLayerTarget {
  explorerHwnd: string;
}

/** 只接受规范的无符号十进制 HWND 原文，避免 JS number 损失句柄精度。 */
function requireCanonicalHwnd(hwnd: string): string {
  if (!/^[1-9][0-9]{0,19}$/.test(hwnd)) {
    throw new Error('EXPLORER_LAYER_HWND_INVALID');
  }
  if (hwnd.length === MAX_NATIVE_HWND.length && hwnd > MAX_NATIVE_HWND) {
    throw new Error('EXPLORER_LAYER_HWND_INVALID');
  }
  return hwnd;
}

/** 从已验证 HWND 原文构造 Electron 固定窗口媒体源标识。 */
export function buildExplorerWindowMediaSourceId(hwnd: string): string {
  return `window:${requireCanonicalHwnd(hwnd)}:0`;
}

/** 只负责 Electron 相邻层级，绝不改变窗口可见性。 */
export class ExplorerWindowLayerController {
  private disposed = false;
  private disposePromise: Promise<void> | undefined;

  constructor(private readonly options: { window: ExplorerLayerWindow }) {}

  async activate(target: ExplorerWindowLayerTarget): Promise<void> {
    if (this.disposed) throw new Error('EXPLORER_LAYER_DISPOSED');
    const explorerHwnd = requireCanonicalHwnd(target.explorerHwnd);
    if (this.options.window.isDestroyed()) {
      throw new Error('EXPLORER_LAYER_WINDOW_DESTROYED');
    }
    if (this.options.window.isAlwaysOnTop()) {
      throw new Error('EXPLORER_LAYER_TOPMOST_FORBIDDEN');
    }
    this.options.window.moveAbove(buildExplorerWindowMediaSourceId(explorerHwnd));
  }

  /** 释放后不再触碰窗口，重复调用返回同一完成 Promise。 */
  dispose(): Promise<void> {
    if (this.disposePromise !== undefined) return this.disposePromise;
    this.disposed = true;
    this.disposePromise = Promise.resolve();
    return this.disposePromise;
  }
}
