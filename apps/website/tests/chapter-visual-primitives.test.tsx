import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CHAPTER_LAYERS } from '../components/website-experience/layer-contract';
import { ChapterBackdrop } from '../components/website-experience/visual/ChapterBackdrop';
import {
  computePointerTilt
} from '../components/website-experience/visual/pointer-tilt-model';
import { PointerTiltText } from '../components/website-experience/visual/PointerTiltText';

const CHAPTER_IDS = ['home', 'about', 'download', 'feedback', 'donation'] as const;
const BACKDROP_TONES = [
  'rgb(200, 200, 200)',
  'rgb(205, 205, 205)',
  'rgb(210, 210, 210)',
  'rgb(215, 215, 215)',
  'rgb(220, 220, 220)',
  'rgb(225, 225, 225)'
];

describe('章节视觉原语', () => {
  it('导出统一且精确的章节图层令牌', () => {
    expect(CHAPTER_LAYERS).toEqual({
      backdrop: 0,
      field: 10,
      files: 20,
      feature: 40,
      focal: 60,
      preview: 80,
      modal: 100
    });
  });

  it('将右上角指针映射为受限的双轴倾斜', () => {
    expect(computePointerTilt(
      { x: 1440, y: 0 },
      { width: 1440, height: 900 },
      5
    )).toEqual({ rotateX: 5, rotateY: 5 });
  });

  it.each([
    { label: 'NaN 指针', pointer: { x: Number.NaN, y: 100 }, viewport: { width: 1440, height: 900 } },
    { label: '无穷指针', pointer: { x: 100, y: Number.POSITIVE_INFINITY }, viewport: { width: 1440, height: 900 } },
    { label: '零宽视口', pointer: { x: 100, y: 100 }, viewport: { width: 0, height: 900 } },
    { label: '零高视口', pointer: { x: 100, y: 100 }, viewport: { width: 1440, height: 0 } },
    { label: '非有限角度', pointer: { x: 1440, y: 0 }, viewport: { width: 1440, height: 900 }, maxDegrees: Number.POSITIVE_INFINITY }
  ])('对$label返回静态安全零变换', ({ pointer, viewport, maxDegrees }) => {
    expect(computePointerTilt(pointer, viewport, maxDegrees)).toEqual({
      rotateX: 0,
      rotateY: 0
    });
  });

  it('禁用时为标题输出零倾斜且保留内容和自定义类名', () => {
    const markup = renderToStaticMarkup(createElement(PointerTiltText, {
      pointer: { x: 1440, y: 0 },
      viewport: { width: 1440, height: 900 },
      disabled: true,
      className: 'heading',
      children: 'AI Pet'
    }));

    expect(markup).toContain('data-motion-enabled="false"');
    expect(markup).toContain('--pointer-tilt-rotate-x:0deg');
    expect(markup).toContain('--pointer-tilt-rotate-y:0deg');
    expect(markup).toContain('heading');
    expect(markup).toContain('AI Pet');
  });

  it.each(CHAPTER_IDS)('为%s输出当前章节标记和六个规格面片', (chapterId) => {
    const markup = renderToStaticMarkup(createElement(ChapterBackdrop, {
      chapterId
    }));

    expect(markup).toContain('data-testid="chapter-backdrop"');
    expect(markup).toContain(`data-chapter-id="${chapterId}"`);
    expect(markup).toContain('aria-hidden="true"');
    expect(markup.match(/data-backdrop-panel="true"/g)).toHaveLength(6);
    for (const tone of BACKDROP_TONES) {
      expect(markup).toContain(`--backdrop-tone:${tone}`);
    }
  });

  it('为五个章节提供独立的 CSS 放射变体', () => {
    const css = readFileSync(
      new URL(
        '../components/website-experience/visual/chapter-backdrop.module.css',
        import.meta.url
      ),
      'utf8'
    );

    for (const chapterId of CHAPTER_IDS) {
      expect(css).toContain(`[data-chapter-id='${chapterId}']`);
    }
  });
});
