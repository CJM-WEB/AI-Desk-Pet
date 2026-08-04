// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AboutChapter } from '../components/website-experience/about/AboutChapter';

vi.mock('gsap', () => ({
  gsap: { set: vi.fn(), to: vi.fn() }
}));

afterEach(cleanup);

describe('AI Pet 液态玻璃介绍章节', () => {
  it('使用三块玻璃承载原有五项介绍内容', () => {
    render(<AboutChapter interactive />);
    expect(document.querySelectorAll('[data-glass-id]')).toHaveLength(3);
    for (const title of ['文件夹管理', '聊天陪伴', '保障系统安全', '桌面整理', '文本编辑']) {
      expect(screen.getByRole('heading', { name: title })).toBeTruthy();
    }
    expect(screen.getByText('AGENT')).toBeTruthy();
    expect(screen.getByText('YOUR')).toBeTruthy();
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
    expect(chapter.dataset.hovered).toBe('files');
    fireEvent.pointerLeave(glass);
    expect(chapter.dataset.hovered).toBe('none');
  });

  it('减少动态效果时关闭持续浮动', () => {
    render(<AboutChapter interactive reducedMotion />);
    expect(screen.getByTestId('about-chapter').dataset.motionDisabled).toBe('true');
  });
});
