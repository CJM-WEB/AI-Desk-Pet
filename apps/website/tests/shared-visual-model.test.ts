import { describe, expect, it } from 'vitest';
import {
  resolveSharedVisualProfile,
  VISUAL_PROFILES
} from '../components/website-experience/shared-visual-model';

describe('共享视觉主题', () => {
  it('首页使用灰色光场，下载与捐款关闭光场并复用默认预览源', () => {
    expect(VISUAL_PROFILES.home.fieldColor).toEqual([180, 180, 180]);
    expect(VISUAL_PROFILES.download.fieldEnabled).toBe(false);
    expect(VISUAL_PROFILES.download.previewSource)
      .toBe(VISUAL_PROFILES.home.previewSource);
    expect(VISUAL_PROFILES.donation.fieldColor).toEqual([255, 255, 0]);
  });

  it('共享仓库拥有独立的灰色共享视觉主题', () => {
    expect(resolveSharedVisualProfile(3, 'interactive')?.id).toBe('community');
    expect(VISUAL_PROFILES.community.fieldColor).toEqual([180, 180, 180]);
    expect(VISUAL_PROFILES.community.previewSource)
      .toBe(VISUAL_PROFILES.home.previewSource);
  });

  it('在首页、下载、共享仓库和捐款区间解析对应共享视觉层', () => {
    expect(resolveSharedVisualProfile(0, 'interactive')?.id).toBe('home');
    expect(resolveSharedVisualProfile(1, 'interactive')).toBeNull();
    expect(resolveSharedVisualProfile(1.25, 'interactive')?.id).toBe('download');
    expect(resolveSharedVisualProfile(2, 'interactive')?.id).toBe('download');
    expect(resolveSharedVisualProfile(2.75, 'interactive')?.id).toBe('download');
    expect(resolveSharedVisualProfile(3, 'interactive')?.id).toBe('community');
    expect(resolveSharedVisualProfile(4, 'interactive')).toBeNull();
    expect(resolveSharedVisualProfile(5, 'interactive')?.id).toBe('donation');
  });
});
