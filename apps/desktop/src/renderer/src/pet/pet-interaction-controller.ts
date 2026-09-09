import type { PetWindowInteractionApi } from '../../../shared/pet-window-interaction';

export type CharacterHitTestPort = {
  kind?: 'alpha' | 'fallback';
  hitTest(point: { x: number; y: number }): boolean;
  subscribe(listener: () => void): () => void;
};

export type PetInteractionControllerOptions = Record<string, never>;

/**
 * CSS 备用角色没有像素掩码，只允许其真实可见矩形接管鼠标。
 */
export function createElementBoundsHitTestPort(
  element: HTMLElement
): CharacterHitTestPort {
  return {
    kind: 'fallback',
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
      let active = true;
      let observer: ResizeObserver | null = null;
      let animationFrame: number | null = null;
      let previousBounds = readElementBounds(element);
      const checkBounds = (): void => {
        if (!active) return;
        const nextBounds = readElementBounds(element);
        if (!sameElementBounds(previousBounds, nextBounds)) {
          previousBounds = nextBounds;
          listener();
        }
      };
      const checkAnimationFrame = (): void => {
        checkBounds();
        if (active && typeof requestAnimationFrame === 'function') {
          animationFrame = requestAnimationFrame(checkAnimationFrame);
        }
      };
      if (typeof ResizeObserver !== 'undefined') {
        try {
          observer = new ResizeObserver(checkBounds);
          observer.observe(element);
        } catch {
          observer = null;
        }
      }
      if (typeof requestAnimationFrame === 'function') {
        animationFrame = requestAnimationFrame(checkAnimationFrame);
      }
      return () => {
        if (!active) return;
        active = false;
        observer?.disconnect();
        if (
          animationFrame !== null
          && typeof cancelAnimationFrame === 'function'
        ) {
          cancelAnimationFrame(animationFrame);
        }
      };
    }
  };
}

type ElementBoundsSnapshot = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
} | null;

function readElementBounds(element: HTMLElement): ElementBoundsSnapshot {
  try {
    const bounds = element.getBoundingClientRect();
    return {
      left: bounds.left,
      top: bounds.top,
      right: bounds.right,
      bottom: bounds.bottom,
      width: bounds.width,
      height: bounds.height
    };
  } catch {
    return null;
  }
}

function sameElementBounds(
  left: ElementBoundsSnapshot,
  right: ElementBoundsSnapshot
): boolean {
  if (!left || !right) return left === right;
  return left.left === right.left
    && left.top === right.top
    && left.right === right.right
    && left.bottom === right.bottom
    && left.width === right.width
    && left.height === right.height;
}

/**
 * Renderer 只维护像素命中、pointer capture 生命周期和无坐标拖拽节拍。
 */
export class PetInteractionController {
  private disposed = false;
  private hitTestPort: CharacterHitTestPort | null = null;
  private unsubscribeHitRegion: (() => void) | null = null;
  private latestPoint: { x: number; y: number } | null = null;
  private desiredPassthrough = true;
  private confirmedPassthrough: boolean | undefined;
  private passthroughInFlight = false;
  private blockedPassthrough: boolean | undefined;
  private safeRetryRemaining = 1;
  private dragging = false;

  constructor(
    private readonly api: PetWindowInteractionApi,
    _options: PetInteractionControllerOptions = {}
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

  handlePointerMove(point: { x: number; y: number }): boolean {
    if (this.disposed) return false;
    this.latestPoint = { ...point };
    if (this.dragging) {
      this.api.updatePetDrag();
      return true;
    }
    return this.refreshPassthrough();
  }

  handlePointerDown(point: { x: number; y: number }): boolean {
    if (this.disposed || this.dragging) return false;
    this.latestPoint = { ...point };
    if (!this.isCurrentPointHit()) return false;
    try {
      this.api.beginPetDrag();
      this.dragging = true;
      return true;
    } catch {
      return false;
    }
  }

  handlePointerUp(): void {
    if (!this.dragging) return;
    this.dragging = false;
    try { this.api.endPetDrag(); } catch {
      // Main 的窗口生命周期清理仍会释放拖拽 owner。
    }
    this.refreshPassthrough();
  }

  handlePointerLeave(): void {
    if (this.disposed) return;
    if (this.dragging) return;
    this.latestPoint = null;
    this.refreshPassthrough();
  }

  dispose(): void {
    if (this.disposed) return;
    this.handlePointerUp();
    this.disposed = true;
    this.unsubscribeHitRegion?.();
    this.unsubscribeHitRegion = null;
    this.hitTestPort = null;
    this.requestPassthrough(true, true);
  }

  private refreshPassthrough(): boolean {
    if (this.disposed) return false;
    const hit = this.isCurrentPointHit();
    this.requestPassthrough(!hit);
    return hit;
  }

  private isCurrentPointHit(): boolean {
    return this.latestPoint ? this.isPointHit(this.latestPoint) : false;
  }

  private isPointHit(point: { x: number; y: number }): boolean {
    if (!this.hitTestPort) return false;
    try {
      return this.hitTestPort.hitTest(point);
    } catch {
      return false;
    }
  }

  private requestPassthrough(ignore: boolean, force = false): void {
    if (this.disposed && !force) return;
    if (this.desiredPassthrough !== ignore) {
      this.desiredPassthrough = ignore;
      this.blockedPassthrough = undefined;
      if (ignore) this.safeRetryRemaining = 1;
    } else if (
      ignore
      && (force || this.blockedPassthrough === true)
    ) {
      // 只有新的外部安全请求重开预算，pump 内部重试不会无限续期。
      this.blockedPassthrough = undefined;
      this.safeRetryRemaining = 1;
      if (force) this.confirmedPassthrough = undefined;
    }
    this.pumpPassthrough();
  }

  /**
   * 穿透 IPC 单通道串行提交；每次完成后重新读取最新意图，跳过过时中间态。
   */
  private pumpPassthrough(): void {
    if (
      this.passthroughInFlight
      || this.confirmedPassthrough === this.desiredPassthrough
      || this.blockedPassthrough === this.desiredPassthrough
    ) {
      return;
    }
    const requested = this.desiredPassthrough;
    this.passthroughInFlight = true;
    let operation: Promise<void>;
    try {
      operation = this.api.setPetMousePassthrough(requested);
    } catch {
      operation = Promise.reject(new Error('PET_PASSTHROUGH_REQUEST_FAILED'));
    }
    void operation.then(() => {
      this.confirmedPassthrough = requested;
      this.blockedPassthrough = undefined;
    }).catch(() => {
      if (this.desiredPassthrough !== requested) return;
      this.confirmedPassthrough = undefined;
      if (!requested) {
        this.desiredPassthrough = true;
        this.blockedPassthrough = undefined;
        this.safeRetryRemaining = 1;
        return;
      }
      if (this.safeRetryRemaining > 0) {
        this.safeRetryRemaining -= 1;
        return;
      }
      this.blockedPassthrough = true;
    }).finally(() => {
      this.passthroughInFlight = false;
      this.pumpPassthrough();
    });
  }
}
