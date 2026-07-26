'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { EXPERIENCE_CONFIG } from '../home-experience/config';
import type { ExperiencePhase, PointerPoint } from '../home-experience/types';
import {
  applyChapterDelta,
  clampChapterProgress,
  interpolateChapterSnapProgress,
  isIntroPhase,
  reduceIntroPhase,
  snapChapterProgress
} from './chapter-model';

export interface WebsiteControllerOptions {
  chapterCount: number;
  staticFallback?: boolean;
  onInitializationError?: () => void;
}

export interface WebsiteControllerResult {
  phase: ExperiencePhase;
  progress: number;
  settledIndex: number;
  pointer: PointerPoint;
  isPaused: boolean;
  prefersReducedMotion: boolean;
  initializationFailed: boolean;
  drawingDone: () => void;
  settled: () => void;
  registerIntroSkip: (skip: (() => void) | null) => void;
  goToAdjacent: (direction: -1 | 1) => void;
}

const SNAP_DURATION_MS = 300;

type ChapterTouchGesture = {
  pointerId: number;
  startY: number;
};

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
 * 把原始滚轮输入适配为受相邻章节边界约束的进度。
 */
export function applyWheelChapterInput(input: {
  progress: number;
  deltaY: number;
  settledIndex: number;
  chapterCount: number;
}): number {
  return applyChapterDelta(
    input.progress,
    input.deltaY * EXPERIENCE_CONFIG.progress.wheelScale,
    input.settledIndex,
    input.chapterCount
  );
}

/**
 * 统一管理官网章节输入、开场跳过和可恢复的章节吸附动画。
 */
