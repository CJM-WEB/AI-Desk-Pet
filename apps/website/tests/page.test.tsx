import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { describe, expect, it } from 'vitest';
import Page from '../app/page';

describe('官网首页', () => {
  it('展示产品承诺与主要下载入口', () => {
    const html = renderToStaticMarkup(<Page />);

    expect(html).toContain('住在桌面上的 AI 文件小助手');
    expect(html).toContain('下载 Windows 测试版');
  });
});
