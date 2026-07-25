import { describe, expect, it } from 'vitest';
import {
  resolveSharedVisualProfile,
  VISUAL_PROFILES
} from '../components/website-experience/shared-visual-model';

describe('共享视觉主题', () => {
  it('首页使用灰色光场且捐款使用黄色光场', () => {
    expect(VISUAL_PROFILES.home.fieldColor).toEqual([180, 180, 180]);
    expect(VISUAL_PROFILES.donation.fieldColor).toEqual([255, 255, 0]);
  });

  it('只在首页和捐款附近启用共享视觉层', () => {
    expect(resolveSharedVisualProfile(0, 'interactive')?.id).toBe('home');
    expect(resolveSharedVisualProfile(2, 'interactive')).toBeNull();
    expect(resolveSharedVisualProfile(4, 'interactive')?.id).toBe('donation');
  });
});
