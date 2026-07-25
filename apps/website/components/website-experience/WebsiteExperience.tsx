'use client';

import { useCallback, useState } from 'react';
import type { CSSProperties } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { HomeExperience } from '../home-experience/HomeExperience';
import {
  deriveChapterVisualState,
  deriveHomeExperiencePhase
} from './chapter-model';
import { CHAPTER_REGISTRY } from './chapter-registry';
import { PlaceholderChapter } from './PlaceholderChapter';
import { SharedVisualLayers } from './SharedVisualLayers';
import {
  resolveSharedVisualProfile,
  VISUAL_PROFILES
} from './shared-visual-model';
import styles from './website-experience.module.css';
import { useWebsiteController } from './use-website-controller';
import type { ChapterId } from './types';

function isExplicitPlaceholder(chapterId: ChapterId): boolean {
  return chapterId === 'about' || chapterId === 'feedback';
}

/**
 * 组合五个章节，并把全局输入状态下发给受控首页。
 */
export function WebsiteExperience() {
  const [initializationFailed, setInitializationFailed] = useState(false);
  const handleInitializationError = useCallback(() => {
    setInitializationFailed(true);
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
  const homePhase = deriveHomeExperiencePhase(
    controller.phase,
    homeExitProgress
  );
  const sharedVisualProfile = resolveSharedVisualProfile(
    controller.progress,
    controller.phase
  );
  const mountedVisualProfile = sharedVisualProfile
    ?? (controller.progress < 1 ? VISUAL_PROFILES.home : null);
  const sharedVisualChapterIndex = sharedVisualProfile?.id === 'donation' ? 4 : 0;
  const sharedVisualGenerating = sharedVisualProfile !== null
    && controller.phase === 'interactive'
    && Math.abs(controller.progress - sharedVisualChapterIndex) < 0.0001;

  return (
    <div
      className={styles.experience}
      data-testid="website-experience"
      data-static-fallback={staticFallback ? 'active' : 'ready'}
      data-reduced-motion={controller.prefersReducedMotion}
      data-active-chapter={activeChapter.id}
      data-initialization-failed={staticFallback}
    >
      {CHAPTER_REGISTRY.map((chapter, index) => {
        const RegisteredChapter = chapter.component;
        const visual = deriveChapterVisualState(
          index,
          controller.progress,
          reducedMotion
        );
        const style = {
          '--chapter-opacity': visual.opacity,
          '--chapter-scale': visual.scale,
          '--chapter-blur': `${visual.blurPx}px`,
          '--chapter-contrast': visual.contrast,
          // 捐款内容位于共享文件层上方，透明区域仍通过 CSS 让文件保持可交互。
          zIndex: chapter.id === 'donation' ? 3 : visual.zIndex
        } as CSSProperties;

        return (
          <section
            key={chapter.id}
            className={styles.chapter}
            data-chapter-id={chapter.id}
            data-visible={visual.visible}
            data-interactive={visual.interactive}
            aria-label={chapter.label}
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
            {isExplicitPlaceholder(chapter.id) ? (
              <PlaceholderChapter title={chapter.label} />
            ) : null}
            {RegisteredChapter ? (
              <RegisteredChapter interactive={visual.interactive} />
            ) : null}
          </section>
        );
      })}
      <nav
        className={styles.chapterControls}
        data-input-scope="local"
        aria-label="章节导航"
      >
        <button
          type="button"
          aria-label="上一章节"
          disabled={controller.settledIndex === 0}
          onClick={() => controller.goToAdjacent(-1)}
        >
          <ChevronUp aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="下一章节"
          disabled={controller.settledIndex === CHAPTER_REGISTRY.length - 1}
          onClick={() => controller.goToAdjacent(1)}
        >
          <ChevronDown aria-hidden="true" />
        </button>
      </nav>
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
