'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { EXPERIENCE_CONFIG } from '../home-experience/config';
import type { ExperiencePhase } from '../home-experience/types';
import {
  accumulateWheelUnlock,
  applyChapterDelta,
  clampChapterProgress,
  dampChapterProgress,
  hasChapterProgressSettled,
  interpolateChapterSnapProgress,
  normalizeWheelDelta,
  snapChapterProgress
} from './chapter-model';
import type { WheelGestureState } from './chapter-model';

export interface WebsiteControllerOptions {
  chapterCount: number;
  staticFallback?: boolean;
  onInitializationError?: () => void;
}

export interface WebsiteControllerResult {
  phase: ExperiencePhase;
  progress: number;
  settledIndex: number;
  isChapterTransitioning: boolean;
  isPaused: boolean;
  prefersReducedMotion: boolean;
  initializationFailed: boolean;
  goToAdjacent: (direction: -1 | 1) => void;
}

type ChapterTouchGesture = {
  pointerId: number;
  startY: number;
};

type WheelMode = 'resting' | 'locked' | 'arming' | 'tracking';

export function isLocalInputElement(
  target: { closest: (selector: string) => unknown } | null
): boolean {
  return typeof target?.closest === 'function'
    && Boolean(target.closest('[data-input-scope="local"]'));
}

export function calculateSwipeDelta(startY: number, currentY: number): -1 | 0 | 1 {
  const distance = startY - currentY;
  if (Math.abs(distance) < 48) return 0;
  return distance > 0 ? 1 : -1;
}

/**
 * 统一管理官网章节输入：滚轮先改变目标，显示进度再逐帧追赶并吸附。
 */
