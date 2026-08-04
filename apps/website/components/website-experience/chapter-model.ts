import type { ChapterVisualState } from './types';

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
