// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../components/i18n/I18nProvider';
import { LIQUID_GLASS_RIPPLE_EVENT } from '../components/home-experience/LiquidGlassHome';
import { LIQUID_GLASS_FRAGMENT_SHADER } from '../components/home-experience/liquid-glass-shaders';
import { DownloadChapter } from '../components/website-experience/download/DownloadChapter';
import { isLocalInputElement } from '../components/website-experience/use-website-controller';

describe('下载模块', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('展示平台标题、文字选择器与未发布状态', () => {
    const { container } = render(<DownloadChapter interactive staticFallback />);

    expect(screen.getByRole('heading', { name: '选择你的平台' })).toBeTruthy();
    expect(screen.getAllByTestId('pointer-tilt-text')).toHaveLength(2);
    expect(screen.getByRole('button', { name: '当前平台为 Windows' })
      .getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('link', { name: '下载 Windows' })).toBeNull();
    expect((screen.getByRole('button', { name: '尚未发布' }) as HTMLButtonElement)
      .disabled).toBe(true);
    expect(container.querySelectorAll('[class*="typingChar"]').length).toBeGreaterThan(20);
    expect(screen.queryByText('AI PET')).toBeNull();
    expect(screen.getAllByTestId('pointer-tilt-text')[1]?.className)
      .toContain('platformWordTilt');
  });

  it('点击文字选择器后切换 macOS 内容', () => {
    render(<DownloadChapter interactive staticFallback />);

    fireEvent.click(screen.getByRole('button', { name: '选择 macOS' }));

    expect(screen.getByTestId('download-chapter').dataset.activePlatform).toBe('macos');
    expect(screen.getByRole('button', { name: '当前平台为 macOS' })
      .getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('link', { name: /macOS/u })).toBeNull();
    expect((screen.getByRole('button', { name: '即将支持' }) as HTMLButtonElement)
      .disabled).toBe(true);
  });

  it('滚轮不切换平台并继续交给全局章节控制', () => {
    const globalChapterWheel = vi.fn();
    const bubbledWheel = vi.fn((event: WheelEvent) => {
      if (!isLocalInputElement(event.target as HTMLElement)) globalChapterWheel();
    });
    window.addEventListener('wheel', bubbledWheel);
    render(<DownloadChapter interactive staticFallback />);

    const selector = screen.getByRole('group', { name: '选择下载平台' });
    fireEvent.wheel(selector, { deltaY: 120, bubbles: true });

    expect(screen.getByTestId('download-chapter').dataset.activePlatform).toBe('windows-x64');
    expect(bubbledWheel).toHaveBeenCalledOnce();
    expect(globalChapterWheel).toHaveBeenCalledOnce();
    window.removeEventListener('wheel', bubbledWheel);
  });

  it('安装提示与常见问题保留语义层，并由独立 GPU 纹理负责视觉渲染', () => {
    const { container } = render(
      <DownloadChapter interactive staticFallback transitionProgress={2} />
    );
    const notice = screen.getByRole('region', { name: '安装前须知 · 常见问题' });
    expect(notice.textContent).toContain('安装前须知');
    expect(notice.textContent).toContain('常见问题');
    expect(container.querySelector('[class*="glassCopyContent"]')).toBeNull();
    expect(LIQUID_GLASS_FRAGMENT_SHADER).toContain('u_downloadTextTexture');
  });

  it('进入视觉死区内按下安装提示区不发布玻璃水波', () => {
    const ripple = vi.fn();
    window.addEventListener(LIQUID_GLASS_RIPPLE_EVENT, ripple);
    render(<DownloadChapter interactive transitionProgress={1.1} />);

    fireEvent.pointerDown(screen.getByRole('region', { name: '安装前须知 · 常见问题' }), {
      button: 0,
      clientX: 120,
      clientY: 240
    });

    expect(ripple).not.toHaveBeenCalled();
    window.removeEventListener(LIQUID_GLASS_RIPPLE_EVENT, ripple);
  });

  it('越过视觉进入死区后按下安装提示区只发布一次玻璃水波', () => {
    const ripple = vi.fn();
    window.addEventListener(LIQUID_GLASS_RIPPLE_EVENT, ripple);
    render(<DownloadChapter interactive transitionProgress={1.13} />);

    fireEvent.pointerDown(screen.getByRole('region', { name: '安装前须知 · 常见问题' }), {
      button: 0,
      clientX: 120,
      clientY: 240
    });

    expect(ripple).toHaveBeenCalledOnce();
    window.removeEventListener(LIQUID_GLASS_RIPPLE_EVENT, ripple);
  });

  it('Windows 大字在下载过渡末段前保持在屏幕外', () => {
    const { rerender } = render(
      <DownloadChapter interactive staticFallback transitionProgress={1.286} />
    );
    const chapter = screen.getByTestId('download-chapter');
    expect(chapter.style.getPropertyValue('--platform-offset')).toBe('130vw');

    rerender(<DownloadChapter interactive staticFallback transitionProgress={2} />);
    expect(chapter.style.getPropertyValue('--platform-offset')).toBe('0vw');
  });

  it('英文环境使用对应的平台与状态文案', () => {
    render(
      <I18nProvider initialLocale="en">
        <DownloadChapter interactive staticFallback />
      </I18nProvider>
    );

    expect(screen.getByRole('heading', { name: 'Choose Your Platform' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Current platform: Windows' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Not yet published' }) as HTMLButtonElement)
      .disabled).toBe(true);
  });
});
