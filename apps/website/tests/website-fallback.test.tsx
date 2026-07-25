// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('初始化失败后停止共享视觉并仍可导航到真实下载', async () => {
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
  });
});
