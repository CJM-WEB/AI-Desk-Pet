// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gsap } from 'gsap';
import { I18nProvider, useI18n } from '../components/i18n/I18nProvider';
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

function createMutableMediaQueryList(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const mediaQuery = {
    get matches() { return matches; },
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    }),
    removeEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    }),
    dispatchEvent: vi.fn()
  } as unknown as MediaQueryList;
  return {
    mediaQuery,
    setMatches(next: boolean) {
      matches = next;
      const event = { matches, media: mediaQuery.media } as MediaQueryListEvent;
      listeners.forEach(listener => listener(event));
    }
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
    expect(context).not.toHaveBeenCalled();

    fireEvent.click(next);
    await waitFor(() => {
      expect(experience.dataset.activeChapter).toBe('download');
    });

    expect(revert).not.toHaveBeenCalled();
    expect(onRuntimeError).not.toHaveBeenCalled();
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
    expect(context).not.toHaveBeenCalled();

    unmount();
    gsap.ticker.sleep();

    const stateWarnings = consoleError.mock.calls
      .flat()
      .map(String)
      .filter((message) => /unmount|state update/i.test(message));
    expect(revert).not.toHaveBeenCalled();
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

  it('matchMedia 失败后下载平台文字切换不再调用浏览器媒体 API', async () => {
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
    expect(screen.queryByRole('link', { name: '下载 Windows' })).toBeNull();
    expect((screen.getByRole('button', { name: '尚未发布' }) as HTMLButtonElement)
      .disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: '选择 macOS' }));
    expect(screen.getByTestId('download-chapter').dataset.activePlatform)
      .toBe('macos');
    expect(screen.getByTestId('download-chapter').dataset.staticFallback)
      .toBe('true');
    expect(screen.getByTestId('support-chapter').dataset.motionDisabled)
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

  it('首页完成后下载平台切换不依赖 GSAP context 初始化', async () => {
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

    fireEvent.click(screen.getByRole('button', { name: '选择 macOS' }));

    expect(context).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByTestId('download-chapter').dataset.activePlatform)
        .toBe('macos');
    });
    expect(screen.queryByRole('link', { name: '下载 macOS' })).toBeNull();
    expect(screen.getByRole('button', { name: '即将支持' })).toBeTruthy();

  });

  it('减少动态效果使用静态品牌且浏览全部业务章节时不创建 WebGL', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => createMediaQueryList(true)));
    const getContext = vi.mocked(HTMLCanvasElement.prototype.getContext);
    const tickerAdd = vi.spyOn(gsap.ticker, 'add');

    render(<WebsiteExperience />);

    const experience = screen.getByTestId('website-experience');
    await waitFor(() => {
      expect(screen.getByTestId('liquid-glass-home').dataset.initializationFailed)
        .toBe('false');
    });
    expect(experience.dataset.initializationFailed).toBe('false');
    expect(experience.dataset.staticFallback).toBe('ready');
    const liquidHome = screen.getByTestId('liquid-glass-home');
    expect(liquidHome.querySelector('span')?.textContent).toBe('AI PET');
    expect(liquidHome.querySelector('span')?.parentElement?.getAttribute('aria-hidden'))
      .toBe('false');
    expect(getContext.mock.calls.some(([type]) => type === 'webgl')).toBe(false);
    expect(tickerAdd).not.toHaveBeenCalled();

    expect(document.querySelector('[data-layer="cursor"]')).toBeNull();
    expect(document.querySelector('[data-layer="file"]')).toBeNull();
    expect(document.querySelectorAll('[data-chapter-id]')).toHaveLength(5);

    const next = screen.getByRole('button', { name: '下一章节' });
    fireEvent.click(next);
    expect(screen.getByTestId('about-chapter').dataset.staticFallback).toBe('true');
    expect(document.querySelector('[data-chapter-id="about"]')?.getAttribute('aria-hidden'))
      .toBe('false');
    fireEvent.click(next);
    expect(screen.getByTestId('website-experience').dataset.activeChapter)
      .toBe('download');
    expect(document.querySelector('[data-chapter-id="download"]')?.getAttribute('aria-hidden'))
      .toBe('false');
    expect(screen.queryByRole('link', { name: '下载 Windows' })).toBeNull();
    expect(screen.getByRole('button', { name: '尚未发布' })).toBeTruthy();
    fireEvent.click(next);
    expect(document.querySelector('[data-chapter-id="community"]')?.getAttribute('aria-hidden'))
      .toBe('false');
    fireEvent.click(next);
    expect(screen.getByTestId('website-experience').dataset.activeChapter)
      .toBe('feedback');
    expect(document.querySelector('[data-chapter-id="feedback"]')?.getAttribute('aria-hidden'))
      .toBe('false');
    expect(screen.getByText('微信')).toBeTruthy();
    expect(screen.getByText('支付宝')).toBeTruthy();
    expect(getContext.mock.calls.some(([type]) => type === 'webgl')).toBe(false);
    expect(tickerAdd).not.toHaveBeenCalled();
  });

  it('运行期切换动态偏好会释放 WebGL 并可重新初始化', async () => {
    const media = createMutableMediaQueryList(false);
    vi.stubGlobal('matchMedia', vi.fn(() => media.mediaQuery));
    const webGlMethods = new Map<string, ReturnType<typeof vi.fn>>();
    const method = (name: string) => {
      let implementation = webGlMethods.get(name);
      if (!implementation) {
        implementation = vi.fn(() => {
          if (/^create(?:Buffer|Program|Shader|Texture)$/.test(name)) return {};
          if (name === 'getUniformLocation') return {};
          if (/^get(?:Program|Shader)Parameter$/.test(name)) return true;
          if (name === 'getAttribLocation') return 0;
          if (/^get(?:Program|Shader)InfoLog$/.test(name)) return '';
          if (name === 'measureText') return { width: 48 };
          if (name === 'createLinearGradient') return { addColorStop: vi.fn() };
          return undefined;
        });
        webGlMethods.set(name, implementation);
      }
      return implementation;
    };
    const context = new Proxy({}, {
      get: (_target, property) => {
        const name = String(property);
        return name === name.toUpperCase() ? 1 : method(name);
      }
    });
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation(() => context as CanvasRenderingContext2D);
    const tickerAdd = vi.spyOn(gsap.ticker, 'add')
      .mockImplementation(callback => callback);
    const tickerRemove = vi.spyOn(gsap.ticker, 'remove').mockImplementation(() => {});

    render(<WebsiteExperience />);
    await waitFor(() => expect(tickerAdd).toHaveBeenCalledTimes(1));
    expect(getContext.mock.calls.filter(([type]) => type === 'webgl')).toHaveLength(1);

    act(() => media.setMatches(true));
    await waitFor(() => {
      expect(screen.getByTestId('website-experience').dataset.reducedMotion).toBe('true');
    });
    expect(screen.getByTestId('liquid-glass-home').dataset.initializationFailed)
      .toBe('false');
    expect(screen.getByTestId('liquid-glass-home').querySelector('span')
      ?.parentElement?.getAttribute('aria-hidden')).toBe('false');
    expect(tickerRemove).toHaveBeenCalledTimes(1);
    expect(method('deleteProgram')).toHaveBeenCalledTimes(1);

    act(() => media.setMatches(false));
    await waitFor(() => expect(tickerAdd).toHaveBeenCalledTimes(2));
    expect(getContext.mock.calls.filter(([type]) => type === 'webgl')).toHaveLength(2);
    expect(screen.getByTestId('website-experience').dataset.reducedMotion).toBe('false');
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
  });

  it('I18nProvider 切换语言后让合并支持模块使用新语言', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => createMediaQueryList(true)));
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

    fireEvent.click(screen.getByRole('button', { name: '测试切换英文' }));
    expect(screen.getByRole('button', { name: 'Open WeChat Pay QR code' })).toBeTruthy();
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

    expect(screen.getByRole('button', { name: 'language' })).toBeTruthy();

    runNextFrame(400);
    fireEvent.click(screen.getByRole('button', { name: '上一章节' }));
    runNextFrame(400);
    expect(screen.queryByRole('button', { name: 'language' })).toBeNull();

    runNextFrame(800);

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
      let frameIndex = -1;
      for (let index = frames.length - 1; index >= 0; index -= 1) {
        if (frames[index]?.name === 'advance') {
          frameIndex = index;
          break;
        }
      }
      const callback = frameIndex < 0 ? undefined : frames.splice(frameIndex, 1)[0];
      if (!callback) throw new Error('缺少章节吸附动画帧');
      act(() => callback(frameAt));
    };
    const experience = screen.getByTestId('website-experience');

    fireEvent.click(screen.getByRole('button', { name: '下一章节' }));
    runNextSnapFrame(0);
    runNextSnapFrame(400);
    expect(experience.dataset.activeChapter).toBe('about');

    act(() => { vi.advanceTimersByTime(800); });
    fireEvent.wheel(window, { deltaY: -120 });
    fireEvent.wheel(window, { deltaY: -120 });
    expect(experience.dataset.activeChapter).toBe('about');

    fireEvent.wheel(window, { deltaY: -600 });
    act(() => { vi.advanceTimersByTime(120); });
    runNextSnapFrame(800);
    runNextSnapFrame(1180);

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
