import { useEffect, useState } from 'react';
import type { CSSProperties, Ref } from 'react';
import { MagneticAPMark } from './MagneticAPMark';
import { computeBrandTransform } from './pointer-model';
import type { PointerPoint } from './types';
import styles from './home-experience.module.css';

interface BrandStageProps {
  stageRef?: Ref<HTMLDivElement>;
  pointer: PointerPoint;
  interactive: boolean;
  isPaused: boolean;
  reducedMotion: boolean;
  magneticAssetFailed?: boolean;
  finalLogoFailed?: boolean;
  onMagneticAssetError?: () => void;
  onFinalLogoError?: () => void;
}

export function BrandStage({
  stageRef,
  pointer,
  interactive,
  isPaused,
  reducedMotion,
  magneticAssetFailed = false,
  finalLogoFailed = false,
  onMagneticAssetError,
  onFinalLogoError
}: BrandStageProps) {
  const [viewport, setViewport] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const updateViewport = () => {
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    };

    updateViewport();
    window.addEventListener('resize', updateViewport);
    return () => window.removeEventListener('resize', updateViewport);
  }, []);

  const motionEnabled = interactive && !isPaused && !reducedMotion;
  const transform = motionEnabled
    ? computeBrandTransform(pointer, viewport)
    : { rotateX: 0, rotateY: 0, x: 0, y: 0 };
  const transformStyle = {
    '--brand-x': `${transform.x}px`,
    '--brand-y': `${transform.y}px`,
    '--brand-rotate-x': `${transform.rotateX}deg`,
    '--brand-rotate-y': `${transform.rotateY}deg`
  } as CSSProperties;

  return (
    <div
      className={styles.brandStage}
      data-testid="brand-stage"
      data-layer="brand"
      data-interactive={interactive}
      data-final-image-failed={finalLogoFailed}
    >
      <div
        ref={stageRef}
        className={styles.brandIntroMotion}
      >
        <div
          className={styles.brandTransform}
          data-motion-enabled={motionEnabled}
          style={transformStyle}
        >
          <div className={styles.brandMark}>
            {!finalLogoFailed ? (
              <img
                className={styles.brandLogo}
                data-testid="brand-logo"
                src="/AP.png"
                alt=""
                onError={onFinalLogoError}
              />
            ) : null}
            {!magneticAssetFailed ? (
              <MagneticAPMark onImageError={onMagneticAssetError} />
            ) : null}
          </div>
          <h1>AI Pet</h1>
        </div>
      </div>
    </div>
  );
}
