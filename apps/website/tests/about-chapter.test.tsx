// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AboutChapter } from '../components/website-experience/about/AboutChapter';
import { ABOUT_FEATURES } from '../components/website-experience/about/about-content';

const gsapMocks = vi.hoisted(() => {
  const state = {
    contextError: null as Error | null,
    revertError: null as Error | null
  };
  const revert = vi.fn(() => {
    if (state.revertError) throw state.revertError;
  });
  const timeline = vi.fn((options?: { onComplete?: () => void }) => {
    const instance = {
      fromTo: vi.fn()
    };
    instance.fromTo.mockReturnValue(instance);
    options?.onComplete?.();
    return instance;
  });
  return {
    context: vi.fn((callback: () => void, _scope?: Element) => {
      if (state.contextError) throw state.contextError;
      callback();
      return { revert };
    }),
    revert,
    state,
    timeline
  };
});

vi.mock('gsap', () => ({
  gsap: {
    context: gsapMocks.context,
    timeline: gsapMocks.timeline
  }
}));

function setMobileViewport(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: matches && query === '(max-width: 760px)',
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }))
  });
}

function setViewport(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: width
  });
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    value: height
  });
}

function getPanel(id: string) {
  return document.querySelector<HTMLButtonElement>(
    `[data-about-feature="${id}"]`
  )!;
}

