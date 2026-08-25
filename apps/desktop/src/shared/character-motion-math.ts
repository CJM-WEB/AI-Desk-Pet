import type { CharacterMotionPoint } from './character-motion-ipc';

export type MotionBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type MotionAdvanceInput = {
  current: CharacterMotionPoint;
  target: CharacterMotionPoint;
  speed: number;
  deltaMs: number;
  maxDeltaMs?: number;
  arrivalToleranceDip?: number;
  bounds?: MotionBounds;
};

export type MotionAdvanceResult = {
  position: CharacterMotionPoint;
  arrived: boolean;
};

function validPoint(point: CharacterMotionPoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function constrain(
  point: CharacterMotionPoint,
  bounds?: MotionBounds
): CharacterMotionPoint {
  if (!bounds) return point;
  if (
    !validPoint(bounds)
    || !Number.isFinite(bounds.width)
    || !Number.isFinite(bounds.height)
    || bounds.width < 0
    || bounds.height < 0
  ) {
    throw new Error('CHARACTER_MOTION_INPUT_INVALID');
  }
  return {
    x: clamp(point.x, bounds.x, bounds.x + bounds.width),
    y: clamp(point.y, bounds.y, bounds.y + bounds.height)
  };
}

/** Main 与 Renderer 共用同一无副作用运动数学，不跨层依赖 UI 模块。 */
export function advanceMotion(input: MotionAdvanceInput): MotionAdvanceResult {
  const maxDeltaMs = input.maxDeltaMs ?? input.deltaMs;
  if (
    !validPoint(input.current)
    || !validPoint(input.target)
    || !Number.isFinite(input.speed)
    || input.speed < 0
    || !Number.isFinite(input.deltaMs)
    || input.deltaMs < 0
    || !Number.isFinite(maxDeltaMs)
    || maxDeltaMs < 0
  ) {
    throw new Error('CHARACTER_MOTION_INPUT_INVALID');
  }
  const current = constrain(input.current, input.bounds);
  const target = constrain(input.target, input.bounds);
  const dx = target.x - current.x;
  const dy = target.y - current.y;
  const distance = Math.hypot(dx, dy);
  const travel = input.speed * Math.min(input.deltaMs, maxDeltaMs) / 1_000;
  const arrivalToleranceDip = input.arrivalToleranceDip ?? 0;
  if (!Number.isFinite(arrivalToleranceDip) || arrivalToleranceDip < 0) {
    throw new Error('CHARACTER_MOTION_INPUT_INVALID');
  }
  if (distance <= arrivalToleranceDip) {
    return { position: current, arrived: true };
  }
  if (travel >= distance) {
    return { position: target, arrived: true };
  }
  if (travel === 0) return { position: current, arrived: false };
  const ratio = travel / distance;
  return {
    position: constrain({
      x: current.x + dx * ratio,
      y: current.y + dy * ratio
    }, input.bounds),
    arrived: false
  };
}
