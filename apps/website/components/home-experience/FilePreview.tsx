'use client';

import { gsap } from 'gsap';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from 'react';
import { computePreviewPosition } from './pointer-model';
import type { FileParticle } from './swarm-model';
import type { PointerPoint } from './types';
import styles from './home-experience.module.css';

const PREVIEW_GAP_PX = 18;

export interface PreviewAnchorRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export type PreviewInputMode = 'pointer' | 'keyboard';

interface FilePreviewProps {
  particle: FileParticle | null;
  pointer: PointerPoint;
  anchorRect: PreviewAnchorRect | null;
  inputMode: PreviewInputMode;
  reducedMotion?: boolean;
  onQuickToStateChange?: (state: 'active' | 'inactive') => void;
}

type QuickTo = ReturnType<typeof gsap.quickTo>;

function splitDataLine(line: string): { label: string; value: string } {
  const separator = line.lastIndexOf(' ');

  if (separator < 0) {
    return { label: line, value: '' };
  }

  return {
    label: line.slice(0, separator),
    value: line.slice(separator + 1)
  };
}

/**
 * 页面级单例预览，负责测量、定位动画与离场资源回收。
 */
export function FilePreview({
  particle,
  pointer,
  anchorRect,
  inputMode,
  reducedMotion = false,
  onQuickToStateChange
}: FilePreviewProps) {
  const [displayedParticle, setDisplayedParticle] = useState<FileParticle | null>(particle);
  const previewRef = useRef<HTMLElement | null>(null);
  const quickXRef = useRef<QuickTo | null>(null);
  const quickYRef = useRef<QuickTo | null>(null);
  const quickToStateRef = useRef<'active' | 'inactive'>('inactive');
  const onQuickToStateChangeRef = useRef(onQuickToStateChange);

  onQuickToStateChangeRef.current = onQuickToStateChange;

  const reportQuickToState = useCallback((state: 'active' | 'inactive') => {
    if (quickToStateRef.current === state) {
      return;
    }

    quickToStateRef.current = state;
    onQuickToStateChangeRef.current?.(state);
  }, []);

  const cleanupQuickTo = useCallback(() => {
    quickXRef.current?.tween.kill();
    quickYRef.current?.tween.kill();
    quickXRef.current = null;
    quickYRef.current = null;
    previewRef.current?.setAttribute('data-motion-state', 'inactive');
    reportQuickToState('inactive');
  }, [reportQuickToState]);

  useEffect(() => {
    if (particle) {
      setDisplayedParticle((current) => (
        current?.id === particle.id ? current : particle
      ));
      return;
    }

    const node = previewRef.current;
    if (!displayedParticle || !node) {
      cleanupQuickTo();
      setDisplayedParticle(null);
      return;
    }

    cleanupQuickTo();
    if (reducedMotion) {
      setDisplayedParticle(null);
      return;
    }

    const leavingId = displayedParticle.id;
    const fadeTween = gsap.to(node, {
      opacity: 0,
      duration: 0.1,
      ease: 'power1.out',
      overwrite: true,
      onComplete: () => {
        setDisplayedParticle((current) => (
          current?.id === leavingId ? null : current
        ));
      }
    });

    return () => {
      fadeTween.kill();
    };
  }, [cleanupQuickTo, displayedParticle, particle, reducedMotion]);

  useEffect(() => {
    const node = previewRef.current;
    if (!particle || !displayedParticle || !node) {
      return;
    }

    const bounds = node.getBoundingClientRect();
    const target = inputMode === 'keyboard' && anchorRect
      ? {
          x: anchorRect.right,
          y: anchorRect.top + (anchorRect.height / 2)
        }
      : pointer;
    const position = computePreviewPosition({
      pointer: target,
      preview: { width: bounds.width, height: bounds.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      gap: PREVIEW_GAP_PX
    });

    if (reducedMotion) {
      cleanupQuickTo();
      node.style.transform = `translate3d(${position.x}px, ${position.y}px, 0)`;
      node.style.opacity = '1';
      return;
    }

    if (!quickXRef.current || !quickYRef.current) {
      quickXRef.current = gsap.quickTo(node, 'x', {
        duration: 0.18,
        ease: 'power2.out'
      });
      quickYRef.current = gsap.quickTo(node, 'y', {
        duration: 0.18,
        ease: 'power2.out'
      });
      node.setAttribute('data-motion-state', 'active');
      reportQuickToState('active');
    }

    quickXRef.current(position.x);
    quickYRef.current(position.y);
    gsap.to(node, {
      opacity: 1,
      duration: 0.1,
      ease: 'power1.out',
      overwrite: 'auto'
    });
  }, [
    anchorRect,
    displayedParticle,
    inputMode,
    particle,
    pointer.x,
    pointer.y,
    reducedMotion,
    cleanupQuickTo,
    reportQuickToState
  ]);

  useLayoutEffect(() => () => {
    cleanupQuickTo();
    if (previewRef.current) {
      gsap.killTweensOf(previewRef.current);
    }
  }, [cleanupQuickTo]);

  if (!displayedParticle) {
    return null;
  }

  const { kind, preview } = displayedParticle;

  return (
    <article
      ref={previewRef}
      className={styles.filePreview}
      data-testid="file-preview"
      data-kind={kind}
      data-motion-state="inactive"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <header className={styles.previewHeader}>
        <h2>{preview.title}</h2>
        <p>{preview.meta}</p>
      </header>

      {kind === 'xls' ? (
        <dl className={styles.previewDataGrid}>
          {preview.lines.map((line) => {
            const data = splitDataLine(line);
            return (
              <div key={line}>
                <dt>{data.label}</dt>
                <dd>{data.value}</dd>
              </div>
            );
          })}
        </dl>
      ) : kind === 'folder' ? (
        <ul className={styles.previewFolderList}>
          {preview.lines.map((line) => <li key={line}>{line}</li>)}
        </ul>
      ) : kind === 'empty' ? (
        <p className={styles.previewEmpty}>{preview.lines.join(' · ')}</p>
      ) : (
        <ul className={styles.previewLines}>
          {preview.lines.map((line) => <li key={line}>{line}</li>)}
        </ul>
      )}
    </article>
  );
}
