// @vitest-environment jsdom

import { createElement, useLayoutEffect } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { gsap } from 'gsap';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LiquidGlassInteractionDetail } from '../components/home-experience/LiquidGlassHome';
import { LiquidGlassHome } from '../components/home-experience/LiquidGlassHome';
import { HomeExperience } from '../components/home-experience/HomeExperience';
import { LIQUID_GLASS_FRAGMENT_SHADER } from '../components/home-experience/liquid-glass-shaders';
import { MagneticAPMark } from '../components/home-experience/MagneticAPMark';

function createCanvasContext(fillText = vi.fn()) {
  return new Proxy({}, {
    get: (_target, property) => {
      if (property === 'measureText') return (text: string) => ({ width: text.length * 8 });
      if (property === 'createLinearGradient') return () => ({ addColorStop: vi.fn() });
      if (property === 'fillText') return fillText;
      return vi.fn();
    }
  }) as CanvasRenderingContext2D;
}

function mockQuickToAsImmediateWrite() {
  vi.spyOn(gsap, 'quickTo').mockImplementation((target, property) => {
    const setter = vi.fn((value: number) => {
      Reflect.set(target as object, property, value);
      return {} as gsap.core.Tween;
    });
    return Object.assign(setter, { tween: {} as gsap.core.Tween }) as ReturnType<typeof gsap.quickTo>;
  });
}

function mockToAsImmediateWrite() {
  vi.spyOn(gsap, 'to').mockImplementation((target, vars) => {
    if (target && typeof target === 'object') {
      for (const [key, value] of Object.entries(vars)) {
        if (typeof value === 'number') Reflect.set(target as object, key, value);
      }
    }
    return {} as gsap.core.Tween;
  });
}

