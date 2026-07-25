'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import type { CSSProperties } from 'react';
import { isIntroPhase } from '../website-experience/chapter-model';
import { BrandStage } from './BrandStage';
import { CursorField } from './CursorField';
import { FileSwarm } from './FileSwarm';
import styles from './home-experience.module.css';
import type { ExperiencePhase, PointerPoint } from './types';
import { useIntroTimeline } from './use-intro-timeline';

export interface HomeExperienceProps {
  phase: ExperiencePhase;
  exitProgress: number;
  pointer: PointerPoint;
  isPaused: boolean;
  reducedMotion: boolean;
  registerIntroSkip: (skip: (() => void) | null) => void;
  onDrawingDone: () => void;
  onSettled: () => void;
  onInitializationError: () => void;
}

export function HomeExperience({
  phase,
  exitProgress,
  pointer,
  isPaused,
  reducedMotion,
  registerIntroSkip,
  onDrawingDone,
  onSettled,
  onInitializationError
}: HomeExperienceProps) {
  const [initializationFailed, setInitializationFailed] = useState(false);
  const [introActive, setIntroActive] = useState(false);
  const [magneticAssetFailed, setMagneticAssetFailed] = useState(false);
  const [finalLogoFailed, setFinalLogoFailed] = useState(false);
  const [previewLayer, setPreviewLayer] = useState<HTMLDivElement | null>(null);
  const scopeRef = useRef<HTMLElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const brandRef = useRef<HTMLDivElement | null>(null);
  const wordmarkRef = useRef<HTMLHeadingElement | null>(null);
  const finalLogoRef = useRef<HTMLImageElement | null>(null);
  const magneticPiecesRef = useRef<HTMLImageElement[]>([]);
  const handleInitializationError = useCallback(() => {
    setInitializationFailed(true);
    onInitializationError();
  }, [onInitializationError]);
  const handleMagneticAssetError = useCallback(() => {
    setMagneticAssetFailed(true);
    handleInitializationError();
  }, [handleInitializationError]);
  const handleFinalLogoError = useCallback(() => {
    setFinalLogoFailed(true);
    handleInitializationError();
  }, [handleInitializationError]);
  const introRefs = useMemo(() => ({
    scope: scopeRef,
    overlay: overlayRef,
    brand: brandRef,
    wordmark: wordmarkRef,
    finalLogo: finalLogoRef,
    magneticPieces: magneticPiecesRef
  }), []);
  const staticFallback = initializationFailed;
  const intro = useIntroTimeline({
    phase,
    reducedMotion: staticFallback || reducedMotion,
    isPaused,
    refs: introRefs,
    onDrawingDone,
    onSettled
  });

  useEffect(() => {
    registerIntroSkip(intro.skip);
    return () => registerIntroSkip(null);
  }, [intro.skip, registerIntroSkip]);

  const setScope = useCallback((node: HTMLElement | null) => {
    scopeRef.current = node;
    if (!node) {
      return;
    }

    wordmarkRef.current = node.querySelector('h1');
    finalLogoRef.current = node.querySelector('[data-testid="brand-logo"]');
    magneticPiecesRef.current = Array.from(
      node.querySelectorAll<HTMLImageElement>('[data-testid="magnetic-logo-piece"]')
    );
  }, []);
  const experienceStyle = {
    '--experience-brand-scale': 1 - exitProgress * 0.42,
    '--experience-brand-opacity': 1 - exitProgress,
    '--experience-files-scale': 1 - exitProgress * 0.28,
    '--experience-field-opacity': 1 - exitProgress
  } as CSSProperties;

  useLayoutEffect(() => {
    const finalLogoFailedBeforeHydration = finalLogoRef.current?.complete
      && finalLogoRef.current.naturalWidth === 0;
    const magneticAssetFailedBeforeHydration = magneticPiecesRef.current.some(
      (piece) => piece.complete && piece.naturalWidth === 0
    );

    if (finalLogoFailedBeforeHydration || magneticAssetFailedBeforeHydration) {
      if (finalLogoFailedBeforeHydration) {
        setFinalLogoFailed(true);
      }
      if (magneticAssetFailedBeforeHydration) {
        setMagneticAssetFailed(true);
      }
      handleInitializationError();
      return;
    }

    // 服务端默认不显示遮罩；仅在 hydration 完成后启用开场视觉。
    setIntroActive(true);
  }, [handleInitializationError]);
  const overlayActive = introActive
    && !staticFallback
    && (phase === 'loading' || isIntroPhase(phase));

  return (
    <main
      ref={setScope}
      className={styles.experience}
      data-testid="home-experience"
      data-static-fallback="ready"
      data-phase={staticFallback ? 'interactive' : phase}
      data-progress={exitProgress.toFixed(4)}
      data-initialization-failed={staticFallback}
      style={experienceStyle}
    >
      {!staticFallback ? (
        <section className={styles.cursorLayer} data-layer="cursor" aria-hidden="true">
          <CursorField
            pointer={pointer}
            isPaused={isPaused}
            progress={exitProgress}
            reducedMotion={reducedMotion}
            onInitializationError={handleInitializationError}
          />
        </section>
      ) : null}
      {!staticFallback && exitProgress < 1 ? (
        <section className={styles.fileLayer} data-layer="file" aria-label="文件预览队列">
          <FileSwarm
            phase={phase}
            pointer={pointer}
            isPaused={isPaused}
            progress={exitProgress}
            reducedMotion={reducedMotion}
            previewContainer={previewLayer}
            onInitializationError={handleInitializationError}
          />
        </section>
      ) : null}
      <BrandStage
        stageRef={brandRef}
        pointer={pointer}
        interactive={!staticFallback && (phase === 'interactive' || phase === 'exiting')}
        isPaused={isPaused}
        reducedMotion={staticFallback || reducedMotion}
        magneticAssetFailed={magneticAssetFailed}
        finalLogoFailed={finalLogoFailed}
        onMagneticAssetError={handleMagneticAssetError}
        onFinalLogoError={handleFinalLogoError}
      />
      <div
        ref={setPreviewLayer}
        className={styles.previewLayer}
        data-layer="preview"
      />
      <div
        ref={overlayRef}
        className={styles.introOverlay}
        data-layer="intro"
        data-active={overlayActive}
        aria-hidden="true"
      />
    </main>
  );
}
