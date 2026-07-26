'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { PaymentMethod } from './donation-content';
import styles from './donation.module.css';

export interface QrDialogProps {
  method: PaymentMethod;
  isPaused?: boolean;
  motionDisabled?: boolean;
  onClose: () => void;
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

/**
 * 将付款码挂到文档根层，并在生命周期内约束和恢复键盘焦点。
 */
export function QrDialog({
  method,
  isPaused = false,
  motionDisabled = false,
  onClose
}: QrDialogProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
  }, [method.qrImagePath]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }

      if ([
        'PageUp',
        'PageDown',
        'ArrowUp',
        'ArrowDown',
        'ArrowLeft',
        'ArrowRight'
      ].includes(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (event.key !== 'Tab') return;
      event.stopPropagation();

      const focusableElements = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
          ?? []
      );
      if (focusableElements.length === 0) {
        event.preventDefault();
        return;
      }

      const firstElement = focusableElements[0]!;
      const lastElement = focusableElements.at(-1)!;
      const activeElement = document.activeElement;
      const shouldWrapBackward = event.shiftKey
        && (activeElement === firstElement || !dialogRef.current?.contains(activeElement));
      const shouldWrapForward = !event.shiftKey
        && (activeElement === lastElement || !dialogRef.current?.contains(activeElement));

      if (shouldWrapBackward || shouldWrapForward) {
        event.preventDefault();
        (shouldWrapBackward ? lastElement : firstElement).focus();
      }
    };

    closeButtonRef.current?.focus();
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previousFocus?.focus();
    };
  }, [onClose]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    // 原生非 passive 监听确保弹层滚轮不会传给章节控制器。
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };

    dialog.addEventListener('wheel', handleWheel, { passive: false });
    return () => dialog.removeEventListener('wheel', handleWheel);
  }, []);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={dialogRef}
      className={styles.qrBackdrop}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-input-scope="local"
      data-paused={isPaused}
      data-motion-disabled={motionDisabled}
      onClick={onClose}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerMove={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onPointerCancel={(event) => event.stopPropagation()}
    >
      <div
        className={styles.qrPanel}
        data-testid="qr-panel"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id={titleId}>{method.name}付款码</h3>
        <div className={styles.qrMedia}>
          {imageFailed ? (
            <p className={styles.qrFallback} role="status">
              付款码暂未配置
            </p>
          ) : (
            <img
              src={method.qrImagePath}
              alt={method.imageAlt}
              draggable={false}
              onClick={(event) => event.stopPropagation()}
              onError={() => setImageFailed(true)}
            />
          )}
        </div>
        <button
          ref={closeButtonRef}
          className={styles.qrClose}
          type="button"
          aria-label="关闭付款码"
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </button>
      </div>
    </div>,
    document.body
  );
}
