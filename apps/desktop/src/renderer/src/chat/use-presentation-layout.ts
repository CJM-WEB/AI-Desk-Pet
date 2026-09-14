import { useLayoutEffect, type RefObject } from 'react';
import type { ChatPresentationApi } from '../../../shared/chat-presentation';

/** 只上报窗口内的可交互形状；屏幕定位与原生窗口权限留在 Main。 */
export function usePresentationLayout(
  root: RefObject<HTMLElement | null>,
  api: Pick<ChatPresentationApi, 'setLayout'> | undefined,
  surface: 'island' | 'bubble',
  mode: 'hidden' | 'peek' | 'opening' | 'open' | 'closing',
  activityKey: unknown,
  onFailure: () => void
) {
  useLayoutEffect(() => {
    const element = root.current;
    if (!api || !element) return;
    let disposed = false;
    let frame = 0;
    let lastLayout = '';
    const started = performance.now();
    const publish = () => {
      if (disposed) return;
      const bounds = element.getBoundingClientRect();
      const width = Math.min(4096, Math.max(1, Math.ceil(bounds.width || 520)));
      const height = Math.min(4096, Math.max(1, Math.ceil(bounds.height || 88)));
      const regions = mode === 'hidden' ? [] : Array.from(element.querySelectorAll<HTMLElement>('[data-presentation-region]'))
        .flatMap(node => {
          const rect = node.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0 || node.closest('[hidden]')) return [];
          let left = rect.left, top = rect.top, right = rect.right, bottom = rect.bottom;
          // 历史揭开动画由祖先裁剪，命中形状仅覆盖当前可见范围。
          for (let parent = node.parentElement; parent && parent !== element; parent = parent.parentElement) {
            const style = getComputedStyle(parent);
            const clipping = parent.getBoundingClientRect();
            if (/(hidden|clip|auto|scroll)/u.test(style.overflowX || style.overflow)) {
              left = Math.max(left, clipping.left); right = Math.min(right, clipping.right);
            }
            if (/(hidden|clip|auto|scroll)/u.test(style.overflowY || style.overflow)) {
              top = Math.max(top, clipping.top); bottom = Math.min(bottom, clipping.bottom);
            }
          }
          const x = Math.max(0, Math.floor(left - bounds.left));
          const y = Math.max(0, Math.floor(top - bounds.top));
          const w = Math.min(width - x, Math.ceil(right - left));
          const h = Math.min(height - y, Math.ceil(bottom - top));
          if (w <= 0 || h <= 0) return [];
          return [{ x, y, width: w, height: h, radius: Math.min(Number(node.dataset.presentationRegion) || 0, w / 2, h / 2) }];
        });
      const layout = { surface, width, height, regions, mode };
      const key = JSON.stringify(layout);
      if (key === lastLayout) return;
      lastLayout = key;
      void api.setLayout(layout).catch(() => { if (!disposed) onFailure(); });
    };
    const animate = () => {
      publish();
      if (!disposed && performance.now() - started < 560) frame = requestAnimationFrame(animate);
    };
    publish();
    if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(animate);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(publish) : null;
    observer?.observe(element);
    element.querySelectorAll('[data-presentation-region]').forEach(node => observer?.observe(node));
    window.addEventListener('resize', publish);
    return () => {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', publish);
    };
  }, [root, api, surface, mode, activityKey, onFailure]);
}
