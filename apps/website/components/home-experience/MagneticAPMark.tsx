import type { CSSProperties } from 'react';
import { EXPERIENCE_CONFIG } from './config';
import { toClipPath } from './magnetic-intro-model';
import styles from './home-experience.module.css';

interface MagneticAPMarkProps {
  onImageError?: (() => void) | undefined;
}

export function MagneticAPMark({ onImageError }: MagneticAPMarkProps = {}) {
  const magnetic = EXPERIENCE_CONFIG.intro.magnetic;

  return (
    <div
      className={styles.magneticMark}
      data-testid="magnetic-ap-mark"
      aria-hidden="true"
    >
      {magnetic.pieces.map((piece) => {
        const style = {
          clipPath: toClipPath(piece.clip),
          transformOrigin: piece.transformOrigin
        } as CSSProperties;

        return (
          <img
            key={piece.id}
            className={styles.magneticPiece}
            data-testid="magnetic-logo-piece"
            data-piece-id={piece.id}
            src={magnetic.assetPath}
            alt=""
            style={style}
            onError={onImageError}
          />
        );
      })}
    </div>
  );
}
