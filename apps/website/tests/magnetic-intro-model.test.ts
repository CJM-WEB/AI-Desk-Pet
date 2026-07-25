import { describe, expect, it } from 'vitest';
import { EXPERIENCE_CONFIG } from '../components/home-experience/config';
import {
  getMagneticLockAtSeconds,
  hasPositiveAreaOverlap,
  toClipPath
} from '../components/home-experience/magnetic-intro-model';

describe('磁吸开场配置', () => {
  it('使用六块真实 AP 素材并保留横向与纵向重叠', () => {
    const magnetic = EXPERIENCE_CONFIG.intro.magnetic;

    expect(magnetic.assetPath).toBe('/AP.png');
    expect(magnetic.pieces).toHaveLength(6);
    expect(magnetic.pieces.every((piece) => piece.from.scale === 0.72)).toBe(true);

    expect(hasPositiveAreaOverlap(magnetic.pieces[0].clip, magnetic.pieces[1].clip)).toBe(true);
    expect(hasPositiveAreaOverlap(magnetic.pieces[2].clip, magnetic.pieces[3].clip)).toBe(true);
    expect(hasPositiveAreaOverlap(magnetic.pieces[4].clip, magnetic.pieces[5].clip)).toBe(true);
    expect(hasPositiveAreaOverlap(magnetic.pieces[0].clip, magnetic.pieces[2].clip)).toBe(true);
    expect(hasPositiveAreaOverlap(magnetic.pieces[2].clip, magnetic.pieces[4].clip)).toBe(true);
  });

  it('将相对裁切边界转换为稳定的 polygon 路径', () => {
    expect(toClipPath({ left: 0, top: 0, right: 54, bottom: 38 }))
      .toBe('polygon(0% 0%, 54% 0%, 54% 38%, 0% 38%)');
  });

  it('在最后一块落位后开始完整 Logo 锁定', () => {
    expect(getMagneticLockAtSeconds(EXPERIENCE_CONFIG.intro.magnetic)).toBeCloseTo(2.07);
  });
});
