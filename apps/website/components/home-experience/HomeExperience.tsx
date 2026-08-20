'use client';

import { LiquidGlassHome } from './LiquidGlassHome';
import styles from './home-experience.module.css';

export interface HomeExperienceProps {
  exitProgress: number;
  isPaused: boolean;
  reducedMotion: boolean;
}

/**
 * 首页只承载新版液态玻璃；磁吸开场技术保留为独立源码，不进入当前运行链路。
 */
export function HomeExperience({
  exitProgress,
  isPaused,
  reducedMotion
}: HomeExperienceProps) {
  // 仅在首页到介绍章节的交接窗口保留 GPU 上下文。
  const active = exitProgress < 1.08;

  return (
    <main
      className={styles.experience}
      data-testid="home-experience"
      data-phase={exitProgress > 0 ? 'exiting' : 'interactive'}
      data-progress={exitProgress.toFixed(4)}
      data-liquid-home-active={active}
    >
      <LiquidGlassHome
        active={active}
        isPaused={isPaused}
        reducedMotion={reducedMotion}
        transitionProgress={Math.min(4, Math.max(0, exitProgress))}
      />
    </main>
  );
}
