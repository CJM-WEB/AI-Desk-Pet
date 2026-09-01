import type {
  PetInteractionProbeEvent,
  PetInteractionProbe
} from '../../shared/pet-window-interaction';
import type { Rectangle } from 'electron';
import { PET_WINDOW_SIZE } from './window-manager';

type PetInteractionWindow = {
  setIgnoreMouseEvents(ignore: boolean, options?: { forward: boolean }): void;
  getBounds(): Rectangle;
  setBounds(bounds: Rectangle): void;
  isDestroyed(): boolean;
};

export type PetWindowInteractionControllerOptions = {
  window: PetInteractionWindow;
  getCursorScreenPoint(): Readonly<{ x: number; y: number }>;
  onDragStarted?(): void;
  onDragEnded?(): void;
};

/** Main 读取系统光标并原子移动固定尺寸窗口；Renderer 只发送无坐标拖拽节拍。 */
export class PetWindowInteractionController {
  private disposed = false;
  private lastKnownPassthrough: boolean | undefined;
  private readonly probeCounts = { mouseMoveHitCount: 0 };
  private drag: Readonly<{
    cursor: Readonly<{ x: number; y: number }>;
    origin: Readonly<{ x: number; y: number }>;
  }> | null = null;

  constructor(private readonly options: PetWindowInteractionControllerOptions) {
    this.setPassthrough(true);
  }

  setPassthrough(ignore: boolean): void {
    if (this.disposed) return;
    this.lastKnownPassthrough = ignore;
    try { this.applyPassthrough(ignore); } catch {
      this.lastKnownPassthrough = undefined;
      this.restoreSafePassthrough();
    }
  }

  beginDrag(): void {
    if (this.disposed || this.drag || !this.windowAvailable()) return;
    let startCallbackEntered = false;
    try {
      const bounds = this.options.window.getBounds();
      this.drag = {
        cursor: this.options.getCursorScreenPoint(),
        origin: { x: bounds.x, y: bounds.y }
      };
      this.lastKnownPassthrough = false;
      this.applyPassthrough(false);
      startCallbackEntered = true;
      this.options.onDragStarted?.();
    } catch {
      this.drag = null;
      if (startCallbackEntered) {
        try { this.options.onDragEnded?.(); } catch { /* 继续恢复安全穿透。 */ }
      }
      this.restoreSafePassthrough();
    }
  }

  updateDrag(): void {
    const drag = this.drag;
    if (this.disposed || !drag) return;
    if (!this.windowAvailable()) {
      try { this.endDrag(); } finally { this.restoreSafePassthrough(); }
      return;
    }
    try {
      const cursor = this.options.getCursorScreenPoint();
      this.options.window.setBounds({
        x: drag.origin.x + cursor.x - drag.cursor.x,
        y: drag.origin.y + cursor.y - drag.cursor.y,
        width: PET_WINDOW_SIZE.width,
        height: PET_WINDOW_SIZE.height
      });
    } catch {
      try { this.endDrag(); } finally { this.restoreSafePassthrough(); }
    }
  }

  endDrag(): void {
    if (!this.drag) return;
    this.drag = null;
    try { this.options.onDragEnded?.(); } catch { this.restoreSafePassthrough(); }
  }

  dispose(): void {
    if (this.disposed) return;
    this.endDrag();
    this.disposed = true;
    this.restoreSafePassthrough();
  }

  /** 受限诊断只报告穿透、controller 拖拽与命中计数，不包含坐标或 native owner。 */
  getProbe(): PetInteractionProbe {
    return {
      passthrough: this.lastKnownPassthrough ?? true,
      dragging: this.drag !== null,
      ...this.probeCounts
    };
  }

  recordProbeEvent(_event: PetInteractionProbeEvent): void {
    this.probeCounts.mouseMoveHitCount = Math.min(
      Number.MAX_SAFE_INTEGER,
      this.probeCounts.mouseMoveHitCount + 1
    );
  }

  private windowAvailable(): boolean {
    try { return !this.options.window.isDestroyed(); } catch { return false; }
  }

  private applyPassthrough(ignore: boolean): void {
    if (!this.windowAvailable()) throw new Error('PET_WINDOW_DESTROYED');
    if (ignore) {
      this.options.window.setIgnoreMouseEvents(true, { forward: true });
      return;
    }
    this.options.window.setIgnoreMouseEvents(false);
  }

  private restoreSafePassthrough(): void {
    this.lastKnownPassthrough = true;
    if (!this.windowAvailable()) return;
    try { this.options.window.setIgnoreMouseEvents(true, { forward: true }); } catch {
      // 窗口销毁期间只做 best-effort 恢复。
    }
  }
}
