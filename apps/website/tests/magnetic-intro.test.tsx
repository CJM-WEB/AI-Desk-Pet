import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MagneticAPMark } from '../components/home-experience/MagneticAPMark';

describe('磁吸 Logo 舞台', () => {
  it('渲染六块来自真实 AP.png 的重叠裁切图片', () => {
    const html = renderToStaticMarkup(createElement(MagneticAPMark));

    expect(html).toContain('data-testid="magnetic-ap-mark"');
    expect(html.match(/data-testid="magnetic-logo-piece"/g) ?? []).toHaveLength(6);
    expect(html.match(/src="\/AP.png"/g) ?? []).toHaveLength(6);
    expect(html).toContain('clip-path:polygon(');
  });
});
