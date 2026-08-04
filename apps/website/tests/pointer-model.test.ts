import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { computeCanvasBufferSize } from '../components/home-experience/CursorField';
import { FilePreview } from '../components/home-experience/FilePreview';
import {
  computePreviewPosition,
  trailAlpha
} from '../components/home-experience/pointer-model';

describe('Canvas 后备缓冲区', () => {
  it('CSS 尺寸不变但 DPR 改变时重新计算受上限约束的像素尺寸', () => {
    expect(computeCanvasBufferSize({
      width: 400,
      height: 200,
      devicePixelRatio: 1
    })).toEqual({ width: 400, height: 200, pixelRatio: 1 });

    expect(computeCanvasBufferSize({
      width: 400,
      height: 200,
      devicePixelRatio: 2
    })).toEqual({ width: 700, height: 350, pixelRatio: 1.75 });
  });
});

describe('预览位置', () => {
  it.each([
    { corner: '左上', pointer: { x: 10, y: 10 }, expected: { x: 28, y: 28 } },
    { corner: '右上', pointer: { x: 1430, y: 10 }, expected: { x: 1152, y: 28 } },
    { corner: '左下', pointer: { x: 10, y: 890 }, expected: { x: 28, y: 692 } },
    { corner: '右下', pointer: { x: 1430, y: 890 }, expected: { x: 1152, y: 692 } }
  ])('在靠近$corner时翻转并将四边限制在视口内', ({ pointer, expected }) => {
    const preview = { width: 260, height: 180 };
    const viewport = { width: 1440, height: 900 };
    const position = computePreviewPosition({
      pointer,
      preview,
      viewport,
      gap: 18
    });

    expect(position).toEqual(expected);
    expect(position.x).toBeGreaterThanOrEqual(0);
    expect(position.y).toBeGreaterThanOrEqual(0);
    expect(position.x + preview.width).toBeLessThanOrEqual(viewport.width);
    expect(position.y + preview.height).toBeLessThanOrEqual(viewport.height);
  });

  it('预览尺寸大于视口时将坐标限制为正零', () => {
    expect(computePreviewPosition({
      pointer: { x: 50, y: 50 },
      preview: { width: 260, height: 180 },
      viewport: { width: 120, height: 80 },
      gap: 18
    })).toEqual({ x: 0, y: 0 });
  });
});

describe('单例文件预览', () => {
  it('以礼貌状态区渲染活动粒子的标题、元数据和内容行', () => {
    const markup = renderToStaticMarkup(createElement(FilePreview, {
      particle: {
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
        isHeld: true,
        phase: 'floating'
      },
      pointer: { x: 120, y: 140 },
      anchorRect: null,
      inputMode: 'pointer'
    }));

    expect(markup).toContain('data-testid="file-preview"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('今日备忘');
    expect(markup).toContain('TXT · 刚刚');
    expect(markup).toContain('整理项目素材');
    expect(markup).toContain('确认下一阶段计划');
    expect(markup.match(/data-testid="file-preview"/g) ?? []).toHaveLength(1);
  });
});

describe('轨迹透明度', () => {
  it('按生命周期线性衰减', () => {
    expect(trailAlpha(0, 1200)).toBe(1);
    expect(trailAlpha(600, 1200)).toBe(0.5);
    expect(trailAlpha(1200, 1200)).toBe(0);
  });

  it('将负年龄和零生命周期限制为有限范围', () => {
    expect(trailAlpha(-100, 1200)).toBe(1);
    expect(trailAlpha(0, 0)).toBe(0);
  });
});
