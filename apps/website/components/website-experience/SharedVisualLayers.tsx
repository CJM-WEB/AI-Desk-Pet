'use client';

import { useCallback, useState } from 'react';
import type { CSSProperties } from 'react';
import { CursorField } from '../home-experience/CursorField';
import { FileSwarm } from '../home-experience/FileSwarm';
import homeStyles from '../home-experience/home-experience.module.css';
import type { PointerPoint } from '../home-experience/types';
import type { SharedVisualProfile } from './shared-visual-model';

export interface SharedVisualLayersProps {
  profile: SharedVisualProfile;
  running: boolean;
  generating: boolean;
  exitProgress: number;
  pointer: PointerPoint;
  isPaused: boolean;
  reducedMotion: boolean;
  onInitializationError: () => void;
}

/**
 * 在官网根层持有唯一光场、文件粒子群和预览挂载点。
 */
export function SharedVisualLayers({
  profile,
  running,
  generating,
  exitProgress,
  pointer,
  isPaused,
  reducedMotion,
  onInitializationError
}: SharedVisualLayersProps) {
  const [initializationFailed, setInitializationFailed] = useState(false);
  const [previewLayer, setPreviewLayer] = useState<HTMLDivElement | null>(null);
  const handleInitializationError = useCallback(() => {
    setInitializationFailed(true);
    onInitializationError();
  }, [onInitializationError]);
  const layersRunning = running && !initializationFailed;
  const exitStyle = {
    '--experience-files-scale': 1 - exitProgress * 0.28,
    '--experience-field-opacity': 1 - exitProgress
  } as CSSProperties;

  if (initializationFailed) {
    return null;
  }

  return (
    <>
      <section
        className={homeStyles.cursorLayer}
        data-layer="cursor"
        data-profile-id={profile.id}
        aria-hidden="true"
        style={exitStyle}
      >
        <CursorField
          active={layersRunning}
          pointer={pointer}
          isPaused={isPaused}
          reducedMotion={reducedMotion}
          color={profile.fieldColor}
          onInitializationError={handleInitializationError}
        />
      </section>
      <section
        className={homeStyles.fileLayer}
        data-layer="file"
        data-profile-id={profile.id}
        aria-label="文件预览队列"
        style={exitStyle}
      >
        <FileSwarm
          key={profile.id}
          running={layersRunning}
          generating={generating && !initializationFailed}
          exitProgress={exitProgress}
          pointer={pointer}
          isPaused={isPaused}
          reducedMotion={reducedMotion}
          maxActive={profile.maxActive}
          safeZoneRatio={profile.safeZoneRatio}
          previewContainer={previewLayer}
          onInitializationError={handleInitializationError}
        />
      </section>
      <div
        ref={setPreviewLayer}
        className={homeStyles.previewLayer}
        data-layer="preview"
      />
    </>
  );
}
