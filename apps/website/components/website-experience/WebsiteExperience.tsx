'use client';

import { useCallback, useState } from 'react';
import type { CSSProperties } from 'react';
import { HomeExperience } from '../home-experience/HomeExperience';
import { deriveChapterVisualState } from './chapter-model';
import { CHAPTER_REGISTRY } from './chapter-registry';
import { PlaceholderChapter } from './PlaceholderChapter';
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
    onInitializationError: handleInitializationError
  });
  const homeExitProgress = Math.min(1, Math.max(0, controller.progress));

  return (
    <div
      className={styles.experience}
      data-testid="website-experience"
      data-initialization-failed={
        initializationFailed || controller.initializationFailed
      }
    >
      {CHAPTER_REGISTRY.map((chapter, index) => {
        const visual = deriveChapterVisualState(
          index,
          controller.progress,
          controller.prefersReducedMotion
        );
        const style = {
          '--chapter-opacity': visual.opacity,
          '--chapter-scale': visual.scale,
          '--chapter-blur': `${visual.blurPx}px`,
          '--chapter-contrast': visual.contrast,
          zIndex: visual.zIndex
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
                phase={controller.phase}
                exitProgress={homeExitProgress}
                pointer={controller.pointer}
                isPaused={controller.isPaused}
                reducedMotion={controller.prefersReducedMotion}
                registerIntroSkip={controller.registerIntroSkip}
                onDrawingDone={controller.drawingDone}
                onSettled={controller.settled}
                onInitializationError={handleInitializationError}
              />
            ) : null}
            {isExplicitPlaceholder(chapter.id) ? (
              <PlaceholderChapter title={chapter.label} />
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
