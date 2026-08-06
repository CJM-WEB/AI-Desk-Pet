// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gsap } from 'gsap';
import { AboutChapter } from '../components/website-experience/about/AboutChapter';
import { LIQUID_GLASS_FRAGMENT_SHADER } from '../components/home-experience/liquid-glass-shaders';

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
    const details: Array<{ hovered: number; dragging: boolean; offsets: readonly number[] }> = [];
    const capture = (event: Event) => details.push((event as CustomEvent).detail);
    window.addEventListener('ai-pet-liquid-interaction', capture);
    render(<AboutChapter interactive />);
    const chapter = screen.getByTestId('about-chapter');
    const glass = document.querySelector<HTMLElement>('[data-glass-id="files"]')!;
    fireEvent.pointerEnter(glass);
    expect(chapter.dataset.hovered).toBe('2');
    expect(details.at(-1)).toMatchObject({
      hovered: 2,
      dragging: false,
      offsets: [0, 0, 0, 0, 0, 0]
    });
    fireEvent.pointerLeave(glass);
    expect(chapter.dataset.hovered).toBe('-1');
    window.removeEventListener('ai-pet-liquid-interaction', capture);
  });

  it('拖拽文字命中层时同步 WebGL 偏移并使用弹性回位', () => {
    const details: Array<{ hovered: number; dragging: boolean; offsets: readonly number[] }> = [];
    const capture = (event: Event) => details.push((event as CustomEvent).detail);
    const ripple = vi.fn();
    window.addEventListener('ai-pet-liquid-interaction', capture);
    window.addEventListener('ai-pet-liquid-ripple', ripple);
    render(<AboutChapter interactive />);
    const glass = document.querySelector<HTMLElement>('[data-glass-id="editor"]')!;
    glass.setPointerCapture = vi.fn();

    fireEvent.pointerDown(glass, { pointerId: 7, clientX: 100, clientY: 100 });
    expect(ripple).toHaveBeenCalledTimes(1);
    fireEvent.pointerMove(glass, { pointerId: 7, clientX: 146, clientY: 128 });
    expect(gsap.set).toHaveBeenCalled();
    expect(details.at(-1)?.dragging).toBe(true);
    expect(details.at(-1)?.offsets[0]).toBeGreaterThan(0);
    fireEvent.pointerUp(glass, { pointerId: 7, clientX: 146, clientY: 128 });
    expect(gsap.to).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      x: 0,
      y: 0,
      ease: 'elastic.out(1, 0.42)'
    }));
    window.removeEventListener('ai-pet-liquid-interaction', capture);
    window.removeEventListener('ai-pet-liquid-ripple', ripple);
  });

  it('着色器使用圆角块与水态颈部的同一 SDF 轮廓', () => {
    expect(LIQUID_GLASS_FRAGMENT_SHADER).toContain('liquidGlassSdf');
    expect(LIQUID_GLASS_FRAGMENT_SHADER).toContain('capsuleSdf');
    expect(LIQUID_GLASS_FRAGMENT_SHADER).toContain('u_blobOffsets[3]');
    expect(LIQUID_GLASS_FRAGMENT_SHADER).toContain('u_hoverAmount');
    expect(LIQUID_GLASS_FRAGMENT_SHADER).toContain('u_dragging');
    expect(LIQUID_GLASS_FRAGMENT_SHADER).toContain('u_rippleActivity');
    expect(LIQUID_GLASS_FRAGMENT_SHADER).toContain('u_cornerTextTexture');
    expect(LIQUID_GLASS_FRAGMENT_SHADER).toContain('u_glassTextTexture');
    expect(LIQUID_GLASS_FRAGMENT_SHADER).toContain(
      'mix(neck01, 100000.0, disconnected)'
    );
    expect(LIQUID_GLASS_FRAGMENT_SHADER).not.toContain('float cut01');
    expect(LIQUID_GLASS_FRAGMENT_SHADER).toContain('/ scale0');
    expect(LIQUID_GLASS_FRAGMENT_SHADER).toContain(
      'mix(7.0, 32.0, u_hoverAmount)'
    );
  });

  it('减少动态效果时关闭持续浮动', () => {
    render(<AboutChapter interactive reducedMotion />);
    expect(screen.getByTestId('about-chapter').dataset.motionDisabled).toBe('true');
  });
});
