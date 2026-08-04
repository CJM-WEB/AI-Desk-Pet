import type { ExperienceConfig } from './types';

export const EXPERIENCE_CONFIG = {
  colors: {
    background: 'rgb(235, 235, 235)'
  },
  intro: {
    settleSeconds: 0.8,
    magnetic: {
      assetPath: '/AP.png',
      blackHoldSeconds: 0.12,
      firstPieceDelaySeconds: 0.08,
      pieceSeconds: 0.72,
      pieceStaggerSeconds: 0.23,
      lockSeconds: 0.16,
      ease: 'back.out(0.45)',
      pieces: [
        {
          id: 'top-left',
          clip: { left: 0, top: 0, right: 54, bottom: 38 },
          transformOrigin: '27% 19%',
          from: { x: -80, y: -60, rotation: -12, scale: 0.72 }
        },
        {
          id: 'top-right',
          clip: { left: 46, top: 0, right: 100, bottom: 38 },
          transformOrigin: '73% 19%',
          from: { x: 90, y: -28, rotation: 9, scale: 0.72 }
        },
        {
          id: 'middle-left',
          clip: { left: 0, top: 29, right: 54, bottom: 71 },
          transformOrigin: '27% 50%',
          from: { x: -92, y: 74, rotation: -8, scale: 0.72 }
        },
        {
          id: 'middle-right',
          clip: { left: 46, top: 29, right: 100, bottom: 71 },
          transformOrigin: '73% 50%',
          from: { x: -38, y: 8, rotation: 14, scale: 0.72 }
        },
        {
          id: 'bottom-left',
          clip: { left: 0, top: 62, right: 54, bottom: 100 },
          transformOrigin: '27% 81%',
          from: { x: 92, y: 78, rotation: 11, scale: 0.72 }
        },
        {
          id: 'bottom-right',
          clip: { left: 46, top: 62, right: 100, bottom: 100 },
          transformOrigin: '73% 81%',
          from: { x: 0, y: 100, rotation: -7, scale: 0.72 }
        }
      ]
    }
  },
  progress: {
    wheelScale: 0.0065,
    keyboardStep: 0.12,
    snapThreshold: 0.06
  },
  swarm: {
    spawnIntervalMs: [480, 920],
    lifetimeMs: [6500, 10500]
  },
  pointer: {
    radius: 220,
    trailSeconds: 1.2,
    maxDevicePixelRatio: 1.75
  }
} as const satisfies ExperienceConfig;
