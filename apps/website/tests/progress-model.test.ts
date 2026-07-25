import { describe, expect, it } from 'vitest';
import { EXPERIENCE_CONFIG } from '../components/home-experience/config';

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