describe('AI Pet 介绍章节', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gsapMocks.state.contextError = null;
    gsapMocks.state.revertError = null;
    setViewport(1280, 800);
    setMobileViewport(false);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('渲染五个可访问功能区、中央标题和错峰入场顺序', () => {
    render(<AboutChapter interactive />);

    const chapter = screen.getByTestId('about-chapter');
    expect(screen.getByRole('heading', { name: 'AI Pet' })).toBeTruthy();
    expect(screen.getAllByTestId('pointer-tilt-text')).toHaveLength(1);
    expect(chapter.hasAttribute('data-input-scope')).toBe(false);
    expect(chapter.dataset.motionDisabled).toBe('false');
    expect(Array.from(chapter.querySelectorAll<HTMLElement>('[data-about-feature]')).map(
      (panel) => ({
        id: panel.dataset.aboutFeature,
        entryOrder: panel.dataset.entryOrder
      })
    )).toEqual(ABOUT_FEATURES.map((feature) => ({
      id: feature.id,
      entryOrder: String(feature.entryOrder)
    })));

    for (const feature of ABOUT_FEATURES) {
      expect(screen.getByRole('button', { name: feature.title })).toBeTruthy();
      expect(chapter.querySelector(`[data-about-illustration="${feature.illustration}"]`))
        .toBeTruthy();
    }
  });

  it('桌面鼠标点击不获取焦点，键盘焦点仍保持预览', () => {
    render(<AboutChapter interactive />);
    const chapter = screen.getByTestId('about-chapter');
    const security = getPanel('security');

    fireEvent.pointerEnter(security, { pointerType: 'mouse' });
    expect(chapter.dataset.activeFeature).toBe('security');
    expect(security.dataset.active).toBe('true');
    expect(screen.getByRole('tooltip')).toBeTruthy();

    expect(fireEvent.pointerDown(security, { pointerType: 'mouse' })).toBe(false);
    fireEvent.click(security);
    fireEvent.pointerLeave(security, { pointerType: 'mouse' });
    expect(chapter.dataset.activeFeature).toBe('none');

    fireEvent.focus(security);
    expect(chapter.dataset.activeFeature).toBe('security');
    fireEvent.pointerLeave(security, { pointerType: 'mouse' });
    expect(chapter.dataset.activeFeature).toBe('security');
    fireEvent.blur(security);
    expect(chapter.dataset.activeFeature).toBe('none');
  });

  it('移动端点击功能平面空白与中央安全区都可清除锁定', () => {
    setMobileViewport(true);
    render(<AboutChapter interactive />);
    const chapter = screen.getByTestId('about-chapter');
    const featurePlane = chapter.firstElementChild as HTMLElement;
    const safeZone = chapter.querySelector<HTMLElement>('[data-about-safe-zone]')!;
    const editor = getPanel('text-editor');
    const chat = getPanel('companion-chat');

    fireEvent.click(editor);
    expect(chapter.dataset.activeFeature).toBe('text-editor');
    fireEvent.click(featurePlane);
    expect(chapter.dataset.activeFeature).toBe('none');

    fireEvent.click(chat);
    expect(chapter.dataset.activeFeature).toBe('companion-chat');
    fireEvent.click(safeZone);
    expect(chapter.dataset.activeFeature).toBe('none');
  });

  it('中央安全区不触发面板预览', () => {
    render(<AboutChapter interactive />);
    const chapter = screen.getByTestId('about-chapter');
    Object.defineProperty(chapter, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 1000,
        bottom: 800,
        width: 1000,
        height: 800,
        toJSON: () => ({})
      })
    });

    fireEvent.pointerMove(chapter, { clientX: 500, clientY: 400 });
    expect(chapter.dataset.activeFeature).toBe('none');
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('安全区内移动仍更新中央标题指针', () => {
    render(<AboutChapter interactive />);
    const title = screen.getByTestId('pointer-tilt-text');
    const safeZone = screen.getByTestId('about-chapter')
      .querySelector<HTMLElement>('[data-about-safe-zone]')!;

    const initialRotateY = title.style.getPropertyValue('--pointer-tilt-rotate-y');
    fireEvent.pointerMove(safeZone, { clientX: 960, clientY: 400 });
    expect(title.style.getPropertyValue('--pointer-tilt-rotate-y'))
      .not.toBe(initialRotateY);
  });

  it('568x320 使用可读的紧凑横屏布局并保留全部功能文本', () => {
    setViewport(568, 320);
    setMobileViewport(true);
    render(<AboutChapter interactive reducedMotion />);
    const chapter = screen.getByTestId('about-chapter');

    expect(chapter.dataset.layout).toBe('compact-landscape');
    for (const feature of ABOUT_FEATURES) {
      const panel = getPanel(feature.id);
      expect(panel.textContent).toContain(feature.summary);
    }
  });

  it('活动面板通过稳定 aria-describedby 关联 tooltip', () => {
    render(<AboutChapter interactive />);
    const security = getPanel('security');

    fireEvent.focus(security);
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip.id).toBe('about-feature-preview-security');
    expect(security.getAttribute('aria-describedby')).toBe(tooltip.id);
  });

  it('减少动态效果与静态回退立即可见且不创建时间线', () => {
    const { rerender } = render(<AboutChapter interactive reducedMotion />);
    const chapter = screen.getByTestId('about-chapter');

    expect(chapter.dataset.motionDisabled).toBe('true');
    expect(chapter.dataset.entranceState).toBe('visible');

    rerender(<AboutChapter interactive staticFallback />);
    expect(chapter.dataset.motionDisabled).toBe('true');
    expect(chapter.dataset.entranceState).toBe('visible');
    expect(gsapMocks.timeline).not.toHaveBeenCalled();
  });

  it('GSAP 使用根节点 context 并在卸载时 revert', () => {
    const { unmount } = render(<AboutChapter interactive />);
    const chapter = screen.getByTestId('about-chapter');

    expect(gsapMocks.context).toHaveBeenCalledTimes(1);
    expect(gsapMocks.context.mock.calls[0]?.[1]).toBe(chapter);
    unmount();
    expect(gsapMocks.revert).toHaveBeenCalledTimes(1);
  });

  it('GSAP 初始化异常进入可见降级并上报', () => {
    const onInitializationError = vi.fn();
    gsapMocks.state.contextError = new Error('context 初始化失败');

    render(
      <AboutChapter
        interactive
        onInitializationError={onInitializationError}
      />
    );

    expect(screen.getByTestId('about-chapter').dataset.entranceState).toBe('visible');
    expect(onInitializationError).toHaveBeenCalledTimes(1);
  });

  it('GSAP 清理异常异步上报且不阻断暂停切换', async () => {
    const onInitializationError = vi.fn();
    gsapMocks.state.revertError = new Error('revert 失败');
    const { rerender } = render(
      <AboutChapter
        interactive
        onInitializationError={onInitializationError}
      />
    );

    rerender(
      <AboutChapter
        interactive
        isPaused
        onInitializationError={onInitializationError}
      />
    );

    await waitFor(() => {
      expect(onInitializationError).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByTestId('about-chapter').dataset.entranceState).toBe('visible');
  });

  it('暂停后恢复不会重放入场动画', () => {
    const { rerender } = render(<AboutChapter interactive />);
    expect(gsapMocks.timeline).toHaveBeenCalledTimes(1);

    rerender(<AboutChapter interactive isPaused />);
    rerender(<AboutChapter interactive />);

    expect(gsapMocks.timeline).toHaveBeenCalledTimes(1);
  });

  it('静态首帧固定为零倾斜，且不读取浏览器视口', () => {
    setViewport(1280, 800);

    const markup = renderToStaticMarkup(<AboutChapter interactive />);

    expect(markup).toContain('--pointer-tilt-rotate-x:0deg');
    expect(markup).toContain('--pointer-tilt-rotate-y:0deg');
  });

  it('激活功能时屏蔽其他面板的指针命中，清除激活后恢复', () => {
    const css = readFileSync(
      'components/website-experience/about/about.module.css',
      'utf8'
    );

    render(<AboutChapter interactive />);
    const security = getPanel('security');
    fireEvent.focus(security);
    expect(screen.getByTestId('about-chapter').dataset.activeFeature).toBe('security');
    expect(css).toMatch(/\.aboutChapter:not\(\[data-active-feature='none'\]\)\s+\.featurePanel:not\(\[data-active='true'\]\)\s*\{[^}]*pointer-events:\s*none;/s);

    fireEvent.blur(security);
    expect(screen.getByTestId('about-chapter').dataset.activeFeature).toBe('none');
  });
});
