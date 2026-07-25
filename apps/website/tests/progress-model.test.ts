import { describe, expect, it } from 'vitest';
import { EXPERIENCE_CONFIG } from '../components/home-experience/config';
import {
  applyProgressDelta,
  clampProgress,
  reduceExperience,
  snapProgress
} from '../components/home-experience/progress-model';
import type { ExperienceState } from '../components/home-experience/progress-model';
import {
  applyIntroSkip,
  calculateInputVelocity,
  interpolateSnapProgress
} from '../components/home-experience/use-experience-controller';

describe('首页体验配置', () => {
  it('使用指定的粒子群限制和安全区比例', () => {
    expect(EXPERIENCE_CONFIG.swarm.maxActive).toBe(10);
    expect(EXPERIENCE_CONFIG.swarm.safeZoneRatio).toBe(0.3);
  });

  it('使用指定的背景和指针场颜色', () => {
    expect(EXPERIENCE_CONFIG.colors.background).toBe('rgb(235, 235, 235)');
    expect(EXPERIENCE_CONFIG.colors.pointerField).toBe('rgb(180, 180, 180)');
  });
});

describe('首页体验进度模型', () => {
  it('把进度限制在零到一之间', () => {
    expect(clampProgress(-0.3)).toBe(0);
    expect(clampProgress(1.3)).toBe(1);
    expect(applyProgressDelta(0.9, 0.3)).toBe(1);
    expect(applyProgressDelta(0.1, -0.3)).toBe(0);
  });

  it('仅在低速且接近边界时吸附', () => {
    expect(snapProgress(0.97, 0.005)).toBe(1);
    expect(snapProgress(0.8, 0.005)).toBe(0.8);
    expect(snapProgress(0.97, 0.2)).toBe(0.97);
    expect(snapProgress(0.97, Number.NaN)).toBe(0.97);
  });

  it('开场输入直接进入稳定交互态', () => {
    expect(reduceExperience(
      { phase: 'drawing', progress: 0 },
      { type: 'SKIP_INTRO' }
    )).toEqual({ phase: 'interactive', progress: 0 });
  });

  it('进度进入退出区后切换到 exiting', () => {
    expect(reduceExperience(
      { phase: 'interactive', progress: 0.7 },
      { type: 'SET_PROGRESS', progress: 0.86 }
    ).phase).toBe('exiting');
  });

  it('滚轮增量按配置缩放', () => {
    expect(applyProgressDelta(0.2, 100 * EXPERIENCE_CONFIG.progress.wheelScale))
      .toBeCloseTo(0.265);
  });

  it('键盘步长不会越过边界', () => {
    expect(applyProgressDelta(0.95, EXPERIENCE_CONFIG.progress.keyboardStep)).toBe(1);
    expect(applyProgressDelta(0.05, -EXPERIENCE_CONFIG.progress.keyboardStep)).toBe(0);
  });

  it('穷尽处理所有阶段事件并保持进度边界', () => {
    const events = [
      { type: 'ASSETS_READY' },
      { type: 'DRAWING_DONE' },
      { type: 'SETTLED' },
      { type: 'SKIP_INTRO' },
      { type: 'SET_PROGRESS', progress: 2 }
    ] as const;

    let state: ExperienceState = { phase: 'loading', progress: 0 };
    for (const event of events) {
      state = reduceExperience(state, event);
    }

    expect(state).toEqual({ phase: 'exiting', progress: 1 });
  });

  it('跳过开场在交互和退场阶段保持现有进度', () => {
    expect(applyIntroSkip({
      phase: 'interactive',
      progress: 0.73
    })).toEqual({ phase: 'interactive', progress: 0.73 });
    expect(applyIntroSkip({
      phase: 'exiting',
      progress: 0.91
    })).toEqual({ phase: 'exiting', progress: 0.91 });
  });

  it('端点吸附通过中间帧靠近目标而不是瞬跳', () => {
    expect(interpolateSnapProgress(0.96, 1, 0.5)).toBeCloseTo(0.995);
    expect(interpolateSnapProgress(0.96, 1, 1)).toBe(1);
  });

  it('首次输入速度使用一帧作为时间基线', () => {
    expect(calculateInputVelocity(0.064, 5000, null)).toBeCloseTo(0.004);
    expect(calculateInputVelocity(0.064, 5000, 4980)).toBeCloseTo(0.0032);
  });
});
