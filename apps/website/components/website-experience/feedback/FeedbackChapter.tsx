'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState
} from 'react';
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent
} from 'react';
import {
  paymentCardVisual,
  paymentRelativeOffset,
  wrapPaymentIndex
} from '../donation/payment-model';
import type { ChapterRuntimeProps } from '../types';
import { PointerTiltText } from '../visual/PointerTiltText';
import { FeedbackListDialog } from './FeedbackListDialog';
import {
  FeedbackComposerDialog,
  type FeedbackDraft
} from './FeedbackComposerDialog';
import { DiscardDraftDialog } from './DiscardDraftDialog';
import { validateDraft } from './feedback-model';
import { LocalStorageFeedbackRepository } from './local-storage-feedback-repository';
import type {
  FeedbackKind,
  FeedbackRepository
} from './feedback-types';
import styles from './feedback.module.css';

export interface FeedbackChapterProps extends ChapterRuntimeProps {
  repository?: FeedbackRepository;
  onCreateRequested?: () => void;
}

type ComposerState =
  | { phase: 'editing'; draft: FeedbackDraft; error: string | null }
  | { phase: 'confirm-discard'; draft: FeedbackDraft }
  | { phase: 'submitting'; draft: FeedbackDraft };

type FeedbackAction = {
  id: 'feedback' | 'suggestion' | 'create';
  label: string;
  kind?: FeedbackKind;
};

type FeedbackCardStyle = CSSProperties & {
  '--feedback-opacity': number;
  '--feedback-scale': number;
  '--feedback-translate-y': string;
};

type PointerDrag = {
  pointerId: number;
  startY: number;
  switched: boolean;
};

const FEEDBACK_TITLE = '倾听你的声音，打造属于你的 Pet';
const FEEDBACK_ACTIONS: readonly FeedbackAction[] = [
  { id: 'feedback', label: '用户反馈', kind: 'feedback' },
  { id: 'suggestion', label: '更新建议', kind: 'suggestion' },
  { id: 'create', label: '新建投稿' }
];
const DRAG_THRESHOLD_PX = 40;
const EMPTY_DRAFT: FeedbackDraft = {
  kind: 'feedback',
  authorName: '',
  content: ''
};

function draftErrorMessage(code: string): string {
  switch (code) {
    case 'AUTHOR_NAME_TOO_LONG':
      return '昵称不能超过 24 个字符。';
    case 'CONTENT_TOO_SHORT':
      return '正文至少需要 10 个字符。';
    case 'CONTENT_TOO_LONG':
      return '正文不能超过 1000 个字符。';
    default:
      return '投稿内容无效，请检查后重试。';
  }
}

function getCardStyle(index: number, activeIndex: number): FeedbackCardStyle {
  const offset = paymentRelativeOffset(
    index,
    activeIndex,
    FEEDBACK_ACTIONS.length
  );
  const visual = paymentCardVisual(offset);
  return {
    '--feedback-opacity': visual.opacity,
    '--feedback-scale': visual.scale,
    '--feedback-translate-y': `${visual.translateYPercent}%`,
    zIndex: visual.zIndex
  };
}

