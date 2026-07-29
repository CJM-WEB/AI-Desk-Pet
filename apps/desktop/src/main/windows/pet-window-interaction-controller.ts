import type { Rectangle } from 'electron';
import { clampPositionToVisibleWorkArea } from './window-manager';

type PetInteractionWindow = {
  getBounds(): Rectangle;
  setPosition(x: number, y: number): void;
  setIgnoreMouseEvents(ignore: boolean, options?: { forward: boolean }): void;
  isDestroyed(): boolean;
};

type PetInteractionScreen = {
  getCursorScreenPoint(): { x: number; y: number };
  getAllDisplays(): readonly { workArea: Rectangle }[];
};

type PetInteractionMotion = {
  beginUserMove(): void;
  endUserMove(): void;
};

export type PetWindowInteractionControllerOptions = {
  window: PetInteractionWindow;
  screen: PetInteractionScreen;
  motion: PetInteractionMotion;
};

type DragSession = {
  initialCursor: { x: number; y: number };
  initialBounds: Rectangle;
  interval?: ReturnType<typeof setInterval>;
  timeout?: ReturnType<typeof setTimeout>;
};

export type PetDragEndReason = 'released' | 'cancelled' | 'timeout' | 'disposed';

/** Main 独占系统光标、原生窗口移动与穿透状态，Renderer 不提供任何坐标。 */
export class PetWindowInteractionController {
  private disposed = false;
  private lastKnownPassthrough: boolean | undefined;
  private dragSession: DragSession | undefined;

  constructor(private readonly options: PetWindowInteractionControllerOptions) {
    this.setPassthrough(true);
  }

  setPassthrough(ignore: boolean): void {
    if (this.disposed) return;
    this.lastKnownPassthrough = ignore;
    if (this.dragSession) return;
    try {
      this.applyPassthrough(ignore);
    } catch {
      this.lastKnownPassthrough = undefined;
      this.restoreSafePassthrough();
    }
  }

  beginDrag(): void {
    if (this.disposed || this.dragSession || !this.windowAvailable()) return;
    let motionStarted = false;
    try {
      const initialCursor = this.options.screen.getCursorScreenPoint();
      const initialBounds = this.options.window.getBounds();
      this.options.motion.beginUserMove();
      motionStarted = true;
      this.applyPassthrough(false);

      const session: DragSession = {
        initialCursor,
        initialBounds
      };
      this.dragSession = session;
      session.interval = setInterval(() => this.updateDrag(session), 16);
      session.timeout = setTimeout(() => this.endDrag('timeout'), 30_000);
    } catch {
      const failedSession = this.dragSession;
      this.dragSession = undefined;
      if (failedSession?.interval) clearInterval(failedSession.interval);
      if (failedSession?.timeout) clearTimeout(failedSession.timeout);
      if (motionStarted) {
        try {
          this.options.motion.endUserMove();
        } catch {
          // motion 清理失败不应阻止窗口恢复安全穿透。
        }
      }
      this.lastKnownPassthrough = undefined;
      this.restoreSafePassthrough();
    }
  }

  endDrag(reason: PetDragEndReason): void {
    const session = this.dragSession;
    if (!session) return;
    this.dragSession = undefined;
    if (session.interval) clearInterval(session.interval);
    if (session.timeout) clearTimeout(session.timeout);
    try {
      this.options.motion.endUserMove();
    } catch {
      this.lastKnownPassthrough = undefined;
    }

    if (reason === 'disposed') {
      this.restoreSafePassthrough();
      return;
    }
    const nextPassthrough = this.lastKnownPassthrough ?? true;
    try {
      this.applyPassthrough(nextPassthrough);
    } catch {
      this.lastKnownPassthrough = undefined;
      this.restoreSafePassthrough();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.dragSession) {
      this.endDrag('disposed');
    } else {
      this.restoreSafePassthrough();
    }
  }

  private updateDrag(session: DragSession): void {
    if (this.dragSession !== session) return;
    if (!this.windowAvailable()) {
      this.endDrag('cancelled');
      return;
    }
    try {
      const cursor = this.options.screen.getCursorScreenPoint();
      const next = clampPositionToVisibleWorkArea(
        {
          x: session.initialBounds.x + cursor.x - session.initialCursor.x,
          y: session.initialBounds.y + cursor.y - session.initialCursor.y
        },
        {
          width: session.initialBounds.width,
          height: session.initialBounds.height
        },
        this.options.screen.getAllDisplays().map(display => display.workArea)
      );
      this.options.window.setPosition(next.x, next.y);
    } catch {
      this.lastKnownPassthrough = undefined;
      this.endDrag('cancelled');
    }
  }

  private windowAvailable(): boolean {
    try {
      return !this.options.window.isDestroyed();
    } catch {
      return false;
    }
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
    if (!this.windowAvailable()) return;
    try {
      this.options.window.setIgnoreMouseEvents(true, { forward: true });
    } catch {
      // 窗口正处于销毁阶段时只做 best-effort 恢复。
    }
  }
}
