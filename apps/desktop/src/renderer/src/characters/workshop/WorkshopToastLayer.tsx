import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import type { WorkshopToast } from '../store/character-workshop-store';

export type { WorkshopToast } from '../store/character-workshop-store';

export interface WorkshopToastLayerProps {
  queue: readonly WorkshopToast[];
  onDismiss(id: string): void;
}

export function toastDurationMs(tone: WorkshopToast['tone']): 3000 | 6000 {
  return tone === 'warning' || tone === 'error' ? 6000 : 3000;
}

/**
 * 右上角提示层只负责展示队首；队列的增删仍由工作台 store 统一管理。
 */
export function WorkshopToastLayer({
  queue,
  onDismiss
}: WorkshopToastLayerProps) {
  const toast = queue[0];
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const startedAtRef = useRef(0);
  const remainingRef = useRef(0);
  const pausedRef = useRef({ focus: false, hover: false });
  const dismissedRef = useRef(false);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  function clearTimer(): void {
    if (timerRef.current !== undefined) {
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
  }

  function dismissCurrent(): void {
    clearTimer();
    if (!toast || dismissedRef.current) return;
    dismissedRef.current = true;
    try {
      onDismissRef.current(toast.id);
    } catch {
      // 消费方回调失败时，本层仍应确保已停止计时，避免重复关闭。
    }
  }

  function startTimer(): void {
    if (!toast || dismissedRef.current || timerRef.current !== undefined) return;
    if (pausedRef.current.hover || pausedRef.current.focus) return;
    startedAtRef.current = performance.now();
    timerRef.current = setTimeout(() => {
      timerRef.current = undefined;
      dismissCurrent();
    }, remainingRef.current);
  }

  function pause(reason: 'focus' | 'hover'): void {
    if (!toast || pausedRef.current[reason]) return;
    pausedRef.current[reason] = true;
    if (timerRef.current === undefined) return;
    remainingRef.current = Math.max(
      0,
      remainingRef.current - (performance.now() - startedAtRef.current)
    );
    clearTimer();
  }

  function resume(reason: 'focus' | 'hover'): void {
    if (!toast || !pausedRef.current[reason]) return;
    pausedRef.current[reason] = false;
    if (!pausedRef.current.hover && !pausedRef.current.focus) startTimer();
  }

  useEffect(() => {
    clearTimer();
    dismissedRef.current = false;
    pausedRef.current = { focus: false, hover: false };
    remainingRef.current = toast ? toastDurationMs(toast.tone) : 0;
    if (toast) startTimer();

    return clearTimer;
  }, [toast?.id]);

  if (!toast) return null;
  const urgent = toast.tone === 'warning' || toast.tone === 'error';

  return (
    <aside className="workshop-toast-layer" aria-label="工作台提示">
      <div
        className={`workshop-toast workshop-toast-${toast.tone}`}
        role={urgent ? 'alert' : 'status'}
        aria-live={urgent ? 'assertive' : 'polite'}
        aria-atomic="true"
        onMouseEnter={() => pause('hover')}
        onMouseLeave={() => resume('hover')}
        onFocus={() => pause('focus')}
        onBlur={event => {
          if (!event.currentTarget.contains(event.relatedTarget)) resume('focus');
        }}
      >
        <span>{toast.text}</span>
        <button
          type="button"
          aria-label={`关闭提示：${toast.text}`}
          title="关闭提示"
          onClick={dismissCurrent}
        >
          <X size={15} aria-hidden="true" />
        </button>
      </div>
    </aside>
  );
}
