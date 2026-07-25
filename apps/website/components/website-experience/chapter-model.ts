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

export function deriveChapterVisualState(
  index: number,
  progress: number,
  reducedMotion: boolean
): ChapterVisualState {
  const distance = index - progress;
  const visible = Math.abs(distance) <= 1;
  const opacity = visible ? 1 - Math.min(1, Math.abs(distance)) : 0;
  const exiting = distance < 0;
  const scale = reducedMotion
    ? 1
    : exiting
      ? 1 - Math.min(1, -distance) * 0.42
      : 1 + Math.min(1, distance) * 0.32;

  return {
    opacity,
    scale,
    blurPx: reducedMotion ? 0 : Math.min(1, Math.abs(distance)) * 10,
    contrast: reducedMotion
      ? 1
      : 1 - Math.min(1, Math.abs(distance)) * 0.18,
    zIndex: exiting ? 1 : 2,
    visible,
    interactive: Math.abs(distance) < 0.0001
  };
}
