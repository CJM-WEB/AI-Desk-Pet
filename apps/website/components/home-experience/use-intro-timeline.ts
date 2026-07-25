'use client';

import { gsap } from 'gsap';
import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { EXPERIENCE_CONFIG } from './config';
import type { ExperiencePhase } from './types';
import { isIntroPhase } from './use-experience-controller';

interface IntroTimelineRefs {
  scope: RefObject<HTMLElement | null>;
  overlay: RefObject<HTMLDivElement | null>;
  brand: RefObject<HTMLDivElement | null>;
  wordmark: RefObject<HTMLHeadingElement | null>;
  drawPaths: RefObject<SVGPathElement[]>;
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
    for (const path of refs.drawPaths.current) {
      path.style.strokeDasharray = '1';
      path.style.strokeDashoffset = '0';
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
    const paths = refs.drawPaths.current;

    if (!scope || !overlay || !brand || !wordmark || paths.length === 0) {
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
          .set(paths, { strokeDasharray: 1, strokeDashoffset: 1 })
          .set(wordmark, { opacity: 0, letterSpacing: '0.28em' })
          .to(paths, {
            strokeDashoffset: 0,
            duration: EXPERIENCE_CONFIG.intro.drawSeconds,
            stagger: 0.12,
            onComplete: () => {
              if (!suppressCallbacksRef.current) {
                callbacksRef.current.onDrawingDone();
              }
            }
          })
          .to(brand, { scale: 1.08, duration: 0.18 })
          .to(brand, { scale: 0.72, duration: 0.62, ease: 'back.out(1.8)' })
          .to(overlay, {
            backgroundColor: EXPERIENCE_CONFIG.colors.background,
            duration: EXPERIENCE_CONFIG.intro.settleSeconds
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
