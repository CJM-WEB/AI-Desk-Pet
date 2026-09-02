// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gsap } from 'gsap';
import {
  LIQUID_GLASS_INTERACTION_EVENT,
  LIQUID_GLASS_RIPPLE_EVENT
} from '../components/home-experience/LiquidGlassHome';
import type { LiquidGlassInteractionDetail } from '../components/home-experience/LiquidGlassHome';
import { LIQUID_GLASS_FRAGMENT_SHADER } from '../components/home-experience/liquid-glass-shaders';
import { AboutChapter } from '../components/website-experience/about/AboutChapter';

vi.mock('gsap', () => ({
  gsap: { killTweensOf: vi.fn(), set: vi.fn(), to: vi.fn() }
}));

afterEach(cleanup);

describe('AI Pet 液态玻璃介绍章节', () => {
  it('使用三块玻璃承载原有五项介绍内容', () => {
    render(<AboutChapter interactive />);
    expect(document.querySelectorAll('[data-glass-id]')).toHaveLength(3);
    for (const title of ['文件夹管理', '聊天陪伴', '保障系统安全', '桌面整理', '文本编辑']) {
      expect(screen.getByRole('heading', { name: title })).toBeTruthy();
    }
    expect(screen.getByRole('heading', { name: '保障系统安全' }).closest('[data-glass-id]'))
      .toBeNull();
    expect(screen.getByRole('heading', { name: '桌面整理' }).closest('[data-glass-id]'))
      .toBeNull();
  });

  it('把首页到介绍页的滚轮进度写入视觉变量', () => {
    render(<AboutChapter interactive={false} transitionProgress={0.46} />);
    expect(screen.getByTestId('about-chapter').style.getPropertyValue('--about-progress')).toBe('0.46');
  });

  it('悬浮玻璃时聚焦当前玻璃，离开后恢复连接态', () => {
    const details: LiquidGlassInteractionDetail[] = [];
    const capture = (event: Event) => {
      details.push((event as CustomEvent<LiquidGlassInteractionDetail>).detail);
    };
    window.addEventListener(LIQUID_GLASS_INTERACTION_EVENT, capture);
    render(<AboutChapter interactive />);
    const chapter = screen.getByTestId('about-chapter');
    const glass = document.querySelector<HTMLElement>('[data-glass-id="files"]')!;
    fireEvent.pointerEnter(glass);
    expect(chapter.dataset.hovered).toBe('2');
    expect(details.at(-1)).toEqual({
      hovered: 2,
      dragging: false,
      offsets: [0, 0, 0, 0, 0, 0]
    });
    fireEvent.pointerLeave(glass);
    expect(chapter.dataset.hovered).toBe('-1');
    window.removeEventListener(LIQUID_GLASS_INTERACTION_EVENT, capture);
  });

  it('拖拽文字命中层时发布归一化偏移、水波并使用弹性回位', () => {
    const details: LiquidGlassInteractionDetail[] = [];
    const capture = (event: Event) => {
      details.push((event as CustomEvent<LiquidGlassInteractionDetail>).detail);
    };
    const ripple = vi.fn();
    window.addEventListener(LIQUID_GLASS_INTERACTION_EVENT, capture);
    window.addEventListener(LIQUID_GLASS_RIPPLE_EVENT, ripple);
    render(<AboutChapter interactive />);
    const glass = document.querySelector<HTMLElement>('[data-glass-id="editor"]')!;
    glass.setPointerCapture = vi.fn();

    fireEvent.pointerDown(glass, { pointerId: 7, clientX: 100, clientY: 100 });
    expect(ripple).toHaveBeenCalledOnce();
    fireEvent.pointerMove(glass, { pointerId: 7, clientX: 146, clientY: 128 });
    expect(gsap.set).toHaveBeenCalled();
    expect(details.at(-1)).toEqual({
      hovered: 0,
      dragging: true,
      offsets: [46 / window.innerWidth, -28 / window.innerHeight, 0, 0, 0, 0]
    });
    fireEvent.pointerUp(glass, { pointerId: 7, clientX: 146, clientY: 128 });
    expect(gsap.to).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      x: 0,
      y: 0,
      ease: 'elastic.out(1, 0.42)'
    }));
    window.removeEventListener(LIQUID_GLASS_INTERACTION_EVENT, capture);
    window.removeEventListener(LIQUID_GLASS_RIPPLE_EVENT, ripple);
  });

  it('五章节着色器保留共享仓库文字纹理接口', () => {
    expect(LIQUID_GLASS_FRAGMENT_SHADER).toContain('u_communityTextTexture');
  });

  it('减少动态效果时关闭持续浮动', () => {
    render(<AboutChapter interactive reducedMotion />);
    expect(screen.getByTestId('about-chapter').dataset.motionDisabled).toBe('true');
  });
});
