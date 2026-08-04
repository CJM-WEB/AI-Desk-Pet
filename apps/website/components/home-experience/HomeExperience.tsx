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
  const active = exitProgress < 1;

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
      />
    </main>
  );
}
