import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

/** 通用提示的最小展示形状；队列归调用方所有。 */
export type TransientToastAction = Readonly<{
  id: string;
  label: string;
  tone?: 'default' | 'danger';
}>;

export type TransientToast = Readonly<{
  id: string;
  tone: 'success' | 'info' | 'warning' | 'error';
  text: string;
  persistent?: boolean;
  dismissible?: boolean;
  actions?: readonly TransientToastAction[];
}>;

export interface TransientToastLayerProps {
  queue: readonly TransientToast[];
  onDismiss(id: string): void;
  onAction?(toastId: string, actionId: string): void;
  durationMs(toast: TransientToast): number;
  ariaLabel: string;
}

/**
 * 瞬时提示层只消费队首，并负责其暂停、恢复与关闭生命周期。
 * 队列写入、移除及各业务场景的持续时间策略由调用方管理。
 */
export function TransientToastLayer({
  queue,
  onDismiss,
  onAction,
  durationMs,
  ariaLabel
}: TransientToastLayerProps) {
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
      /** 消费方回调失败时仍停止计时，避免重复关闭。 */
    }
  }

  function startTimer(): void {
    if (
      !toast
      || toast.persistent
      || dismissedRef.current
      || timerRef.current !== undefined
    ) return;
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
    remainingRef.current = toast ? durationMs(toast) : 0;
    if (toast) {
      // 原位替换 ID 时 DOM 仍可能处于 hover/focus；保留暂停位并重置新提示时长。
      startTimer();
    } else {
      // 节点移除后清空交互状态，避免后续新节点继承已消失节点的暂停位。
      pausedRef.current = { focus: false, hover: false };
    }

    return clearTimer;
  }, [toast?.id]);

  if (!toast) return null;
  const urgent = toast.tone === 'warning' || toast.tone === 'error';

  return (
    <aside className="transient-toast-layer" aria-label={ariaLabel}>
      <div
        className={`transient-toast transient-toast-${toast.tone}`}
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
        <div className="transient-toast-content">
          <span>{toast.text}</span>
          {toast.actions?.length ? (
            <div className="transient-toast-actions">
              {toast.actions.map(action => (
                <button
                  key={action.id}
                  className={action.tone === 'danger' ? 'is-danger' : undefined}
                  type="button"
                  onClick={() => {
                    try {
                      onAction?.(toast.id, action.id);
                    } catch {
                      /** 业务动作自行呈现失败；提示层不重复触发用户选择。 */
                    }
                  }}
                >
                  {action.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        {toast.dismissible === false ? null : (
          <button
            type="button"
            aria-label={`关闭${ariaLabel}：${toast.text}`}
            title="关闭提示"
            onClick={dismissCurrent}
          >
            <X size={15} aria-hidden="true" />
          </button>
        )}
      </div>
    </aside>
  );
}
