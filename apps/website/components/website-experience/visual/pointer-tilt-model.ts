import type { PointerPoint } from '../../home-experience/types';

export interface ViewportSize {
  width: number;
  height: number;
}

export interface PointerTilt {
  rotateX: number;
  rotateY: number;
}

const STATIC_TILT: PointerTilt = { rotateX: 0, rotateY: 0 };

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function canonicalizeZero(value: number): number {
  return value === 0 ? 0 : value;
}

/**
 * 将指针位置映射为不离开原命中区域的受限标题倾斜。
 */
export function computePointerTilt(
  pointer: PointerPoint,
  viewport: ViewportSize,
  maxDegrees = 5
): PointerTilt {
  if (
    !Number.isFinite(pointer.x)
    || !Number.isFinite(pointer.y)
    || !Number.isFinite(viewport.width)
    || !Number.isFinite(viewport.height)
    || !Number.isFinite(maxDegrees)
    || viewport.width <= 0
    || viewport.height <= 0
    || maxDegrees <= 0
  ) {
    return STATIC_TILT;
  }

  const normalizedX = clamp(
    (pointer.x - (viewport.width / 2)) / (viewport.width / 2),
    -1,
    1
  );
  const normalizedY = clamp(
    (pointer.y - (viewport.height / 2)) / (viewport.height / 2),
    -1,
    1
  );

  return {
    rotateX: canonicalizeZero(normalizedY * -maxDegrees),
    rotateY: canonicalizeZero(normalizedX * maxDegrees)
  };
}
