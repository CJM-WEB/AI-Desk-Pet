// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gsap } from 'gsap';
import { I18nProvider, useI18n } from '../components/i18n/I18nProvider';
import { WebsiteExperience } from '../components/website-experience/WebsiteExperience';
import { WHEEL_SNAP_DEBOUNCE_MS } from '../components/website-experience/use-website-controller';

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

function LocaleTestControls() {
  const { setLocale } = useI18n();
  return (
    <>
      <button type="button" onClick={() => setLocale('zh-CN')}>测试切换中文</button>
      <button type="button" onClick={() => setLocale('en')}>测试切换英文</button>
    </>
  );
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
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('介绍章节依赖更新时 cleanup 异常会报告统一运行时错误并进入静态回退', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => createMediaQueryList(false)));
    const onRuntimeError = vi.fn();
    render(<WebsiteExperience onRuntimeError={onRuntimeError} />);

    const experience = screen.getByTestId('website-experience');
    fireEvent.click(document.body);
    await waitFor(() => {
      expect(screen.getByTestId('home-experience').dataset.phase)
        .toBe('interactive');
    });

    let frameAt = 0;
    vi.stubGlobal('requestAnimationFrame', vi.fn((
      callback: FrameRequestCallback
    ) => window.setTimeout(() => {
      frameAt += 400;
      callback(frameAt);
    }, 0)));
    vi.stubGlobal('cancelAnimationFrame', vi.fn((frame: number) => {
      window.clearTimeout(frame);
    }));
    const next = experience
      .querySelector('nav')!
      .querySelectorAll<HTMLButtonElement>('button')[1]!;
    const revert = vi.fn(() => {
      throw new Error('介绍 GSAP 依赖更新清理失败');
    });
    const context = vi.spyOn(gsap, 'context').mockReturnValue({
      revert
    } as unknown as gsap.Context);

    fireEvent.click(next);
    await waitFor(() => {
      expect(experience.dataset.activeChapter).toBe('about');
    });
    expect(context).toHaveBeenCalledOnce();

    fireEvent.click(next);
    await waitFor(() => {
      expect(experience.dataset.staticFallback).toBe('active');
    });

    expect(revert).toHaveBeenCalledOnce();
    expect(onRuntimeError).toHaveBeenCalledOnce();
  });

  it('WebsiteExperience 最终 unmount 时介绍 cleanup 异常不会再报告父级运行时错误', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => createMediaQueryList(false)));
    const onRuntimeError = vi.fn();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { unmount } = render(
      <WebsiteExperience onRuntimeError={onRuntimeError} />
    );

    const experience = screen.getByTestId('website-experience');
    fireEvent.click(document.body);
    await waitFor(() => {
      expect(screen.getByTestId('home-experience').dataset.phase)
        .toBe('interactive');
    });

    let frameAt = 0;
    vi.stubGlobal('requestAnimationFrame', vi.fn((
      callback: FrameRequestCallback
    ) => window.setTimeout(() => {
      frameAt += 400;
      callback(frameAt);
    }, 0)));
    vi.stubGlobal('cancelAnimationFrame', vi.fn((frame: number) => {
      window.clearTimeout(frame);
    }));
    const next = experience
      .querySelector('nav')!
      .querySelectorAll<HTMLButtonElement>('button')[1]!;
    const revert = vi.fn(() => {
      throw new Error('介绍 GSAP 最终卸载清理失败');
    });
    const context = vi.spyOn(gsap, 'context').mockReturnValue({
      revert
    } as unknown as gsap.Context);

    fireEvent.click(next);
    await waitFor(() => {
      expect(experience.dataset.activeChapter).toBe('about');
    });
    expect(context).toHaveBeenCalledOnce();

    unmount();
    gsap.ticker.sleep();

    const stateWarnings = consoleError.mock.calls
      .flat()
      .map(String)
      .filter((message) => /unmount|state update/i.test(message));
    expect(revert).toHaveBeenCalledOnce();
    expect(onRuntimeError).not.toHaveBeenCalled();
    expect(stateWarnings).toEqual([]);
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
    expect(document.querySelectorAll('[data-chapter-id]')).toHaveLength(6);
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
    expect(screen.queryByRole('link', { name: '下载 Windows' })).toBeNull();
    expect((screen.getByRole('button', { name: '尚未发布' }) as HTMLButtonElement)
      .disabled).toBe(true);

    expect(() => {
      fireEvent.pointerEnter(screen.getByRole('button', { name: '显示常见问题' }));
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
    expect(removeEventListener).not.toHaveBeenCalledWith(
      'click',
      expect.any(Function)
    );

    window.dispatchEvent(new WheelEvent('wheel', {
      cancelable: true,
      deltaY: 640
    }));
    expect(experience.dataset.activeChapter).toBe('home');
  });

  it('首页完成后下载 GSAP 初始化失败会进入统一静态回退', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => createMediaQueryList(false)));
    render(<WebsiteExperience />);

    const experience = screen.getByTestId('website-experience');
    fireEvent.click(document.body);
    await waitFor(() => {
      expect(screen.getByTestId('home-experience').dataset.phase)
        .toBe('interactive');
    });

    const context = vi.spyOn(gsap, 'context').mockImplementation(() => {
      throw new Error('下载 GSAP 初始化失败');
    });
    let frameAt = 0;
    vi.stubGlobal('requestAnimationFrame', vi.fn((
      callback: FrameRequestCallback
    ) => window.setTimeout(() => {
      frameAt += 400;
      callback(frameAt);
    }, 0)));
    vi.stubGlobal('cancelAnimationFrame', vi.fn((frame: number) => {
      window.clearTimeout(frame);
    }));
    const next = screen.getByRole('button', { name: '下一章节' });
    fireEvent.click(next);
    await waitFor(() => {
      expect(experience.dataset.activeChapter).toBe('about');
    });
    fireEvent.click(next);
    await waitFor(() => {
      expect(experience.dataset.activeChapter).toBe('download');
    });

    expect(() => {
      fireEvent.pointerEnter(screen.getByRole('button', { name: '显示常见问题' }));
    }).not.toThrow();
    await waitFor(() => {
      expect(experience.dataset.staticFallback).toBe('active');
    });

    expect(context).toHaveBeenCalledOnce();
    expect(screen.getByTestId('download-chapter').dataset.visibleSide)
      .toBe('faq');
    expect(screen.queryByRole('link', { name: '下载 Windows' })).toBeNull();
    expect(screen.getByRole('button', { name: '尚未发布' })).toBeTruthy();

    fireEvent.click(next);
    fireEvent.click(next);
    fireEvent.click(next);
    expect(experience.dataset.activeChapter).toBe('donation');
    const payment = screen.getByRole('button', { name: '打开微信付款码' });
    expect((payment as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(payment);
    expect(screen.getByRole('dialog', { name: '微信付款码' })).toBeTruthy();
  });

  it('首页 WebGL 初始化失败只启用首页局部回退并保留章节内容', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => createMediaQueryList(true)));

    render(<WebsiteExperience />);

    const experience = screen.getByTestId('website-experience');
    await waitFor(() => {
      expect(screen.getByTestId('liquid-glass-home').dataset.initializationFailed)
        .toBe('true');
    });
    expect(experience.dataset.staticFallback).toBe('ready');

    expect(document.querySelector('[data-layer="cursor"]')).toBeNull();
    expect(document.querySelector('[data-layer="file"]')).toBeNull();
    expect(document.querySelectorAll('[data-chapter-id]')).toHaveLength(6);

    const next = screen.getByRole('button', { name: '下一章节' });
    fireEvent.click(next);
    fireEvent.click(next);
    expect(screen.getByTestId('website-experience').dataset.activeChapter)
      .toBe('download');
    expect(screen.queryByRole('link', { name: '下载 Windows' })).toBeNull();
    expect(screen.getByRole('button', { name: '尚未发布' })).toBeTruthy();
    fireEvent.click(next);
    fireEvent.click(next);
    fireEvent.click(next);
    expect(screen.getByTestId('website-experience').dataset.activeChapter)
      .toBe('donation');
    expect(screen.getByText('微信')).toBeTruthy();
    expect(screen.getByText('支付宝')).toBeTruthy();
  });

  it('首页切换英文后导航至共享仓库会隐藏语言入口，返回首页后恢复英文选择', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => createMediaQueryList(true)));
    render(
      <I18nProvider initialLocale="zh-CN">
        <WebsiteExperience />
      </I18nProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: 'language' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'English' }));
    const next = screen.getByRole('button', { name: 'Next chapter' });
    fireEvent.click(next);
    fireEvent.click(next);
    fireEvent.click(next);

    expect(screen.getByTestId('website-experience').dataset.activeChapter)
      .toBe('community');
    expect(screen.queryByRole('button', { name: 'language' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'AI Pet Community' })).toBeTruthy();

    const previous = screen.getByRole('button', { name: 'Previous chapter' });
    fireEvent.click(previous);
    fireEvent.click(previous);
    fireEvent.click(previous);

    expect(screen.getByTestId('website-experience').dataset.activeChapter)
      .toBe('home');
    fireEvent.click(screen.getByRole('button', { name: 'language' }));
    expect(screen.getByRole('menuitemradio', { name: 'English' })
      .getAttribute('aria-checked')).toBe('true');
  });

  it('英文环境使用国际化章节区域标签', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => createMediaQueryList(true)));
    render(
      <I18nProvider initialLocale="en">
        <WebsiteExperience />
      </I18nProvider>
    );

    expect(document.querySelector('[data-chapter-id="home"]')?.getAttribute('aria-label'))
      .toBe('Home');
    expect(document.querySelector('[data-chapter-id="about"]')?.getAttribute('aria-label'))
      .toBe('About AI Pet');
    expect(document.querySelector('[data-chapter-id="download"]')?.getAttribute('aria-label'))
      .toBe('Download AI Pet');
    expect(document.querySelector('[data-chapter-id="community"]')?.getAttribute('aria-label'))
      .toBe('Shared repository');
    expect(document.querySelector('[data-chapter-id="feedback"]')?.getAttribute('aria-label'))
      .toBe('Feedback and Suggestions');
    expect(document.querySelector('[data-chapter-id="donation"]')?.getAttribute('aria-label'))
      .toBe('Support Development');
  });

  it('I18nProvider 切换语言后让 WebsiteExperience 的新反馈预览使用新语言', () => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', vi.fn(() => createMediaQueryList(true)));
    vi.spyOn(Math, 'random').mockReturnValue(0);
    render(
      <I18nProvider initialLocale="zh-CN">
        <LocaleTestControls />
        <WebsiteExperience />
      </I18nProvider>
    );
    const next = screen.getByRole('button', { name: '下一章节' });
    fireEvent.click(next);
    fireEvent.click(next);
    fireEvent.click(next);
    fireEvent.click(next);
    expect(screen.getByTestId('website-experience').dataset.activeChapter).toBe('feedback');

    act(() => vi.advanceTimersByTime(1_000));
    const firstParticle = screen.getAllByTestId('file-icon')[0]!;
    fireEvent.pointerEnter(firstParticle);
    expect(screen.getByTestId('file-preview').textContent).toContain('类型');

    fireEvent.click(screen.getByRole('button', { name: '测试切换英文' }));
    act(() => vi.advanceTimersByTime(1_000));
    const particles = screen.getAllByTestId('file-icon');
    fireEvent.pointerEnter(particles.at(-1)!);

    expect(screen.getByTestId('file-preview').textContent).toContain('Type');
  });

  it('正常动画的首帧离开首页时立即卸载语言入口，返回稳定首页后恢复', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => createMediaQueryList(false)));
    render(<WebsiteExperience />);

    fireEvent.click(document.body);
    await waitFor(() => {
      expect(screen.getByTestId('home-experience').dataset.phase)
        .toBe('interactive');
    });

    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback) => {
      frames.push(callback);
      return frames.length;
    }));
    const runNextFrame = (frameAt: number) => {
      const callback = frames.shift();
      if (!callback) throw new Error('缺少章节吸附动画帧');
      act(() => callback(frameAt));
    };

    fireEvent.click(screen.getByRole('button', { name: '下一章节' }));
    runNextFrame(0);

    expect(screen.queryByRole('button', { name: 'language' })).toBeNull();

    runNextFrame(300);
    fireEvent.click(screen.getByRole('button', { name: '上一章节' }));
    runNextFrame(400);
    expect(screen.queryByRole('button', { name: 'language' })).toBeNull();

    runNextFrame(700);

    expect(screen.getByTestId('website-experience').dataset.activeChapter)
      .toBe('home');
    expect(screen.getByRole('button', { name: 'language' })).toBeTruthy();
  });

  it('滚轮返回首页的吸附期间不显示语言入口，稳定落位后才恢复', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => createMediaQueryList(false)));
    render(<WebsiteExperience />);

    fireEvent.click(document.body);
    await waitFor(() => {
      expect(screen.getByTestId('home-experience').dataset.phase)
        .toBe('interactive');
    });

    vi.useFakeTimers();
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback) => {
      frames.push(callback);
      return frames.length;
    }));
    const runNextSnapFrame = (frameAt: number) => {
      const frameIndex = frames.findIndex((callback) => callback.name === 'advance');
      const callback = frameIndex < 0 ? undefined : frames.splice(frameIndex, 1)[0];
      if (!callback) throw new Error('缺少章节吸附动画帧');
      act(() => callback(frameAt));
    };
    const experience = screen.getByTestId('website-experience');

    fireEvent.click(screen.getByRole('button', { name: '下一章节' }));
    runNextSnapFrame(0);
    runNextSnapFrame(300);
    expect(experience.dataset.activeChapter).toBe('about');

    fireEvent.wheel(window, { deltaY: -50_000 });

    expect(experience.dataset.activeChapter).toBe('about');
    expect(screen.queryByRole('button', { name: 'language' })).toBeNull();

    act(() => {
      vi.advanceTimersByTime(WHEEL_SNAP_DEBOUNCE_MS);
    });
    runNextSnapFrame(400);
    expect(screen.queryByRole('button', { name: 'language' })).toBeNull();

    runNextSnapFrame(700);

    expect(experience.dataset.activeChapter).toBe('home');
    expect(screen.getByRole('button', { name: 'language' })).toBeTruthy();
  });

  it('语言菜单使用首页右上角定位', () => {
    const css = readFileSync(
      resolve(process.cwd(), 'components/i18n/language-menu.module.css'),
      'utf8'
    );

    expect(css).not.toContain('left: 50%');
    expect(css).not.toContain('translateX(-50%)');
    expect(css).toMatch(/right:\s*[^;]+;/);
  });
});
