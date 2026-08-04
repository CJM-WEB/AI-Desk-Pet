import { describe, expect, it } from 'vitest';
import {
  applyChapterDelta,
  clampChapterProgress,
  deriveChapterVisualState,
  interpolateChapterSnapProgress,
  snapChapterProgress
} from '../components/website-experience/chapter-model';
import {
  isIntroPhase,
  reduceIntroPhase
} from '../components/home-experience/intro-phase-model';
import {
  applyWheelChapterInput,
  calculateSwipeDelta,
  isLocalInputElement
} from '../components/website-experience/use-website-controller';
import {
  CHAPTER_REGISTRY,
  getChapterIndex
} from '../components/website-experience/chapter-registry';

describe('官网章节进度模型', () => {
  it('按确认顺序注册六个章节', () => {
    expect(CHAPTER_REGISTRY.map((chapter) => chapter.id)).toEqual([
      'home',
      'about',
      'download',
      'community',
      'feedback',
      'donation'
    ]);
    expect(getChapterIndex('feedback')).toBe(4);
    expect(getChapterIndex('donation')).toBe(5);
  });

  it('识别局部滚动输入并忽略短触屏移动', () => {
    const local = {
      closest: (selector: string) => selector === '[data-input-scope="local"]'
        ? {}
        : null
    };

    expect(isLocalInputElement(local)).toBe(true);
    expect(calculateSwipeDelta(500, 470)).toBe(0);
    expect(calculateSwipeDelta(500, 430)).toBe(1);
    expect(calculateSwipeDelta(500, 570)).toBe(-1);
  });

  it('限制进度并阻止一次输入跨越相邻章节', () => {
    expect(clampChapterProgress(-1, 5)).toBe(0);
    expect(clampChapterProgress(8, 5)).toBe(4);
    expect(applyChapterDelta(0, 8, 0, 5)).toBe(1);
    expect(applyChapterDelta(2, -8, 2, 5)).toBe(1);
  });

  it('滚轮输入按配置缩放并限制在稳定章节的相邻范围', () => {
    expect(applyWheelChapterInput({
      progress: 0.2,
      deltaY: 100,
      settledIndex: 0,
      chapterCount: 5
    })).toBeCloseTo(0.85);
    expect(applyWheelChapterInput({
      progress: 2,
      deltaY: 100_000,
      settledIndex: 2,
      chapterCount: 5
    })).toBe(3);
    expect(applyWheelChapterInput({
      progress: 2,
      deltaY: -100_000,
      settledIndex: 2,
      chapterCount: 5
    })).toBe(1);
  });

  it('吸附到最近章节并保持硬边界', () => {
    expect(snapChapterProgress(1.49, 5)).toBe(1);
    expect(snapChapterProgress(1.51, 5)).toBe(2);
    expect(snapChapterProgress(4.8, 5)).toBe(4);
  });

  it('仅把绘制和稳定阶段识别为可跳过的开场', () => {
    expect(isIntroPhase('loading')).toBe(false);
    expect(isIntroPhase('drawing')).toBe(true);
    expect(isIntroPhase('settling')).toBe(true);
    expect(isIntroPhase('interactive')).toBe(false);
  });

  it('开场跳过从绘制阶段直接进入交互态', () => {
    expect(reduceIntroPhase('drawing', 'skip')).toBe('interactive');
    expect(reduceIntroPhase('settling', 'skip')).toBe('interactive');
  });

  it('正常开场只按绘制、稳定、交互顺序推进', () => {
    const settling = reduceIntroPhase('drawing', 'drawing-done');
    expect(settling).toBe('settling');
    expect(reduceIntroPhase(settling, 'settled')).toBe('interactive');
  });

  it('章节吸附通过中间帧靠近目标而不是瞬跳', () => {
    expect(interpolateChapterSnapProgress(0.96, 1, 0.5)).toBeCloseTo(0.995);
    expect(interpolateChapterSnapProgress(0.96, 1, 1)).toBe(1);
  });

  it('以同一模型生成对称的退出和进入视觉', () => {
    expect(deriveChapterVisualState(0, 0.5, false)).toMatchObject({
      opacity: 0.5,
      scale: 1,
      blurPx: 0,
      interactive: false
    });
    expect(deriveChapterVisualState(1, 0.5, false)).toMatchObject({
      opacity: 0.5,
      scale: 1,
      blurPx: 0,
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
      blurPx: 0,
      contrast: 1
    });
  });
});
