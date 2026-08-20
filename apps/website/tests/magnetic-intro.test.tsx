// @vitest-environment jsdom

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiquidGlassHome } from '../components/home-experience/LiquidGlassHome';
import { MagneticAPMark } from '../components/home-experience/MagneticAPMark';

function createCanvasContext() {
  return new Proxy({}, {
    get: (_target, property) => {
      if (property === 'measureText') return (text: string) => ({ width: text.length * 8 });
      if (property === 'createLinearGradient') return () => ({ addColorStop: vi.fn() });
      return vi.fn();
    }
  }) as CanvasRenderingContext2D;
}

function createWebGlContext() {
  const noop = vi.fn();
  const constants = new Set([
    'ARRAY_BUFFER', 'CLAMP_TO_EDGE', 'COMPILE_STATUS', 'FLOAT', 'FRAGMENT_SHADER',
    'LINEAR', 'LINK_STATUS', 'RGBA', 'STATIC_DRAW', 'TEXTURE_2D',
    'TEXTURE_MAG_FILTER', 'TEXTURE_MIN_FILTER', 'TEXTURE_WRAP_S', 'TEXTURE_WRAP_T',
    'TEXTURE0', 'TEXTURE1', 'TEXTURE2', 'TEXTURE3', 'TEXTURE4', 'TEXTURE5',
    'TEXTURE6', 'TRIANGLES', 'UNPACK_FLIP_Y_WEBGL', 'UNSIGNED_BYTE', 'VERTEX_SHADER'
  ]);
  const objectMethods = new Set([
    'createBuffer', 'createProgram', 'createShader', 'createTexture', 'getUniformLocation'
  ]);
  const successfulMethods = new Set(['getProgramParameter', 'getShaderParameter']);
  const noopMethods = new Set([
    'activeTexture', 'attachShader', 'bindBuffer', 'bindTexture', 'bufferData',
    'compileShader', 'deleteBuffer', 'deleteProgram', 'deleteShader', 'deleteTexture',
    'drawArrays', 'enableVertexAttribArray', 'linkProgram', 'pixelStorei', 'shaderSource',
    'texImage2D', 'texParameteri', 'uniform1f', 'uniform1i', 'uniform2f', 'uniform2fv',
    'uniform4fv', 'useProgram', 'vertexAttribPointer', 'viewport'
  ]);
  return new Proxy({}, {
    get: (_target, property) => {
      const name = String(property);
      if (constants.has(name)) return 1;
      if (objectMethods.has(name)) return () => ({});
      if (successfulMethods.has(name)) return () => true;
      if (name === 'getAttribLocation') return () => 0;
      if (name === 'getProgramInfoLog' || name === 'getShaderInfoLog') return () => '';
      if (noopMethods.has(name)) return noop;
      throw new Error(`测试 WebGL 替身未定义接口：${name}`);
    }
  }) as WebGLRenderingContext;
}

class FailedLogoImage extends EventTarget {
  static latest: FailedLogoImage | null = null;
  private source = '';

  constructor() {
    super();
    FailedLogoImage.latest = this;
  }

  get src() { return this.source; }
  set src(value: string) { this.source = value; }
}

afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  FailedLogoImage.latest = null;
});

describe('磁吸 Logo 舞台', () => {
  it('渲染六块来自真实 AP.png 的重叠裁切图片', () => {
    const html = renderToStaticMarkup(createElement(MagneticAPMark));

    expect(html).toContain('data-testid="magnetic-ap-mark"');
    expect(html.match(/data-testid="magnetic-logo-piece"/g) ?? []).toHaveLength(6);
    expect(html.match(/src="\/AP.png"/g) ?? []).toHaveLength(6);
    expect(html).toContain('clip-path:polygon(');
  });

  it('AP Logo 素材加载失败后进入静态回退并保留品牌标题', async () => {
    const webGl = createWebGlContext();
    vi.stubGlobal('Image', FailedLogoImage);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation((type) => type === 'webgl' ? webGl : createCanvasContext());

    render(<LiquidGlassHome active isPaused={false} reducedMotion />);

    const home = screen.getByTestId('liquid-glass-home');
    expect(home.dataset.initializationFailed).toBe('false');
    expect(FailedLogoImage.latest?.src).toBe('/AP.png');
    FailedLogoImage.latest?.dispatchEvent(new Event('error'));

    await waitFor(() => {
      expect(home.dataset.initializationFailed).toBe('true');
    });
    const brandTitle = screen.getByText('AI PET');
    expect(brandTitle.parentElement?.getAttribute('aria-hidden')).toBe('false');
  });
});
