import type { CSSProperties } from 'react';
import type { ChapterId } from '../types';
import styles from './chapter-backdrop.module.css';

const BACKDROP_TONES = [
  'rgb(200, 200, 200)',
  'rgb(205, 205, 205)',
  'rgb(210, 210, 210)',
  'rgb(215, 215, 215)',
  'rgb(220, 220, 220)',
  'rgb(225, 225, 225)'
] as const;

interface ChapterBackdropProps {
  chapterId: ChapterId;
  useBackdropDataAttribute?: boolean;
}

/**
 * 用固定六阶灰色面片为各章节提供可区分的放射背景。
 */
export function ChapterBackdrop({
  chapterId,
  useBackdropDataAttribute = false
}: ChapterBackdropProps) {
  return (
    <div
      className={styles.backdrop}
      data-testid="chapter-backdrop"
      data-chapter-id={useBackdropDataAttribute ? undefined : chapterId}
      data-backdrop-chapter-id={useBackdropDataAttribute ? chapterId : undefined}
      aria-hidden="true"
    >
      {BACKDROP_TONES.map((tone) => (
        <span
          key={tone}
          data-backdrop-panel="true"
          style={{ '--backdrop-tone': tone } as CSSProperties}
        />
      ))}
    </div>
  );
}
