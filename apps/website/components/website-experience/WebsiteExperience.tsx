'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from 'react';
import type { CSSProperties } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { LanguageMenu } from '../i18n/LanguageMenu';
import { interpolateMessage, useI18n } from '../i18n/I18nProvider';
import type { Translate } from '../i18n/i18n-types';
import { HomeExperience } from '../home-experience/HomeExperience';
import {
  deriveChapterVisualState,
  deriveHomeExperiencePhase
} from './chapter-model';
import {
  CHAPTER_REGISTRY,
  feedbackRepository,
  getChapterIndex
} from './chapter-registry';
import { SharedVisualLayers } from './SharedVisualLayers';
import { ChapterBackdrop } from './visual/ChapterBackdrop';
import { CHAPTER_LAYERS } from './layer-contract';
import { createFeedbackVisualProfile } from './feedback/feedback-preview-source';
import {
  resolveSharedVisualProfile,
  VISUAL_PROFILES
} from './shared-visual-model';
import styles from './website-experience.module.css';
import { useWebsiteController } from './use-website-controller';

export interface WebsiteExperienceProps {
  onRuntimeError?: () => void;
}

/** 生产粒子预览只读取章节已注入的云端反馈快照。 */
export function createProductionFeedbackVisualProfile(t: Translate) {
  return createFeedbackVisualProfile(feedbackRepository, Math.random, t);
}

function createChapterVisualStyle(
  visual: ReturnType<typeof deriveChapterVisualState>,
  zIndex = visual.zIndex
): CSSProperties {
  return {
    '--chapter-opacity': visual.opacity,
    '--chapter-scale': visual.scale,
    '--chapter-blur': `${visual.blurPx}px`,
    '--chapter-contrast': visual.contrast,
    zIndex
  } as CSSProperties;
}

/**
 * 组合首页、介绍、下载、社区、反馈和捐款六个章节，并把全局输入状态下发给受控首页。
 */
