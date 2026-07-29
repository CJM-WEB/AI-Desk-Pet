'use client';

import {
  type PropsWithChildren,
  type ReactNode,
  useEffect,
  useId,
  useRef
} from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import styles from './community.module.css';

export interface SharedPetDialogShellProps extends PropsWithChildren {
  title: string;
  closeLabel: string;
  footer?: ReactNode;
  dismissDisabled?: boolean;
  onRequestClose: () => void;
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

/** 统一根级弹窗的焦点、键盘与章节输入隔离行为。 */
export function SharedPetDialogShell({
  title,
  closeLabel,
  footer,
  dismissDisabled = false,
  children,
  onRequestClose
}: SharedPetDialogShellProps) {
  const titleId = useId();
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (!dismissDisabled) onRequestClose();
        return;
      }

      if (event.key !== 'Tab') {
        event.stopPropagation();
        return;
      }

      event.stopPropagation();
      const focusable = Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? []
      );
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      const active = document.activeElement;
      const backward = event.shiftKey
        && (active === first || !panelRef.current?.contains(active));
      const forward = !event.shiftKey
        && (active === last || !panelRef.current?.contains(active));
      if (backward || forward) {
        event.preventDefault();
        (backward ? last : first).focus();
      }
    };

    closeButtonRef.current?.focus();
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      previousFocus?.focus();
    };
  }, [dismissDisabled, onRequestClose]);

  useEffect(() => {
    const backdrop = backdropRef.current;
    if (!backdrop) return undefined;

    // 弹窗外区域不消费页面滚动，面板自身保留原生滚动。
    const handleWheel = (event: WheelEvent) => {
      event.stopPropagation();
      if (!(event.target instanceof Element)
        || !event.target.closest('[data-shared-pet-dialog-panel]')) {
        event.preventDefault();
      }
    };
    backdrop.addEventListener('wheel', handleWheel, { passive: false });
    return () => backdrop.removeEventListener('wheel', handleWheel);
  }, []);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={backdropRef}
      className={styles.dialogBackdrop}
      data-input-scope="local"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={() => {
        if (!dismissDisabled) onRequestClose();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerMove={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onPointerCancel={(event) => event.stopPropagation()}
    >
      <section
        ref={panelRef}
        className={styles.dialogPanel}
        data-shared-pet-dialog-panel
        onClick={(event) => event.stopPropagation()}
      >
        <header className={styles.dialogHeader}>
          <h3 id={titleId}>{title}</h3>
          <button
            ref={closeButtonRef}
            className={styles.iconButton}
            type="button"
            aria-label={closeLabel}
            title={closeLabel}
            disabled={dismissDisabled}
            onClick={onRequestClose}
          >
            <X aria-hidden="true" />
          </button>
        </header>
        <div className={styles.dialogContent}>{children}</div>
        {footer ? <footer className={styles.dialogFooter}>{footer}</footer> : null}
      </section>
    </div>,
    document.body
  );
}
