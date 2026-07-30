'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent
} from 'react';
import { createPaymentMethods } from './donation-content';
import type { PaymentMethod } from './donation-content';
import {
  paymentCardVisual,
  paymentRelativeOffset,
  wrapPaymentIndex
} from './payment-model';
import { QrDialog } from './QrDialog';
import type { ChapterRuntimeProps } from '../types';
import { PointerTiltText } from '../visual/PointerTiltText';
import { interpolateMessage, useI18n } from '../../i18n/I18nProvider';
import type { Translate } from '../../i18n/i18n-types';
import styles from './donation.module.css';

export type DonationChapterProps = ChapterRuntimeProps;

type PaymentCardStyle = CSSProperties & {
  '--payment-opacity': number;
  '--payment-scale': number;
  '--payment-translate-y': string;
};

type PaymentPointerDrag = {
  pointerId: number;
  startY: number;
  switched: boolean;
};

const PAYMENT_DRAG_THRESHOLD_PX = 40;
type DonationPointer = {
  x: number;
  y: number;
};

type DonationViewport = {
  width: number;
  height: number;
};

function getPaymentCardStyle(
  index: number,
  activeIndex: number,
  paymentCount: number
): PaymentCardStyle {
  const offset = paymentRelativeOffset(
    index,
    activeIndex,
    paymentCount
  );
  const visual = paymentCardVisual(offset);

  return {
    '--payment-opacity': visual.opacity,
    '--payment-scale': visual.scale,
    '--payment-translate-y': `${visual.translateYPercent}%`,
    zIndex: visual.zIndex
  };
}

/**
 * 以配置驱动支付滚筒，并把付款码展示隔离到根级对话框。
 */
