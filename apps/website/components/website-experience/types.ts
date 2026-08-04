export type ChapterId = 'home' | 'about' | 'download' | 'community' | 'feedback' | 'donation';
export type ChapterDirection = -1 | 0 | 1;

export interface ChapterRuntimeProps {
  interactive: boolean;
  transitionProgress?: number;
  isPaused?: boolean;
  reducedMotion?: boolean;
  staticFallback?: boolean;
  onInitializationError?: () => void;
}

export interface ChapterVisualState {
  opacity: number;
  scale: number;
  blurPx: number;
  contrast: number;
  zIndex: number;
  visible: boolean;
  interactive: boolean;
}
