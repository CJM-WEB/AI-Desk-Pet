import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { describe, expect, it } from 'vitest';
import Page from '../app/page';

describe('AI Pet 官网首页', () => {
  it('静态 HTML 注册六章节和对应内容状态', () => {
    const html = renderToStaticMarkup(<Page />);

    expect(html).toContain('data-testid="website-experience"');
    expect(html.match(/data-chapter-id=/g) ?? []).toHaveLength(6);
    expect(html).toContain('data-chapter-id="home"');
    expect(html).toContain('data-chapter-id="about"');
    expect(html).toContain('data-chapter-id="download"');
    expect(html).toContain('data-chapter-id="community"');
    expect(html).toContain('data-chapter-id="feedback"');
    expect(html).toContain('id="feedback"');
    expect(html).toContain('data-chapter-id="donation"');
    expect(html).toContain('data-testid="download-chapter"');
    expect(html).toContain('data-testid="donation-chapter"');
    expect(html).toContain('data-testid="about-chapter"');
    expect(html).toContain('data-testid="feedback-chapter"');
    expect(html).toContain('data-testid="shared-pet-chapter"');
    expect(html).toContain('AI Pet 介绍');
    expect(html).toContain('用户反馈与建议箱');
    expect(html).toContain('共享仓库');
    expect(html.match(/内容准备中/g) ?? []).toHaveLength(0);
  });

  it('在静态 HTML 中只保留新版首页和基础语义', () => {
    const html = renderToStaticMarkup(<Page />);

    expect(html).toContain('data-testid="home-experience"');
    expect(html).toContain('data-static-fallback="ready"');
    expect(html).toContain('data-testid="liquid-glass-home"');
    expect(html).toContain('aria-label="AI PET 互动液态玻璃画布"');
    expect(html).not.toContain('data-testid="brand-stage"');
    expect(html).not.toContain('data-layer="intro"');
    expect(html).not.toContain('data-layer="file"');
    expect(html).toContain('data-active="true"');
    expect(html).toMatch(/<canvas[^>]*><\/canvas>/);
  });

  it('静态 HTML 保留章节导航和真实下载回退', () => {
    const html = renderToStaticMarkup(<Page />);

    expect(html).toContain('data-static-fallback="ready"');
    expect(html).toContain('data-reduced-motion="false"');
    expect(html).toContain('data-active-chapter="home"');
    expect(html).toContain('aria-label="上一章节"');
    expect(html).toContain('aria-label="下一章节"');
    expect(html).toContain('AI-Pet-0.1.0-alpha.1-windows-x64.exe');
    expect(html).toContain('aria-label="选择 macOS"');
    expect(html).toContain('尚未发布');
  });

  it('首页静态回退保留独立的语言入口', () => {
    const html = renderToStaticMarkup(<Page />);

    expect(html).toContain('data-layer="fixed-controls"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('language');
  });

  it('不再渲染旧的传统纵向首页入口', () => {
    const html = renderToStaticMarkup(<Page />);

    expect(html).not.toMatch(/(?:^|\s)id="features"/);
  });
});
