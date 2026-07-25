'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent
} from 'react';
import { PAYMENT_METHODS } from './donation-content';
import {
  paymentCardVisual,
  paymentRelativeOffset,
  wrapPaymentIndex
} from './payment-model';
import { QrDialog } from './QrDialog';
import styles from './donation.module.css';

export interface DonationChapterProps {
  interactive: boolean;
}

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
const DONATION_TITLE = '助力开发，你便也是我不可或缺的参与者';

function getPaymentCardStyle(
  index: number,
  activeIndex: number
): PaymentCardStyle {
  const offset = paymentRelativeOffset(
    index,
    activeIndex,
    PAYMENT_METHODS.length
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
export function DonationChapter({ interactive }: DonationChapterProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [openMethod, setOpenMethod] = useState<
    (typeof PAYMENT_METHODS)[number] | null
  >(null);
  const pointerDragRef = useRef<PaymentPointerDrag | null>(null);
  const suppressClickRef = useRef(false);
  const suppressClickTimeoutRef = useRef<number | null>(null);
  const closeDialog = useCallback(() => setOpenMethod(null), []);

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
      PAYMENT_METHODS.length
    ));
  };

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();

    if (!interactive || event.deltaY === 0) return;
    selectRelativePayment(event.deltaY > 0 ? 1 : -1);
  };

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
      event.currentTarget.blur();
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
    >
      <h2 className={styles.donationTitle}>{DONATION_TITLE}</h2>

      <div
        className={styles.paymentRoller}
        data-input-scope="local"
        tabIndex={interactive ? 0 : -1}
        role="group"
        aria-label="选择付款方式"
        onWheel={handleWheel}
        onKeyDown={handleKeyDown}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishPointerDrag}
        onPointerCancel={finishPointerDrag}
      >
        <div className={styles.paymentDeck}>
          {PAYMENT_METHODS.map((method, index) => {
            const offset = paymentRelativeOffset(
              index,
              activeIndex,
              PAYMENT_METHODS.length
            );
            const isActive = offset === 0;

            return (
              <button
                key={method.id}
                className={styles.paymentCard}
                type="button"
                aria-label={
                  isActive
                    ? `打开${method.name}付款码`
                    : `选择${method.name}付款方式`
                }
                aria-pressed={isActive}
                disabled={!interactive}
                tabIndex={interactive ? 0 : -1}
                data-payment-id={method.id}
                data-active={isActive}
                style={getPaymentCardStyle(index, activeIndex)}
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
                <span className={styles.paymentMeta}>付款方式</span>
              </button>
            );
          })}
        </div>
      </div>

      {openMethod ? (
        <QrDialog method={openMethod} onClose={closeDialog} />
      ) : null}
    </section>
  );
}
