'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ThumbsUp, X } from 'lucide-react';
import type {
  FeedbackKind,
  FeedbackRepository,
  FeedbackStatusNotice
} from './feedback-types';
import styles from './feedback.module.css';

export interface FeedbackListDialogProps {
  kind: FeedbackKind;
  repository: FeedbackRepository;
  onClose: () => void;
}

type RepositoryWithNotice = FeedbackRepository & {
  getStatusNotice?: () => FeedbackStatusNotice | null;
};

const KIND_LABELS: Record<FeedbackKind, string> = {
  feedback: '用户反馈',
  suggestion: '更新建议'
};

const BLOCKED_KEYS = new Set([
  'PageUp',
  'PageDown',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight'
]);

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

function formatPublishedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

/** 在根级 Portal 中展示仓储排序结果，并约束章节级输入与焦点。 */
export function FeedbackListDialog({
  kind,
  repository,
  onClose
}: FeedbackListDialogProps) {
  const titleId = useId();
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [revision, setRevision] = useState(0);
  const [interactionNotice, setInteractionNotice] = useState('');
  const [optimisticLikes, setOptimisticLikes] = useState(() => new Map<
    string,
    { liked: boolean; count: number }
  >());
  const entries = repository.list(kind).map((entry) => {
    const optimistic = optimisticLikes.get(entry.id);
    return optimistic
      ? {
          ...entry,
          likedByCurrentBrowser: optimistic.liked,
          likeCount: optimistic.count
        }
      : entry;
  });
  const repositoryNotice = (repository as RepositoryWithNotice)
    .getStatusNotice?.() ?? null;
  const label = KIND_LABELS[kind];

  useEffect(() => repository.subscribe(() => {
    setOptimisticLikes(new Map());
    setRevision((current) => current + 1);
  }), [repository]);
  void revision;

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

      if (event.key === 'Tab') {
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
          && (activeElement === firstElement
            || !dialogRef.current?.contains(activeElement));
        const shouldWrapForward = !event.shiftKey
          && (activeElement === lastElement
            || !dialogRef.current?.contains(activeElement));

        if (shouldWrapBackward || shouldWrapForward) {
          event.preventDefault();
          (shouldWrapBackward ? lastElement : firstElement).focus();
        }
        return;
      }

      if (BLOCKED_KEYS.has(event.key)) {
        event.stopPropagation();
        if (!(event.target instanceof Element)
          || !event.target.closest('[data-feedback-scroll]')) {
          event.preventDefault();
        }
      }
    };

    closeButtonRef.current?.focus();
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      previousFocus?.focus();
    };
  }, [onClose]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    // 对话框外壳阻止章节滚动，列表自身仍保留原生纵向滚动。
    const handleWheel = (event: WheelEvent) => {
      event.stopPropagation();
      if (!(event.target instanceof Element)
        || !event.target.closest('[data-feedback-scroll]')) {
        event.preventDefault();
      }
    };
    dialog.addEventListener('wheel', handleWheel, { passive: false });
    return () => dialog.removeEventListener('wheel', handleWheel);
  }, []);

  const toggleLike = useCallback((
    id: string,
    wasLiked: boolean,
    visibleCount: number
  ) => {
    try {
      const updated = repository.toggleLike(id, 'current-browser');
      const expectedCount = Math.max(0, visibleCount + (wasLiked ? -1 : 1));
      setOptimisticLikes((current) => {
        const next = new Map(current);
        next.set(id, {
          liked: updated.likedByCurrentBrowser,
          count: updated.likeCount === visibleCount
            ? expectedCount
            : updated.likeCount
        });
        return next;
      });
      setInteractionNotice('');
    } catch {
      setInteractionNotice('点赞状态暂时无法保存，请稍后重试。');
    }
  }, [repository]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={dialogRef}
      className={styles.dialogBackdrop}
      data-testid="feedback-dialog-backdrop"
      data-input-scope="local"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={onClose}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerMove={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onPointerCancel={(event) => event.stopPropagation()}
    >
      <section
        className={styles.dialogPanel}
        data-testid="feedback-dialog-panel"
        onClick={(event) => event.stopPropagation()}
      >
        <header className={styles.dialogHeader}>
          <div>
            <p className={styles.dialogEyebrow}>VOICE ARCHIVE</p>
            <h3 id={titleId}>{label}</h3>
          </div>
          <button
            ref={closeButtonRef}
            className={styles.dialogClose}
            type="button"
            aria-label={`关闭${label}`}
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </button>
        </header>

        {repositoryNotice || interactionNotice ? (
          <p className={styles.statusNotice} role="status">
            {interactionNotice || repositoryNotice?.message}
          </p>
        ) : null}

        <div
          className={styles.feedbackList}
          data-feedback-scroll
          data-input-scope="local"
          role="list"
          aria-label={`${label}列表`}
        >
          {entries.map((entry, index) => (
            <article
              key={entry.id}
              className={styles.feedbackRow}
              data-row-side={index % 2 === 0 ? 'left' : 'right'}
              data-testid="feedback-row"
              role="listitem"
            >
              <div className={styles.feedbackMeta}>
                <strong>{entry.authorName}</strong>
                <time dateTime={entry.createdAt}>
                  {formatPublishedAt(entry.createdAt)}
                </time>
              </div>
              <p className={styles.feedbackContent}>{entry.content}</p>
              <button
                className={styles.likeButton}
                type="button"
                aria-label={`点赞${entry.authorName}的${kind === 'feedback' ? '反馈' : '建议'}`}
                aria-pressed={entry.likedByCurrentBrowser}
                onClick={() => toggleLike(
                  entry.id,
                  entry.likedByCurrentBrowser,
                  entry.likeCount
                )}
              >
                <ThumbsUp aria-hidden="true" />
                <span>{entry.likeCount}</span>
              </button>
            </article>
          ))}
        </div>
      </section>
    </div>,
    document.body
  );
}
