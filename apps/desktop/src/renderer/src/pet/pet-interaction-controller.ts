import type { PetWindowInteractionApi } from '../../../shared/pet-window-interaction';

export type CharacterHitTestPort = {
  hitTest(point: { x: number; y: number }): boolean;
  subscribe(listener: () => void): () => void;
};

type PetInteractionControllerOptions = {
  onDragStart?: (pointerId: number) => void;
  onDragEnd?: () => void;
};

/**
 * CSS 备用角色没有像素掩码，只允许其真实可见矩形接管鼠标。
 */
export function createElementBoundsHitTestPort(
  element: HTMLElement
): CharacterHitTestPort {
  return {
    hitTest(point) {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
      if (!element.isConnected || element.hidden) return false;
      try {
        const style = getComputedStyle(element);
        if (
          style.display === 'none'
          || style.visibility === 'hidden'
          || style.visibility === 'collapse'
        ) {
          return false;
        }
        const bounds = element.getBoundingClientRect();
        if (
          !Number.isFinite(bounds.left)
          || !Number.isFinite(bounds.top)
          || !Number.isFinite(bounds.right)
          || !Number.isFinite(bounds.bottom)
          || bounds.width <= 0
          || bounds.height <= 0
        ) {
          return false;
        }
        return point.x >= bounds.left
          && point.x < bounds.right
          && point.y >= bounds.top
          && point.y < bounds.bottom;
      } catch {
        return false;
      }
    },
    subscribe(listener) {
      if (typeof ResizeObserver === 'undefined') return () => undefined;
      let active = true;
      let observer: ResizeObserver;
      try {
        observer = new ResizeObserver(() => {
          if (active) listener();
        });
        observer.observe(element);
      } catch {
        return () => undefined;
      }
      return () => {
        if (!active) return;
        active = false;
        observer.disconnect();
      };
    }
  };
}

/**
 * Renderer 只维护命中与拖拽会话状态；系统窗口操作全部委托给受限 preload API。
 */
export class PetInteractionController {
  private disposed = false;
  private hitTestPort: CharacterHitTestPort | null = null;
  private unsubscribeHitRegion: (() => void) | null = null;
  private latestPoint: { x: number; y: number } | null = null;
  private activePointerId: number | null = null;
  private requestedPassthrough: boolean | undefined;

  constructor(
    private readonly api: PetWindowInteractionApi,
    private readonly options: PetInteractionControllerOptions = {}
  ) {
    this.requestPassthrough(true);
  }

  setHitTestPort(port: CharacterHitTestPort | null): void {
    if (this.disposed) return;
    this.unsubscribeHitRegion?.();
    this.unsubscribeHitRegion = null;
    this.hitTestPort = port;
    if (port) {
      try {
        this.unsubscribeHitRegion = port.subscribe(() => this.refreshPassthrough());
      } catch {
        this.hitTestPort = null;
      }
    }
    this.refreshPassthrough();
  }

  handlePointerMove(point: { x: number; y: number }): void {
    if (this.disposed) return;
    this.latestPoint = { ...point };
    this.refreshPassthrough();
  }

  handlePointerDown(
    event: Pick<PointerEvent, 'button' | 'pointerId'>
  ): void {
    if (
      this.disposed
      || event.button !== 0
      || this.activePointerId !== null
      || !this.isCurrentPointHit()
    ) {
      return;
    }
    this.activePointerId = event.pointerId;
    this.options.onDragStart?.(event.pointerId);
    this.requestPassthrough(false);
    void this.api.beginPetDrag().catch(() => {
      if (this.disposed || this.activePointerId !== event.pointerId) return;
      this.activePointerId = null;
      this.options.onDragEnd?.();
      this.requestPassthrough(true);
    });
  }

  handlePointerUp(): void {
    this.finishDrag();
  }

  handlePointerCancel(): void {
    this.finishDrag();
  }

  handleContextMenu(): void {
    if (this.disposed || !this.isCurrentPointHit()) return;
    void this.api.openPetContextMenu().catch(() => {
      this.requestPassthrough(true);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    const hadActiveDrag = this.activePointerId !== null;
    this.disposed = true;
    this.activePointerId = null;
    this.unsubscribeHitRegion?.();
    this.unsubscribeHitRegion = null;
    this.hitTestPort = null;
    if (hadActiveDrag) {
      this.options.onDragEnd?.();
      void this.api.endPetDrag().catch(() => undefined);
    }
    this.requestPassthrough(true, true);
  }

  private finishDrag(): void {
    if (this.disposed || this.activePointerId === null) return;
    this.activePointerId = null;
    this.options.onDragEnd?.();
    void this.api.endPetDrag().catch(() => {
      this.requestPassthrough(true);
    });
    this.refreshPassthrough();
  }

  private refreshPassthrough(): void {
    if (this.disposed || this.activePointerId !== null) return;
    this.requestPassthrough(!this.isCurrentPointHit());
  }

  private isCurrentPointHit(): boolean {
    if (!this.latestPoint || !this.hitTestPort) return false;
    try {
      return this.hitTestPort.hitTest(this.latestPoint);
    } catch {
      return false;
    }
  }

  private requestPassthrough(
    ignore: boolean,
    force = false,
    retrySafe = true
  ): void {
    if ((this.disposed && !force) || this.requestedPassthrough === ignore) return;
    this.requestedPassthrough = ignore;
    void this.api.setPetMousePassthrough(ignore).catch(() => {
      if (this.requestedPassthrough === ignore) {
        this.requestedPassthrough = undefined;
      }
      if (!ignore || retrySafe) {
        this.requestPassthrough(true, this.disposed, !ignore);
      }
    });
  }
}
