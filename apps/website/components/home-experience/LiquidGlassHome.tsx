'use client';

import { gsap } from 'gsap';
import { useEffect, useRef, useState } from 'react';
import {
  LIQUID_GLASS_FRAGMENT_SHADER,
  LIQUID_GLASS_VERTEX_SHADER
} from './liquid-glass-shaders';
import styles from './liquid-glass-home.module.css';

export const LIQUID_GLASS_RIPPLE_EVENT = 'ai-pet-liquid-ripple';

interface LiquidGlassHomeProps {
  active: boolean;
  isPaused: boolean;
  reducedMotion: boolean;
}

interface RippleEventDetail {
  clientX: number;
  clientY: number;
  strength: number;
}

/**
 * 将液态玻璃原型封装为首页稳定态叶子组件，离开首页时完整释放 GPU 与动画资源。
 */
export function LiquidGlassHome({
  active,
  isPaused,
  reducedMotion
}: LiquidGlassHomeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pausedRef = useRef(isPaused);
  const [initializationFailed, setInitializationFailed] = useState(false);

  useEffect(() => {
    pausedRef.current = isPaused;
  }, [isPaused]);

  useEffect(() => {
    if (!active) return;

    const canvas = canvasRef.current;
    const gl = canvas?.getContext('webgl', {
      alpha: false,
      antialias: false,
      depth: false,
      desynchronized: true,
      powerPreference: 'high-performance'
    });
    if (!canvas || !gl) {
      setInitializationFailed(true);
      return;
    }

    let disposed = false;
    let renderedStaticFrame = false;
    let currentTime = 0;
    let initializedViewport = false;
    let inset = 48;
    let radius = 62;
    let rippleIndex = 0;
    const pointer = { x: 0.5, y: 0.5 };
    const rippleData = new Float32Array(6 * 4);
    const createdTextures: WebGLTexture[] = [];
    const createdBuffers: WebGLBuffer[] = [];
    const createdShaders: WebGLShader[] = [];
    let program: WebGLProgram | null = null;

    for (let index = 0; index < 6; index += 1) {
      rippleData[index * 4 + 2] = -100;
    }

    const compileShader = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error('无法创建 WebGL 着色器');
      createdShaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(`着色器编译失败：${gl.getShaderInfoLog(shader) ?? '未知错误'}`);
      }
      return shader;
    };

    const createTexture = () => {
      const texture = gl.createTexture();
      if (!texture) throw new Error('无法创建 WebGL 纹理');
      createdTextures.push(texture);
      return texture;
    };

    const pointerX = gsap.quickTo(pointer, 'x', {
      duration: 0.38,
      ease: 'power3.out'
    });
    const pointerY = gsap.quickTo(pointer, 'y', {
      duration: 0.38,
      ease: 'power3.out'
    });

    let render = (_time: number) => {};
    let resize = () => {};
    let updateLogoTexture = (_width: number, _height: number) => {};

    try {
      const vertexShader = compileShader(gl.VERTEX_SHADER, LIQUID_GLASS_VERTEX_SHADER);
      const fragmentShader = compileShader(gl.FRAGMENT_SHADER, LIQUID_GLASS_FRAGMENT_SHADER);
      program = gl.createProgram();
      if (!program) throw new Error('无法创建 WebGL 程序');
      gl.attachShader(program, vertexShader);
      gl.attachShader(program, fragmentShader);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(`着色器链接失败：${gl.getProgramInfoLog(program) ?? '未知错误'}`);
      }
      gl.useProgram(program);

      const positions = gl.createBuffer();
      if (!positions) throw new Error('无法创建 WebGL 顶点缓冲');
      createdBuffers.push(positions);
      gl.bindBuffer(gl.ARRAY_BUFFER, positions);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1, -1,
        1, -1,
        -1, 1,
        -1, 1,
        1, -1,
        1, 1
      ]), gl.STATIC_DRAW);

      const positionLocation = gl.getAttribLocation(program, 'a_position');
      gl.enableVertexAttribArray(positionLocation);
      gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

      const uniforms = {
        resolution: gl.getUniformLocation(program, 'u_resolution'),
        pointer: gl.getUniformLocation(program, 'u_pointer'),
        time: gl.getUniformLocation(program, 'u_time'),
        inset: gl.getUniformLocation(program, 'u_inset'),
        radius: gl.getUniformLocation(program, 'u_radius'),
        motion: gl.getUniformLocation(program, 'u_motion'),
        ripples: gl.getUniformLocation(program, 'u_ripples[0]'),
        logoTexture: gl.getUniformLocation(program, 'u_logoTexture'),
        textTexture: gl.getUniformLocation(program, 'u_textTexture')
      };

      const logoCanvas = document.createElement('canvas');
      const logoContext = logoCanvas.getContext('2d');
      const textCanvas = document.createElement('canvas');
      const textContext = textCanvas.getContext('2d');
      if (!logoContext || !textContext) {
        throw new Error('无法创建首页纹理画布');
      }

      const logoTexture = createTexture();
      const textTexture = createTexture();
      const logoImage = new Image();
      let logoReady = false;

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, logoTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        1,
        1,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        new Uint8Array([0, 0, 0, 0])
      );
      gl.uniform1i(uniforms.logoTexture, 1);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, textTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.uniform1i(uniforms.textTexture, 0);

      const updateTextTexture = (width: number, height: number) => {
        textCanvas.width = width;
        textCanvas.height = height;
        textContext.clearRect(0, 0, width, height);

        let fontSize = Math.min(width * 0.235, height * 0.40);
        const gradient = textContext.createLinearGradient(width * 0.18, 0, width * 0.82, 0);
        gradient.addColorStop(0, '#BDFCF5');
        gradient.addColorStop(0.28, '#CFF8D5');
        gradient.addColorStop(0.52, '#F6F7A7');
        gradient.addColorStop(0.74, '#FFE6BD');
        gradient.addColorStop(1, '#F7DCC8');

        textContext.font = `900 ${fontSize}px "Arial Black", "Segoe UI", sans-serif`;
        const measuredWidth = textContext.measureText('AI PET').width;
        if (measuredWidth > width * 0.80) {
          fontSize *= width * 0.80 / measuredWidth;
          textContext.font = `900 ${fontSize}px "Arial Black", "Segoe UI", sans-serif`;
        }
        textContext.textAlign = 'center';
        textContext.textBaseline = 'middle';
        textContext.fillStyle = 'rgba(4, 10, 11, 0.52)';
        textContext.shadowColor = 'rgba(2, 7, 8, 0.72)';
        textContext.shadowBlur = Math.max(16, fontSize * 0.10);
        textContext.shadowOffsetX = fontSize * 0.018;
        textContext.shadowOffsetY = fontSize * 0.055;
        textContext.fillText('AI PET', width * 0.5, height * 0.5);
        textContext.fillStyle = gradient;
        textContext.shadowColor = 'transparent';
        textContext.shadowBlur = 0;
        textContext.shadowOffsetX = 0;
        textContext.shadowOffsetY = 0;
        textContext.fillText('AI PET', width * 0.5, height * 0.5);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, textTexture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, textCanvas);
      };

      updateLogoTexture = (width: number, height: number) => {
        if (!logoReady) return;
        logoCanvas.width = width;
        logoCanvas.height = height;
        logoContext.clearRect(0, 0, width, height);

        const source = { x: 450, y: 35, width: 560, height: 670 };
        const maxWidth = width * (width < height ? 0.86 : 0.78);
        const maxHeight = height * 0.92;
        const scale = Math.min(maxWidth / source.width, maxHeight / source.height);
        const targetWidth = source.width * scale;
        const targetHeight = source.height * scale;
        logoContext.drawImage(
          logoImage,
          source.x,
          source.y,
          source.width,
          source.height,
          (width - targetWidth) * 0.5,
          (height - targetHeight) * 0.5,
          targetWidth,
          targetHeight
        );

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, logoTexture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, logoCanvas);
      };

      resize = () => {
        const resolutionScale = window.innerWidth >= 2400
          ? 0.65
          : window.innerWidth >= 1600
            ? 0.8
            : window.innerWidth >= 1200
              ? 0.9
              : 1;
        const pixelRatio = Math.min(window.devicePixelRatio || 1, resolutionScale);
        const width = Math.round(window.innerWidth * pixelRatio);
        const height = Math.round(window.innerHeight * pixelRatio);

        const sizeChanged = canvas.width !== width || canvas.height !== height;
        if (sizeChanged) {
          canvas.width = width;
          canvas.height = height;
        }

        // 同一 Canvas 的 WebGL 资源在章节离场时会释放；返回首页即使尺寸不变，
        // 也必须为新程序恢复视口并重新上传两张纹理，避免首帧只剩黑色背景。
        if (!initializedViewport || sizeChanged) {
          gl.viewport(0, 0, width, height);
          updateLogoTexture(width, height);
          updateTextTexture(width, height);
          renderedStaticFrame = false;
          initializedViewport = true;
        }

        inset = Math.min(
          64,
          Math.max(window.innerWidth < 640 ? 13 : 16, window.innerWidth * 0.04)
        ) * pixelRatio;
        radius = Math.min(82, Math.max(30, window.innerWidth * 0.048)) * pixelRatio;
      };

      const addRipple = (x: number, y: number, strength = 1) => {
        const offset = rippleIndex * 4;
        rippleData[offset] = x;
        rippleData[offset + 1] = y;
        rippleData[offset + 2] = currentTime;
        rippleData[offset + 3] = strength;
        rippleIndex = (rippleIndex + 1) % 6;
      };
      const isInsideGlass = (x: number, y: number) => {
        const insetCss = Math.min(
          64,
          Math.max(window.innerWidth < 640 ? 13 : 16, window.innerWidth * 0.04)
        );
        return x > insetCss
          && x < window.innerWidth - insetCss
          && y > insetCss
          && y < window.innerHeight - insetCss;
      };
      const updatePointer = (event: PointerEvent, forceRipple = false) => {
        if (reducedMotion || !isInsideGlass(event.clientX, event.clientY)) return;
        const x = event.clientX / window.innerWidth;
        const y = 1 - event.clientY / window.innerHeight;
        pointerX(x);
        pointerY(y);
        if (forceRipple) addRipple(x, y, 1.65);
      };
      const handleCanvasPointerDown = (event: PointerEvent) => updatePointer(event, true);
      const handleControlRipple = (event: Event) => {
        if (reducedMotion) return;
        const detail = (event as CustomEvent<RippleEventDetail>).detail;
        if (!detail) return;
        const x = detail.clientX / window.innerWidth;
        const y = 1 - detail.clientY / window.innerHeight;
        pointerX(x);
        pointerY(y);
        addRipple(x, y, detail.strength);
      };

      render = (time: number) => {
        if (disposed || pausedRef.current || (reducedMotion && renderedStaticFrame)) return;
        currentTime = reducedMotion ? 12 : time;
        gl.uniform2f(uniforms.resolution, canvas.width, canvas.height);
        gl.uniform2f(uniforms.pointer, pointer.x, pointer.y);
        gl.uniform1f(uniforms.time, currentTime);
        gl.uniform1f(uniforms.inset, inset);
        gl.uniform1f(uniforms.radius, radius);
        gl.uniform1f(uniforms.motion, reducedMotion ? 0 : 1);
        gl.uniform4fv(uniforms.ripples, rippleData);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        renderedStaticFrame = reducedMotion;
      };
      const handleVisibilityChange = () => {
        if (document.hidden) {
          gsap.ticker.remove(render);
        } else {
          gsap.ticker.add(render);
        }
      };
      const handleLogoLoad = () => {
        if (disposed) return;
        logoReady = true;
        updateLogoTexture(canvas.width, canvas.height);
        renderedStaticFrame = false;
        render(currentTime);
      };
      const handleLogoError = () => {
        if (disposed) return;
        setInitializationFailed(true);
      };

      logoImage.addEventListener('load', handleLogoLoad);
      logoImage.addEventListener('error', handleLogoError);
      logoImage.src = '/AP.png';
      resize();
      gsap.ticker.lagSmoothing(500, 33);
      gsap.ticker.add(render);
      window.addEventListener('resize', resize, { passive: true });
      window.addEventListener('pointermove', updatePointer, { passive: true });
      window.addEventListener(LIQUID_GLASS_RIPPLE_EVENT, handleControlRipple);
      canvas.addEventListener('pointerdown', handleCanvasPointerDown, { passive: true });
      document.addEventListener('visibilitychange', handleVisibilityChange);

      return () => {
        disposed = true;
        gsap.ticker.remove(render);
        gsap.killTweensOf(pointer);
        window.removeEventListener('resize', resize);
        window.removeEventListener('pointermove', updatePointer);
        window.removeEventListener(LIQUID_GLASS_RIPPLE_EVENT, handleControlRipple);
        canvas.removeEventListener('pointerdown', handleCanvasPointerDown);
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        logoImage.removeEventListener('load', handleLogoLoad);
        logoImage.removeEventListener('error', handleLogoError);
        createdTextures.forEach(texture => gl.deleteTexture(texture));
        createdBuffers.forEach(buffer => gl.deleteBuffer(buffer));
        createdShaders.forEach(shader => gl.deleteShader(shader));
        if (program) gl.deleteProgram(program);
      };
    } catch {
      disposed = true;
      gsap.killTweensOf(pointer);
      createdTextures.forEach(texture => gl.deleteTexture(texture));
      createdBuffers.forEach(buffer => gl.deleteBuffer(buffer));
      createdShaders.forEach(shader => gl.deleteShader(shader));
      if (program) gl.deleteProgram(program);
      setInitializationFailed(true);
    }
  }, [active, reducedMotion]);

  return (
    <div
      className={styles.surface}
      data-testid="liquid-glass-home"
      data-active={active}
      data-initialization-failed={initializationFailed}
      aria-hidden={!active}
    >
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        aria-label="AI PET 互动液态玻璃画布"
      />
      <div className={styles.fallback} aria-hidden={!initializationFailed}>
        <span>AI PET</span>
      </div>
    </div>
  );
}
