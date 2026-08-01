'use client';

import {
  useCallback,
  useEffect,
  useMemo,
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
import { interpolateMessage, useI18n } from '../../i18n/I18nProvider';
import type { Translate } from '../../i18n/i18n-types';
import { PointerTiltText } from '../visual/PointerTiltText';
import { FeedbackListDialog } from './FeedbackListDialog';
import {
  FeedbackComposerDialog,
  type FeedbackDraft
} from './FeedbackComposerDialog';
import { DiscardDraftDialog } from './DiscardDraftDialog';
import { validateDraft } from './feedback-model';
import { ApiClient } from '../../../lib/api-client';
import { CaptchaClient, type CaptchaVerifier } from '../../../lib/captcha';
import { CloudFeedbackRepository } from './cloud-feedback-repository';
import type {
  FeedbackKind,
  FeedbackRepository
} from './feedback-types';
import type { SubmissionReceipt } from '@myself/shared-types';
import styles from './feedback.module.css';

export interface FeedbackChapterProps extends ChapterRuntimeProps {
  repository?: FeedbackRepository;
  captcha?: CaptchaVerifier;
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

const DRAG_THRESHOLD_PX = 40;
const EMPTY_DRAFT: FeedbackDraft = {
  kind: 'feedback',
  authorName: '',
  content: ''
};

function draftErrorMessage(code: string, t: ReturnType<typeof useI18n>['t']): string {
  switch (code) {
    case 'AUTHOR_NAME_TOO_LONG':
      return t('feedback.error.authorTooLong');
    case 'CONTENT_TOO_SHORT':
      return t('feedback.error.contentTooShort');
    case 'CONTENT_TOO_LONG':
      return t('feedback.error.contentTooLong');
    default:
      return t('feedback.error.invalid');
  }
}

function getCardStyle(
  index: number,
  activeIndex: number,
  actionCount: number
): FeedbackCardStyle {
  const offset = paymentRelativeOffset(
    index,
    activeIndex,
    actionCount
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
  captcha: injectedCaptcha,
  onCreateRequested
}: FeedbackChapterProps) {
  const { locale, t: rawTranslate } = useI18n();
  const t = useCallback<Translate>((key, values) => (
    interpolateMessage(rawTranslate(key), values)
  ), [rawTranslate]);
  const feedbackActions = useMemo<readonly FeedbackAction[]>(() => [
    { id: 'feedback', label: t('feedback.action.feedback'), kind: 'feedback' },
    { id: 'suggestion', label: t('feedback.action.suggestion'), kind: 'suggestion' },
    { id: 'create', label: t('feedback.action.create') }
  ], [t]);
  const repositoryRef = useRef<FeedbackRepository | null>(null);
  if (repositoryRef.current === null) {
    repositoryRef.current = injectedRepository
      ?? new CloudFeedbackRepository(new ApiClient(
        process.env.NEXT_PUBLIC_API_BASE_URL ?? '/api/v1'
      ));
  }
  const repository = repositoryRef.current;
  const captchaRef = useRef<CaptchaVerifier | null>(null);
  if (captchaRef.current === null) captchaRef.current = injectedCaptcha ?? new CaptchaClient();
  const captcha = captchaRef.current;
  const [activeIndex, setActiveIndex] = useState(0);
  const [openKind, setOpenKind] = useState<FeedbackKind | null>(null);
  const [composerState, setComposerState] = useState<ComposerState | null>(null);
  const [submissionReceipt, setSubmissionReceipt] = useState<SubmissionReceipt | null>(null);
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

  useEffect(() => {
    if (!interactive) return;
    void Promise.all([
      repository.refresh('feedback'),
      repository.refresh('suggestion')
    ]).catch(() => undefined);
  }, [interactive, repository]);

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
        error: draftErrorMessage(validation.code, t)
      });
      return;
    }
    submittedDraftRef.current = null;
    setComposerState({ phase: 'submitting', draft: composerState.draft });
  }, [composerState, t]);

  useEffect(() => {
    if (!composerState || composerState.phase !== 'submitting') return;
    if (submittedDraftRef.current === composerState.draft) return;
    submittedDraftRef.current = composerState.draft;

    const validation = validateDraft(composerState.draft);
    if (!validation.valid) {
      setComposerState({
        phase: 'editing',
        draft: composerState.draft,
        error: draftErrorMessage(validation.code, t)
      });
      return;
    }
    void (async () => {
      try {
        const receipt = await repository.create(
          validation.value,
          await captcha.verify()
        );
        setSubmissionReceipt(receipt);
        setComposerState(null);
      } catch {
        setComposerState({
          phase: 'editing',
          draft: composerState.draft,
          error: t('feedback.error.saveFailed')
        });
      }
    })();
  }, [captcha, composerState, repository, t]);

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
      feedbackActions.length
    ));
  }, [feedbackActions.length]);

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
          {t('feedback.title')}
        </PointerTiltText>
      </h2>

      <div
        ref={rollerRef}
        className={styles.feedbackRoller}
        data-input-scope="local"
        data-active-action={feedbackActions[activeIndex]?.id}
        role="group"
        aria-label={t('feedback.group')}
        tabIndex={interactive ? 0 : -1}
        onKeyDown={handleKeyDown}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishPointerDrag}
        onPointerCancel={finishPointerDrag}
      >
        <div className={styles.feedbackDeck}>
          {feedbackActions.map((action, index) => {
            const isActive = index === activeIndex;
            const activeLabel = action.id === 'create'
              ? t('feedback.action.create')
              : t('feedback.action.view', { label: action.label });
            return (
              <button
                key={action.id}
                ref={action.id === 'create' ? createTriggerRef : undefined}
                className={styles.feedbackCard}
                type="button"
                aria-label={isActive
                  ? activeLabel
                  : t('feedback.action.select', { label: action.label })}
                aria-pressed={isActive}
                data-action-id={action.id}
                data-active={isActive}
                disabled={!interactive}
                tabIndex={interactive ? 0 : -1}
                style={getCardStyle(index, activeIndex, feedbackActions.length)}
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
                  setSubmissionReceipt(null);
                  onCreateRequested?.();
                }}
              >
                <span className={styles.feedbackActionName}>{action.label}</span>
                {!action.kind ? (
                  <span className={styles.feedbackActionMeta}>{t('feedback.action.createMeta')}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      {openKind ? (
        <FeedbackListDialog
          kind={openKind}
          repository={repository}
          t={t}
          locale={locale}
          onClose={closeDialog}
        />
      ) : null}

      {composerState?.phase === 'editing' || composerState?.phase === 'submitting' ? (
        <FeedbackComposerDialog
          draft={composerState.draft}
          error={composerState.phase === 'editing' ? composerState.error : null}
          submitting={composerState.phase === 'submitting'}
          t={t}
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
          t={t}
          onDiscard={confirmDiscard}
        />
      ) : null}

      {submissionReceipt ? (
        <div className={styles.statusNotice} role="status">
          <p>{t('feedback.submission.received')}</p>
          <a href={`${submissionReceipt.statusPath}#${submissionReceipt.statusToken}`}>
            {t('feedback.submission.statusLink')}
          </a>
          <p>{t('feedback.submission.saveLink')}</p>
        </div>
      ) : null}
    </section>
  );
}
