import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { describe, expect, it } from 'vitest';
import Page from '../app/page';

describe('AI Pet 官网首页', () => {
  it('静态 HTML 注册五章节和两个明确占位状态', () => {
    const html = renderToStaticMarkup(<Page />);

    expect(html).toContain('data-testid="website-experience"');
    expect(html.match(/data-chapter-id=/g) ?? []).toHaveLength(5);
    expect(html).toContain('data-chapter-id="home"');
    expect(html).toContain('data-chapter-id="about"');
    expect(html).toContain('data-chapter-id="download"');
    expect(html).toContain('data-chapter-id="feedback"');
    expect(html).toContain('data-chapter-id="donation"');
    expect(html).toContain('data-testid="download-chapter"');
    expect(html).toContain('data-testid="donation-chapter"');
    expect(html).toContain('AI Pet 介绍');
    expect(html).toContain('用户反馈与建议箱');
    expect(html.match(/内容准备中/g) ?? []).toHaveLength(2);
  });

  it('在静态 HTML 中保留品牌和基础语义', () => {
    const html = renderToStaticMarkup(<Page />);

    expect(html).toContain('<h1');
    expect(html).toContain('AI Pet');
    expect(html).toContain('data-testid="home-experience"');
    expect(html).toContain('data-static-fallback="ready"');
    expect(html).toContain('src="/AP.png"');
    expect(html).toContain('data-testid="brand-logo"');
    expect(html.match(/data-testid="magnetic-logo-piece"/g) ?? []).toHaveLength(6);
    expect(html).toContain('data-final-image-failed="false"');
    expect(html).toContain('data-piece-id="top-left"');
    expect(html).toContain('data-piece-id="bottom-right"');
    expect(html).not.toContain('data-testid="ap-draw-mark"');
    expect(html).toContain('data-layer="file"');
    expect(html).toContain('data-layer="intro"');
    expect(html).toContain('data-active="false"');
    expect(html).toMatch(/<canvas[^>]*><\/canvas>/);
  });

  it('静态 HTML 保留章节导航和真实下载回退', () => {
    const html = renderToStaticMarkup(<Page />);

    expect(html).toContain('data-static-fallback="ready"');
    expect(html).toContain('data-reduced-motion="false"');
    expect(html).toContain('data-active-chapter="home"');
    expect(html).toContain('aria-label="上一章节"');
    expect(html).toContain('aria-label="下一章节"');
    expect(html).toContain('Myself-0.1.0-alpha.1-windows-x64.exe');
    expect(html).toContain('即将支持');
  });

  it('不再渲染旧的传统纵向首页入口', () => {
    const html = renderToStaticMarkup(<Page />);

    expect(html).not.toMatch(/(?:^|\s)id="(?:features|download)"/);
  });
});