export function DonationChapter({
  interactive,
  isPaused = false,
  reducedMotion = false,
  staticFallback = false
}: DonationChapterProps) {
  const { t: rawTranslate } = useI18n();
  const t = useCallback<Translate>((key, values) => (
    interpolateMessage(rawTranslate(key), values)
  ), [rawTranslate]);
  const paymentMethods = useMemo(() => createPaymentMethods(t), [t]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [openMethod, setOpenMethod] = useState<PaymentMethod | null>(null);
  const [pointer, setPointer] = useState<DonationPointer>({ x: 0, y: 0 });
  const [viewport, setViewport] = useState<DonationViewport>({
    width: 0,
    height: 0
  });
  const paymentRollerRef = useRef<HTMLDivElement | null>(null);
  const pointerDragRef = useRef<PaymentPointerDrag | null>(null);
  const suppressClickRef = useRef(false);
  const suppressClickTimeoutRef = useRef<number | null>(null);
  const closeDialog = useCallback(() => setOpenMethod(null), []);
  const motionDisabled = reducedMotion || staticFallback || isPaused;

  useEffect(() => {
    if (!interactive || motionDisabled) return;

    const syncViewport = () => {
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    };
    const handlePointerMove = (event: PointerEvent) => {
      setPointer({ x: event.clientX, y: event.clientY });
    };

    let resizeRegistered = false;
    let pointerRegistered = false;

    try {
      syncViewport();
      window.addEventListener('resize', syncViewport);
      resizeRegistered = true;
      window.addEventListener('pointermove', handlePointerMove, { passive: true });
      pointerRegistered = true;

      return () => {
        if (resizeRegistered) {
          window.removeEventListener('resize', syncViewport);
        }
        if (pointerRegistered) {
          window.removeEventListener('pointermove', handlePointerMove);
        }
      };
    } catch {
      // 任一监听注册失败都立即回滚，交由父级控制器完成统一降级。
      if (resizeRegistered) {
        window.removeEventListener('resize', syncViewport);
      }
      if (pointerRegistered) {
        window.removeEventListener('pointermove', handlePointerMove);
      }
    }
  }, [interactive, motionDisabled]);

  useEffect(() => {
    if (!interactive) {
      pointerDragRef.current = null;
      suppressClickRef.current = false;
      setOpenMethod(null);
    }

    return () => {
      if (suppressClickTimeoutRef.current !== null) {
        window.clearTimeout(suppressClickTimeoutRef.current);
        suppressClickTimeoutRef.current = null;
      }
    };
  }, [interactive]);

  const selectRelativePayment = (delta: number) => {
    setActiveIndex((current) => wrapPaymentIndex(
      current + delta,
      paymentMethods.length
    ));
  };

  useEffect(() => {
    const roller = paymentRollerRef.current;
    if (!roller) return;

    // 原生非 passive 监听保证滚筒输入不会继续交给外层章节控制器。
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (!interactive || event.deltaY === 0) return;
      selectRelativePayment(event.deltaY > 0 ? 1 : -1);
    };

    roller.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      roller.removeEventListener('wheel', handleWheel);
    };
  }, [interactive]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const direction = event.key === 'ArrowDown' || event.key === 'ArrowRight'
      ? 1
      : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
        ? -1
        : 0;

    if (direction !== 0) {
      event.preventDefault();
      event.stopPropagation();
      if (interactive) selectRelativePayment(direction);
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      const focusedElement = event.currentTarget.ownerDocument.activeElement;
      if (
        focusedElement instanceof HTMLElement
        && event.currentTarget.contains(focusedElement)
      ) {
        focusedElement.blur();
        return;
      }

      if (event.target instanceof HTMLElement) {
        event.target.blur();
      }
    }
  };

  const handlePointerDown = (
    event: ReactPointerEvent<HTMLDivElement>
  ) => {
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
      // 浏览器可能尚未开放指针捕获，局部状态仍可正常结束。
    }
  };

  const handlePointerMove = (
    event: ReactPointerEvent<HTMLDivElement>
  ) => {
    const drag = pointerDragRef.current;
    if (!drag) return;

    event.preventDefault();
    event.stopPropagation();
    if (drag.pointerId !== event.pointerId || drag.switched) return;

    const deltaY = event.clientY - drag.startY;
    if (Math.abs(deltaY) <= PAYMENT_DRAG_THRESHOLD_PX) return;

    drag.switched = true;
    suppressClickRef.current = true;
    selectRelativePayment(deltaY < 0 ? 1 : -1);
  };

  const finishPointerDrag = (
    event: ReactPointerEvent<HTMLDivElement>
  ) => {
    const drag = pointerDragRef.current;
    if (!drag) return;

    event.preventDefault();
    event.stopPropagation();
    if (drag.pointerId !== event.pointerId) return;
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
      // pointercancel 发生时浏览器可能已经自动释放捕获。
    }
  };

  return (
    <section
      className={styles.donationChapter}
      data-testid="donation-chapter"
      data-dialog-open={openMethod !== null}
      data-paused={isPaused}
      data-reduced-motion={reducedMotion}
      data-static-fallback={staticFallback}
      data-motion-disabled={motionDisabled}
    >
      <h2 className={styles.donationTitle}>
        <PointerTiltText
          pointer={pointer}
          viewport={viewport}
          disabled={motionDisabled || viewport.width <= 760}
        >
          {t('donation.title')}
        </PointerTiltText>
      </h2>

      <div
        ref={paymentRollerRef}
        className={styles.paymentRoller}
        data-testid="payment-roller"
        data-active-payment={paymentMethods[activeIndex]?.id ?? ''}
        data-input-scope="local"
        tabIndex={interactive ? 0 : -1}
        role="group"
        aria-label={t('donation.group')}
        onKeyDown={handleKeyDown}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishPointerDrag}
        onPointerCancel={finishPointerDrag}
      >
        <div className={styles.paymentDeck}>
          {paymentMethods.map((method, index) => {
            const offset = paymentRelativeOffset(
              index,
              activeIndex,
              paymentMethods.length
            );
            const isActive = offset === 0;

            return (
              <button
                key={method.id}
                className={styles.paymentCard}
                type="button"
                aria-label={
                  isActive
                    ? t('donation.open', { method: method.name })
                    : t('donation.select', { method: method.name })
                }
                aria-pressed={isActive}
                disabled={!interactive}
                tabIndex={interactive ? 0 : -1}
                data-payment-id={method.id}
                data-active={isActive}
                style={getPaymentCardStyle(index, activeIndex, paymentMethods.length)}
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
                  if (isActive) {
                    setOpenMethod(method);
                    return;
                  }
                  setActiveIndex(index);
                }}
              >
                <span className={styles.paymentName}>{method.name}</span>
                <span className={styles.paymentMeta}>{t('donation.method')}</span>
              </button>
            );
          })}
        </div>
      </div>

      {openMethod ? (
        <QrDialog
          method={openMethod}
          isPaused={isPaused}
          motionDisabled={motionDisabled}
          onClose={closeDialog}
        />
      ) : null}
    </section>
  );
}
