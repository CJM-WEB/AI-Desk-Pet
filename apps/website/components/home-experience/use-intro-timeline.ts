'use client';

import { gsap } from 'gsap';
import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { isIntroPhase } from '../website-experience/chapter-model';
import { EXPERIENCE_CONFIG } from './config';
import { getMagneticLockAtSeconds } from './magnetic-intro-model';
import type { ExperiencePhase } from './types';

interface IntroTimelineRefs {
  scope: RefObject<HTMLElement | null>;
  overlay: RefObject<HTMLDivElement | null>;
  brand: RefObject<HTMLDivElement | null>;
  wordmark: RefObject<HTMLHeadingElement | null>;
  finalLogo: RefObject<HTMLImageElement | null>;
  magneticPieces: RefObject<HTMLImageElement[]>;
}

interface UseIntroTimelineInput {
  phase: ExperiencePhase;
  reducedMotion: boolean;
  isPaused: boolean;
  refs: IntroTimelineRefs;
  onDrawingDone: () => void;
  onSettled: () => void;
}

/**
 * 管理开场动画的生命周期，所有动画写入都限定在页面体验作用域内。
 */
export function useIntroTimeline({
  phase,
  reducedMotion,
  isPaused,
  refs,
  onDrawingDone,
  onSettled
}: UseIntroTimelineInput): { skip: () => void } {
  const contextRef = useRef<gsap.Context | null>(null);
  const timelineRef = useRef<gsap.core.Timeline | null>(null);
  const settledRef = useRef(false);
  const suppressCallbacksRef = useRef(false);
  const callbacksRef = useRef({ onDrawingDone, onSettled });

  callbacksRef.current = { onDrawingDone, onSettled };

  const killTimeline = useCallback(() => {
    timelineRef.current?.kill();
    timelineRef.current = null;
  }, []);

  const revertContext = useCallback(() => {
    killTimeline();
    const context = contextRef.current;
    contextRef.current = null;
    context?.revert();
  }, [killTimeline]);

  const applyStableVisualState = useCallback(() => {
    const overlay = refs.overlay.current;
    const brand = refs.brand.current;
    const wordmark = refs.wordmark.current;
    const finalLogo = refs.finalLogo.current;

    if (overlay) {
      overlay.style.display = '';
      overlay.style.backgroundColor = EXPERIENCE_CONFIG.colors.background;
    }
    if (brand) {
      brand.style.transform = 'scale(0.72)';
    }
    if (wordmark) {
      wordmark.style.opacity = '1';
      wordmark.style.letterSpacing = '0em';
    }
    if (finalLogo) {
      finalLogo.style.filter = '';
      finalLogo.style.opacity = '1';
      finalLogo.style.visibility = 'visible';
    }
    for (const piece of refs.magneticPieces.current) {
      piece.style.opacity = '0';
      piece.style.visibility = 'hidden';
      piece.style.transform = '';
    }
  }, [refs]);

  const notifySettled = useCallback(() => {
    if (settledRef.current) {
      return;
    }

    settledRef.current = true;
    callbacksRef.current.onSettled();
  }, []);

  const finishWithoutMotion = useCallback(() => {
    if (settledRef.current) {
      return;
    }

    try {
      revertContext();
    } catch {
      // 清理异常不能阻止静态终态恢复。
    } finally {
      applyStableVisualState();
      callbacksRef.current.onDrawingDone();
      notifySettled();
    }
  }, [applyStableVisualState, notifySettled, revertContext]);

  useEffect(() => {
    if (reducedMotion && isIntroPhase(phase)) {
      finishWithoutMotion();
      return;
    }

    if (
      phase !== 'drawing'
      || settledRef.current
      || contextRef.current
    ) {
      return;
    }

    const scope = refs.scope.current;
    const overlay = refs.overlay.current;
    const brand = refs.brand.current;
    const wordmark = refs.wordmark.current;
    const finalLogo = refs.finalLogo.current;
    const pieces = refs.magneticPieces.current;
    const magnetic = EXPERIENCE_CONFIG.intro.magnetic;

    if (
      !scope
      || !overlay
      || !brand
      || !wordmark
      || !finalLogo
      || pieces.length !== magnetic.pieces.length
    ) {
      finishWithoutMotion();
      return;
    }

    suppressCallbacksRef.current = false;
    const partialContextRef: { current: gsap.Context | null } = {
      current: null
    };

    try {
      const context = gsap.context((createdContext) => {
        partialContextRef.current = createdContext;
        contextRef.current = createdContext;

        const timeline = gsap.timeline({
          paused: isPaused,
          onComplete: () => {
            killTimeline();
            notifySettled();
          }
        });
        timelineRef.current = timeline;

        timeline
          .set(finalLogo, { autoAlpha: 0, filter: 'invert(1)' })
          .set(wordmark, { opacity: 0, letterSpacing: '0.28em' })

        magnetic.pieces.forEach((pieceConfig, index) => {
          const piece = pieces[index]!;
          const startsAt = magnetic.blackHoldSeconds
            + magnetic.firstPieceDelaySeconds
            + (index * magnetic.pieceStaggerSeconds);

          timeline.fromTo(
            piece,
            {
              autoAlpha: 0,
              x: pieceConfig.from.x,
              y: pieceConfig.from.y,
              rotation: pieceConfig.from.rotation,
              scale: pieceConfig.from.scale
            },
            {
              autoAlpha: 1,
              x: 0,
              y: 0,
              rotation: 0,
              scale: 1,
              duration: magnetic.pieceSeconds,
              ease: magnetic.ease
            },
            startsAt
          );
        });

        const lockAt = getMagneticLockAtSeconds(magnetic);
        timeline
          .to(finalLogo, {
            autoAlpha: 1,
            duration: magnetic.lockSeconds,
            ease: 'none'
          }, lockAt)
          .to(pieces, {
            autoAlpha: 0,
            duration: magnetic.lockSeconds,
            ease: 'none',
            onComplete: () => {
              if (!suppressCallbacksRef.current) {
                callbacksRef.current.onDrawingDone();
              }
            }
          }, lockAt)
          .to(brand, { scale: 1.08, duration: 0.18 })
          .to(brand, { scale: 0.72, duration: 0.62, ease: 'back.out(1.8)' })
          .to(overlay, {
            backgroundColor: EXPERIENCE_CONFIG.colors.background,
            duration: EXPERIENCE_CONFIG.intro.settleSeconds
          }, '<')
          .to(finalLogo, {
            filter: 'invert(0)',
            duration: EXPERIENCE_CONFIG.intro.settleSeconds,
            ease: 'none',
            onComplete: () => {
              finalLogo.style.filter = '';
            }
          }, '<')
          .to(wordmark, {
            opacity: 1,
            letterSpacing: '0em',
            duration: 0.6
          }, '<');
      }, scope);

      contextRef.current = context;
    } catch {
      try {
        killTimeline();
        partialContextRef.current?.revert();
      } catch {
        // 撤销失败时仍继续写入静态终态，避免页面停留在部分初始化状态。
      } finally {
        contextRef.current = null;
        applyStableVisualState();
        callbacksRef.current.onDrawingDone();
        notifySettled();
      }
    }
  }, [
    applyStableVisualState,
    finishWithoutMotion,
    isPaused,
    killTimeline,
    notifySettled,
    phase,
    reducedMotion,
    refs
  ]);

  useEffect(() => {
    if (isPaused) {
      timelineRef.current?.pause();
    } else {
      timelineRef.current?.resume();
    }
  }, [isPaused]);

  useEffect(() => revertContext, [revertContext]);

  const skip = useCallback(() => {
    if (settledRef.current) {
      return;
    }

    suppressCallbacksRef.current = true;
    const timeline = timelineRef.current;
    try {
      timeline?.progress(1, true).pause();
    } catch {
      // 推进末帧失败时仍由静态终态兜底。
    }
    try {
      killTimeline();
    } catch {
      // 清理失败不能阻止最终视觉状态写入。
    } finally {
      applyStableVisualState();
      notifySettled();
    }
  }, [applyStableVisualState, killTimeline, notifySettled]);

  return { skip };
}
