// @vitest-environment jsdom

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { gsap } from 'gsap';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LiquidGlassInteractionDetail } from '../components/home-experience/LiquidGlassHome';
import { LiquidGlassHome } from '../components/home-experience/LiquidGlassHome';
import { HomeExperience } from '../components/home-experience/HomeExperience';
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
  const viewport = vi.fn();
  const uniform1f = vi.fn();
  const uniform2f = vi.fn();
  const uniform2fv = vi.fn();
  const uniform4fv = vi.fn();
  const getUniformLocation = vi.fn((_program: WebGLProgram, name: string) => (
    { name } as unknown as WebGLUniformLocation
  ));
  const constants = new Set([
    'ARRAY_BUFFER', 'CLAMP_TO_EDGE', 'COMPILE_STATUS', 'FLOAT', 'FRAGMENT_SHADER',
    'LINEAR', 'LINK_STATUS', 'RGBA', 'STATIC_DRAW', 'TEXTURE_2D',
    'TEXTURE_MAG_FILTER', 'TEXTURE_MIN_FILTER', 'TEXTURE_WRAP_S', 'TEXTURE_WRAP_T',
    'TEXTURE0', 'TEXTURE1', 'TEXTURE2', 'TEXTURE3', 'TEXTURE4', 'TEXTURE5',
    'TEXTURE6', 'TRIANGLES', 'UNPACK_FLIP_Y_WEBGL', 'UNSIGNED_BYTE', 'VERTEX_SHADER'
  ]);
  const objectMethods = new Set([
    'createBuffer', 'createProgram', 'createShader', 'createTexture'
  ]);
  const successfulMethods = new Set(['getProgramParameter', 'getShaderParameter']);
  const noopMethods = new Set([
    'activeTexture', 'attachShader', 'bindBuffer', 'bindTexture', 'bufferData',
    'compileShader', 'deleteBuffer', 'deleteProgram', 'deleteShader', 'deleteTexture',
    'drawArrays', 'enableVertexAttribArray', 'linkProgram', 'pixelStorei', 'shaderSource',
    'texImage2D', 'texParameteri', 'uniform1i',
    'useProgram', 'vertexAttribPointer'
  ]);
  const context = new Proxy({}, {
    get: (_target, property) => {
      const name = String(property);
      if (name === 'getUniformLocation') return getUniformLocation;
      if (name === 'viewport') return viewport;
      if (name === 'uniform1f') return uniform1f;
      if (name === 'uniform2f') return uniform2f;
      if (name === 'uniform2fv') return uniform2fv;
      if (name === 'uniform4fv') return uniform4fv;
      if (constants.has(name)) return 1;
      if (objectMethods.has(name)) return () => ({});
      if (successfulMethods.has(name)) return () => true;
      if (name === 'getAttribLocation') return () => 0;
      if (name === 'getProgramInfoLog' || name === 'getShaderInfoLog') return () => '';
      if (noopMethods.has(name)) return noop;
      throw new Error(`测试 WebGL 替身未定义接口：${name}`);
    }
  }) as WebGLRenderingContext;
  return { context, viewport, uniform1f, uniform2f, uniform2fv, uniform4fv };
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
  it.each([0, 1, 2, 3, 4])('进度 %s 时保留五章节液态玻璃', (exitProgress) => {
    render(<HomeExperience exitProgress={exitProgress} isPaused={false} reducedMotion={false} />);

    expect(screen.getByTestId('home-experience').dataset.liquidHomeActive).toBe('true');
  });

  it('离开支持章节后释放液态玻璃', () => {
    render(<HomeExperience exitProgress={4.08} isPaused={false} reducedMotion={false} />);

    expect(screen.getByTestId('home-experience').dataset.liquidHomeActive).toBe('false');
  });
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
      .mockImplementation((type) => type === 'webgl' ? webGl.context : createCanvasContext());

    render(<LiquidGlassHome active isPaused={false} reducedMotion={false} />);

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

  it('按性能比例建立缓冲区并把指针与点击写入 WebGL uniform', () => {
    vi.stubGlobal('innerWidth', 1440); vi.stubGlobal('innerHeight', 900);
    vi.stubGlobal('devicePixelRatio', 2);
    const webGl = createWebGlContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation((type) => type === 'webgl' ? webGl.context : createCanvasContext());
    vi.spyOn(gsap, 'quickTo').mockImplementation((target, property) => {
      const setter = vi.fn((value: number) => {
        Reflect.set(target as object, property, value);
        return {} as gsap.core.Tween;
      });
      return Object.assign(setter, { tween: {} as gsap.core.Tween }) as ReturnType<typeof gsap.quickTo>;
    });
    let renderFrame: Parameters<typeof gsap.ticker.add>[0] | undefined;
    vi.spyOn(gsap.ticker, 'add').mockImplementation((callback) => {
      renderFrame = callback;
      return callback;
    });

    render(<LiquidGlassHome active isPaused={false} reducedMotion={false} />);
    const canvas = screen.getByLabelText('AI PET 互动液态玻璃画布');
    expect(canvas).toHaveProperty('width', 1296);
    expect(canvas).toHaveProperty('height', 810);
    expect(webGl.viewport).toHaveBeenCalledWith(0, 0, 1296, 810);

    fireEvent.pointerMove(window, { clientX: 360, clientY: 225 });
    fireEvent.pointerDown(canvas, { clientX: 360, clientY: 225 });
    expect(renderFrame).toBeDefined();
    renderFrame?.(1, 16, 1, 0.016);
    const pointerCall = webGl.uniform2f.mock.calls.find(([location]) => (
      (location as unknown as { name: string }).name === 'u_pointer'
    ));
    expect(pointerCall?.slice(1)).toEqual([0.25, 0.75]);
    const rippleCall = webGl.uniform4fv.mock.calls.find(([location]) => (
      (location as unknown as { name: string }).name === 'u_ripples[0]'
    ));
    const rippleValues = Array.from(rippleCall?.[1] as Float32Array);
    expect(rippleValues.slice(0, 3)).toEqual([0.25, 0.75, 0]);
    expect(rippleValues[3]).toBeCloseTo(1.65, 5);
  });

  it('把四类章节视觉事件同步到同一帧的 WebGL uniform', () => {
    const webGl = createWebGlContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation((type) => type === 'webgl' ? webGl.context : createCanvasContext());
    vi.spyOn(gsap, 'quickTo').mockImplementation((target, property) => {
      const setter = vi.fn((value: number) => {
        Reflect.set(target as object, property, value);
        return {} as gsap.core.Tween;
      });
      return Object.assign(setter, { tween: {} as gsap.core.Tween }) as ReturnType<typeof gsap.quickTo>;
    });
    vi.spyOn(gsap, 'to').mockImplementation((target, vars) => {
      if (target && typeof target === 'object') {
        for (const [key, value] of Object.entries(vars)) {
          if (typeof value === 'number') Reflect.set(target as object, key, value);
        }
      }
      return {} as gsap.core.Tween;
    });
    let renderFrame: Parameters<typeof gsap.ticker.add>[0] | undefined;
    vi.spyOn(gsap.ticker, 'add').mockImplementation((callback) => {
      renderFrame = callback;
      return callback;
    });

    render(<LiquidGlassHome active isPaused={false} reducedMotion={false} />);

    window.dispatchEvent(new CustomEvent('ai-pet-liquid-ripple', {
      detail: { clientX: 256, clientY: 192, strength: 1.8 }
    }));
    window.dispatchEvent(new CustomEvent<LiquidGlassInteractionDetail>(
      'ai-pet-liquid-interaction',
      { detail: { hovered: 2, dragging: true, offsets: [4, 6, 0, 0, 0, 0] } }
    ));
    window.dispatchEvent(new CustomEvent('ai-pet-community-card-count', {
      detail: { count: 7, currentPage: 2, totalPages: 3 }
    }));
    window.dispatchEvent(new CustomEvent('ai-pet-support-selection', {
      detail: { feedbackIndex: 1, paymentIndex: 2 }
    }));
    expect(renderFrame).toBeDefined();
    renderFrame?.(1, 16, 1, 0.016);

    const uniform1fValue = (name: string) => webGl.uniform1f.mock.calls.find(
      ([location]) => (location as unknown as { name: string }).name === name
    )?.[1];
    const rippleCall = webGl.uniform4fv.mock.calls.find(([location]) => (
      (location as unknown as { name: string }).name === 'u_ripples[0]'
    ));
    expect(Array.from(rippleCall?.[1] as Float32Array).slice(0, 4)).toEqual([
      0.25,
      0.75,
      0,
      expect.closeTo(1.8, 5)
    ]);
    expect(uniform1fValue('u_hoveredBlob')).toBe(2);
    const offsetsCall = webGl.uniform2fv.mock.calls.find(([location]) => (
      (location as unknown as { name: string }).name === 'u_blobOffsets[0]'
    ));
    expect(Array.from(offsetsCall?.[1] as Float32Array)).toEqual([4, 6, 0, 0, 0, 0]);
    expect(uniform1fValue('u_communityCardCount')).toBe(7);
    expect(uniform1fValue('u_supportFeedbackActive')).toBe(1);
    expect(uniform1fValue('u_supportPaymentActive')).toBe(-1);
  });
});
