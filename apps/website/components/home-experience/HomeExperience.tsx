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
  // 前五个模块连续复用首页液态玻璃；离开合并支持模块后再释放上下文。
  const active = exitProgress < 4.08;

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
