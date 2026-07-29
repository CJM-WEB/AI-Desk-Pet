'use client';

import { gsap } from 'gsap';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState
} from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { PointerPoint } from '../../home-experience/types';
import { useI18n } from '../../i18n/I18nProvider';
import type { ChapterRuntimeProps } from '../types';
import { PointerTiltText } from '../visual/PointerTiltText';
import { AboutFeaturePanel } from './AboutFeaturePanel';
import { AboutFeaturePreview } from './AboutFeaturePreview';
import { createAboutFeatures } from './about-content';
import {
  initialAboutInteraction,
  isInsideAboutSafeZone,
  reduceAboutInteraction,
  visibleAboutFeatureId
} from './about-model';
import styles from './about.module.css';

const MOBILE_QUERY = '(max-width: 760px)';
const INITIAL_POINTER: PointerPoint = { x: 0, y: 0 };
const INITIAL_VIEWPORT = { width: 0, height: 0 };

function syncViewport() {
  return { width: window.innerWidth, height: window.innerHeight };
}

/**
 * 介绍章节使用模型驱动的临时悬停和移动端锁定，并把预览置于章节外的 Portal 层。
 */
export function AboutChapter({
  interactive,
  isPaused = false,
  reducedMotion = false,
  staticFallback = false,
  onInitializationError
}: ChapterRuntimeProps) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLElement | null>(null);
  const entranceConsumedRef = useRef(false);
  const [interaction, dispatch] = useReducer(reduceAboutInteraction, initialAboutInteraction);
  const [mobile, setMobile] = useState(false);
  const [pointer, setPointer] = useState<PointerPoint>(INITIAL_POINTER);
  const [viewport, setViewport] = useState(INITIAL_VIEWPORT);
  const [entranceState, setEntranceState] = useState<'pending' | 'visible'>('visible');
  const motionDisabled = reducedMotion || staticFallback || isPaused;
  const features = useMemo(() => createAboutFeatures(t), [t]);
  const layout = viewport.width <= 760
    && viewport.height <= 520
    && viewport.width > viewport.height
    ? 'compact-landscape'
    : 'default';
  const activeFeatureId = visibleAboutFeatureId(interaction);
  const activeFeature = useMemo(
    () => features.find((feature) => feature.id === activeFeatureId) ?? null,
    [activeFeatureId, features]
  );

  useEffect(() => {
    if (
      typeof window === 'undefined'
      || typeof window.matchMedia !== 'function'
    ) return;

    const updateViewport = () => setViewport(syncViewport());
    let media: MediaQueryList | null = null;
    let mediaRegistered = false;
    let resizeRegistered = false;

    try {
      media = window.matchMedia(MOBILE_QUERY);
      const updateMedia = () => setMobile(media?.matches ?? false);
      updateMedia();
      updateViewport();
      media.addEventListener?.('change', updateMedia);
      mediaRegistered = true;
      window.addEventListener('resize', updateViewport);
      resizeRegistered = true;

      return () => {
        if (mediaRegistered) {
          media?.removeEventListener?.('change', updateMedia);
        }
        if (resizeRegistered) {
          window.removeEventListener('resize', updateViewport);
        }
      };
    } catch {
      // 父级控制器负责统一降级；此处只回滚局部监听，避免异常逃逸。
      if (resizeRegistered) {
        window.removeEventListener('resize', updateViewport);
      }
      setMobile(false);
      updateViewport();
    }
  }, []);

  useEffect(() => {
    if (!interactive) dispatch({ type: 'RESET' });
  }, [interactive]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !interactive) {
      setEntranceState('visible');
      return;
    }

    if (motionDisabled || entranceConsumedRef.current) {
      entranceConsumedRef.current = true;
      setEntranceState('visible');
      return;
    }

    entranceConsumedRef.current = true;
    setEntranceState('pending');
    let context: gsap.Context | null = null;
    try {
      context = gsap.context(() => {
        const panels = Array.from(root.querySelectorAll<HTMLElement>('[data-about-feature]'));
        const title = root.querySelector<HTMLElement>('[data-about-title]');
        const timeline = gsap.timeline({
          defaults: { ease: 'power3.out' },
          onComplete: () => setEntranceState('visible')
        });
        timeline.fromTo(
          panels,
          { autoAlpha: 0, scale: 1.16 },
          { autoAlpha: 1, scale: 1, duration: 0.48, stagger: 0.09 }
        );
        if (title) {
          timeline.fromTo(
            title,
            { autoAlpha: 0, scale: 1.08 },
            { autoAlpha: 1, scale: 1, duration: 0.38 },
            '>-0.04'
          );
        }
      }, root);
    } catch {
      setEntranceState('visible');
      onInitializationError?.();
    }
    return () => {
      try {
        context?.revert();
      } catch {
        // 章节切换仍挂载在页面中时上报；整页卸载时避免触发卸载后的父级更新。
        queueMicrotask(() => {
          if (root.isConnected) {
            onInitializationError?.();
          }
        });
      }
    };
  }, [interactive, motionDisabled, onInitializationError]);

  const clearHoverForSafeZone = (event: ReactPointerEvent<HTMLElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const point = {
      x: (event.clientX - bounds.left) / bounds.width,
      y: (event.clientY - bounds.top) / bounds.height
    };
    if (isInsideAboutSafeZone(point)) {
      dispatch({ type: 'SET_HOVER', id: null });
    }
  };

  return (
    <section
      ref={rootRef}
      className={styles.aboutChapter}
      data-testid="about-chapter"
      data-active-feature={activeFeatureId ?? 'none'}
      data-motion-disabled={motionDisabled}
      data-entrance-state={entranceState}
      data-layout={layout}
      onPointerMove={(event) => {
        setPointer({ x: event.clientX, y: event.clientY });
        if (!mobile) clearHoverForSafeZone(event);
      }}
      onPointerLeave={() => {
        if (!mobile) dispatch({ type: 'SET_HOVER', id: null });
      }}
      onClick={(event) => {
        if (mobile) {
          dispatch({ type: 'CLEAR_MOBILE_LOCK' });
        }
      }}
    >
      <div className={styles.featurePlane} aria-label={t('about.featurePlane')}>
        {features.map((feature) => (
          <AboutFeaturePanel
            key={feature.id}
            feature={feature}
            active={activeFeatureId === feature.id}
            interactive={interactive}
            mobile={mobile}
            onHoverChange={(id) => dispatch({ type: 'SET_HOVER', id })}
            onFocusChange={(id) => dispatch({ type: 'SET_FOCUS', id })}
            onMobileToggle={(id) => dispatch({ type: 'TOGGLE_MOBILE_LOCK', id })}
          />
        ))}
      </div>
      <div
        className={styles.titleSafeZone}
        data-about-title
        data-about-safe-zone
        onPointerEnter={() => dispatch({ type: 'SET_HOVER', id: null })}
      >
        <h2>
          <PointerTiltText pointer={pointer} viewport={viewport} disabled={motionDisabled}>
            AI Pet
          </PointerTiltText>
        </h2>
      </div>
      <AboutFeaturePreview feature={activeFeature} pointer={pointer} reducedMotion={motionDisabled} />
    </section>
  );
}
