'use client';

import { gsap } from 'gsap';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import { useI18n } from '../i18n/I18nProvider';
import { createContentPool } from './content-pool';
import { computePreviewPosition } from './pointer-model';
import type { FileParticle } from './swarm-model';
import type { PointerPoint } from './types';
import {
  DEFAULT_FILE_PREVIEW_CONTENT_SOURCE,
  type FilePreviewContentSource
} from '../website-experience/shared-visual-model';
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

export interface FilePreviewProps {
  particle: FileParticle | null;
  pointer: PointerPoint;
  anchorRect: PreviewAnchorRect | null;
  inputMode: PreviewInputMode;
  reducedMotion?: boolean;
  previewSource?: FilePreviewContentSource | undefined;
  onInitializationError?: (() => void) | undefined;
  onQuickToStateChange?: (state: 'active' | 'inactive') => void;
}

type QuickTo = ReturnType<typeof gsap.quickTo>;

interface QuickToCleanupOptions {
  notifyParent?: boolean;
  reportFailure?: boolean;
}

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
  previewSource = DEFAULT_FILE_PREVIEW_CONTENT_SOURCE,
  onInitializationError,
  onQuickToStateChange
}: FilePreviewProps) {
  const { t } = useI18n();
  const localizedPool = useMemo(() => createContentPool(t), [t]);
  const [displayedParticle, setDisplayedParticle] = useState<FileParticle | null>(particle);
  const previewRef = useRef<HTMLElement | null>(null);
  const quickXRef = useRef<QuickTo | null>(null);
  const quickYRef = useRef<QuickTo | null>(null);
  const quickToStateRef = useRef<'active' | 'inactive'>('inactive');
  const mountedRef = useRef(true);
  const initializationErrorReportedRef = useRef(false);
  const onInitializationErrorRef = useRef(onInitializationError);
  const onQuickToStateChangeRef = useRef(onQuickToStateChange);

  onInitializationErrorRef.current = onInitializationError;
  onQuickToStateChangeRef.current = onQuickToStateChange;

  const reportQuickToState = useCallback((state: 'active' | 'inactive') => {
    if (quickToStateRef.current === state) {
      return;
    }

    quickToStateRef.current = state;
    if (mountedRef.current) {
      onQuickToStateChangeRef.current?.(state);
    }
  }, []);

  const reportInitializationError = useCallback(() => {
    if (
      !mountedRef.current
      || initializationErrorReportedRef.current
    ) {
      return;
    }

    initializationErrorReportedRef.current = true;
    onInitializationErrorRef.current?.();
  }, []);

  const cleanupQuickTo = useCallback((
    options: QuickToCleanupOptions = {}
  ): boolean => {
    const {
      notifyParent = true,
      reportFailure = true
    } = options;
    const quickX = quickXRef.current;
    const quickY = quickYRef.current;
    quickXRef.current = null;
    quickYRef.current = null;
    let cleanupFailed = false;

    for (const quickTo of [quickX, quickY]) {
      try {
        quickTo?.tween.kill();
      } catch {
        cleanupFailed = true;
      }
    }

    try {
      previewRef.current?.setAttribute('data-motion-state', 'inactive');
    } catch {
      cleanupFailed = true;
    }

    if (notifyParent) {
      reportQuickToState('inactive');
    } else {
      quickToStateRef.current = 'inactive';
    }

    if (cleanupFailed && reportFailure) {
      reportInitializationError();
    }
    return !cleanupFailed;
  }, [reportInitializationError, reportQuickToState]);

  const applyMotionFallback = useCallback((
    node: HTMLElement | null,
    position?: { x: number; y: number }
  ) => {
    cleanupQuickTo({ reportFailure: false });
    if (node) {
      try {
        gsap.killTweensOf(node);
      } catch {
        // 统一回退不让二次清理异常逃逸。
      }

      try {
        node.setAttribute('data-motion-state', 'inactive');
        if (position) {
          node.style.transform = `translate3d(${position.x}px, ${position.y}px, 0)`;
        }
        node.style.opacity = '1';
      } catch {
        // DOM 已被移除时仅保留错误上报，不再触碰父级状态。
      }
    }
    reportInitializationError();
  }, [cleanupQuickTo, reportInitializationError]);

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
    let fadeTween: gsap.core.Tween;
    try {
      fadeTween = gsap.to(node, {
        opacity: 0,
        duration: 0.1,
        ease: 'power1.out',
        overwrite: true,
        onComplete: () => {
          if (!mountedRef.current) return;
          setDisplayedParticle((current) => (
            current?.id === leavingId ? null : current
          ));
        }
      });
    } catch {
      applyMotionFallback(node);
      if (mountedRef.current) {
        setDisplayedParticle(null);
      }
      return;
    }

    return () => {
      try {
        fadeTween.kill();
      } catch {
        applyMotionFallback(node);
      }
    };
  }, [
    applyMotionFallback,
    cleanupQuickTo,
    displayedParticle,
    particle,
    reducedMotion
  ]);

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

    try {
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
    } catch {
      applyMotionFallback(node, position);
    }
  }, [
    applyMotionFallback,
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

  useLayoutEffect(() => {
    mountedRef.current = true;

    return () => {
      // 最终卸载先关闭父级通知，再尽力回收本地动画资源。
      mountedRef.current = false;
      cleanupQuickTo({
        notifyParent: false,
        reportFailure: false
      });
      if (previewRef.current) {
        try {
          gsap.killTweensOf(previewRef.current);
        } catch {
          // 最终卸载不再向父级上报，避免触发已卸载树的状态更新。
        }
      }
    };
  }, [cleanupQuickTo]);

  if (!displayedParticle) {
    return null;
  }

  const { kind, preview } = displayedParticle;
  const previewIndex = displayedParticle.previewIndex;
  const localizedPreview = previewIndex === undefined
    ? preview
    : localizedPool[kind][previewIndex] ?? preview;
  const previewLines = previewSource === DEFAULT_FILE_PREVIEW_CONTENT_SOURCE
    && previewIndex !== undefined
    ? localizedPreview.lines
    : previewSource.getPreview(displayedParticle);

  return (
    <article
      ref={previewRef}
      className={styles.filePreview}
      data-testid="file-preview"
      data-kind={kind}
      data-motion-state="inactive"
      role="status"
      aria-label={t('shared.filePreview')}
      aria-live="polite"
      aria-atomic="true"
    >
      <header className={styles.previewHeader}>
        <h2>{localizedPreview.title}</h2>
        <p>{localizedPreview.meta}</p>
      </header>

      {kind === 'xls' ? (
        <dl className={styles.previewDataGrid}>
          {previewLines.map((line) => {
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
          {previewLines.map((line) => <li key={line}>{line}</li>)}
        </ul>
      ) : kind === 'empty' ? (
        <p className={styles.previewEmpty}>{previewLines.join(' · ')}</p>
      ) : (
        <ul className={styles.previewLines}>
          {previewLines.map((line) => <li key={line}>{line}</li>)}
        </ul>
      )}
    </article>
  );
}