export function WebsiteExperience({
  onRuntimeError
}: WebsiteExperienceProps = {}) {
  const { t: rawTranslate } = useI18n();
  const t = useCallback<Translate>((key, values) => (
    interpolateMessage(rawTranslate(key), values)
  ), [rawTranslate]);
  const [initializationFailed, setInitializationFailed] = useState(false);
  const mountedRef = useRef(true);
  const onRuntimeErrorRef = useRef(onRuntimeError);
  onRuntimeErrorRef.current = onRuntimeError;

  // 父级 layout cleanup 早于子级 passive cleanup，用于屏蔽最终卸载中的错误上报。
  useLayoutEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
    };
  }, []);

  const handleInitializationError = useCallback(() => {
    if (!mountedRef.current) return;

    setInitializationFailed(true);
    onRuntimeErrorRef.current?.();
  }, []);
  const controller = useWebsiteController({
    chapterCount: CHAPTER_REGISTRY.length,
    staticFallback: initializationFailed,
    onInitializationError: handleInitializationError
  });
  const staticFallback = initializationFailed || controller.initializationFailed;
  const reducedMotion = staticFallback || controller.prefersReducedMotion;
  const activeChapter = CHAPTER_REGISTRY[controller.settledIndex] ?? CHAPTER_REGISTRY[0];
  const homeExitProgress = Math.min(1, Math.max(0, controller.progress));
  const showLanguageMenu = controller.progress === 0
    && !controller.isChapterTransitioning;
  const homePhase = deriveHomeExperiencePhase(
    controller.phase,
    homeExitProgress
  );
  const feedbackVisualProfileRef = useRef<ReturnType<
    typeof createFeedbackVisualProfile
  > | null>(null);
  if (feedbackVisualProfileRef.current === null) {
    feedbackVisualProfileRef.current = createProductionFeedbackVisualProfile(t);
  }
  useEffect(() => {
    // 只更新后续生成粒子的翻译快照，已绑定粒子保持生成时的内容。
    feedbackVisualProfileRef.current?.setTranslate(t);
  }, [t]);
  const sharedVisualProfile = controller.phase === 'interactive'
    && Math.abs(controller.progress - getChapterIndex('feedback')) < 0.0001
    ? feedbackVisualProfileRef.current
    : resolveSharedVisualProfile(controller.progress, controller.phase);
  const mountedVisualProfile = sharedVisualProfile
    ?? (controller.progress < 1 ? VISUAL_PROFILES.home : null);
  const sharedVisualChapterIndex = sharedVisualProfile
    ? getChapterIndex(sharedVisualProfile.id)
    : 0;
  const sharedVisualGenerating = sharedVisualProfile !== null
    && controller.phase === 'interactive'
    && Math.abs(controller.progress - sharedVisualChapterIndex) < 0.0001;
  const chapters = CHAPTER_REGISTRY.map((chapter, index) => ({
    chapter,
    visual: deriveChapterVisualState(
      index,
      controller.progress,
      reducedMotion
    )
  }));

  return (
    <div
      className={styles.experience}
      data-testid="website-experience"
      data-static-fallback={staticFallback ? 'active' : 'ready'}
      data-reduced-motion={reducedMotion}
      data-active-chapter={activeChapter.id}
      data-initialization-failed={staticFallback}
    >
      <div
        className={styles.backdropLayer}
        data-layer="backdrop"
        aria-hidden="true"
        style={{ zIndex: CHAPTER_LAYERS.backdrop }}
      >
        {chapters.map(({ chapter, visual }) => (
          <div
            key={chapter.id}
            className={styles.chapterBackdrop}
            data-backdrop-for={chapter.id}
            style={createChapterVisualStyle(visual)}
          >
            <ChapterBackdrop
              chapterId={chapter.id}
              useBackdropDataAttribute
            />
          </div>
        ))}
      </div>
      {chapters.map(({ chapter, visual }) => {
        const RegisteredChapter = chapter.component;
        const style = createChapterVisualStyle(
          visual,
          CHAPTER_LAYERS.focal
        );

        return (
          <section
            key={chapter.id}
            className={styles.chapter}
            data-chapter-id={chapter.id}
            data-visible={visual.visible}
            data-interactive={visual.interactive}
            data-layer="focal"
            aria-label={t(chapter.labelKey)}
            aria-hidden={!visual.visible}
            inert={!visual.interactive ? true : undefined}
            style={style}
          >
            {chapter.id === 'home' ? (
              <HomeExperience
                phase={homePhase}
                exitProgress={homeExitProgress}
                pointer={controller.pointer}
                isPaused={controller.isPaused}
                reducedMotion={reducedMotion}
                staticFallback={staticFallback}
                registerIntroSkip={controller.registerIntroSkip}
                onDrawingDone={controller.drawingDone}
                onSettled={controller.settled}
                onInitializationError={handleInitializationError}
              />
            ) : null}
            {RegisteredChapter ? (
              <RegisteredChapter
                interactive={visual.interactive}
                isPaused={controller.isPaused}
                reducedMotion={reducedMotion}
                staticFallback={staticFallback}
                onInitializationError={handleInitializationError}
              />
            ) : null}
          </section>
        );
      })}
      <nav
        className={styles.chapterControls}
        data-input-scope="local"
        aria-label={t('navigation.label')}
      >
        <button
          type="button"
          aria-label={t('navigation.previousChapter')}
          disabled={controller.settledIndex === 0}
          onClick={() => controller.goToAdjacent(-1)}
        >
          <ChevronUp aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={t('navigation.nextChapter')}
          disabled={controller.settledIndex === CHAPTER_REGISTRY.length - 1}
          onClick={() => controller.goToAdjacent(1)}
        >
          <ChevronDown aria-hidden="true" />
        </button>
      </nav>
      {showLanguageMenu ? (
        <div data-layer="fixed-controls">
          <LanguageMenu />
        </div>
      ) : null}
      {mountedVisualProfile && !staticFallback ? (
        <SharedVisualLayers
          profile={mountedVisualProfile}
          running={sharedVisualProfile !== null}
          generating={sharedVisualGenerating}
          exitProgress={
            mountedVisualProfile.id === 'home' ? homeExitProgress : 0
          }
          pointer={controller.pointer}
          isPaused={controller.isPaused}
          reducedMotion={controller.prefersReducedMotion}
          onInitializationError={handleInitializationError}
        />
      ) : null}
    </div>
  );
}
