'use client';

import { useCallback, useEffect, useRef } from 'react';
import type { RgbColor } from './visual-types';
import { trailAlpha } from './pointer-model';
import type { PointerPoint } from './types';
import styles from './home-experience.module.css';

interface CursorFieldProps {
  active: boolean;
  pointer: PointerPoint;
  isPaused: boolean;
  reducedMotion: boolean;
  color: RgbColor;
  onInitializationError?: () => void;
}

interface TrailSample extends PointerPoint {
  sampledAt: number;
}

const MAX_PIXEL_RATIO = 1.75;
const MAX_TRAIL_SAMPLES = 18;
const SAMPLE_DISTANCE_PX = 8;
const SAMPLE_INTERVAL_MS = 40;
const TRAIL_LIFETIME_MS = 1200;
const FIELD_RADIUS_PX = 220;

export function computeCanvasBufferSize(input: {
  width: number;
  height: number;
  devicePixelRatio: number;
}): { width: number; height: number; pixelRatio: number } {
  const width = Number.isFinite(input.width) ? Math.max(0, input.width) : 0;
  const height = Number.isFinite(input.height) ? Math.max(0, input.height) : 0;
  const pixelRatio = Number.isFinite(input.devicePixelRatio) && input.devicePixelRatio > 0
    ? Math.min(input.devicePixelRatio, MAX_PIXEL_RATIO)
    : 1;

  return {
    width: Math.round(width * pixelRatio),
    height: Math.round(height * pixelRatio),
    pixelRatio
  };
}

function drawField(
  context: CanvasRenderingContext2D,
  point: PointerPoint,
  opacity: number,
  color: RgbColor
): void {
  const gradient = context.createRadialGradient(
    point.x,
    point.y,
    0,
    point.x,
    point.y,
    FIELD_RADIUS_PX
  );

  gradient.addColorStop(0, toRgba(color, 0.72 * opacity));
  gradient.addColorStop(0.55, toRgba(color, 0.34 * opacity));
  gradient.addColorStop(1, toRgba(color, 0));
  context.fillStyle = gradient;
  context.fillRect(
    point.x - FIELD_RADIUS_PX,
    point.y - FIELD_RADIUS_PX,
    FIELD_RADIUS_PX * 2,
    FIELD_RADIUS_PX * 2
  );
}

function toRgba(color: RgbColor, alpha: number): string {
  return `rgba(${color[0]},${color[1]},${color[2]},${alpha})`;
}

export function CursorField({
  active,
  pointer,
  isPaused,
  reducedMotion,
  color,
  onInitializationError
}: CursorFieldProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const pointerRef = useRef<PointerPoint>(pointer);
  const samplesRef = useRef<TrailSample[]>([]);
  const sizeRef = useRef({ width: 0, height: 0, pixelRatio: 1 });
  const activeRef = useRef(false);

  pointerRef.current = pointer;

  const cancelFrame = useCallback(() => {
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  }, []);

  const clearCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) {
      return;
    }

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.setTransform(sizeRef.current.pixelRatio, 0, 0, sizeRef.current.pixelRatio, 0, 0);
  }, []);

  const syncCanvasSize = useCallback((cssSize?: { width: number; height: number }) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const bounds = cssSize ?? canvas.getBoundingClientRect();
    const width = Math.max(0, bounds.width);
    const height = Math.max(0, bounds.height);
    const buffer = computeCanvasBufferSize({
      width,
      height,
      devicePixelRatio: window.devicePixelRatio || 1
    });
    const cached = sizeRef.current;
    if (
      cached.width === width
      && cached.height === height
      && cached.pixelRatio === buffer.pixelRatio
      && canvas.width === buffer.width
      && canvas.height === buffer.height
    ) {
      return;
    }

    sizeRef.current = { width, height, pixelRatio: buffer.pixelRatio };
    canvas.width = buffer.width;
    canvas.height = buffer.height;
    clearCanvas();
  }, [clearCanvas]);

  const drawFrame = useCallback((frameAt: number) => {
    if (!activeRef.current) {
      frameRef.current = null;
      return;
    }

    const canvas = canvasRef.current;
    if (canvas) {
      const cached = sizeRef.current;
      const currentPixelRatio = computeCanvasBufferSize({
        width: cached.width,
        height: cached.height,
        devicePixelRatio: window.devicePixelRatio || 1
      }).pixelRatio;
      if (currentPixelRatio !== cached.pixelRatio) {
        syncCanvasSize(cached);
      }
    }

    const context = canvas?.getContext('2d');
    if (!canvas || !context || sizeRef.current.width === 0 || sizeRef.current.height === 0) {
      frameRef.current = window.requestAnimationFrame(drawFrame);
      return;
    }

    samplesRef.current = samplesRef.current.filter(
      (sample) => frameAt - sample.sampledAt < TRAIL_LIFETIME_MS
    );
    clearCanvas();
    samplesRef.current.forEach((sample) => {
      drawField(
        context,
        sample,
        trailAlpha(frameAt - sample.sampledAt, TRAIL_LIFETIME_MS),
        color
      );
    });
    drawField(context, pointerRef.current, 1, color);
    frameRef.current = window.requestAnimationFrame(drawFrame);
  }, [clearCanvas, color, syncCanvasSize]);

  const isActive = active && !isPaused && !reducedMotion;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    let observer: ResizeObserver;
    try {
      if (!canvas.getContext('2d')) {
        throw new Error('Canvas 2D 上下文不可用');
      }
      observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (entry) {
          syncCanvasSize(entry.contentRect);
        }
      });
      syncCanvasSize();
      observer.observe(canvas);
    } catch {
      cancelFrame();
      onInitializationError?.();
      return;
    }

    return () => {
      observer.disconnect();
      cancelFrame();
    };
  }, [cancelFrame, onInitializationError, syncCanvasSize]);

  useEffect(() => {
    if (!isActive) {
      samplesRef.current = [];
      cancelFrame();
      clearCanvas();
      return;
    }

    const now = performance.now();
    const previous = samplesRef.current.at(-1);
    const distance = previous
      ? Math.hypot(pointer.x - previous.x, pointer.y - previous.y)
      : Infinity;
    if (!previous || distance > SAMPLE_DISTANCE_PX || now - previous.sampledAt > SAMPLE_INTERVAL_MS) {
      samplesRef.current = [
        ...samplesRef.current,
        { ...pointer, sampledAt: now }
      ].slice(-MAX_TRAIL_SAMPLES);
    }
  }, [cancelFrame, clearCanvas, isActive, pointer]);

  useEffect(() => {
    activeRef.current = isActive;
    if (!isActive) {
      return;
    }

    frameRef.current = window.requestAnimationFrame(drawFrame);
    return cancelFrame;
  }, [cancelFrame, drawFrame, isActive]);

  return <canvas ref={canvasRef} className={styles.cursorField} data-testid="cursor-field" aria-hidden="true" />;
}
