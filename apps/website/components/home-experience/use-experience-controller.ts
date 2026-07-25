'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { EXPERIENCE_CONFIG } from './config';
import {
  applyProgressDelta,
  reduceExperience,
  snapProgress
} from './progress-model';
import type {
  ExperienceEvent,
  ExperienceState
} from './progress-model';
import type { ExperiencePhase, PointerPoint } from './types';

export interface ExperienceControllerResult {
  phase: ExperiencePhase;
  progress: number;
  pointer: PointerPoint;
  isPaused: boolean;
  prefersReducedMotion: boolean;
  skipIntro: () => void;
}

interface UseExperienceControllerOptions {
  onSkipIntro?: () => void;
  onInitializationError?: () => void;
  timelineActionsRef?: MutableRefObject<ExperienceTimelineActions | null>;
}

export interface ExperienceTimelineActions {
  drawingDone: () => void;
  settled: () => void;
}

const INITIAL_STATE: ExperienceState = { phase: 'loading', progress: 0 };
const SNAP_DURATION_MS = 180;
const FRAME_BASELINE_MS = 16;

export function isIntroPhase(phase: ExperiencePhase): boolean {
  return phase === 'drawing' || phase === 'settling';
}

export function applyIntroSkip(state: ExperienceState): ExperienceState {
  return isIntroPhase(state.phase)
    ? reduceExperience(state, { type: 'SKIP_INTRO' })
    : state;
}

export function calculateInputVelocity(
  delta: number,
  inputAt: number,
  previousInputAt: number | null
): number {
  const elapsed = previousInputAt === null
    ? FRAME_BASELINE_MS
    : Math.max(FRAME_BASELINE_MS, inputAt - previousInputAt);
  return delta / elapsed;
}

export function interpolateSnapProgress(
  from: number,
  to: number,
  ratio: number
): number {
  const clampedRatio = Math.min(1, Math.max(0, ratio));
  const easedRatio = 1 - ((1 - clampedRatio) ** 3);
  return from + ((to - from) * easedRatio);
}

/**
 * 将浏览器输入适配为任务 2 的纯状态模型，并集中管理所有可释放的副作用。
 */