export function useWebsiteController(
  options: WebsiteControllerOptions
): WebsiteControllerResult {
  const [phase, setPhase] = useState<ExperiencePhase>('loading');
  const [progress, setProgress] = useState(0);
  const [settledIndex, setSettledIndex] = useState(0);
  const [pointer, setPointer] = useState<PointerPoint>({ x: 0, y: 0 });
  const [isPaused, setIsPaused] = useState(false);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const [initializationFailed, setInitializationFailed] = useState(false);
  const phaseRef = useRef<ExperiencePhase>('loading');
  const progressRef = useRef(0);
  const settledIndexRef = useRef(0);
  const prefersReducedMotionRef = useRef(false);
  const staticFallbackRef = useRef(Boolean(options.staticFallback));
  const isPausedRef = useRef(false);
  const isDocumentHiddenRef = useRef(false);
  const isWindowBlurredRef = useRef(false);
  const pointerTargetRef = useRef<PointerPoint>({ x: 0, y: 0 });
  const pointerFrameRef = useRef<number | null>(null);
  const snapFrameRef = useRef<number | null>(null);
  const snapTargetRef = useRef<number | null>(null);
  const touchGestureRef = useRef<ChapterTouchGesture | null>(null);
  const introSkipRef = useRef<(() => void) | null>(null);
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

  const commitPhase = useCallback((next: ExperiencePhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

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

  const stopSnapFrame = useCallback(() => {
    if (snapFrameRef.current !== null) {
      window.cancelAnimationFrame(snapFrameRef.current);
      snapFrameRef.current = null;
    }
  }, []);

  const cancelSnap = useCallback(() => {
    stopSnapFrame();
    snapTargetRef.current = null;
  }, [stopSnapFrame]);

  const startSnap = useCallback((target: number) => {
    stopSnapFrame();
    snapTargetRef.current = target;

    if (staticFallbackRef.current || prefersReducedMotionRef.current) {
      commitProgress(target);
      commitSettledIndex(target);
      snapTargetRef.current = null;
      return;
    }

    const from = progressRef.current;
    let startedAt: number | null = null;

    const advance = (frameAt: number) => {
      if (isPausedRef.current) {
        snapFrameRef.current = null;
        return;
      }

      startedAt ??= frameAt;
      const ratio = Math.min(1, (frameAt - startedAt) / SNAP_DURATION_MS);
      commitProgress(interpolateChapterSnapProgress(from, target, ratio));

      if (ratio < 1) {
        snapFrameRef.current = window.requestAnimationFrame(advance);
        return;
      }

      commitProgress(target);
      commitSettledIndex(target);
      snapTargetRef.current = null;
      snapFrameRef.current = null;
    };

    snapFrameRef.current = window.requestAnimationFrame(advance);
  }, [commitProgress, commitSettledIndex, stopSnapFrame]);

  const drawingDone = useCallback(() => {
    const next = reduceIntroPhase(phaseRef.current, 'drawing-done');
    if (next !== phaseRef.current) {
      commitPhase(next);
    }
  }, [commitPhase]);

  const settled = useCallback(() => {
    const next = reduceIntroPhase(phaseRef.current, 'settled');
    if (next !== phaseRef.current) {
      commitPhase(next);
    }
  }, [commitPhase]);

  const registerIntroSkip = useCallback((skip: (() => void) | null) => {
    introSkipRef.current = skip;
  }, []);

  const requestIntroSkip = useCallback(() => {
    if (isIntroPhase(phaseRef.current)) {
      commitPhase(reduceIntroPhase(phaseRef.current, 'skip'));
      introSkipRef.current?.();
    }
  }, [commitPhase]);

  const goToAdjacent = useCallback((direction: -1 | 1) => {
    if (phaseRef.current !== 'interactive' || isPausedRef.current) {
      return;
    }

    const target = clampChapterProgress(settledIndexRef.current + direction, chapterCount);
    if (target === settledIndexRef.current) {
      return;
    }

    startSnap(target);
  }, [chapterCount, startSnap]);

  useEffect(() => {
    commitPhase('drawing');
  }, [commitPhase]);

  useEffect(() => {
    if (!options.staticFallback) {
      return;
    }

    staticFallbackRef.current = true;
    normalizePausedState();
    cancelSnap();
    commitProgress(settledIndexRef.current);
    commitPhase('interactive');
  }, [
    cancelSnap,
    commitPhase,
    commitProgress,
    normalizePausedState,
    options.staticFallback
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

    // 失焦和隐藏共享暂停状态，恢复后继续向原目标章节吸附。
    const syncPausedState = () => {
      const nextPaused = isDocumentHiddenRef.current || isWindowBlurredRef.current;
      if (nextPaused === isPausedRef.current) {
        return;
      }

      isPausedRef.current = nextPaused;
      setIsPaused(nextPaused);

      if (nextPaused) {
        stopSnapFrame();
        if (pointerFrameRef.current !== null) {
          window.cancelAnimationFrame(pointerFrameRef.current);
          pointerFrameRef.current = null;
        }
        return;
      }

      const target = snapTargetRef.current;
      if (target !== null) {
        startSnap(target);
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

      if (isIntroPhase(phaseRef.current)) {
        event.preventDefault();
        requestIntroSkip();
        return;
      }
      if (phaseRef.current !== 'interactive') {
        return;
      }

      event.preventDefault();
      cancelSnap();
      const next = applyWheelChapterInput({
        progress: progressRef.current,
        deltaY: event.deltaY,
        settledIndex: settledIndexRef.current,
        chapterCount
      });
      commitProgress(next);
      startSnap(snapChapterProgress(next, chapterCount));
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

      if (isIntroPhase(phaseRef.current)) {
        event.preventDefault();
        requestIntroSkip();
        return;
      }
      if (phaseRef.current !== 'interactive') {
        return;
      }

      event.preventDefault();
      goToAdjacent(direction);
    };
    const handleClick = (event: MouseEvent) => {
      if (!isLocalInput(event.target) && !isPausedRef.current) {
        requestIntroSkip();
      }
    };
    const handlePointerMove = (event: PointerEvent) => {
      if (isLocalInput(event.target) || isPausedRef.current) {
        return;
      }

      pointerTargetRef.current = { x: event.clientX, y: event.clientY };
      if (pointerFrameRef.current !== null) {
        return;
      }

      pointerFrameRef.current = window.requestAnimationFrame(() => {
        pointerFrameRef.current = null;
        setPointer(pointerTargetRef.current);
      });
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

      cancelSnap();
      touchGestureRef.current = null;
      if (pointerFrameRef.current !== null) {
        window.cancelAnimationFrame(pointerFrameRef.current);
        pointerFrameRef.current = null;
      }

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
      registerWindowListener('click', handleClick);
      registerWindowListener('pointermove', handlePointerMove);
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
    cancelSnap,
    chapterCount,
    commitProgress,
    goToAdjacent,
    notifyInitializationError,
    requestIntroSkip,
    startSnap,
    stopSnapFrame,
    options.staticFallback
  ]);

  return {
    phase,
    progress,
    settledIndex,
    pointer,
    isPaused,
    prefersReducedMotion,
    initializationFailed,
    drawingDone,
    settled,
    registerIntroSkip,
    goToAdjacent
  };
}
