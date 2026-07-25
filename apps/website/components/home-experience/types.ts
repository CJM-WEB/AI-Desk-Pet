export type ExperiencePhase =
  | 'loading'
  | 'drawing'
  | 'settling'
  | 'interactive'
  | 'exiting';

export type FileKind = 'txt' | 'pdf' | 'ppt' | 'xls' | 'img' | 'empty' | 'folder';

export interface PointerPoint {
  x: number;
  y: number;
}

export interface ExperienceConfig {
  colors: {
    background: string;
    pointerField: string;
  };
  intro: {
    drawSeconds: number;
    settleSeconds: number;
  };
  progress: {
    wheelScale: number;
    keyboardStep: number;
    snapThreshold: number;
  };
  swarm: {
    maxActive: number;
    safeZoneRatio: number;
    spawnIntervalMs: readonly [number, number];
    lifetimeMs: readonly [number, number];
  };
  pointer: {
    radius: number;
    trailSeconds: number;
    maxDevicePixelRatio: number;
  };
}
