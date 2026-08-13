'use client';

import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { Translate } from '../../i18n/i18n-types';
import styles from './feedback.module.css';

export interface DiscardDraftDialogProps {
  onContinueEditing: () => void;
  onDiscard: () => void;
  t: Translate;
}

const FOCUSABLE_SELECTOR = 'button:not([disabled])';

/** 以不可穿透的确认层阻止未保存草稿被意外丢弃。 */
export function DiscardDraftDialog({
  onContinueEditing,
  onDiscard,
  t
}: DiscardDraftDialogProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const continueRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onContinueEditing();
        return;
      }
      if (event.key !== 'Tab') {
        event.stopPropagation();
        return;
      }
      event.stopPropagation();
      const dialog = dialogRef.current;
      if (!dialog) return;
      const buttons = Array.from(dialog.querySelectorAll<HTMLButtonElement>(FOCUSABLE_SELECTOR));
      const first = buttons[0];
      const last = buttons.at(-1);
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    continueRef.current?.focus();
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [onContinueEditing]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      className={styles.discardBackdrop}
      data-testid="discard-draft-backdrop"
      data-input-scope="local"
      onPointerDown={(event) => event.stopPropagation()}
      onPointerMove={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onTouchMove={(event) => event.stopPropagation()}
      onWheel={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <section
        ref={dialogRef}
        className={styles.discardPanel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id={titleId}>{t('feedback.dialog.discardTitle')}</h3>
        <div className={styles.discardActions}>
          <button ref={continueRef} type="button" onClick={onContinueEditing}>{t('feedback.dialog.continue')}</button>
          <button type="button" onClick={onDiscard}>{t('feedback.dialog.discard')}</button>
        </div>
      </section>
    </div>,
    document.body
  );
}
