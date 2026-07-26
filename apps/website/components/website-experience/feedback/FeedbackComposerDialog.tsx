'use client';

import {
  useEffect,
  useId,
  useRef
} from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { FeedbackKind } from './feedback-types';
import styles from './feedback.module.css';

export interface FeedbackDraft {
  kind: FeedbackKind;
  authorName: string;
  content: string;
}

export interface FeedbackComposerDialogProps {
  draft: FeedbackDraft;
  error: string | null;
  submitting: boolean;
  onDraftChange: (draft: FeedbackDraft) => void;
  onSubmit: () => void;
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

function trapFocus(event: KeyboardEvent, container: HTMLElement | null) {
  if (event.key !== 'Tab') return;
  event.stopPropagation();
  const elements = Array.from(
    container?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? []
  );
  if (elements.length === 0) {
    event.preventDefault();
    return;
  }
  const first = elements[0]!;
  const last = elements.at(-1)!;
  const active = document.activeElement;
  const backward = event.shiftKey && (active === first || !container?.contains(active));
  const forward = !event.shiftKey && (active === last || !container?.contains(active));
  if (backward || forward) {
    event.preventDefault();
    (backward ? last : first).focus();
  }
}

/** 以根级 Portal 提供投稿编辑、输入隔离和焦点循环。 */
export function FeedbackComposerDialog({
  draft,
  error,
  submitting,
  onDraftChange,
  onSubmit,
  onRequestClose
}: FeedbackComposerDialogProps) {
  const titleId = useId();
  const contentErrorId = useId();
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onRequestClose();
        return;
      }
      trapFocus(event, dialogRef.current);
      if (event.key !== 'Tab') event.stopPropagation();
    };

    contentRef.current?.focus();
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      previousFocus?.focus();
    };
  }, [onRequestClose]);

  useEffect(() => {
    const backdrop = backdropRef.current;
    if (!backdrop) return;
    // 阻止章节滚动，但保留面板自身的原生滚动。
    const handleWheel = (event: WheelEvent) => {
      event.stopPropagation();
    };
    backdrop.addEventListener('wheel', handleWheel, { passive: false });
    return () => backdrop.removeEventListener('wheel', handleWheel);
  }, []);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={backdropRef}
      className={styles.composerBackdrop}
      data-testid="feedback-composer-backdrop"
      data-input-scope="local"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={onRequestClose}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerMove={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onTouchMove={(event) => event.stopPropagation()}
      onWheel={(event) => {
        event.stopPropagation();
        const target = event.target;
        const isInsidePanel = target instanceof Element
          && target.closest('[data-testid="feedback-composer-panel"]');
        if (!isInsidePanel) event.preventDefault();
      }}
    >
      <section
        ref={dialogRef}
        className={styles.composerPanel}
        data-testid="feedback-composer-panel"
        onClick={(event) => event.stopPropagation()}
      >
        <header className={styles.composerHeader}>
          <h3 id={titleId}>新建投稿</h3>
          <button
            className={styles.dialogCloseButton}
            type="button"
            aria-label="取消投稿"
            disabled={submitting}
            onClick={onRequestClose}
          >
            <X aria-hidden="true" />
          </button>
        </header>

        <div className={styles.composerFields}>
          <fieldset className={styles.composerKindField}>
            <legend>投稿类型</legend>
            <div className={styles.composerSegmentedControl} role="radiogroup" aria-label="投稿类型">
              {([
                ['feedback', '用户反馈'],
                ['suggestion', '更新建议']
              ] as const).map(([kind, label]) => (
                <button
                  key={kind}
                  type="button"
                  role="radio"
                  aria-checked={draft.kind === kind}
                  disabled={submitting}
                  onClick={() => onDraftChange({ ...draft, kind })}
                >
                  {label}
                </button>
              ))}
            </div>
          </fieldset>

          <div className={styles.composerField}>
            <label htmlFor="feedback-author-name">昵称（可选）</label>
            <input
              id="feedback-author-name"
              name="authorName"
              value={draft.authorName}
              maxLength={24}
              disabled={submitting}
              onChange={(event) => onDraftChange({
                ...draft,
                authorName: event.target.value
              })}
            />
          </div>

          <div className={styles.composerField}>
            <div className={styles.composerContentLabel}>
              <label htmlFor="feedback-content">正文</label>
              <span aria-live="polite">{draft.content.length}/1000</span>
            </div>
            <textarea
              ref={contentRef}
              id="feedback-content"
              name="content"
              value={draft.content}
              minLength={10}
              maxLength={1000}
              aria-invalid={error ? 'true' : undefined}
              aria-describedby={error ? contentErrorId : undefined}
              disabled={submitting}
              onChange={(event) => onDraftChange({
                ...draft,
                content: event.target.value
              })}
            />
            {error ? <p id={contentErrorId} className={styles.composerError} role="alert">{error}</p> : null}
          </div>
        </div>

        <footer className={styles.composerFooter}>
          <button type="button" disabled={submitting} onClick={onRequestClose}>取消</button>
          <button type="button" disabled={submitting} onClick={onSubmit}>
            {submitting ? '正在发布' : '发布投稿'}
          </button>
        </footer>
      </section>
    </div>,
    document.body
  );
}
