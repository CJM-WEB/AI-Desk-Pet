'use client';

import { gsap } from 'gsap';
import { useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import type { ChapterRuntimeProps } from '../types';
import { createAboutFeatures } from './about-content';
import type { AboutFeatureId } from './about-content';
import styles from './about.module.css';

type GlassId = 'files' | 'companion' | 'editor';

interface DragState {
  id: GlassId;
  pointerId: number;
  startX: number;
  startY: number;
}

/**
 * 第二模块延续首页液态背景，以三块仍相连的玻璃承载原有功能介绍。
 */
export function AboutChapter({
  interactive,
  reducedMotion = false,
  staticFallback = false,
  transitionProgress = 1
}: ChapterRuntimeProps) {
  const { t } = useI18n();
  const features = useMemo(() => createAboutFeatures(t), [t]);
  const featureMap = useMemo(
    () => new Map(features.map((feature) => [feature.id, feature])),
    [features]
  );
  const glassRefs = useRef<Record<GlassId, HTMLElement | null>>({
    files: null,
    companion: null,
    editor: null
  });
  const dragRef = useRef<DragState | null>(null);
  const [hovered, setHovered] = useState<GlassId | 'none'>('none');
  const motionDisabled = reducedMotion || staticFallback;
  const progress = Math.min(1, Math.max(0, transitionProgress));

  const beginDrag = (id: GlassId, event: ReactPointerEvent<HTMLElement>) => {
    if (!interactive || motionDisabled) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY
    };
  };

  const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const target = glassRefs.current[drag.id];
    if (!target) return;
    gsap.set(target, {
      x: Math.max(-72, Math.min(72, event.clientX - drag.startX)),
      y: Math.max(-58, Math.min(58, event.clientY - drag.startY)),
      overwrite: true
    });
  };

  const releaseDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    const target = glassRefs.current[drag.id];
    if (!target) return;
    gsap.to(target, {
      x: 0,
      y: 0,
      duration: 1.05,
      ease: 'elastic.out(1, 0.42)',
      overwrite: true
    });
  };

  const renderFeature = (id: AboutFeatureId) => {
    const feature = featureMap.get(id);
    if (!feature) return null;
    return (
      <>
        <span className={styles.eyebrow}>{feature.eyebrow}</span>
        <h3>{feature.title}</h3>
        <p>{feature.summary}</p>
      </>
    );
  };

  return (
    <section
      className={styles.aboutChapter}
      data-testid="about-chapter"
      data-hovered={hovered}
      data-motion-disabled={motionDisabled}
      style={{ '--about-progress': progress } as CSSProperties}
    >
      <div className={styles.backgroundBlur} aria-hidden="true" />
      <div className={`${styles.cornerWord} ${styles.agentWord}`} aria-hidden="true">AGENT</div>
      <div className={`${styles.cornerWord} ${styles.yourWord}`} aria-hidden="true">YOUR</div>

      <div className={styles.glassField} aria-label={t('about.featurePlane')}>
        <span className={`${styles.liquidBridge} ${styles.bridgeTop}`} aria-hidden="true" />
        <span className={`${styles.liquidBridge} ${styles.bridgeBottom}`} aria-hidden="true" />

        <article
          ref={(node) => { glassRefs.current.files = node; }}
          className={`${styles.glass} ${styles.filesGlass}`}
          data-glass-id="files"
          tabIndex={interactive ? 0 : -1}
          onPointerEnter={() => setHovered('files')}
          onPointerLeave={() => setHovered('none')}
          onPointerDown={(event) => beginDrag('files', event)}
          onPointerMove={moveDrag}
          onPointerUp={releaseDrag}
          onPointerCancel={releaseDrag}
        >
          {renderFeature('file-management')}
        </article>

        <article
          ref={(node) => { glassRefs.current.companion = node; }}
          className={`${styles.glass} ${styles.companionGlass}`}
          data-glass-id="companion"
          tabIndex={interactive ? 0 : -1}
          onPointerEnter={() => setHovered('companion')}
          onPointerLeave={() => setHovered('none')}
          onPointerDown={(event) => beginDrag('companion', event)}
          onPointerMove={moveDrag}
          onPointerUp={releaseDrag}
          onPointerCancel={releaseDrag}
        >
          <div className={styles.primaryFeature}>{renderFeature('companion-chat')}</div>
          <div className={styles.sideFeatures}>
            <div>{renderFeature('security')}</div>
            <div>{renderFeature('desktop-organizer')}</div>
          </div>
        </article>

        <article
          ref={(node) => { glassRefs.current.editor = node; }}
          className={`${styles.glass} ${styles.editorGlass}`}
          data-glass-id="editor"
          tabIndex={interactive ? 0 : -1}
          onPointerEnter={() => setHovered('editor')}
          onPointerLeave={() => setHovered('none')}
          onPointerDown={(event) => beginDrag('editor', event)}
          onPointerMove={moveDrag}
          onPointerUp={releaseDrag}
          onPointerCancel={releaseDrag}
        >
          {renderFeature('text-editor')}
        </article>
      </div>
    </section>
  );
}
