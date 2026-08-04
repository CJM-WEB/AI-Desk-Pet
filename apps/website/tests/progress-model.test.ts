import { describe, expect, it } from 'vitest';
import { EXPERIENCE_CONFIG } from '../components/home-experience/config';
import { deriveHomeExperiencePhase } from '../components/home-experience/intro-phase-model';

describe('首页体验配置', () => {
  it('使用指定的页面背景色', () => {
    expect(EXPERIENCE_CONFIG.colors.background).toBe('rgb(235, 235, 235)');
  });
});

describe('首页章节阶段适配', () => {
  it('首页离开时使用 exiting 且不污染全局交互态', () => {
    expect(deriveHomeExperiencePhase('interactive', 0)).toBe('interactive');
    expect(deriveHomeExperiencePhase('interactive', 0.25)).toBe('exiting');
    expect(deriveHomeExperiencePhase('interactive', 1)).toBe('exiting');
  });

  it('开场阶段不被首页退场进度覆盖', () => {
    expect(deriveHomeExperiencePhase('drawing', 0.25)).toBe('drawing');
    expect(deriveHomeExperiencePhase('settling', 0.25)).toBe('settling');
  });
});
