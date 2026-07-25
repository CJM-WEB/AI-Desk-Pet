import type { ExperiencePhase } from '../home-experience/types';

export type RgbColor = readonly [number, number, number];

export interface SharedVisualProfile {
  id: 'home' | 'donation';
  fieldColor: RgbColor;
  maxActive: number;
  safeZoneRatio: number;
}

export const VISUAL_PROFILES = {
  home: {
    id: 'home',
    fieldColor: [180, 180, 180],
    maxActive: 10,
    safeZoneRatio: 0.3
  },
  donation: {
    id: 'donation',
    fieldColor: [255, 255, 0],
    maxActive: 8,
    safeZoneRatio: 0.34
  }
} as const satisfies Record<string, SharedVisualProfile>;

/**
 * 只在首页退场区间和捐款章节入场区间提供共享视觉主题。
 */
export function resolveSharedVisualProfile(
  progress: number,
  phase: ExperiencePhase
): SharedVisualProfile | null {
  if (phase !== 'interactive' && phase !== 'exiting') return null;
  if (progress < 1) return VISUAL_PROFILES.home;
  if (progress > 3) return VISUAL_PROFILES.donation;
  return null;
}
