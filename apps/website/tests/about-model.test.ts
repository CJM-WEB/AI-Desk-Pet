import { describe, expect, it } from 'vitest';
import { ABOUT_FEATURES } from '../components/website-experience/about/about-content';
import {
  initialAboutInteraction,
  isInsideAboutSafeZone,
  reduceAboutInteraction,
  visibleAboutFeatureId
} from '../components/website-experience/about/about-model';

describe('AI Pet 介绍内容与交互状态', () => {
  it('按固定层次提供五项可替换功能内容', () => {
    expect(ABOUT_FEATURES.map((feature) => feature.id)).toEqual([
      'security',
      'file-management',
      'text-editor',
      'companion-chat',
      'desktop-organizer'
    ]);
    expect(ABOUT_FEATURES.map((feature) => feature.entryOrder)).toEqual([
      1,
      2,
      3,
      4,
      5
    ]);
    expect(new Set(ABOUT_FEATURES.map((feature) => feature.id)).size).toBe(5);
    expect(new Set(ABOUT_FEATURES.map((feature) => feature.entryOrder)).size).toBe(5);

    for (const feature of ABOUT_FEATURES) {
      expect(feature.title.trim()).not.toBe('');
      expect(feature.eyebrow.trim()).not.toBe('');
      expect(feature.summary.trim()).not.toBe('');
      expect(feature.details.length).toBeGreaterThan(0);
      expect(typeof feature.icon).toBe('object');
      expect(feature.illustration).toMatch(/^(security|file-management|text-editor|companion-chat|desktop-organizer)$/);
    }
  });

  it('桌面悬停与焦点在离开后恢复临时状态', () => {
    const hovered = reduceAboutInteraction(initialAboutInteraction, {
      type: 'SET_HOVER',
      id: 'security'
    });
    const focused = reduceAboutInteraction(hovered, {
      type: 'SET_FOCUS',
      id: 'file-management'
    });
    const blurred = reduceAboutInteraction(focused, {
      type: 'SET_FOCUS',
      id: null
    });
    const left = reduceAboutInteraction(blurred, {
      type: 'SET_HOVER',
      id: null
    });

    expect(visibleAboutFeatureId(hovered)).toBe('security');
    expect(visibleAboutFeatureId(focused)).toBe('file-management');
    expect(visibleAboutFeatureId(blurred)).toBe('security');
    expect(visibleAboutFeatureId(left)).toBeNull();
  });

  it('只允许移动端轻触切换锁定，空白轻触复位', () => {
    const locked = reduceAboutInteraction(initialAboutInteraction, {
      type: 'TOGGLE_MOBILE_LOCK',
      id: 'text-editor'
    });
    const unlocked = reduceAboutInteraction(locked, {
      type: 'TOGGLE_MOBILE_LOCK',
      id: 'text-editor'
    });
    const relocked = reduceAboutInteraction(unlocked, {
      type: 'TOGGLE_MOBILE_LOCK',
      id: 'companion-chat'
    });
    const cleared = reduceAboutInteraction(relocked, {
      type: 'CLEAR_MOBILE_LOCK'
    });

    expect(visibleAboutFeatureId(locked)).toBe('text-editor');
    expect(visibleAboutFeatureId(unlocked)).toBeNull();
    expect(visibleAboutFeatureId(cleared)).toBeNull();
  });

  it('活动项以移动锁定、焦点、悬停的固定优先级派生', () => {
    const hovered = reduceAboutInteraction(initialAboutInteraction, {
      type: 'SET_HOVER',
      id: 'security'
    });
    const focused = reduceAboutInteraction(hovered, {
      type: 'SET_FOCUS',
      id: 'file-management'
    });
    const mobileLocked = reduceAboutInteraction(focused, {
      type: 'TOGGLE_MOBILE_LOCK',
      id: 'desktop-organizer'
    });

    expect(visibleAboutFeatureId(hovered)).toBe('security');
    expect(visibleAboutFeatureId(focused)).toBe('file-management');
    expect(visibleAboutFeatureId(mobileLocked)).toBe('desktop-organizer');
  });

  it('中央 AI Pet 安全区包含边界，不包含区域外的点', () => {
    expect(isInsideAboutSafeZone({ x: 0.31, y: 0.32 })).toBe(true);
    expect(isInsideAboutSafeZone({ x: 0.69, y: 0.68 })).toBe(true);
    expect(isInsideAboutSafeZone({ x: 0.5, y: 0.5 })).toBe(true);
    expect(isInsideAboutSafeZone({ x: 0.309, y: 0.5 })).toBe(false);
    expect(isInsideAboutSafeZone({ x: 0.5, y: 0.681 })).toBe(false);
  });
});
