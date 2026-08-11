import { describe, expect, it } from 'vitest';
import {
  applyChapterDelta,
  accumulateWheelUnlock,
  clampChapterProgress,
  dampChapterProgress,
  deriveChapterVisualState,
  hasChapterProgressSettled,
  interpolateChapterSnapProgress,
  normalizeWheelDelta,
  snapChapterProgress
} from '../components/website-experience/chapter-model';
import {
  isIntroPhase,
  reduceIntroPhase
} from '../components/home-experience/intro-phase-model';
import {
  calculateSwipeDelta,
  isLocalInputElement
} from '../components/website-experience/use-website-controller';
import {
  CHAPTER_REGISTRY,
  getChapterIndex
} from '../components/website-experience/chapter-registry';

describe('官网章节进度模型', () => {
  it('把像素、行和页面滚轮统一换算为像素并拒绝非有限值', () => {
    expect(normalizeWheelDelta(120, 0, 900)).toBe(120);
    expect(normalizeWheelDelta(3, 1, 900)).toBe(48);
    expect(normalizeWheelDelta(1, 2, 900)).toBe(900);
    expect(normalizeWheelDelta(Number.NaN, 0, 900)).toBe(0);
  });

  it('同方向累计到 240px 才释放且只返回超过阈值的余量', () => {
    const first = accumulateWheelUnlock({ direction: 0, accumulated: 0 }, 120, 240);
    expect(first).toEqual({ direction: 1, accumulated: 120, releasedDelta: 0 });
    const second = accumulateWheelUnlock(first, 120, 240);
    expect(second).toEqual({ direction: 1, accumulated: 240, releasedDelta: 0 });
    const third = accumulateWheelUnlock(second, 60, 240);
    expect(third.releasedDelta).toBe(60);
  });

  it('解锁累计方向反转时清空旧方向并从新方向重新计算', () => {
    const result = accumulateWheelUnlock(
      { direction: 1, accumulated: 180 },
      -100,
      240
    );
    expect(result).toEqual({ direction: -1, accumulated: 100, releasedDelta: 0 });
  });

  it('按帧间时间指数追赶目标并限制严重掉帧的时间差', () => {
    const normal = dampChapterProgress(0, 1, 16, 90, 50);
    const delayed = dampChapterProgress(0, 1, 500, 90, 50);
    expect(normal).toBeGreaterThan(0);
    expect(normal).toBeLessThan(1);
    expect(delayed).toBeCloseTo(dampChapterProgress(0, 1, 50, 90, 50));
    expect(hasChapterProgressSettled(0.9996, 1, 0.0005)).toBe(true);
  });

  it('按确认顺序注册六个章节', () => {
    expect(CHAPTER_REGISTRY.map((chapter) => chapter.id)).toEqual([
      'home',
      'about',
      'download',
      'community',
      'feedback'
    ]);
    expect(getChapterIndex('feedback')).toBe(4);
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
