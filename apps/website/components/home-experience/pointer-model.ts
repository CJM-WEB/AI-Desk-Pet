import type { PointerPoint } from './types';

interface ViewportSize {
  width: number;
  height: number;
}

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * 优先将预览放在指针右下方，空间不足时翻转至左上方并保持在视口内。
 */
export function computePreviewPosition(input: {
  pointer: PointerPoint;
  preview: ViewportSize;
  viewport: ViewportSize;
  gap: number;
}): PointerPoint {
  const viewportWidth = Math.max(0, finite(input.viewport.width));
  const viewportHeight = Math.max(0, finite(input.viewport.height));
  const previewWidth = Math.max(0, finite(input.preview.width));
  const previewHeight = Math.max(0, finite(input.preview.height));
  const gap = Math.max(0, finite(input.gap));
  const pointerX = finite(input.pointer.x);
  const pointerY = finite(input.pointer.y);
  const maximumX = Math.max(0, viewportWidth - previewWidth);
  const maximumY = Math.max(0, viewportHeight - previewHeight);
  const preferredX = pointerX + gap;
  const preferredY = pointerY + gap;

  return {
    x: clamp(
      preferredX + previewWidth > viewportWidth ? pointerX - previewWidth - gap : preferredX,
      0,
      maximumX
    ),
    y: clamp(
      preferredY + previewHeight > viewportHeight ? pointerY - previewHeight - gap : preferredY,
      0,
      maximumY
    )
  };
}

/**
 * 按生命周期线性计算轨迹透明度，异常时间输入不会泄漏到渲染层。
 */
export function trailAlpha(ageMs: number, lifetimeMs: number): number {
  const lifetime = finite(lifetimeMs);
  if (lifetime <= 0) {
    return 0;
  }

  const age = Math.max(0, finite(ageMs));
  return clamp(1 - (age / lifetime), 0, 1);
}
