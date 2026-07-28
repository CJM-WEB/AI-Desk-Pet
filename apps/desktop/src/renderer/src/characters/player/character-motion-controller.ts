import type {
  CharacterMotionPoint,
  CharacterMotionSnapshot
} from '../../../../shared/character-motion-ipc';
import {
  advanceMotion,
  type MotionBounds
} from '../../../../shared/character-motion-math';

export {
  advanceMotion,
  type MotionAdvanceInput,
  type MotionAdvanceResult,
  type MotionBounds
} from '../../../../shared/character-motion-math';

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function validatePoint(point: CharacterMotionPoint): void {
  if (!finite(point.x) || !finite(point.y)) {
    throw new Error('CHARACTER_MOTION_INPUT_INVALID');
  }
}

/**
 * anchor 必须是播放器输出的显示空间坐标，播放器已完成方向镜像。
 * direction 只用于调用方显式记录契约，不参与第二次镜像。
 */
export function resolveDesktopAnchor(
  anchor: CharacterMotionPoint,
  frame: MotionBounds,
  direction: 'left' | 'right'
): CharacterMotionPoint {
  validatePoint(anchor);
  void direction;
  if (
    anchor.x < 0
    || anchor.x > 1
    || anchor.y < 0
    || anchor.y > 1
    || !finite(frame.x)
    || !finite(frame.y)
    || !finite(frame.width)
    || !finite(frame.height)
    || frame.width < 0
    || frame.height < 0
  ) {
    throw new Error('CHARACTER_MOTION_INPUT_INVALID');
  }
  return {
    x: frame.x + frame.width * anchor.x,
    y: frame.y + frame.height * anchor.y
  };
}

export type CharacterMotionControllerOptions = {
  position: CharacterMotionPoint;
  speed?: number;
  maxDeltaMs?: number;
  maxResidualPx?: number;
};

/** Renderer 仅平滑表现 Main 快照，修订号决定快照所有权。 */
export class CharacterMotionController {
  private position: CharacterMotionPoint;
  private snapshot: CharacterMotionSnapshot | null = null;
  private lastAdvanceMs: number | null = null;
  private readonly speed: number;
  private readonly maxDeltaMs: number;
  private readonly maxResidualPx: number;

  constructor(options: CharacterMotionControllerOptions) {
    validatePoint(options.position);
    this.position = { ...options.position };
    this.speed = options.speed ?? 240;
    this.maxDeltaMs = options.maxDeltaMs ?? 100;
    this.maxResidualPx = options.maxResidualPx ?? 48;
  }

  accept(snapshot: CharacterMotionSnapshot): boolean {
    if (this.snapshot && snapshot.revision <= this.snapshot.revision) return false;
    validatePoint(snapshot.position);
    validatePoint(snapshot.target);
    if (!this.snapshot) {
      this.position = { ...snapshot.position };
      // Main 时间戳只用于快照元数据；本地 delta 从首个 RAF 建立基线。
      this.lastAdvanceMs = null;
    } else {
      const deltaX = this.position.x - snapshot.position.x;
      const deltaY = this.position.y - snapshot.position.y;
      const distance = Math.hypot(deltaX, deltaY);
      if (distance > this.maxResidualPx) {
        const scale = this.maxResidualPx / distance;
        this.position = {
          x: snapshot.position.x + deltaX * scale,
          y: snapshot.position.y + deltaY * scale
        };
      }
    }
    this.snapshot = structuredClone(snapshot);
    return true;
  }

  advance(nowMs: number): CharacterMotionSnapshot {
    if (!finite(nowMs) || nowMs < 0) {
      throw new Error('CHARACTER_MOTION_INPUT_INVALID');
    }
    const snapshot = this.snapshot;
    if (!snapshot) {
      return {
        revision: 0,
        timestampMs: nowMs,
        position: { ...this.position },
        target: { ...this.position },
        direction: 'right',
        moving: false,
        carrying: false
      };
    }
    const previous = this.lastAdvanceMs ?? nowMs;
    const next = advanceMotion({
      current: this.position,
      target: snapshot.position,
      speed: this.speed,
      deltaMs: Math.max(0, nowMs - previous),
      maxDeltaMs: this.maxDeltaMs
    });
    this.position = next.position;
    this.lastAdvanceMs = nowMs;
    return {
      ...snapshot,
      timestampMs: nowMs,
      position: { ...this.position },
      moving: snapshot.moving && !next.arrived
    };
  }
}