export function useExperienceController(
  options: UseExperienceControllerOptions = {}
): ExperienceControllerResult {
  const [experience, setExperience] = useState<ExperienceState>(INITIAL_STATE);
  const [pointer, setPointer] = useState<PointerPoint>({ x: 0, y: 0 });
  const [isPaused, setIsPaused] = useState(false);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const experienceRef = useRef<ExperienceState>(INITIAL_STATE);
  const isPausedRef = useRef(false);
  const isDocumentHiddenRef = useRef(false);
  const isWindowBlurredRef = useRef(false);
  const pointerTargetRef = useRef<PointerPoint>({ x: 0, y: 0 });
  const pointerFrameRef = useRef<number | null>(null);
  const snapFrameRef = useRef<number | null>(null);
  const snapTargetRef = useRef<number | null>(null);
  const lastInputAtRef = useRef<number | null>(null);
  const onSkipIntroRef = useRef(options.onSkipIntro);
  const onInitializationErrorRef = useRef(options.onInitializationError);

  onSkipIntroRef.current = options.onSkipIntro;
  onInitializationErrorRef.current = options.onInitializationError;

  const notifyInitializationError = useCallback(() => {
    onInitializationErrorRef.current?.();
  }, []);

  const commitExperience = useCallback((next: ExperienceState) => {
    experienceRef.current = next;
    setExperience(next);
  }, []);

  const dispatchExperience = useCallback((event: ExperienceEvent) => {
    commitExperience(reduceExperience(experienceRef.current, event));
  }, [commitExperience]);

  const skipIntro = useCallback(() => {
    const current = experienceRef.current;
    const next = applyIntroSkip(current);
    if (next === current) {
      return;
    }

    experienceRef.current = next;
    onSkipIntroRef.current?.();
    setExperience(next);
  }, []);

  const drawingDone = useCallback(() => {
    dispatchExperience({ type: 'DRAWING_DONE' });
  }, [dispatchExperience]);
  const settled = useCallback(() => {
    dispatchExperience({ type: 'SETTLED' });
  }, [dispatchExperience]);
  const timelineActions = useMemo<ExperienceTimelineActions>(
    () => ({ drawingDone, settled }),
    [drawingDone, settled]
  );

  if (options.timelineActionsRef) {
    options.timelineActionsRef.current = timelineActions;
  }

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

  const commitProgress = useCallback((progress: number): ExperienceState | null => {
    const current = experienceRef.current;
    if (current.phase !== 'interactive' && current.phase !== 'exiting') {
      return null;
    }

    const next = reduceExperience(current, { type: 'SET_PROGRESS', progress });
    commitExperience(next);
    return next;
  }, [commitExperience]);

  const startSnap = useCallback((from: number, target: number) => {
    stopSnapFrame();
    snapTargetRef.current = target;
    let startedAt: number | null = null;

    const advance = (frameAt: number) => {
      if (isPausedRef.current) {
        snapFrameRef.current = null;
        return;
      }

      startedAt ??= frameAt;
      const ratio = (frameAt - startedAt) / SNAP_DURATION_MS;
      const nextProgress = interpolateSnapProgress(from, target, ratio);
      if (!commitProgress(nextProgress)) {
        snapTargetRef.current = null;
        snapFrameRef.current = null;
        return;
      }

      if (ratio < 1) {
        snapFrameRef.current = window.requestAnimationFrame(advance);
      } else {
        snapTargetRef.current = null;
        snapFrameRef.current = null;
      }
    };

    snapFrameRef.current = window.requestAnimationFrame(advance);
  }, [commitProgress, stopSnapFrame]);

  const updateProgress = useCallback((delta: number, velocity: number) => {
    cancelSnap();
    const current = experienceRef.current;
    if (current.phase !== 'interactive' && current.phase !== 'exiting') {
      return;
    }

    const next = reduceExperience(current, {
      type: 'SET_PROGRESS',
      progress: applyProgressDelta(current.progress, delta)
    });
    commitExperience(next);

    const target = snapProgress(next.progress, velocity);
    if (target !== next.progress) {
      startSnap(next.progress, target);
    }
  }, [cancelSnap, commitExperience, startSnap]);

  useEffect(() => {
    dispatchExperience({ type: 'ASSETS_READY' });
  }, [dispatchExperience]);

  useEffect(() => {
    let mediaQuery: MediaQueryList;
    const syncReducedMotion = () => setPrefersReducedMotion(mediaQuery.matches);

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
  }, [notifyInitializationError]);

  useEffect(() => {
    let desktopQuery: MediaQueryList;

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
      } else {
        lastInputAtRef.current = null;
        const target = snapTargetRef.current;
        if (target !== null) {
          startSnap(experienceRef.current.progress, target);
        }
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
    const handleWheel = (event: WheelEvent) => {
      const current = experienceRef.current;
      if (
        !desktopQuery.matches
        || current.phase === 'loading'
        || isPausedRef.current
      ) {
        return;
      }

      event.preventDefault();
      if (isIntroPhase(current.phase)) {
        skipIntro();
        return;
      }

      const now = performance.now();
      const delta = event.deltaY * EXPERIENCE_CONFIG.progress.wheelScale;
      const velocity = calculateInputVelocity(delta, now, lastInputAtRef.current);
      lastInputAtRef.current = now;
      updateProgress(delta, velocity);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      const keyDelta = event.key === 'ArrowDown' || event.key === 'PageDown'
        ? EXPERIENCE_CONFIG.progress.keyboardStep
        : event.key === 'ArrowUp' || event.key === 'PageUp'
          ? -EXPERIENCE_CONFIG.progress.keyboardStep
          : null;
      const current = experienceRef.current;

      if (
        keyDelta === null
        || !desktopQuery.matches
        || current.phase === 'loading'
        || isPausedRef.current
      ) {
        return;
      }

      event.preventDefault();
      if (isIntroPhase(current.phase)) {
        skipIntro();
        return;
      }

      updateProgress(keyDelta, Math.abs(keyDelta) / FRAME_BASELINE_MS);
    };
    const handleClick = () => {
      if (!isPausedRef.current && isIntroPhase(experienceRef.current.phase)) {
        skipIntro();
      }
    };
    const handlePointerMove = (event: PointerEvent) => {
      if (isPausedRef.current) {
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

    try {
      desktopQuery = window.matchMedia('(min-width: 761px)');
      isDocumentHiddenRef.current = document.visibilityState === 'hidden';
      syncPausedState();

      window.addEventListener('wheel', handleWheel, { passive: false });
      window.addEventListener('keydown', handleKeyDown);
      window.addEventListener('click', handleClick);
      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('blur', pause);
      window.addEventListener('focus', resume);
      document.addEventListener('visibilitychange', handleVisibilityChange);
    } catch {
      notifyInitializationError();
      return;
    }

    return () => {
      cancelSnap();
      if (pointerFrameRef.current !== null) {
        window.cancelAnimationFrame(pointerFrameRef.current);
        pointerFrameRef.current = null;
      }
      window.removeEventListener('wheel', handleWheel);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('click', handleClick);
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('blur', pause);
      window.removeEventListener('focus', resume);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [
    cancelSnap,
    notifyInitializationError,
    skipIntro,
    startSnap,
    stopSnapFrame,
    updateProgress
  ]);

  return {
    phase: experience.phase,
    progress: experience.progress,
    pointer,
    isPaused,
    prefersReducedMotion,
    skipIntro
  };
}
