'use client';

import { createPortal } from 'react-dom';
import { useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { computePreviewPosition } from '../../home-experience/pointer-model';
import type { PointerPoint } from '../../home-experience/types';
import type { AboutFeature } from './about-content';
import styles from './about.module.css';

const PREVIEW_GAP_PX = 18;

export interface AboutFeaturePreviewProps {
  feature: AboutFeature | null;
  pointer: PointerPoint;
  reducedMotion: boolean;
}

/**
 * 预览始终通过 Portal 放在根级预览层，避免被章节缩放和局部溢出裁切。
 */
export function AboutFeaturePreview({ feature, pointer, reducedMotion }: AboutFeaturePreviewProps) {
  const previewRef = useRef<HTMLElement | null>(null);
  const [position, setPosition] = useState<PointerPoint>({ x: 0, y: 0 });

  useLayoutEffect(() => {
    if (!feature || !previewRef.current || typeof window === 'undefined') return;
    const bounds = previewRef.current.getBoundingClientRect();
    setPosition(computePreviewPosition({
      pointer,
      preview: { width: bounds.width, height: bounds.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      gap: PREVIEW_GAP_PX
    }));
  }, [feature, pointer.x, pointer.y]);

  if (!feature || typeof document === 'undefined') return null;
  const Icon = feature.icon;
  const style = {
    '--about-preview-x': `${position.x}px`,
    '--about-preview-y': `${position.y}px`
  } as CSSProperties;

  return createPortal(
    <aside
      id={`about-feature-preview-${feature.id}`}
      ref={previewRef}
      className={styles.featurePreview}
      data-testid="about-feature-preview"
      data-feature-id={feature.id}
      data-reduced-motion={reducedMotion}
      role="tooltip"
      style={style}
    >
      <header>
        <Icon aria-hidden="true" />
        <div><p>{feature.eyebrow}</p><h3>{feature.title}</h3></div>
      </header>
      <p>{feature.summary}</p>
      <ul>{feature.details.map((detail) => <li key={detail}>{detail}</li>)}</ul>
    </aside>,
    document.body
  );
}
