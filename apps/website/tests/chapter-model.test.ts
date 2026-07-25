import { describe, expect, it } from 'vitest';
import {
  applyChapterDelta,
  clampChapterProgress,
  deriveChapterVisualState,
  snapChapterProgress
} from '../components/website-experience/chapter-model';

describe('官网章节进度模型', () => {
  it('限制进度并阻止一次输入跨越相邻章节', () => {
    expect(clampChapterProgress(-1, 5)).toBe(0);
    expect(clampChapterProgress(8, 5)).toBe(4);
    expect(applyChapterDelta(0, 8, 0, 5)).toBe(1);
    expect(applyChapterDelta(2, -8, 2, 5)).toBe(1);
  });

  it('吸附到最近章节并保持硬边界', () => {
    expect(snapChapterProgress(1.49, 5)).toBe(1);
    expect(snapChapterProgress(1.51, 5)).toBe(2);
    expect(snapChapterProgress(4.8, 5)).toBe(4);
  });

  it('以同一模型生成对称的退出和进入视觉', () => {
    expect(deriveChapterVisualState(0, 0.5, false)).toMatchObject({
      opacity: 0.5,
      scale: 0.79,
      interactive: false
    });
    expect(deriveChapterVisualState(1, 0.5, false)).toMatchObject({
      opacity: 0.5,
      scale: 1.16,
      interactive: false
    });
    expect(deriveChapterVisualState(1, 1, false)).toMatchObject({
      opacity: 1,
      scale: 1,
      interactive: true
    });
  });

  it('减少动态效果时只保留交叉渐隐', () => {
    expect(deriveChapterVisualState(1, 0.5, true)).toMatchObject({
      opacity: 0.5,
      scale: 1,
      blurPx: 0
    });
  });
});
