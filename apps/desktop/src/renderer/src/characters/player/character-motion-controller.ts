import type {
  CharacterMotionPoint
} from '../../../../shared/character-motion-ipc';
import {
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
