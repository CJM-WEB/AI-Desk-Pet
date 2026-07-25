import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { describe, expect, it } from 'vitest';
import Page from '../app/page';

describe('AI Pet 官网首页', () => {
  it('在静态 HTML 中保留品牌和基础语义', () => {
    const html = renderToStaticMarkup(<Page />);

    expect(html).toContain('<h1');
    expect(html).toContain('AI Pet');
    expect(html).toContain('data-testid="home-experience"');
    expect(html).toContain('data-static-fallback="ready"');
    expect(html).toContain('src="/AP.png"');
    expect(html).toContain('data-layer="file"');
    expect(html).toContain('data-layer="chapter-placeholder"');
    expect(html).toContain('data-layer="intro"');
    expect(html).toContain('data-active="false"');
    expect(html).toMatch(/<canvas[^>]*><\/canvas>/);
  });

  it('不再渲染旧的传统纵向首页入口', () => {
    const html = renderToStaticMarkup(<Page />);

    expect(html).not.toContain('id="features"');
    expect(html).not.toContain('id="download"');
  });
});
