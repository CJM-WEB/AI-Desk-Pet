'use client';

import { useCallback, useState } from 'react';
import type { CSSProperties } from 'react';
import { CursorField } from '../home-experience/CursorField';
import { FileSwarm } from '../home-experience/FileSwarm';
import { useI18n } from '../i18n/I18nProvider';
import homeStyles from '../home-experience/home-experience.module.css';
import type { PointerPoint } from '../home-experience/types';
import type { SharedVisualProfile } from './shared-visual-model';
import { CHAPTER_LAYERS } from './layer-contract';

export interface SharedVisualLayerProfile extends Omit<SharedVisualProfile, 'id'> {
  id: SharedVisualProfile['id'] | 'feedback';
}

export interface SharedVisualLayersProps {
  profile: SharedVisualLayerProfile;
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
  const { t } = useI18n();
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
  const fieldStyle = {
    ...exitStyle,
    zIndex: CHAPTER_LAYERS.field,
    pointerEvents: 'none'
  } as CSSProperties;
  const fileStyle = {
    ...exitStyle,
    zIndex: CHAPTER_LAYERS.files,
    pointerEvents: 'none'
  } as CSSProperties;
  const previewStyle = {
    zIndex: CHAPTER_LAYERS.preview,
    pointerEvents: 'none'
  } as CSSProperties;

  if (initializationFailed) {
    return null;
  }

  return (
    <>
      {profile.fieldEnabled ? (
        <section
          className={homeStyles.cursorLayer}
          data-layer="cursor"
          data-profile-id={profile.id}
          aria-hidden="true"
          style={fieldStyle}
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
      ) : null}
      <section
        className={homeStyles.fileLayer}
        data-layer="file"
        data-profile-id={profile.id}
        aria-label={t('shared.filePreviewQueue')}
        style={fileStyle}
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
          previewSource={profile.previewSource}
          previewContainer={previewLayer}
          onInitializationError={handleInitializationError}
        />
      </section>
      <div
        ref={setPreviewLayer}
        className={homeStyles.previewLayer}
        data-layer="preview"
        style={previewStyle}
      />
    </>
  );
}
