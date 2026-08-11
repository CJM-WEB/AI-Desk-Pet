import type { ChapterVisualState } from './types';

/** 滚轮手势的累计方向。 */
export type WheelDirection = -1 | 0 | 1;

/** 用于判断滚轮解锁的纯输入状态。 */
export interface WheelGestureState {
  direction: WheelDirection;
  accumulated: number;
}

/** 滚轮解锁后交给章节进度的有向余量。 */
export interface WheelUnlockResult extends WheelGestureState {
  releasedDelta: number;
}

/** 将浏览器滚轮单位转换为像素。 */
export function normalizeWheelDelta(
  deltaY: number,
  deltaMode: number,
  viewportHeight: number
): number {
  if (!Number.isFinite(deltaY)) return 0;
  if (deltaMode === 1) return deltaY * 16;
  if (deltaMode === 2) return deltaY * Math.max(1, viewportHeight);
  return deltaY;
}

/** 累计同方向滚轮输入，并在超过阈值时释放余量。 */
export function accumulateWheelUnlock(
  state: WheelGestureState,
  delta: number,
  threshold: number
): WheelUnlockResult {
  const direction = Math.sign(delta) as WheelDirection;
  if (direction === 0) return { ...state, releasedDelta: 0 };
  if (threshold <= 0) {
    return { direction, accumulated: 0, releasedDelta: delta };
  }
  const accumulated = direction === state.direction
    ? state.accumulated + Math.abs(delta)
    : Math.abs(delta);
  const released = Math.max(0, accumulated - threshold);
  return {
    direction,
    accumulated: Math.min(accumulated, threshold),
    releasedDelta: released === 0 ? 0 : direction * released
  };
}

/** 按有限帧间隔指数逼近章节目标进度。 */
export function dampChapterProgress(
  current: number,
  target: number,
  deltaMs: number,
  timeConstantMs: number,
  maximumDeltaMs: number
): number {
  const safeDelta = Math.min(maximumDeltaMs, Math.max(0, deltaMs));
  const alpha = 1 - Math.exp(-safeDelta / Math.max(1, timeConstantMs));
  return current + (target - current) * alpha;
}

/** 判断章节进度是否已经逼近目标。 */
export function hasChapterProgressSettled(
  current: number,
  target: number,
  epsilon: number
): boolean {
  return Math.abs(target - current) < epsilon;
}

export function clampChapterProgress(value: number, chapterCount: number): number {
  const maximum = Math.max(0, chapterCount - 1);
  if (!Number.isFinite(value)) return 0;
  return Math.min(maximum, Math.max(0, value));
}

export function applyChapterDelta(
  progress: number,
  delta: number,
  settledIndex: number,
  chapterCount: number
): number {
  const minimum = Math.max(0, settledIndex - 1);
  const maximum = Math.min(chapterCount - 1, settledIndex + 1);
  return Math.min(maximum, Math.max(minimum, progress + delta));
}

export function snapChapterProgress(progress: number, chapterCount: number): number {
  return clampChapterProgress(Math.round(progress), chapterCount);
}

export function interpolateChapterSnapProgress(
  from: number,
  to: number,
  ratio: number
): number {
  const clampedRatio = Math.min(1, Math.max(0, ratio));
  const easedRatio = 1 - ((1 - clampedRatio) ** 3);
  return from + ((to - from) * easedRatio);
}

export function deriveChapterVisualState(
  index: number,
  progress: number,
  _reducedMotion: boolean
): ChapterVisualState {
  const distance = index - progress;
  const visible = Math.abs(distance) <= 1;
  const opacity = visible ? 1 - Math.min(1, Math.abs(distance)) : 0;
  const exiting = distance < 0;

  return {
    opacity,
    // 章节改为原位直接交接，不再使用前后推拉镜头。
    scale: 1,
    blurPx: 0,
    contrast: 1,
    zIndex: exiting ? 1 : 2,
    visible,
    interactive: Math.abs(distance) < 0.0001
  };
}
