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

export interface MagneticClipBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface MagneticPieceConfig {
  id: string;
  clip: MagneticClipBounds;
  transformOrigin: string;
  from: {
    x: number;
    y: number;
    rotation: number;
    scale: number;
  };
}

export interface MagneticIntroConfig {
  assetPath: string;
  blackHoldSeconds: number;
  firstPieceDelaySeconds: number;
  pieceSeconds: number;
  pieceStaggerSeconds: number;
  lockSeconds: number;
  ease: string;
  pieces: readonly MagneticPieceConfig[];
}

export interface BrandTransformLimits {
  maxRotateX: number;
  maxRotateY: number;
  maxX: number;
  maxY: number;
}

export interface ExperienceConfig {
  colors: {
    background: string;
    pointerField: string;
  };
  intro: {
    settleSeconds: number;
    magnetic: MagneticIntroConfig;
  };
  brandTransform: BrandTransformLimits;
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
