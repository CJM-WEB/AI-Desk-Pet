'use client';

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { BrandStage } from './BrandStage';
import { CursorField } from './CursorField';
import { FileSwarm } from './FileSwarm';
import styles from './home-experience.module.css';
import {
  isIntroPhase,
  useExperienceController,
  type ExperienceTimelineActions
} from './use-experience-controller';
import { useIntroTimeline } from './use-intro-timeline';

export function HomeExperience() {
  const [initializationFailed, setInitializationFailed] = useState(false);
  const [introActive, setIntroActive] = useState(false);
  const [drawAssetFailed, setDrawAssetFailed] = useState(false);
  const [finalLogoFailed, setFinalLogoFailed] = useState(false);
  const [previewLayer, setPreviewLayer] = useState<HTMLDivElement | null>(null);
  const scopeRef = useRef<HTMLElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const brandRef = useRef<HTMLDivElement | null>(null);
  const wordmarkRef = useRef<HTMLHeadingElement | null>(null);
  const drawPathsRef = useRef<SVGPathElement[]>([]);
  const introSkipRef = useRef<() => void>(() => undefined);
  const timelineActionsRef = useRef<ExperienceTimelineActions | null>(null);
  const requestIntroSkip = useCallback(() => introSkipRef.current(), []);
  const handleInitializationError = useCallback(() => {
    setInitializationFailed(true);
  }, []);
  const introRefs = useMemo(() => ({
    scope: scopeRef,
    overlay: overlayRef,
    brand: brandRef,
    wordmark: wordmarkRef,
    drawPaths: drawPathsRef
  }), []);
  const handleDrawingDone = useCallback(
    () => timelineActionsRef.current?.drawingDone(),
    []
  );
  const handleSettled = useCallback(
    () => timelineActionsRef.current?.settled(),
    []
  );
  const controller = useExperienceController({
    onSkipIntro: requestIntroSkip,
    onInitializationError: handleInitializationError,
    timelineActionsRef
  });
  const staticFallback = initializationFailed;
  const intro = useIntroTimeline({
    phase: controller.phase,
    reducedMotion: staticFallback || controller.prefersReducedMotion,
    isPaused: controller.isPaused,
    refs: introRefs,
    onDrawingDone: handleDrawingDone,
    onSettled: handleSettled
  });

  introSkipRef.current = intro.skip;

  const setScope = useCallback((node: HTMLElement | null) => {
    scopeRef.current = node;
    if (!node) {
      return;
    }

    wordmarkRef.current = node.querySelector('h1');
    drawPathsRef.current = Array.from(node.querySelectorAll('svg path'));
  }, []);
  const exitProgress = Math.max(0, (controller.progress - 0.62) / 0.38);
  const experienceStyle = {
    '--experience-brand-scale': 1 - exitProgress * 0.42,
    '--experience-brand-opacity': 1 - exitProgress,
    '--experience-files-scale': 1 - exitProgress * 0.28,
    '--experience-field-opacity': 1 - exitProgress,
    '--experience-chapter-opacity': exitProgress
  } as CSSProperties;

  useLayoutEffect(() => {
    // 服务端默认不显示遮罩；仅在 hydration 完成后启用开场视觉。
    setIntroActive(true);
  }, []);
  const overlayActive = introActive
    && !staticFallback
    && (controller.phase === 'loading' || isIntroPhase(controller.phase));

  return (
    <main
      ref={setScope}
      className={styles.experience}
      data-testid="home-experience"
      data-static-fallback="ready"
      data-phase={staticFallback ? 'interactive' : controller.phase}
      data-progress={controller.progress.toFixed(4)}
      data-initialization-failed={staticFallback}
      style={experienceStyle}
    >
      <section
        className={styles.chapterPlaceholder}
        data-layer="chapter-placeholder"
        aria-label="内容章节"
      />
      {!staticFallback ? (
        <section className={styles.cursorLayer} data-layer="cursor" aria-hidden="true">
          <CursorField
            pointer={controller.pointer}
            isPaused={controller.isPaused}
            progress={controller.progress}
            reducedMotion={controller.prefersReducedMotion}
            onInitializationError={handleInitializationError}
          />
        </section>
      ) : null}
      {!staticFallback && controller.progress < 1 ? (
        <section className={styles.fileLayer} data-layer="file" aria-label="文件预览队列">
          <FileSwarm
            phase={controller.phase}
            pointer={controller.pointer}
            isPaused={controller.isPaused}
            progress={controller.progress}
            reducedMotion={controller.prefersReducedMotion}
            previewContainer={previewLayer}
            onInitializationError={handleInitializationError}
          />
        </section>
      ) : null}
      <BrandStage
        stageRef={brandRef}
        pointer={controller.pointer}
        interactive={!staticFallback && (controller.phase === 'interactive' || controller.phase === 'exiting')}
        isPaused={controller.isPaused}
        reducedMotion={staticFallback || controller.prefersReducedMotion}
        drawAssetFailed={drawAssetFailed}
        finalLogoFailed={finalLogoFailed}
        onDrawAssetError={() => setDrawAssetFailed(true)}
        onFinalLogoError={() => setFinalLogoFailed(true)}
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
