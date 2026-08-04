// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FilePreview } from '../components/home-experience/FilePreview';
import type { FileParticle } from '../components/home-experience/swarm-model';
import { CHAPTER_LAYERS } from '../components/website-experience/layer-contract';
import { SharedVisualLayers } from '../components/website-experience/SharedVisualLayers';
import { WebsiteExperience } from '../components/website-experience/WebsiteExperience';
import { I18nProvider } from '../components/i18n/I18nProvider';
import {
  DEFAULT_FILE_PREVIEW_CONTENT_SOURCE,
  type FilePreviewContentSource,
  VISUAL_PROFILES
} from '../components/website-experience/shared-visual-model';

const PARTICLE: FileParticle = {
  id: 'particle-1',
  kind: 'txt',
  preview: {
    title: '今日备忘',
    meta: 'TXT · 刚刚',
    lines: ['整理项目素材', '确认下一阶段计划']
  },
  x: 100,
  y: 100,
  width: 120,
  height: 120,
  rotation: 0,
  scale: 1,
  remainingMs: 1000,
  isHeld: false,
  phase: 'floating'
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function createReducedMotionQuery(): MediaQueryList {
  return {
    matches: true,
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn()
  };
}

function renderSharedLayers() {
  const markup = renderToStaticMarkup(createElement(
    'div',
    null,
    createElement(SharedVisualLayers, {
      profile: VISUAL_PROFILES.download,
      running: false,
      generating: false,
      exitProgress: 0,
      pointer: { x: 0, y: 0 },
      isPaused: false,
      reducedMotion: false,
      onInitializationError: () => {}
    })
  ));
  const container = document.createElement('div');
  container.innerHTML = markup;
  return container;
}

describe('共享文件预览内容源', () => {
  it('默认内容源保持首页现有预览文本不变', () => {
    expect(DEFAULT_FILE_PREVIEW_CONTENT_SOURCE.getPreview(PARTICLE)).toEqual([
      '整理项目素材',
      '确认下一阶段计划'
    ]);
  });

  it('预览组件消费注入内容源而不依赖章节标识', () => {
    const source: FilePreviewContentSource = {
      getPreview: () => ['来自可配置内容源的预览']
    };
    const markup = renderToStaticMarkup(createElement(FilePreview, {
      particle: PARTICLE,
      pointer: { x: 120, y: 140 },
      anchorRect: null,
      inputMode: 'pointer',
      previewSource: source
    }));

    expect(markup).toContain('来自可配置内容源的预览');
    expect(markup).not.toContain('整理项目素材');
  });
});

describe('共享视觉图层契约', () => {
  it('英文环境本地化文件预览队列标签', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <SharedVisualLayers
          profile={VISUAL_PROFILES.download}
          running={false}
          generating={false}
          exitProgress={0}
          pointer={{ x: 0, y: 0 }}
          isPaused={false}
          reducedMotion={false}
          onInitializationError={() => {}}
        />
      </I18nProvider>
    );

    expect(markup).toContain('aria-label="File preview queue"');
  });

  it('后续章节关闭光场并复用默认预览内容源', () => {
    expect(VISUAL_PROFILES.download.fieldEnabled).toBe(false);
    expect(VISUAL_PROFILES.donation.fieldEnabled).toBe(false);
    expect(VISUAL_PROFILES.download.previewSource)
      .toBe(DEFAULT_FILE_PREVIEW_CONTENT_SOURCE);
    expect(VISUAL_PROFILES.donation.previewSource)
      .toBe(DEFAULT_FILE_PREVIEW_CONTENT_SOURCE);
  });

  it('文件层不截获焦点区域的命中，预览层保持最高层级', () => {
    const container = renderSharedLayers();
    const fileLayer = container.querySelector<HTMLElement>('[data-layer="file"]');
    const previewLayer = container.querySelector<HTMLElement>('[data-layer="preview"]');

    expect(fileLayer?.style.zIndex).toBe(String(CHAPTER_LAYERS.files));
    expect(fileLayer?.style.pointerEvents).toBe('none');
    expect(previewLayer?.style.zIndex).toBe(String(CHAPTER_LAYERS.preview));
    expect(CHAPTER_LAYERS.focal).toBeGreaterThan(CHAPTER_LAYERS.files);
    expect(CHAPTER_LAYERS.preview).toBeGreaterThan(CHAPTER_LAYERS.focal);
  });

  it('生产首页以独立液态玻璃画布替代旧文件层，章节背景仍保持根级', () => {
    const markup = renderToStaticMarkup(createElement(WebsiteExperience));
    const container = document.createElement('div');
    container.innerHTML = markup;
    const experience = container.querySelector<HTMLElement>('[data-testid="website-experience"]');
    const backdropLayer = container.querySelector<HTMLElement>('[data-layer="backdrop"]');
    const homeBackdrop = container.querySelector<HTMLElement>(
      '[data-backdrop-chapter-id="home"]'
    );
    const chapters = Array.from(container.querySelectorAll<HTMLElement>('[data-chapter-id]'));
    const fileLayer = container.querySelector<HTMLElement>('[data-layer="file"]');
    const liquidHome = container.querySelector<HTMLElement>(
      '[data-testid="liquid-glass-home"]'
    );
    const homeChapter = chapters.find(
      (chapter) => chapter.dataset.chapterId === 'home'
    );

    expect(backdropLayer?.parentElement).toBe(experience);
    expect(fileLayer).toBeNull();
    expect(homeChapter?.contains(liquidHome ?? null)).toBe(true);
    expect(backdropLayer?.style.zIndex).toBe(String(CHAPTER_LAYERS.backdrop));
    expect(backdropLayer?.contains(homeBackdrop)).toBe(true);
    expect(homeChapter?.contains(homeBackdrop)).toBe(false);
    expect(chapters).toHaveLength(6);
    expect(chapters.some((chapter) => chapter.dataset.chapterId === 'community'))
      .toBe(true);
    for (const chapter of chapters) {
      expect(chapter.dataset.layer).toBe('focal');
      expect(Number(chapter.style.zIndex)).toBeGreaterThan(CHAPTER_LAYERS.files);
    }
  });

  it('生产页面进入下载章节后挂载下载文件配置并开始生成粒子', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => createReducedMotionQuery()));
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      clearRect: vi.fn(),
      setTransform: vi.fn()
    } as unknown as CanvasRenderingContext2D);
    render(<WebsiteExperience />);
    const experience = screen.getByTestId('website-experience');
    const next = screen.getByRole('button', { name: '下一章节' });

    fireEvent.click(next);
    fireEvent.click(next);

    expect(experience.dataset.activeChapter).toBe('download');
    let fileLayer: HTMLElement | null = null;
    await waitFor(() => {
      fileLayer = document.querySelector<HTMLElement>('[data-layer="file"]');
      expect(fileLayer?.dataset.profileId).toBe('download');
    });
    await waitFor(() => {
      expect(Number(fileLayer?.querySelector<HTMLElement>('[data-active-count]')
        ?.dataset.activeCount ?? 0)).toBeGreaterThan(0);
    }, { timeout: 1_500 });
  });
});
