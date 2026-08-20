'use client';

import { gsap } from 'gsap';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import {
  LIQUID_GLASS_INTERACTION_EVENT,
  LIQUID_GLASS_RIPPLE_EVENT
} from '../../home-experience/LiquidGlassHome';
import type { LiquidGlassInteractionDetail } from '../../home-experience/LiquidGlassHome';
import { useI18n } from '../../i18n/I18nProvider';
import type { ChapterRuntimeProps } from '../types';
import { createAboutFeatures } from './about-content';
import type { AboutFeatureId } from './about-content';
import styles from './about.module.css';

type GlassIndex = 0 | 1 | 2;

interface DragState {
  index: GlassIndex;
  pointerId: number;
  startX: number;
  startY: number;
}

const GLASS_IDS = ['editor', 'companion', 'files'] as const;

/** 第二模块只绘制文字命中层，玻璃本体由首页同一个 WebGL 着色器连续形变。 */
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
  const articleRefs = useRef<Array<HTMLElement | null>>([null, null, null]);
  const offsetsRef = useRef([
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 }
  ]);
  const dragRef = useRef<DragState | null>(null);
  const returningRef = useRef(false);
  const hoveredRef = useRef<-1 | GlassIndex>(-1);
  const [hovered, setHovered] = useState<-1 | GlassIndex>(-1);
  const progress = Math.min(1, Math.max(0, transitionProgress));
  const exitProgress = Math.min(1, Math.max(0, transitionProgress - 1));
  const motionDisabled = reducedMotion || staticFallback;

  const publishInteraction = (nextHovered = hoveredRef.current) => {
    if (typeof window === 'undefined') return;
    const [first, second, third] = offsetsRef.current;
    const width = Math.max(window.innerWidth, 1);
    const height = Math.max(window.innerHeight, 1);
    const offsetY = (value: number) => value === 0 ? 0 : -value / height;
    const offsets: LiquidGlassInteractionDetail['offsets'] = [
      first!.x / width, offsetY(first!.y),
      second!.x / width, offsetY(second!.y),
      third!.x / width, offsetY(third!.y)
    ];
    window.dispatchEvent(new CustomEvent<LiquidGlassInteractionDetail>(
      LIQUID_GLASS_INTERACTION_EVENT,
      {
        detail: {
          hovered: nextHovered,
          dragging: dragRef.current !== null || returningRef.current,
          offsets
        }
      }
    ));
  };

  useEffect(() => () => {
    offsetsRef.current.forEach(offset => gsap.killTweensOf(offset));
    window.dispatchEvent(new CustomEvent<LiquidGlassInteractionDetail>(
      LIQUID_GLASS_INTERACTION_EVENT,
      { detail: { hovered: -1, dragging: false, offsets: [0, 0, 0, 0, 0, 0] } }
    ));
  }, []);

  const setHover = (index: -1 | GlassIndex) => {
    hoveredRef.current = index;
    setHovered(index);
    publishInteraction(index);
  };

  const beginDrag = (index: GlassIndex, event: ReactPointerEvent<HTMLElement>) => {
    if (!interactive || motionDisabled) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      index,
      pointerId: event.pointerId,
      startX: event.clientX - offsetsRef.current[index]!.x,
      startY: event.clientY - offsetsRef.current[index]!.y
    };
    setHover(index);
    window.dispatchEvent(new CustomEvent(LIQUID_GLASS_RIPPLE_EVENT, {
      detail: { clientX: event.clientX, clientY: event.clientY, strength: 1.35 }
    }));
  };

  const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const offset = offsetsRef.current[drag.index]!;
    offset.x = Math.max(-92, Math.min(92, event.clientX - drag.startX));
    offset.y = Math.max(-72, Math.min(72, event.clientY - drag.startY));
    const article = articleRefs.current[drag.index];
    if (article) gsap.set(article, { x: offset.x, y: offset.y });
    publishInteraction(drag.index);
  };

  const releaseDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    returningRef.current = true;
    const offset = offsetsRef.current[drag.index]!;
    const article = articleRefs.current[drag.index];
    gsap.to(offset, {
      x: 0,
      y: 0,
      duration: 1.15,
      ease: 'elastic.out(1, 0.42)',
      overwrite: true,
      onUpdate: () => {
        if (article) gsap.set(article, { x: offset.x, y: offset.y });
        publishInteraction(hoveredRef.current);
      },
      onComplete: () => {
        returningRef.current = false;
        publishInteraction(hoveredRef.current);
      }
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

  const articleEvents = (index: GlassIndex) => ({
    onPointerEnter: () => setHover(index),
    onPointerLeave: () => {
      if (!dragRef.current) setHover(-1);
    },
    onFocus: () => setHover(index),
    onBlur: () => setHover(-1),
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => beginDrag(index, event),
    onPointerMove: moveDrag,
    onPointerUp: releaseDrag,
    onPointerCancel: releaseDrag
  });

  return (
    <section
      className={styles.aboutChapter}
      data-testid="about-chapter"
      data-hovered={hovered}
      data-motion-disabled={motionDisabled}
      data-static-fallback={reducedMotion || staticFallback}
      style={{
        '--about-progress': progress,
        '--about-exit': exitProgress
      } as CSSProperties}
    >
      <div className={styles.glassField} aria-label={t('about.featurePlane')}>
        <aside className={`${styles.detachedFeature} ${styles.securityFeature}`}>
          {renderFeature('security')}
        </aside>
        <aside className={`${styles.detachedFeature} ${styles.desktopFeature}`}>
          {renderFeature('desktop-organizer')}
        </aside>

        <article
          ref={(node) => { articleRefs.current[0] = node; }}
          className={`${styles.glassContent} ${styles.editorGlass}`}
          data-glass-id={GLASS_IDS[0]}
          tabIndex={interactive ? 0 : -1}
          {...articleEvents(0)}
        >
          <div
            className={styles.glassTextFallback}
            data-layout-ignore={!staticFallback ? true : undefined}
          >
            {renderFeature('text-editor')}
          </div>
        </article>

        <article
          ref={(node) => { articleRefs.current[1] = node; }}
          className={`${styles.glassContent} ${styles.companionGlass}`}
          data-glass-id={GLASS_IDS[1]}
          tabIndex={interactive ? 0 : -1}
          {...articleEvents(1)}
        >
          <div
            className={styles.glassTextFallback}
            data-layout-ignore={!staticFallback ? true : undefined}
          >
            {renderFeature('companion-chat')}
          </div>
        </article>

        <article
          ref={(node) => { articleRefs.current[2] = node; }}
          className={`${styles.glassContent} ${styles.filesGlass}`}
          data-glass-id={GLASS_IDS[2]}
          tabIndex={interactive ? 0 : -1}
          {...articleEvents(2)}
        >
          <div
            className={styles.glassTextFallback}
            data-layout-ignore={!staticFallback ? true : undefined}
          >
            {renderFeature('file-management')}
          </div>
        </article>
      </div>
    </section>
  );
}
