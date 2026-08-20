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
    render(<AboutChapter interactive />);
    const chapter = screen.getByTestId('about-chapter');
    const glass = document.querySelector<HTMLElement>('[data-glass-id="files"]')!;
    fireEvent.pointerEnter(glass);
    expect(chapter.dataset.hovered).toBe('2');
    fireEvent.pointerLeave(glass);
    expect(chapter.dataset.hovered).toBe('-1');
  });

  it('拖拽文字命中层时更新 DOM 并使用弹性回位', () => {
    render(<AboutChapter interactive />);
    const glass = document.querySelector<HTMLElement>('[data-glass-id="editor"]')!;
    glass.setPointerCapture = vi.fn();

    fireEvent.pointerDown(glass, { pointerId: 7, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(glass, { pointerId: 7, clientX: 146, clientY: 128 });
    expect(gsap.set).toHaveBeenCalled();
    fireEvent.pointerUp(glass, { pointerId: 7, clientX: 146, clientY: 128 });
    expect(gsap.to).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      x: 0,
      y: 0,
      ease: 'elastic.out(1, 0.42)'
    }));
  });

  it('着色器只保留首页到介绍交接的基础玻璃轮廓', () => {
    expect(LIQUID_GLASS_FRAGMENT_SHADER).toContain('liquidGlassSdf');
    expect(LIQUID_GLASS_FRAGMENT_SHADER).toContain('capsuleSdf');
    expect(LIQUID_GLASS_FRAGMENT_SHADER).toContain('u_ripples[6]');
    expect(LIQUID_GLASS_FRAGMENT_SHADER).not.toContain('u_blobOffsets');
    expect(LIQUID_GLASS_FRAGMENT_SHADER).not.toContain('u_hoverAmount');
    expect(LIQUID_GLASS_FRAGMENT_SHADER).not.toContain('u_dragging');
    expect(LIQUID_GLASS_FRAGMENT_SHADER).not.toContain('u_cornerTextTexture');
    expect(LIQUID_GLASS_FRAGMENT_SHADER).not.toContain('u_glassTextTexture');
    expect(LIQUID_GLASS_FRAGMENT_SHADER).not.toContain('u_supportTextTexture');
    expect(LIQUID_GLASS_FRAGMENT_SHADER).not.toContain('supportButton');
  });

  it('减少动态效果时关闭持续浮动', () => {
    render(<AboutChapter interactive reducedMotion />);
    expect(screen.getByTestId('about-chapter').dataset.motionDisabled).toBe('true');
  });
});
