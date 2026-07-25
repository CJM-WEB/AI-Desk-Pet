import type { ExperienceConfig } from './types';

export const EXPERIENCE_CONFIG = {
  colors: {
    background: 'rgb(235, 235, 235)',
    pointerField: 'rgb(180, 180, 180)'
  },
  intro: {
    drawSeconds: 1.4,
    settleSeconds: 0.8
  },
  progress: {
    wheelScale: 0.00065,
    keyboardStep: 0.12,
    snapThreshold: 0.06
  },
  swarm: {
    maxActive: 10,
    safeZoneRatio: 0.3,
    spawnIntervalMs: [480, 920],
    lifetimeMs: [6500, 10500]
  },
  pointer: {
    radius: 220,
    trailSeconds: 1.2,
    maxDevicePixelRatio: 1.75
  }
} as const satisfies ExperienceConfig;