export function useWebsiteController(
  options: WebsiteControllerOptions
): WebsiteControllerResult {
  const phase: ExperiencePhase = 'interactive';
  const [progress, setProgress] = useState(0);
  const [settledIndex, setSettledIndex] = useState(0);
  const [isChapterTransitioning, setIsChapterTransitioning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const [initializationFailed, setInitializationFailed] = useState(false);
  const progressRef = useRef(0);
  const targetProgressRef = useRef(0);
  const settledIndexRef = useRef(0);
  const prefersReducedMotionRef = useRef(false);
  const staticFallbackRef = useRef(Boolean(options.staticFallback));
  const isPausedRef = useRef(false);
  const isDocumentHiddenRef = useRef(false);
  const isWindowBlurredRef = useRef(false);
  const progressFrameRef = useRef<number | null>(null);
  const lastFrameAtRef = useRef<number | null>(null);
  const wheelModeRef = useRef<WheelMode>('resting');
  const wheelGestureRef = useRef<WheelGestureState>({ direction: 0, accumulated: 0 });
  const wheelIdleTimerRef = useRef<number | null>(null);
  const wheelLockTimerRef = useRef<number | null>(null);
  const lastWheelAtRef = useRef<number | null>(null);
  const touchGestureRef = useRef<ChapterTouchGesture | null>(null);
  const onInitializationErrorRef = useRef(options.onInitializationError);

  onInitializationErrorRef.current = options.onInitializationError;

  const chapterCount = Math.max(1, options.chapterCount);

  const normalizePausedState = useCallback(() => {
    isDocumentHiddenRef.current = false;
    isWindowBlurredRef.current = false;
    isPausedRef.current = false;
    setIsPaused(false);
  }, []);

  const notifyInitializationError = useCallback(() => {
    staticFallbackRef.current = true;
    normalizePausedState();
    setInitializationFailed(true);
    onInitializationErrorRef.current?.();
  }, [normalizePausedState]);

  const commitProgress = useCallback((next: number) => {
    const clamped = clampChapterProgress(next, chapterCount);
    progressRef.current = clamped;
    setProgress(clamped);
    return clamped;
  }, [chapterCount]);

  const commitSettledIndex = useCallback((next: number) => {
    const clamped = snapChapterProgress(next, chapterCount);
    settledIndexRef.current = clamped;
    setSettledIndex(clamped);
  }, [chapterCount]);

  const stopProgressFrame = useCallback(() => {
    if (progressFrameRef.current !== null) {
      window.cancelAnimationFrame(progressFrameRef.current);
      progressFrameRef.current = null;
    }
    lastFrameAtRef.current = null;
  }, []);

  const stopWheelIdleTimer = useCallback(() => {
    if (wheelIdleTimerRef.current !== null) {
      window.clearTimeout(wheelIdleTimerRef.current);
      wheelIdleTimerRef.current = null;
    }
  }, []);

  const stopWheelLockTimer = useCallback(() => {
    if (wheelLockTimerRef.current !== null) {
      window.clearTimeout(wheelLockTimerRef.current);
      wheelLockTimerRef.current = null;
    }
  }, []);

  const resetWheelGesture = useCallback(() => {
    wheelGestureRef.current = { direction: 0, accumulated: 0 };
  }, []);

  const armWheelAfterSilence = useCallback(() => {
    const lastWheelAt = lastWheelAtRef.current;
    const elapsed = lastWheelAt === null
      ? EXPERIENCE_CONFIG.progress.wheelIdleMs
      : performance.now() - lastWheelAt;
    const remaining = EXPERIENCE_CONFIG.progress.wheelIdleMs - elapsed;

    if (remaining > 0) {
      wheelLockTimerRef.current = window.setTimeout(
        armWheelAfterSilence,
        remaining
      );
      return;
    }

    wheelLockTimerRef.current = null;
    wheelModeRef.current = 'arming';
    resetWheelGesture();
  }, [resetWheelGesture]);

  const startWheelLock = useCallback(() => {
    stopWheelLockTimer();
    wheelModeRef.current = 'locked';
    wheelLockTimerRef.current = window.setTimeout(
      armWheelAfterSilence,
      EXPERIENCE_CONFIG.progress.wheelLockMs
    );
  }, [armWheelAfterSilence, stopWheelLockTimer]);

  const cancelProgressMotion = useCallback(() => {
    stopProgressFrame();
    setIsChapterTransitioning(false);
  }, [stopProgressFrame]);

  const startProgressFollow = useCallback(() => {
    if (progressFrameRef.current !== null) {
      return;
    }

    lastFrameAtRef.current = performance.now();
    const advance = (frameAt: number) => {
      if (isPausedRef.current) {
        progressFrameRef.current = null;
        lastFrameAtRef.current = null;
        return;
      }

      const lastFrameAt = lastFrameAtRef.current ?? frameAt;
      const next = dampChapterProgress(
        progressRef.current,
        targetProgressRef.current,
        frameAt - lastFrameAt,
        EXPERIENCE_CONFIG.progress.followTimeConstantMs,
        EXPERIENCE_CONFIG.progress.maxFrameDeltaMs
      );
      lastFrameAtRef.current = frameAt;

      if (hasChapterProgressSettled(
        next,
        targetProgressRef.current,
        EXPERIENCE_CONFIG.progress.settleEpsilon
      )) {
        commitProgress(targetProgressRef.current);
        progressFrameRef.current = null;
        lastFrameAtRef.current = null;
        return;
      }

      commitProgress(next);
      progressFrameRef.current = window.requestAnimationFrame(advance);
    };

    progressFrameRef.current = window.requestAnimationFrame(advance);
  }, [commitProgress]);

  const startSnap = useCallback((target: number) => {
    stopWheelIdleTimer();
    stopWheelLockTimer();
    stopProgressFrame();
    resetWheelGesture();
    wheelModeRef.current = 'locked';
    const clampedTarget = clampChapterProgress(target, chapterCount);
    targetProgressRef.current = clampedTarget;
    setIsChapterTransitioning(
      clampedTarget !== settledIndexRef.current
      || Math.abs(progressRef.current - clampedTarget) > 0.0001
    );

    if (staticFallbackRef.current || prefersReducedMotionRef.current) {
      commitProgress(clampedTarget);
      commitSettledIndex(clampedTarget);
      setIsChapterTransitioning(false);
      startWheelLock();
      return;
    }

    const from = progressRef.current;
    let startedAt: number | null = null;

    const advance = (frameAt: number) => {
      if (isPausedRef.current) {
        progressFrameRef.current = null;
        return;
      }

      startedAt ??= frameAt;
      const ratio = Math.min(1, (
        frameAt - startedAt
      ) / EXPERIENCE_CONFIG.progress.snapDurationMs);
      commitProgress(interpolateChapterSnapProgress(from, clampedTarget, ratio));

      if (ratio < 1) {
        progressFrameRef.current = window.requestAnimationFrame(advance);
        return;
      }

      commitProgress(clampedTarget);
      targetProgressRef.current = clampedTarget;
      commitSettledIndex(clampedTarget);
      progressFrameRef.current = null;
      lastFrameAtRef.current = null;
      setIsChapterTransitioning(false);
      startWheelLock();
    };

    progressFrameRef.current = window.requestAnimationFrame(advance);
  }, [
    chapterCount,
    commitProgress,
    commitSettledIndex,
    resetWheelGesture,
    startWheelLock,
    stopProgressFrame,
    stopWheelIdleTimer,
    stopWheelLockTimer
  ]);

  const goToAdjacent = useCallback((direction: -1 | 1) => {
    if (isPausedRef.current) {
      return;
    }

    const target = clampChapterProgress(settledIndexRef.current + direction, chapterCount);
    if (target === settledIndexRef.current) {
      // 边界键若在连续进度中触发，只回到当前章节，不推进越界目标。
      if (
        progressRef.current !== settledIndexRef.current
        || targetProgressRef.current !== settledIndexRef.current
      ) {
        startSnap(settledIndexRef.current);
      }
      return;
    }

    startSnap(target);
  }, [
    chapterCount,
    startSnap
  ]);

  useEffect(() => {
    if (!options.staticFallback) {
      return;
    }

    staticFallbackRef.current = true;
    normalizePausedState();
    cancelProgressMotion();
    stopWheelIdleTimer();
    stopWheelLockTimer();
    resetWheelGesture();
    wheelModeRef.current = 'resting';
    lastWheelAtRef.current = null;
    targetProgressRef.current = settledIndexRef.current;
    commitProgress(settledIndexRef.current);
  }, [
    cancelProgressMotion,
    commitProgress,
    normalizePausedState,
    options.staticFallback,
    resetWheelGesture,
    stopWheelIdleTimer,
    stopWheelLockTimer
  ]);

  useEffect(() => {
    if (options.staticFallback) {
      return;
    }

    let mediaQuery: MediaQueryList;
    const syncReducedMotion = () => {
      prefersReducedMotionRef.current = mediaQuery.matches;
      setPrefersReducedMotion(mediaQuery.matches);
    };

    try {
      mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
      syncReducedMotion();
      mediaQuery.addEventListener('change', syncReducedMotion);
    } catch {
      notifyInitializationError();
      return;
    }

    return () => {
      mediaQuery.removeEventListener('change', syncReducedMotion);
    };
  }, [notifyInitializationError, options.staticFallback]);

  useEffect(() => {
    if (staticFallbackRef.current || options.staticFallback) {
      return;
    }

    // 失焦和隐藏共享暂停状态，暂停时立即回收惯性并收敛到最近章节。
    const syncPausedState = () => {
      const nextPaused = isDocumentHiddenRef.current || isWindowBlurredRef.current;
      if (nextPaused === isPausedRef.current) {
        return;
      }

      isPausedRef.current = nextPaused;
      setIsPaused(nextPaused);

      if (nextPaused) {
        stopProgressFrame();
        stopWheelIdleTimer();
        stopWheelLockTimer();
        resetWheelGesture();
        wheelModeRef.current = 'resting';
        lastWheelAtRef.current = null;
        const nearest = snapChapterProgress(targetProgressRef.current, chapterCount);
        targetProgressRef.current = nearest;
        commitProgress(nearest);
        commitSettledIndex(nearest);
        setIsChapterTransitioning(false);
      }
    };
    const pause = () => {
      isWindowBlurredRef.current = true;
      syncPausedState();
    };
    const resume = () => {
      isWindowBlurredRef.current = false;
      syncPausedState();
    };
    const handleVisibilityChange = () => {
      isDocumentHiddenRef.current = document.visibilityState === 'hidden';
      syncPausedState();
    };
    const isLocalInput = (target: EventTarget | null) => isLocalInputElement(
      target as { closest: (selector: string) => unknown } | null
    );
    const handleWheel = (event: WheelEvent) => {
      if (isLocalInput(event.target) || isPausedRef.current) {
        return;
      }

      event.preventDefault();
      const delta = normalizeWheelDelta(
        event.deltaY,
        event.deltaMode,
        window.innerHeight
      );
      lastWheelAtRef.current = performance.now();

      if (wheelModeRef.current === 'locked') {
        return;
      }

      const atSettledBoundary = progressRef.current === settledIndexRef.current
        && targetProgressRef.current === settledIndexRef.current
        && (
          (settledIndexRef.current === 0 && delta < 0)
          || (settledIndexRef.current === chapterCount - 1 && delta > 0)
        );
      if (atSettledBoundary) {
        // 硬边界只吸收越界输入，不让它污染下一次反向手势的累计量。
        wheelModeRef.current = 'arming';
        resetWheelGesture();
        return;
      }

      let releasedDelta = delta;
      if (wheelModeRef.current !== 'tracking') {
        const unlock = accumulateWheelUnlock(
          wheelGestureRef.current,
          delta,
          EXPERIENCE_CONFIG.progress.wheelUnlockDelta
        );
        wheelGestureRef.current = {
          direction: unlock.direction,
          accumulated: unlock.accumulated
        };
        releasedDelta = unlock.releasedDelta;
        if (releasedDelta === 0) {
          targetProgressRef.current = settledIndexRef.current;
          return;
        }
        wheelModeRef.current = 'tracking';
      }

      if (prefersReducedMotionRef.current) {
        // 减少动态效果仍保留新手势阈值，但释放后直接稳定到相邻章节。
        startSnap(settledIndexRef.current + (releasedDelta > 0 ? 1 : -1));
        return;
      }

      targetProgressRef.current = applyChapterDelta(
        targetProgressRef.current,
        releasedDelta * EXPERIENCE_CONFIG.progress.wheelScale,
        settledIndexRef.current,
        chapterCount
      );
      setIsChapterTransitioning(
        Math.abs(targetProgressRef.current - settledIndexRef.current) > 0.0001
      );
      startProgressFollow();

      stopWheelIdleTimer();
      wheelIdleTimerRef.current = window.setTimeout(() => {
        wheelIdleTimerRef.current = null;
        if (wheelModeRef.current !== 'tracking') {
          return;
        }
        startSnap(snapChapterProgress(targetProgressRef.current, chapterCount));
      }, EXPERIENCE_CONFIG.progress.wheelIdleMs);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isLocalInput(event.target) || isPausedRef.current) {
        return;
      }

      const direction = event.key === 'ArrowDown' || event.key === 'PageDown'
        ? 1
        : event.key === 'ArrowUp' || event.key === 'PageUp'
          ? -1
          : 0;
      if (direction === 0) {
        return;
      }

      event.preventDefault();
      goToAdjacent(direction);
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (
        isLocalInput(event.target)
        || event.pointerType !== 'touch'
        || touchGestureRef.current
      ) {
        return;
      }

      touchGestureRef.current = {
        pointerId: event.pointerId,
        startY: event.clientY
      };
    };
    const handlePointerUp = (event: PointerEvent) => {
      const gesture = touchGestureRef.current;
      if (
        event.pointerType !== 'touch'
        || !gesture
        || gesture.pointerId !== event.pointerId
      ) {
        return;
      }

      touchGestureRef.current = null;
      if (isLocalInput(event.target) || isPausedRef.current) {
        return;
      }

      const direction = calculateSwipeDelta(gesture.startY, event.clientY);
      if (direction !== 0) {
        goToAdjacent(direction);
      }
    };
    const clearTouchStart = (event: PointerEvent) => {
      if (touchGestureRef.current?.pointerId === event.pointerId) {
        touchGestureRef.current = null;
      }
    };
    const listenerTeardowns: Array<() => void> = [];
    let tornDown = false;

    const registerWindowListener = <K extends keyof WindowEventMap>(
      type: K,
      listener: (this: Window, event: WindowEventMap[K]) => unknown,
      options?: boolean | AddEventListenerOptions
    ) => {
      window.addEventListener(type, listener, options);
      listenerTeardowns.push(() => {
        window.removeEventListener(type, listener);
      });
    };
    const registerDocumentListener = <K extends keyof DocumentEventMap>(
      type: K,
      listener: (this: Document, event: DocumentEventMap[K]) => unknown
    ) => {
      document.addEventListener(type, listener);
      listenerTeardowns.push(() => {
        document.removeEventListener(type, listener);
      });
    };
    const teardown = () => {
      if (tornDown) return;
      tornDown = true;

      stopProgressFrame();
      stopWheelIdleTimer();
      stopWheelLockTimer();
      lastWheelAtRef.current = null;
      lastFrameAtRef.current = null;
      wheelModeRef.current = 'resting';
      resetWheelGesture();
      touchGestureRef.current = null;
      for (const removeListener of listenerTeardowns.reverse()) {
        try {
          removeListener();
        } catch {
          // 单个浏览器监听器清理失败时继续回收其余监听器。
        }
      }
      listenerTeardowns.length = 0;
    };

    try {
      isDocumentHiddenRef.current = document.visibilityState === 'hidden';
      syncPausedState();
      registerWindowListener('wheel', handleWheel, { passive: false });
      registerWindowListener('keydown', handleKeyDown);
      registerWindowListener('pointerdown', handlePointerDown);
      registerWindowListener('pointerup', handlePointerUp);
      registerWindowListener('pointercancel', clearTouchStart);
      registerWindowListener('blur', pause);
      registerWindowListener('focus', resume);
      registerDocumentListener('visibilitychange', handleVisibilityChange);
    } catch {
      teardown();
      notifyInitializationError();
      return;
    }

    return teardown;
  }, [
    chapterCount,
    commitSettledIndex,
    commitProgress,
    goToAdjacent,
    notifyInitializationError,
    resetWheelGesture,
    startSnap,
    startProgressFollow,
    stopProgressFrame,
    stopWheelIdleTimer,
    stopWheelLockTimer,
    options.staticFallback
  ]);

  return {
    phase,
    progress,
    settledIndex,
    isChapterTransitioning,
    isPaused,
    prefersReducedMotion,
    initializationFailed,
    goToAdjacent
  };
}
