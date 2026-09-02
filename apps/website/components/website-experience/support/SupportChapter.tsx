'use client';

import type { SubmissionReceipt } from '@myself/shared-types';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, WheelEvent as ReactWheelEvent } from 'react';
import type { CSSProperties } from 'react';
import { ApiClient } from '../../../lib/api-client';
import type { PointerPoint } from '../../home-experience/types';
import { LIQUID_GLASS_SUPPORT_SELECTION_EVENT } from '../../home-experience/LiquidGlassHome';
import { interpolateMessage, useI18n } from '../../i18n/I18nProvider';
import type { Translate } from '../../i18n/i18n-types';
import { createPaymentMethods, type PaymentMethod } from '../donation/donation-content';
import { QrDialog } from '../donation/QrDialog';
import {
  paymentCardVisual,
  paymentDepthIndex,
  paymentRelativeOffset,
  wrapPaymentIndex
} from '../donation/payment-model';
import { DiscardDraftDialog } from '../feedback/DiscardDraftDialog';
import { FeedbackComposerDialog, type FeedbackDraft } from '../feedback/FeedbackComposerDialog';
import { FeedbackListDialog } from '../feedback/FeedbackListDialog';
import { CloudFeedbackRepository } from '../feedback/cloud-feedback-repository';
import { validateDraft } from '../feedback/feedback-model';
import type { FeedbackKind, FeedbackRepository } from '../feedback/feedback-types';
import type { ChapterRuntimeProps } from '../types';
import { PointerTiltText } from '../visual/PointerTiltText';
import styles from './support.module.css';

export interface SupportChapterProps extends ChapterRuntimeProps {
  repository?: FeedbackRepository;
}

type ComposerState =
  | { phase: 'editing'; draft: FeedbackDraft; error: string | null }
  | { phase: 'confirm-discard'; draft: FeedbackDraft }
  | { phase: 'submitting'; draft: FeedbackDraft };

type FeedbackAction = {
  id: 'suggestion' | 'feedback' | 'create';
  label: string;
  kind?: FeedbackKind;
};

type SupportActionGroup = 'feedback' | 'payment';

const EMPTY_DRAFT: FeedbackDraft = {
  kind: 'feedback',
  authorName: '',
  content: ''
};

const INITIAL_POINTER: PointerPoint = { x: 0, y: 0 };

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

/**
 * 合并反馈与支持业务；DOM 只承载语义和点击热区，六块玻璃及文字由共享 WebGL 绘制。
 */
