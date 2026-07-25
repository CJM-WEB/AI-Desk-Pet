// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gsap } from 'gsap';
import { WebsiteExperience } from '../components/website-experience/WebsiteExperience';

function createMediaQueryList(matches: boolean): MediaQueryList {
  return {
    matches,
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn()
  };
}

describe('官网章节降级模式', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      clearRect: vi.fn(),
      setTransform: vi.fn()
    } as unknown as CanvasRenderingContext2D);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('减少动态效果时章节导航直接落位且保留内容对比度', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => createMediaQueryList(true)));
    render(<WebsiteExperience />);

    const experience = screen.getByTestId('website-experience');
    await waitFor(() => {
      expect(experience.dataset.reducedMotion).toBe('true');
    });

    fireEvent.click(screen.getByRole('button', { name: '下一章节' }));

    expect(experience.dataset.activeChapter).toBe('about');
    const about = document.querySelector<HTMLElement>(
      '[data-chapter-id="about"]'
    );
    expect(about?.dataset.interactive).toBe('true');
    expect(about?.style.getPropertyValue('--chapter-scale')).toBe('1');
    expect(about?.style.getPropertyValue('--chapter-blur')).toBe('0px');
    expect(about?.style.getPropertyValue('--chapter-contrast')).toBe('1');
  });

  it('matchMedia 失败后下载侧栏不再调用浏览器媒体 API', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => {
      throw new Error('matchMedia 初始化失败');
    }));
    render(<WebsiteExperience />);

    const experience = screen.getByTestId('website-experience');
    await waitFor(() => {
      expect(experience.dataset.initializationFailed).toBe('true');
    });

    expect(experience.dataset.staticFallback).toBe('active');
    expect(document.querySelector('[data-layer="cursor"]')).toBeNull();
    expect(document.querySelector('[data-layer="file"]')).toBeNull();
    expect(document.querySelectorAll('[data-chapter-id]')).toHaveLength(5);
    expect(screen.getByText('微信')).toBeTruthy();
    expect(screen.getByText('支付宝')).toBeTruthy();

    const next = screen.getByRole('button', { name: '下一章节' });
    fireEvent.click(next);
    fireEvent.click(next);

    expect(experience.dataset.activeChapter).toBe('download');
    const downloadSection = document.querySelector<HTMLElement>(
      '[data-chapter-id="download"]'
    );
    expect(downloadSection?.dataset.interactive).toBe('true');
    expect(
      screen.getByRole('link', { name: '下载 Windows' }).getAttribute('href')
    ).toContain('Myself-0.1.0-alpha.1-windows-x64.exe');

    expect(() => {
      fireEvent.click(screen.getByRole('button', { name: '显示常见问题' }));
    }).not.toThrow();
    await waitFor(() => {
      expect(screen.getByTestId('download-chapter').dataset.visibleSide)
        .toBe('faq');
    });
    expect(screen.getByTestId('download-chapter').dataset.staticFallback)
      .toBe('true');
    expect(screen.getByTestId('donation-chapter').dataset.staticFallback)
      .toBe('true');
  });

  it('监听器半注册失败会回滚已注册输入并阻止残留导航', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => createMediaQueryList(false)));
    const originalAddEventListener = window.addEventListener.bind(window);
    const originalRemoveEventListener = window.removeEventListener.bind(window);
    vi.spyOn(window, 'addEventListener').mockImplementation((
      type,
      listener,
      options
    ) => {
      if (type === 'pointermove') {
        throw new Error('监听器注册失败');
      }
      originalAddEventListener(type, listener, options);
    });
    const removeEventListener = vi.spyOn(window, 'removeEventListener')
      .mockImplementation((type, listener, options) => {
        originalRemoveEventListener(type, listener, options);
      });

    render(<WebsiteExperience />);

    const experience = screen.getByTestId('website-experience');
    await waitFor(() => {
      expect(experience.dataset.staticFallback).toBe('active');
    });

    expect(removeEventListener).toHaveBeenCalledWith(
      'wheel',
      expect.any(Function)
    );
    expect(removeEventListener).toHaveBeenCalledWith(
      'keydown',
      expect.any(Function)
    );
    expect(removeEventListener).toHaveBeenCalledWith(
      'click',
      expect.any(Function)
    );

    window.dispatchEvent(new WheelEvent('wheel', {
      cancelable: true,
      deltaY: 640
    }));
    expect(experience.dataset.activeChapter).toBe('home');
  });

  it('GSAP 初始化失败会进入统一静态回退并保留章节内容', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => createMediaQueryList(false)));
    vi.spyOn(gsap, 'context').mockImplementation(() => {
      throw new Error('GSAP 初始化失败');
    });

    render(<WebsiteExperience />);

    const experience = screen.getByTestId('website-experience');
    await waitFor(() => {
      expect(experience.dataset.staticFallback).toBe('active');
    });

    expect(document.querySelector('[data-layer="cursor"]')).toBeNull();
    expect(document.querySelector('[data-layer="file"]')).toBeNull();
    expect(document.querySelectorAll('[data-chapter-id]')).toHaveLength(5);

    const next = screen.getByRole('button', { name: '下一章节' });
    fireEvent.click(next);
    fireEvent.click(next);
    expect(screen.getByTestId('website-experience').dataset.activeChapter)
      .toBe('download');
    expect(screen.getByRole('link', { name: '下载 Windows' })).toBeTruthy();
    expect(() => {
      fireEvent.click(screen.getByRole('button', { name: '显示安装前须知' }));
    }).not.toThrow();
    await waitFor(() => {
      expect(screen.getByTestId('download-chapter').dataset.visibleSide)
        .toBe('notice');
    });

    fireEvent.click(next);
    fireEvent.click(next);
    expect(screen.getByTestId('website-experience').dataset.activeChapter)
      .toBe('donation');
    expect(screen.getByText('微信')).toBeTruthy();
    expect(screen.getByText('支付宝')).toBeTruthy();
  });
});
