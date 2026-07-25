export type ChapterId = 'home' | 'about' | 'download' | 'feedback' | 'donation';
export type ChapterDirection = -1 | 0 | 1;

export interface ChapterVisualState {
  opacity: number;
  scale: number;
  blurPx: number;
  contrast: number;
  zIndex: number;
  visible: boolean;
  interactive: boolean;
}