export function SupportChapter({
  interactive,
  transitionProgress = 4,
  isPaused = false,
  reducedMotion = false,
  staticFallback = false,
  repository: injectedRepository
}: SupportChapterProps) {
  const { locale, t: rawTranslate } = useI18n();
  const t = useCallback<Translate>((key, values) => (
    interpolateMessage(rawTranslate(key), values)
  ), [rawTranslate]);
  const feedbackActions = useMemo<readonly FeedbackAction[]>(() => [
    { id: 'suggestion', label: t('feedback.action.suggestion'), kind: 'suggestion' },
    { id: 'feedback', label: t('feedback.action.feedback'), kind: 'feedback' },
    { id: 'create', label: t('feedback.action.create') }
  ], [t]);
  const paymentMethods = useMemo(() => createPaymentMethods(t), [t]);
  const repositoryRef = useRef<FeedbackRepository | null>(null);
  if (repositoryRef.current === null) {
    repositoryRef.current = injectedRepository ?? new CloudFeedbackRepository(
      new ApiClient(process.env.NEXT_PUBLIC_API_BASE_URL ?? '/api/v1')
    );
  }
  const repository = repositoryRef.current;
  const [activeFeedbackIndex, setActiveFeedbackIndex] = useState(0);
  const [activePaymentIndex, setActivePaymentIndex] = useState(0);
  const [pointer, setPointer] = useState<PointerPoint>(INITIAL_POINTER);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const pointerFrameRef = useRef<number | null>(null);
  const pointerTargetRef = useRef<PointerPoint>(INITIAL_POINTER);
  const [openKind, setOpenKind] = useState<FeedbackKind | null>(null);
  const [openMethod, setOpenMethod] = useState<PaymentMethod | null>(null);
  const [composerState, setComposerState] = useState<ComposerState | null>(null);
  const [submissionReceipt, setSubmissionReceipt] = useState<SubmissionReceipt | null>(null);
  const createTriggerRef = useRef<HTMLButtonElement | null>(null);
  const restoreCreateFocusRef = useRef(false);
  const submittedDraftRef = useRef<FeedbackDraft | null>(null);
  const feedbackGroupRef = useRef<HTMLDivElement | null>(null);
  const paymentGroupRef = useRef<HTMLDivElement | null>(null);
  const pendingKeyboardFocusRef = useRef<SupportActionGroup | null>(null);
  const motionDisabled = reducedMotion || staticFallback || isPaused;
  const supportProgress = Math.min(1, Math.max(0, transitionProgress - 3));
  const chapterStyle = {
    '--support-title-top-y': `${(1 - supportProgress) * -72}vh`,
    '--support-title-bottom-y': `${(1 - supportProgress) * 72}vh`
  } as CSSProperties;

  useEffect(() => {
    window.dispatchEvent(new CustomEvent(LIQUID_GLASS_SUPPORT_SELECTION_EVENT, {
      detail: {
        feedbackIndex: activeFeedbackIndex,
        paymentIndex: activePaymentIndex
      }
    }));
  }, [activeFeedbackIndex, activePaymentIndex]);

  useEffect(() => {
    const syncViewport = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    const syncPointer = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse') return;
      pointerTargetRef.current = { x: event.clientX, y: event.clientY };
      if (pointerFrameRef.current !== null) return;
      pointerFrameRef.current = window.requestAnimationFrame(() => {
        pointerFrameRef.current = null;
        setPointer(pointerTargetRef.current);
      });
    };
    syncViewport();
    let resizeRegistered = false;
    let pointerRegistered = false;
    try {
      window.addEventListener('resize', syncViewport, { passive: true });
      resizeRegistered = true;
      window.addEventListener('pointermove', syncPointer, { passive: true });
      pointerRegistered = true;
    } catch {
      // 鼠标倾向属于渐进增强，监听失败时回滚已注册事件并保留章节核心交互。
      if (resizeRegistered) window.removeEventListener('resize', syncViewport);
      return;
    }
    return () => {
      if (resizeRegistered) window.removeEventListener('resize', syncViewport);
      if (pointerRegistered) window.removeEventListener('pointermove', syncPointer);
      if (pointerFrameRef.current !== null) window.cancelAnimationFrame(pointerFrameRef.current);
    };
  }, []);

  useEffect(() => {
    const pendingGroup = pendingKeyboardFocusRef.current;
    if (pendingGroup === null) return;
    pendingKeyboardFocusRef.current = null;
    const group = pendingGroup === 'feedback'
      ? feedbackGroupRef.current
      : paymentGroupRef.current;
    group?.querySelector<HTMLButtonElement>('[data-depth-index="0"]')?.focus();
  }, [activeFeedbackIndex, activePaymentIndex]);

  useEffect(() => {
    if (!interactive) return;
    void Promise.all([
      repository.refresh('feedback'),
      repository.refresh('suggestion')
    ]).catch(() => undefined);
  }, [interactive, repository]);

  useEffect(() => {
    if (interactive) return;
    setOpenKind(null);
    setOpenMethod(null);
    setComposerState(null);
  }, [interactive]);

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
        error: draftErrorMessage(validation.code, rawTranslate)
      });
      return;
    }
    submittedDraftRef.current = null;
    setComposerState({ phase: 'submitting', draft: composerState.draft });
  }, [composerState, rawTranslate]);

  useEffect(() => {
    if (!composerState || composerState.phase !== 'submitting') return;
    if (submittedDraftRef.current === composerState.draft) return;
    submittedDraftRef.current = composerState.draft;
    const validation = validateDraft(composerState.draft);
    if (!validation.valid) {
      setComposerState({
        phase: 'editing',
        draft: composerState.draft,
        error: draftErrorMessage(validation.code, rawTranslate)
      });
      return;
    }
    void (async () => {
      try {
        const receipt = await repository.create(validation.value);
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
  }, [composerState, rawTranslate, repository, t]);

  useEffect(() => {
    if (!composerState && restoreCreateFocusRef.current) {
      restoreCreateFocusRef.current = false;
      createTriggerRef.current?.focus();
    }
  }, [composerState]);

  const selectFeedbackAction = (action: FeedbackAction, index: number) => {
    if (!interactive) return;
    if (index !== activeFeedbackIndex) {
      setActiveFeedbackIndex(index);
      return;
    }
    setActiveFeedbackIndex(index);
    if (action.kind) {
      setOpenKind(action.kind);
      return;
    }
    setSubmissionReceipt(null);
    setComposerState({ phase: 'editing', draft: { ...EMPTY_DRAFT }, error: null });
  };

  const selectPaymentMethod = (method: PaymentMethod, index: number) => {
    if (!interactive) return;
    if (index !== activePaymentIndex) {
      setActivePaymentIndex(index);
      return;
    }
    setOpenMethod(method);
  };

  const cycleFeedback = (delta: number) => {
    setActiveFeedbackIndex((current) => wrapPaymentIndex(
      current + delta,
      feedbackActions.length
    ));
  };

  const cyclePayment = (delta: number) => {
    setActivePaymentIndex((current) => wrapPaymentIndex(
      current + delta,
      paymentMethods.length
    ));
  };

  const handleGroupKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
    cycle: (delta: number) => void,
    group: SupportActionGroup
  ) => {
    const delta = event.key === 'ArrowDown' || event.key === 'ArrowRight'
      ? 1
      : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
        ? -1
        : 0;
    if (delta === 0 || !interactive) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.target instanceof HTMLButtonElement) {
      pendingKeyboardFocusRef.current = group;
    }
    cycle(delta);
  };

  const handleGroupWheel = (
    event: ReactWheelEvent<HTMLDivElement>,
    cycle: (delta: number) => void
  ) => {
    if (!interactive || event.deltaY === 0) return;
    // React 的 wheel 委托监听可能为 passive；仅阻止冒泡即可隔离章节级滚轮。
    event.stopPropagation();
    cycle(event.deltaY > 0 ? 1 : -1);
  };

  return (
    <section
      className={styles.supportChapter}
      data-testid="support-chapter"
      data-dialog-open={openKind !== null || openMethod !== null || composerState !== null}
      data-motion-disabled={motionDisabled}
      data-static-presentation={reducedMotion || staticFallback}
      data-paused={isPaused}
      style={chapterStyle}
    >
      <h2 className={styles.srOnly} data-layout-ignore>{t('feedback.title')}</h2>
      <PointerTiltText
        pointer={pointer}
        viewport={viewport}
        disabled={motionDisabled}
        className={`${styles.headlineTilt} ${styles.feedbackHeadlineTilt}`}
      >
        <p className={`${styles.supportHeadline} ${styles.feedbackHeadline}`} aria-hidden="true">
          {t('feedback.title')}
        </p>
      </PointerTiltText>
      <PointerTiltText
        pointer={pointer}
        viewport={viewport}
        disabled={motionDisabled}
        className={`${styles.headlineTilt} ${styles.donationHeadlineTilt}`}
      >
        <p className={`${styles.supportHeadline} ${styles.donationHeadline}`} aria-hidden="true">
          {t('donation.title')}
        </p>
      </PointerTiltText>

      <div
        ref={feedbackGroupRef}
        className={`${styles.actionGroup} ${styles.feedbackGroup}`}
        data-input-scope="local"
        data-active-action={feedbackActions[activeFeedbackIndex]?.id}
        role="group"
        aria-label={t('feedback.group')}
        tabIndex={interactive ? 0 : -1}
        onKeyDown={(event) => handleGroupKeyDown(event, cycleFeedback, 'feedback')}
        onWheel={(event) => handleGroupWheel(event, cycleFeedback)}
      >
        {feedbackActions.map((action, index) => {
          const offset = paymentRelativeOffset(index, activeFeedbackIndex, feedbackActions.length);
          const depthIndex = paymentDepthIndex(index, activeFeedbackIndex, feedbackActions.length);
          const visual = paymentCardVisual(offset, depthIndex);
          return (
            <button
              key={action.id}
              ref={action.id === 'create' ? createTriggerRef : undefined}
              className={styles.glassButton}
              type="button"
              aria-label={action.kind
                ? t('feedback.action.view', { label: action.label })
                : action.label}
              aria-pressed={visual.activatable}
              data-action-id={action.id}
              data-active={visual.activatable}
              data-depth-index={depthIndex}
              data-blur-px={visual.blurPx}
              disabled={!interactive}
              tabIndex={interactive && visual.activatable ? 0 : -1}
              style={{
                '--support-button-offset': `${visual.translateYPercent}%`,
                '--support-button-scale': visual.scale,
                '--support-button-opacity': visual.opacity,
                '--support-button-blur': `${visual.blurPx}px`,
                zIndex: visual.zIndex
              } as CSSProperties}
              onClick={() => selectFeedbackAction(action, index)}
            >
              <span>{action.label}</span>
            </button>
          );
        })}
      </div>

      <div
        ref={paymentGroupRef}
        className={`${styles.actionGroup} ${styles.paymentGroup}`}
        data-testid="payment-roller"
        data-input-scope="local"
        data-active-payment={paymentMethods[activePaymentIndex]?.id ?? ''}
        role="group"
        aria-label={t('donation.group')}
        tabIndex={interactive ? 0 : -1}
        onKeyDown={(event) => handleGroupKeyDown(event, cyclePayment, 'payment')}
        onWheel={(event) => handleGroupWheel(event, cyclePayment)}
      >
        {paymentMethods.map((method, index) => {
          const offset = paymentRelativeOffset(index, activePaymentIndex, paymentMethods.length);
          const depthIndex = paymentDepthIndex(index, activePaymentIndex, paymentMethods.length);
          const visual = paymentCardVisual(offset, depthIndex);
          return (
            <button
              key={method.id}
              className={styles.glassButton}
              type="button"
              aria-label={t('donation.open', { method: method.name })}
              aria-pressed={visual.activatable}
              data-payment-id={method.id}
              data-active={visual.activatable}
              data-depth-index={depthIndex}
              data-blur-px={visual.blurPx}
              disabled={!interactive}
              tabIndex={interactive && visual.activatable ? 0 : -1}
              style={{
                '--support-button-offset': `${visual.translateYPercent}%`,
                '--support-button-scale': visual.scale,
                '--support-button-opacity': visual.opacity,
                '--support-button-blur': `${visual.blurPx}px`,
                zIndex: visual.zIndex
              } as CSSProperties}
              onClick={() => selectPaymentMethod(method, index)}
            >
              <span>{method.name}</span>
            </button>
          );
        })}
      </div>

      {openKind ? (
        <FeedbackListDialog
          kind={openKind}
          repository={repository}
          t={t}
          locale={locale}
          onClose={() => setOpenKind(null)}
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
          onDiscard={() => {
            restoreCreateFocusRef.current = true;
            setComposerState(null);
          }}
        />
      ) : null}

      {openMethod ? (
        <QrDialog
          method={openMethod}
          isPaused={isPaused}
          motionDisabled={motionDisabled}
          onClose={() => setOpenMethod(null)}
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
