import type {
  PetInteractionProbeEvent,
  PetInteractionProbe
} from '../../shared/pet-window-interaction';

type PetInteractionWindow = {
  setIgnoreMouseEvents(ignore: boolean, options?: { forward: boolean }): void;
  isDestroyed(): boolean;
};

export type PetWindowInteractionControllerOptions = { window: PetInteractionWindow };

/** Main 只裁决透明像素穿透；窗口移动由 Windows 原生 draggable region 独占。 */
export class PetWindowInteractionController {
  private disposed = false;
  private lastKnownPassthrough: boolean | undefined;
  private readonly probeCounts = { mouseMoveHitCount: 0 };

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

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.restoreSafePassthrough();
  }

  /** 兼容既有受限诊断形状；原生拖拽事实由 Main E2E state 单独公开。 */
  getProbe(): PetInteractionProbe {
    return { passthrough: this.lastKnownPassthrough ?? true, dragging: false, ...this.probeCounts };
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
