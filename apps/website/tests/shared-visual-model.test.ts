import { describe, expect, it } from 'vitest';
import {
  resolveSharedVisualProfile,
  VISUAL_PROFILES
} from '../components/website-experience/shared-visual-model';

describe('共享视觉主题', () => {
  it('社区与捐款关闭光场并复用默认预览源', () => {
    expect(VISUAL_PROFILES.community.fieldEnabled).toBe(false);
    expect(VISUAL_PROFILES.community.previewSource)
      .toBe(VISUAL_PROFILES.donation.previewSource);
    expect(VISUAL_PROFILES.donation.fieldColor).toEqual([255, 255, 0]);
  });

  it('共享仓库拥有独立的灰色共享视觉主题', () => {
    expect(resolveSharedVisualProfile(3, 'interactive')?.id).toBe('community');
    expect(VISUAL_PROFILES.community.fieldColor).toEqual([180, 180, 180]);
    expect(VISUAL_PROFILES.community.safeZoneRatio)
      .toBe(VISUAL_PROFILES.donation.safeZoneRatio);
    expect(VISUAL_PROFILES.community.previewSource)
      .toBe(VISUAL_PROFILES.donation.previewSource);
  });

  it('首页不再启用旧共享视觉，并解析后续章节对应视觉层', () => {
    expect(resolveSharedVisualProfile(0, 'interactive')).toBeNull();
    expect(resolveSharedVisualProfile(1, 'interactive')).toBeNull();
    expect(resolveSharedVisualProfile(1.25, 'interactive')).toBeNull();
    expect(resolveSharedVisualProfile(2, 'interactive')).toBeNull();
    expect(resolveSharedVisualProfile(2.75, 'interactive')).toBeNull();
    expect(resolveSharedVisualProfile(3, 'interactive')?.id).toBe('community');
    expect(resolveSharedVisualProfile(3.5, 'interactive')?.id).toBe('community');
    expect(resolveSharedVisualProfile(4, 'interactive')).toBeNull();
    expect(resolveSharedVisualProfile(4.5, 'interactive')?.id).toBe('donation');
    expect(resolveSharedVisualProfile(5, 'interactive')?.id).toBe('donation');
  });
});