/** 提供反馈专用三项滚筒，并把查看列表挂载到根级 Portal。 */
export function FeedbackChapter({
  interactive,
  isPaused = false,
  reducedMotion = false,
  staticFallback = false,
  repository: injectedRepository,
  onCreateRequested
}: FeedbackChapterProps) {
  const repositoryRef = useRef<FeedbackRepository | null>(null);
  if (repositoryRef.current === null) {
    repositoryRef.current = injectedRepository
      ?? new LocalStorageFeedbackRepository();
  }
  const repository = repositoryRef.current;
  const [activeIndex, setActiveIndex] = useState(0);
  const [openKind, setOpenKind] = useState<FeedbackKind | null>(null);
  const [composerState, setComposerState] = useState<ComposerState | null>(null);
  const [pointer, setPointer] = useState({ x: 0, y: 0 });
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const rollerRef = useRef<HTMLDivElement | null>(null);
  const createTriggerRef = useRef<HTMLButtonElement | null>(null);
  const restoreCreateFocusRef = useRef(false);
  const submittedDraftRef = useRef<FeedbackDraft | null>(null);
  const pointerDragRef = useRef<PointerDrag | null>(null);
  const suppressClickRef = useRef(false);
  const suppressClickTimeoutRef = useRef<number | null>(null);
  const motionDisabled = reducedMotion || staticFallback || isPaused;
  const closeDialog = useCallback(() => setOpenKind(null), []);

  const requestComposerClose = useCallback(() => {
    setComposerState((current) => {
      if (!current || current.phase === 'submitting') return current;
      if (current.draft.authorName || current.draft.content) {
        return { phase: 'confirm-discard', draft: current.draft };
      }
      restoreCreateFocusRef.current = true;
      return null;
    });
  }, []);

  const updateDraft = useCallback((draft: FeedbackDraft) => {
    setComposerState((current) => current && current.phase !== 'submitting'
      ? { phase: 'editing', draft, error: null }
      : current);
  }, []);

  const submitDraft = useCallback(() => {
    if (!composerState || composerState.phase !== 'editing') return;
    const validation = validateDraft(composerState.draft);
    if (!validation.valid) {
      setComposerState({
        phase: 'editing',
        draft: composerState.draft,
        error: draftErrorMessage(validation.code)
      });
      return;
    }
    submittedDraftRef.current = null;
    setComposerState({ phase: 'submitting', draft: composerState.draft });
  }, [composerState]);

  useEffect(() => {
    if (!composerState || composerState.phase !== 'submitting') return;
    if (submittedDraftRef.current === composerState.draft) return;
    submittedDraftRef.current = composerState.draft;

    const validation = validateDraft(composerState.draft);
    if (!validation.valid) {
      setComposerState({
        phase: 'editing',
        draft: composerState.draft,
        error: draftErrorMessage(validation.code)
      });
      return;
    }
    try {
      const entry = repository.create(validation.value);
      setOpenKind(entry.kind);
      setComposerState(null);
    } catch {
      setComposerState({
        phase: 'editing',
        draft: composerState.draft,
        error: '投稿暂时无法保存，请稍后重试。'
      });
    }
  }, [composerState, repository]);

  const confirmDiscard = useCallback(() => {
    restoreCreateFocusRef.current = true;
    setComposerState(null);
  }, []);

  useEffect(() => {
    if (!composerState && restoreCreateFocusRef.current) {
      restoreCreateFocusRef.current = false;
      createTriggerRef.current?.focus();
    }
  }, [composerState]);

  useEffect(() => {
    if (!interactive || motionDisabled) return;
    const syncViewport = () => {
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    };
    const handlePointerMove = (event: PointerEvent) => {
      setPointer({ x: event.clientX, y: event.clientY });
    };

    syncViewport();
    window.addEventListener('resize', syncViewport);
    window.addEventListener('pointermove', handlePointerMove, { passive: true });
    return () => {
      window.removeEventListener('resize', syncViewport);
      window.removeEventListener('pointermove', handlePointerMove);
    };
  }, [interactive, motionDisabled]);

  useEffect(() => {
    if (!interactive) {
      pointerDragRef.current = null;
      suppressClickRef.current = false;
      setOpenKind(null);
      setComposerState(null);
    }
    return () => {
      if (suppressClickTimeoutRef.current !== null) {
        window.clearTimeout(suppressClickTimeoutRef.current);
      }
    };
  }, [interactive]);

  const selectRelativeAction = useCallback((delta: number) => {
    setActiveIndex((current) => wrapPaymentIndex(
      current + delta,
      FEEDBACK_ACTIONS.length
    ));
  }, []);

  useEffect(() => {
    const roller = rollerRef.current;
    if (!roller) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (!interactive || event.deltaY === 0) return;
      selectRelativeAction(event.deltaY > 0 ? 1 : -1);
    };
    roller.addEventListener('wheel', handleWheel, { passive: false });
    return () => roller.removeEventListener('wheel', handleWheel);
  }, [interactive, selectRelativeAction]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const direction = event.key === 'ArrowDown' || event.key === 'ArrowRight'
      ? 1
      : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
        ? -1
        : 0;
    if (direction !== 0) {
      event.preventDefault();
      event.stopPropagation();
      if (interactive) selectRelativeAction(direction);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      (event.target as HTMLElement).blur?.();
    }
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!interactive || event.pointerType === 'mouse') return;
    event.preventDefault();
    event.stopPropagation();
    if (pointerDragRef.current) return;
    pointerDragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      switched: false
    };
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // 指针捕获不可用时仍由局部手势状态完成切换。
    }
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = pointerDragRef.current;
    if (!drag) return;
    event.preventDefault();
    event.stopPropagation();
    if (drag.pointerId !== event.pointerId || drag.switched) return;
    const deltaY = event.clientY - drag.startY;
    if (Math.abs(deltaY) <= DRAG_THRESHOLD_PX) return;
    drag.switched = true;
    suppressClickRef.current = true;
    selectRelativeAction(deltaY < 0 ? 1 : -1);
  };

  const finishPointerDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = pointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    pointerDragRef.current = null;
    if (drag.switched) {
      suppressClickTimeoutRef.current = window.setTimeout(() => {
        suppressClickRef.current = false;
        suppressClickTimeoutRef.current = null;
      }, 0);
    }
    try {
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture?.(event.pointerId);
      }
    } catch {
      // pointercancel 可能已由浏览器释放捕获。
    }
  };

  return (
    <section
      className={styles.feedbackChapter}
      data-testid="feedback-chapter"
      data-dialog-open={openKind !== null || composerState !== null}
      data-motion-disabled={motionDisabled}
    >
      <h2 className={styles.feedbackTitle}>
        <PointerTiltText
          pointer={pointer}
          viewport={viewport}
          disabled={motionDisabled || viewport.width <= 760}
        >
          {FEEDBACK_TITLE}
        </PointerTiltText>
      </h2>

      <div
        ref={rollerRef}
        className={styles.feedbackRoller}
        data-input-scope="local"
        data-active-action={FEEDBACK_ACTIONS[activeIndex]?.id}
        role="group"
        aria-label="选择反馈操作"
        tabIndex={interactive ? 0 : -1}
        onKeyDown={handleKeyDown}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishPointerDrag}
        onPointerCancel={finishPointerDrag}
      >
        <div className={styles.feedbackDeck}>
          {FEEDBACK_ACTIONS.map((action, index) => {
            const isActive = index === activeIndex;
            const activeLabel = action.id === 'create'
              ? '新建投稿'
              : `查看${action.label}`;
            return (
              <button
                key={action.id}
                ref={action.id === 'create' ? createTriggerRef : undefined}
                className={styles.feedbackCard}
                type="button"
                aria-label={isActive ? activeLabel : `选择${action.label}`}
                aria-pressed={isActive}
                data-action-id={action.id}
                data-active={isActive}
                disabled={!interactive}
                tabIndex={interactive ? 0 : -1}
                style={getCardStyle(index, activeIndex)}
                onClick={() => {
                  if (!interactive) return;
                  if (suppressClickRef.current) {
                    suppressClickRef.current = false;
                    if (suppressClickTimeoutRef.current !== null) {
                      window.clearTimeout(suppressClickTimeoutRef.current);
                      suppressClickTimeoutRef.current = null;
                    }
                    return;
                  }
                  if (!isActive) {
                    setActiveIndex(index);
                    return;
                  }
                  if (action.kind) {
                    setOpenKind(action.kind);
                    return;
                  }
                  setComposerState({
                    phase: 'editing',
                    draft: { ...EMPTY_DRAFT },
                    error: null
                  });
                  onCreateRequested?.();
                }}
              >
                <span className={styles.feedbackActionName}>{action.label}</span>
                <span className={styles.feedbackActionMeta}>
                  {action.kind ? '打开声音档案' : '编辑器预留入口'}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {openKind ? (
        <FeedbackListDialog
          kind={openKind}
          repository={repository}
          onClose={closeDialog}
        />
      ) : null}

      {composerState?.phase === 'editing' || composerState?.phase === 'submitting' ? (
        <FeedbackComposerDialog
          draft={composerState.draft}
          error={composerState.phase === 'editing' ? composerState.error : null}
          submitting={composerState.phase === 'submitting'}
          onDraftChange={updateDraft}
          onSubmit={submitDraft}
          onRequestClose={requestComposerClose}
        />
      ) : null}

      {composerState?.phase === 'confirm-discard' ? (
        <DiscardDraftDialog
          onContinueEditing={() => setComposerState({
            phase: 'editing',
            draft: composerState.draft,
            error: null
          })}
          onDiscard={confirmDiscard}
        />
      ) : null}
    </section>
  );
}