function createWebGlContext({ failTextureAt }: { failTextureAt?: number } = {}) {
  const noop = vi.fn();
  const viewport = vi.fn();
  const uniform1f = vi.fn();
  const uniform2f = vi.fn();
  const uniform2fv = vi.fn();
  const uniform4fv = vi.fn();
  const createBuffer = vi.fn(() => ({ kind: 'buffer' } as unknown as WebGLBuffer));
  const createProgram = vi.fn(() => ({ kind: 'program' } as unknown as WebGLProgram));
  const createShader = vi.fn(() => ({ kind: 'shader' } as unknown as WebGLShader));
  let textureCreationCount = 0;
  const createTexture = vi.fn(() => {
    textureCreationCount += 1;
    return textureCreationCount === failTextureAt
      ? null
      : ({ kind: 'texture', index: textureCreationCount } as unknown as WebGLTexture);
  });
  const deleteBuffer = vi.fn();
  const deleteProgram = vi.fn();
  const deleteShader = vi.fn();
  const deleteTexture = vi.fn();
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
  const successfulMethods = new Set(['getProgramParameter', 'getShaderParameter']);
  const noopMethods = new Set([
    'activeTexture', 'attachShader', 'bindBuffer', 'bindTexture', 'bufferData',
    'compileShader', 'drawArrays', 'enableVertexAttribArray', 'linkProgram', 'pixelStorei', 'shaderSource',
    'texImage2D', 'texParameteri', 'uniform1i',
    'useProgram', 'vertexAttribPointer'
  ]);
  const methods = new Map<string, unknown>([
    ['createBuffer', createBuffer],
    ['createProgram', createProgram],
    ['createShader', createShader],
    ['createTexture', createTexture],
    ['deleteBuffer', deleteBuffer],
    ['deleteProgram', deleteProgram],
    ['deleteShader', deleteShader],
    ['deleteTexture', deleteTexture]
  ]);
  const context = new Proxy({}, {
    get: (_target, property) => {
      const name = String(property);
      if (methods.has(name)) return methods.get(name);
      if (name === 'getUniformLocation') return getUniformLocation;
      if (name === 'viewport') return viewport;
      if (name === 'uniform1f') return uniform1f;
      if (name === 'uniform2f') return uniform2f;
      if (name === 'uniform2fv') return uniform2fv;
      if (name === 'uniform4fv') return uniform4fv;
      if (constants.has(name)) return 1;
      if (successfulMethods.has(name)) return () => true;
      if (name === 'getAttribLocation') return () => 0;
      if (name === 'getProgramInfoLog' || name === 'getShaderInfoLog') return () => '';
      if (noopMethods.has(name)) return noop;
      throw new Error(`测试 WebGL 替身未定义接口：${name}`);
    }
  }) as WebGLRenderingContext;
  return {
    context,
    createBuffer,
    createProgram,
    createShader,
    createTexture,
    deleteBuffer,
    deleteProgram,
    deleteShader,
    deleteTexture,
    viewport,
    uniform1f,
    uniform2f,
    uniform2fv,
    uniform4fv
  };
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

function DispatchLogoErrorDuringLayoutCleanup() {
  useLayoutEffect(() => () => {
    FailedLogoImage.latest?.dispatchEvent(new Event('error'));
  }, []);

  return null;
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

  it('AP Logo 素材加载失败后只上报一次并立即幂等释放完整 WebGL 生命周期', async () => {
    const webGl = createWebGlContext();
    vi.stubGlobal('Image', FailedLogoImage);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation((type) => type === 'webgl' ? webGl.context : createCanvasContext());
    const tickerAdd = vi.spyOn(gsap.ticker, 'add').mockImplementation(callback => callback);
    const tickerRemove = vi.spyOn(gsap.ticker, 'remove').mockImplementation(() => {});
    const onInitializationError = vi.fn();

    const { unmount } = render(
      <LiquidGlassHome
        active
        isPaused={false}
        reducedMotion={false}
        onInitializationError={onInitializationError}
      />
    );

    const home = screen.getByTestId('liquid-glass-home');
    const canvas = screen.getByLabelText('AI PET 互动液态玻璃画布');
    const removeWindowListener = vi.spyOn(window, 'removeEventListener');
    const removeDocumentListener = vi.spyOn(document, 'removeEventListener');
    const removeCanvasListener = vi.spyOn(canvas, 'removeEventListener');
    const removeLogoListener = vi.spyOn(FailedLogoImage.latest!, 'removeEventListener');
    expect(home.dataset.initializationFailed).toBe('false');
    expect(FailedLogoImage.latest?.src).toBe('/AP.png');
    act(() => {
      FailedLogoImage.latest?.dispatchEvent(new Event('error'));
      FailedLogoImage.latest?.dispatchEvent(new Event('error'));
    });

    await waitFor(() => {
      expect(home.dataset.initializationFailed).toBe('true');
    });
    expect(onInitializationError).toHaveBeenCalledOnce();
    expect(tickerAdd).toHaveBeenCalledOnce();
    expect(tickerRemove).toHaveBeenCalledOnce();
    expect(webGl.deleteTexture).toHaveBeenCalledTimes(7);
    expect(webGl.deleteBuffer).toHaveBeenCalledOnce();
    expect(webGl.deleteShader).toHaveBeenCalledTimes(2);
    expect(webGl.deleteProgram).toHaveBeenCalledOnce();
    for (const eventType of ['resize', 'pointermove', 'ai-pet-liquid-ripple']) {
      expect(removeWindowListener).toHaveBeenCalledWith(eventType, expect.any(Function));
    }
    for (const eventType of [
      'ai-pet-community-card-count',
      'ai-pet-liquid-interaction',
      'ai-pet-support-selection'
    ]) {
      expect(removeWindowListener).not.toHaveBeenCalledWith(eventType, expect.any(Function));
    }
    expect(removeCanvasListener).toHaveBeenCalledWith('pointerdown', expect.any(Function));
    expect(removeDocumentListener).toHaveBeenCalledWith(
      'visibilitychange',
      expect.any(Function)
    );
    expect(removeLogoListener).toHaveBeenCalledWith('load', expect.any(Function));
    expect(removeLogoListener).toHaveBeenCalledWith('error', expect.any(Function));
    const brandTitle = screen.getByText('AI PET');
    expect(brandTitle.parentElement?.getAttribute('aria-hidden')).toBe('false');

    unmount();
    expect(tickerRemove).toHaveBeenCalledOnce();
    expect(webGl.deleteTexture).toHaveBeenCalledTimes(7);
    expect(webGl.deleteBuffer).toHaveBeenCalledOnce();
    expect(webGl.deleteShader).toHaveBeenCalledTimes(2);
    expect(webGl.deleteProgram).toHaveBeenCalledOnce();
    for (const eventType of [
      'ai-pet-community-card-count',
      'ai-pet-liquid-interaction',
      'ai-pet-support-selection'
    ]) {
      expect(removeWindowListener).toHaveBeenCalledWith(eventType, expect.any(Function));
    }
  });

  it('正常卸载精确释放一套 WebGL 资源且不上报失败', () => {
    const webGl = createWebGlContext();
    vi.stubGlobal('Image', FailedLogoImage);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation((type) => type === 'webgl' ? webGl.context : createCanvasContext());
    vi.spyOn(gsap.ticker, 'add').mockImplementation(callback => callback);
    const tickerRemove = vi.spyOn(gsap.ticker, 'remove').mockImplementation(() => {});
    const onInitializationError = vi.fn();

    const { unmount } = render(
      <LiquidGlassHome
        active
        isPaused={false}
        reducedMotion={false}
        onInitializationError={onInitializationError}
      />
    );

    unmount();

    expect(onInitializationError).not.toHaveBeenCalled();
    expect(tickerRemove).toHaveBeenCalledOnce();
    expect(webGl.deleteTexture).toHaveBeenCalledTimes(7);
    expect(webGl.deleteBuffer).toHaveBeenCalledOnce();
    expect(webGl.deleteShader).toHaveBeenCalledTimes(2);
    expect(webGl.deleteProgram).toHaveBeenCalledOnce();
  });

  it('卸载进入 passive cleanup 前的迟到 Logo error 不再更新状态或上报', () => {
    const webGl = createWebGlContext();
    vi.stubGlobal('Image', FailedLogoImage);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation((type) => type === 'webgl' ? webGl.context : createCanvasContext());
    vi.spyOn(gsap.ticker, 'add').mockImplementation(callback => callback);
    const tickerRemove = vi.spyOn(gsap.ticker, 'remove').mockImplementation(() => {});
    const onInitializationError = vi.fn();

    const { unmount } = render(
      <>
        <LiquidGlassHome
          active
          isPaused={false}
          reducedMotion={false}
          onInitializationError={onInitializationError}
        />
        <DispatchLogoErrorDuringLayoutCleanup />
      </>
    );

    expect(FailedLogoImage.latest?.src).toBe('/AP.png');
    unmount();

    expect(onInitializationError).not.toHaveBeenCalled();
    expect(tickerRemove).toHaveBeenCalledOnce();
    expect(webGl.deleteProgram).toHaveBeenCalledOnce();
  });

  it('同步纹理初始化异常上报一次并释放已创建资源', async () => {
    const webGl = createWebGlContext({ failTextureAt: 4 });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation((type) => type === 'webgl' ? webGl.context : createCanvasContext());
    const onInitializationError = vi.fn();

    render(
      <LiquidGlassHome
        active
        isPaused={false}
        reducedMotion={false}
        onInitializationError={onInitializationError}
      />
    );

    await waitFor(() => expect(onInitializationError).toHaveBeenCalledOnce());
    expect(webGl.deleteTexture).toHaveBeenCalledTimes(3);
    expect(webGl.deleteBuffer).toHaveBeenCalledOnce();
    expect(webGl.deleteShader).toHaveBeenCalledTimes(2);
    expect(webGl.deleteProgram).toHaveBeenCalledOnce();
  });

  it('初始暂停时不获取 WebGL 上下文也不创建 ticker', () => {
    const webGl = createWebGlContext();
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation((type) => type === 'webgl' ? webGl.context : createCanvasContext());
    const tickerAdd = vi.spyOn(gsap.ticker, 'add');

    render(<LiquidGlassHome active isPaused reducedMotion={false} />);

    expect(getContext.mock.calls.some(([type]) => type === 'webgl')).toBe(false);
    expect(webGl.createTexture).not.toHaveBeenCalled();
    expect(tickerAdd).not.toHaveBeenCalled();
  });

  it('运行中暂停释放当前资源，恢复后只重建一套', () => {
    const webGl = createWebGlContext();
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation((type) => type === 'webgl' ? webGl.context : createCanvasContext());
    const tickerAdd = vi.spyOn(gsap.ticker, 'add').mockImplementation(callback => callback);
    const tickerRemove = vi.spyOn(gsap.ticker, 'remove').mockImplementation(() => {});

    const { rerender, unmount } = render(
      <LiquidGlassHome active isPaused={false} reducedMotion={false} />
    );
    expect(getContext.mock.calls.filter(([type]) => type === 'webgl')).toHaveLength(1);

    rerender(<LiquidGlassHome active isPaused reducedMotion={false} />);
    expect(tickerRemove).toHaveBeenCalledOnce();
    expect(webGl.deleteProgram).toHaveBeenCalledOnce();

    rerender(<LiquidGlassHome active isPaused={false} reducedMotion={false} />);
    expect(getContext.mock.calls.filter(([type]) => type === 'webgl')).toHaveLength(2);
    expect(tickerAdd).toHaveBeenCalledTimes(2);
    expect(webGl.createProgram).toHaveBeenCalledTimes(2);

    unmount();
    expect(tickerRemove).toHaveBeenCalledTimes(2);
    expect(webGl.deleteTexture).toHaveBeenCalledTimes(14);
    expect(webGl.deleteBuffer).toHaveBeenCalledTimes(2);
    expect(webGl.deleteShader).toHaveBeenCalledTimes(4);
    expect(webGl.deleteProgram).toHaveBeenCalledTimes(2);
  });

  it('按性能比例建立缓冲区并把指针与点击写入 WebGL uniform', () => {
    vi.stubGlobal('innerWidth', 1440); vi.stubGlobal('innerHeight', 900);
    vi.stubGlobal('devicePixelRatio', 2);
    const webGl = createWebGlContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation((type) => type === 'webgl' ? webGl.context : createCanvasContext());
    mockQuickToAsImmediateWrite();
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

  it('把 DOM 顶部起算的社区卡片行映射为 WebGL 底部起算坐标', () => {
    const webGl = createWebGlContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation((type) => type === 'webgl' ? webGl.context : createCanvasContext());
    let renderFrame: Parameters<typeof gsap.ticker.add>[0] | undefined;
    vi.spyOn(gsap.ticker, 'add').mockImplementation((callback) => {
      renderFrame = callback;
      return callback;
    });

    render(<LiquidGlassHome active isPaused={false} reducedMotion={false} />);
    renderFrame?.(1, 16, 1, 0.016);

    const communityRowsCall = webGl.uniform2f.mock.calls.find(([location]) => (
      (location as unknown as { name: string }).name === 'u_communityCardRows'
    ));
    expect(communityRowsCall?.slice(1)).toEqual([
      expect.closeTo(0.81, 8),
      expect.closeTo(0.19, 8)
    ]);
    expect(LIQUID_GLASS_FRAGMENT_SHADER).toMatch(
      /mix\(u_communityCardRows\.x, u_communityCardRows\.y, row\)/
    );
  });

  it('把四类章节视觉事件同步到同一帧的 WebGL uniform', () => {
    const webGl = createWebGlContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation((type) => type === 'webgl' ? webGl.context : createCanvasContext());
    mockQuickToAsImmediateWrite();
    mockToAsImmediateWrite();
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

  it('effect 重建后恢复最新章节快照但不回放 ripple', () => {
    const fillText = vi.fn();
    const webGl = createWebGlContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation((type) => (
        type === 'webgl' ? webGl.context : createCanvasContext(fillText)
      ));
    mockQuickToAsImmediateWrite();
    mockToAsImmediateWrite();
    const renderFrames: Parameters<typeof gsap.ticker.add>[0][] = [];
    vi.spyOn(gsap.ticker, 'add').mockImplementation((callback) => {
      renderFrames.push(callback);
      return callback;
    });
    vi.spyOn(gsap.ticker, 'remove').mockImplementation(() => {});

    const { rerender } = render(
      <LiquidGlassHome active isPaused={false} reducedMotion={false} />
    );
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
    renderFrames[0]?.(1, 16, 1, 0.016);

    rerender(<LiquidGlassHome active isPaused reducedMotion={false} />);
    window.dispatchEvent(new CustomEvent<LiquidGlassInteractionDetail>(
      'ai-pet-liquid-interaction',
      { detail: { hovered: 1, dragging: false, offsets: [8, 10, 0, 0, 0, 0] } }
    ));
    window.dispatchEvent(new CustomEvent('ai-pet-community-card-count', {
      detail: { count: 5, currentPage: 4, totalPages: 6 }
    }));
    window.dispatchEvent(new CustomEvent('ai-pet-support-selection', {
      detail: { feedbackIndex: 2, paymentIndex: 1 }
    }));
    window.dispatchEvent(new CustomEvent('ai-pet-liquid-ripple', {
      detail: { clientX: 640, clientY: 360, strength: 2 }
    }));
    webGl.uniform1f.mockClear();
    webGl.uniform2fv.mockClear();
    webGl.uniform4fv.mockClear();
    fillText.mockClear();
    rerender(<LiquidGlassHome active isPaused={false} reducedMotion={false} />);

    expect(renderFrames).toHaveLength(2);
    renderFrames[1]?.(2, 16, 2, 0.016);
    const uniform1fValue = (name: string) => webGl.uniform1f.mock.calls.find(
      ([location]) => (location as unknown as { name: string }).name === name
    )?.[1];
    expect(uniform1fValue('u_hoveredBlob')).toBe(1);
    expect(uniform1fValue('u_hoverAmount')).toBe(1);
    expect(uniform1fValue('u_dragging')).toBe(0);
    expect(uniform1fValue('u_communityCardCount')).toBe(5);
    expect(uniform1fValue('u_supportFeedbackActive')).toBe(2);
    expect(uniform1fValue('u_supportPaymentActive')).toBe(1);
    const offsetsCall = webGl.uniform2fv.mock.calls.find(([location]) => (
      (location as unknown as { name: string }).name === 'u_blobOffsets[0]'
    ));
    expect(Array.from(offsetsCall?.[1] as Float32Array)).toEqual([8, 10, 0, 0, 0, 0]);
    expect(fillText).toHaveBeenCalledWith('4', expect.any(Number), expect.any(Number));
    expect(fillText).toHaveBeenCalledWith('6', expect.any(Number), expect.any(Number));
    const rippleCall = webGl.uniform4fv.mock.calls.find(([location]) => (
      (location as unknown as { name: string }).name === 'u_ripples[0]'
    ));
    const rebuiltRippleValues = Array.from(rippleCall?.[1] as Float32Array);
    expect(rebuiltRippleValues.filter((_value, index) => index % 4 === 3))
      .toEqual([0, 0, 0, 0, 0, 0]);
  });
});
