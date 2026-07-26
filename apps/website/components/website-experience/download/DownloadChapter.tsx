'use client';

import { useEffect, useReducer, useRef, useState } from 'react';
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent
} from 'react';
import {
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock3,
  Download,
  FileCheck2,
  Monitor,
  ShieldCheck
} from 'lucide-react';
import { gsap } from 'gsap';
import {
  DOWNLOAD_PLATFORMS,
  FAQ_ITEMS,
  INSTALL_NOTICE_ITEMS
} from './download-content';
import {
  initialDownloadInteraction,
  reduceDownloadInteraction,
  rotatePlatformIndex,
  visibleDownloadSide
} from './download-model';
import type {
  DownloadSide,
  PreviewHoldSource,
  VisibleDownloadSide
} from './download-model';
import { formatReleaseSize } from '../../../lib/release-manifest';
import type { ChapterRuntimeProps } from '../types';
import styles from './download.module.css';

export type DownloadChapterProps = ChapterRuntimeProps;

type DownloadCardStyle = CSSProperties & {
  '--card-distance': number;
  '--card-scale': number;
};

type PanelFlowState = {
  visibleSide: DownloadSide;
  pendingSide: DownloadSide;
  phase: 'open' | 'closing';
};

type PlatformPointerDrag = {
  pointerId: number;
  startY: number;
  switched: boolean;
};

const PANEL_CLOSE_DURATION_MS = 220;
const PLATFORM_DRAG_THRESHOLD_PX = 40;

function clearPanelMotionResidue(scope: HTMLElement) {
  const animatedElements = scope.querySelectorAll<HTMLElement>(
    '[data-panel-heading], [data-panel-item]'
  );

  for (const element of animatedElements) {
    element.style.removeProperty('opacity');
    element.style.removeProperty('visibility');
    element.style.removeProperty('transform');
  }
}

// 计算最短循环距离，使平台数量增加后仍保持连续堆叠。
function getCircularDistance(index: number, activeIndex: number, length: number): number {
  if (length <= 1) return 0;

  const forward = (index - activeIndex + length) % length;
  const backward = forward - length;
  return Math.abs(forward) < Math.abs(backward) ? forward : backward;
}

function getCardStyle(distance: number, length: number): DownloadCardStyle {
  const depth = Math.abs(distance);
  const scale = Math.max(0.78, 1 - depth * 0.08);
  const opacity = Math.max(0.28, 1 - depth * 0.34);

  return {
    '--card-distance': distance,
    '--card-scale': scale,
    opacity,
    zIndex: length - depth
  };
}

export function DownloadChapter({
  interactive,
  reducedMotion = false,
  staticFallback = false,
  onInitializationError
}: DownloadChapterProps) {
  const [state, dispatch] = useReducer(
    reduceDownloadInteraction,
    initialDownloadInteraction
  );
  const [panelFlow, setPanelFlow] = useState<PanelFlowState>({
    visibleSide: null,
    pendingSide: null,
    phase: 'open'
  });
  const rootRef = useRef<HTMLDivElement | null>(null);
  const platformStackRef = useRef<HTMLDivElement | null>(null);
  const platformDragRef = useRef<PlatformPointerDrag | null>(null);
  const requestedSide = visibleDownloadSide(state);
  const visibleSide = panelFlow.visibleSide;
  const motionDisabled = reducedMotion || staticFallback;

  // 当前侧先进入 closing，结束后才把 pendingSide 提升为可见侧。
  useEffect(() => {
    setPanelFlow((current) => {
      if (requestedSide === current.visibleSide) {
        return current.phase === 'closing'
          ? {
              visibleSide: current.visibleSide,
              pendingSide: null,
              phase: 'open'
            }
          : current;
      }

      if (current.visibleSide === null) {
        return {
          visibleSide: requestedSide,
          pendingSide: null,
          phase: 'open'
        };
      }

      if (
        current.phase === 'closing'
        && current.pendingSide === requestedSide
      ) {
        return current;
      }

      return {
        visibleSide: current.visibleSide,
        pendingSide: requestedSide,
        phase: 'closing'
      };
    });
  }, [requestedSide]);

  useEffect(() => {
    if (panelFlow.phase !== 'closing') return;

    const timeout = window.setTimeout(() => {
      setPanelFlow((current) => {
        if (current.phase !== 'closing') return current;

        return {
          visibleSide: current.pendingSide,
          pendingSide: null,
          phase: 'open'
        };
      });
    }, motionDisabled ? 0 : PANEL_CLOSE_DURATION_MS);

    return () => window.clearTimeout(timeout);
  }, [
    panelFlow.pendingSide,
    panelFlow.phase,
    motionDisabled
  ]);

  // 每次可见侧栏变化都建立独立作用域，切换或卸载时完整回收动画状态。
  useEffect(() => {
    const scope = rootRef.current;
    if (
      !scope
      || !visibleSide
      || panelFlow.phase !== 'open'
      || !interactive
      || motionDisabled
    ) {
      return;
    }

    const direction = visibleSide === 'faq' ? -1 : 1;
    const partialContextRef: { current: gsap.Context | null } = {
      current: null
    };

    try {
      const context = gsap.context((createdContext) => {
        partialContextRef.current = createdContext;
        const panelSelector = `[data-side-panel="${visibleSide}"]`;
        const timeline = gsap.timeline({
          defaults: {
            duration: 0.32,
            ease: 'power2.out'
          }
        });

        timeline
          .from(`${panelSelector} [data-panel-heading]`, {
            autoAlpha: 0,
            x: direction * 14
          }, 0)
          .from(`${panelSelector} [data-panel-item]`, {
            autoAlpha: 0,
            x: direction * 12,
            stagger: 0.035
          }, '<0.06');
      }, scope);

      partialContextRef.current = context;
      return () => {
        try {
          context.revert();
        } catch {
          onInitializationError?.();
        }
      };
    } catch {
      try {
        partialContextRef.current?.revert();
      } catch {
        // 部分创建的动画上下文清理失败时仍进入统一静态回退。
      } finally {
        onInitializationError?.();
      }
    }
  }, [
    interactive,
    onInitializationError,
    panelFlow.phase,
    motionDisabled,
    visibleSide
  ]);

  // 静态模式主动清除 GSAP 部分回滚失败后可能留下的内联运动属性。
  useEffect(() => {
    if (!motionDisabled || !rootRef.current) return;

    clearPanelMotionResidue(rootRef.current);
  }, [motionDisabled, panelFlow.phase, visibleSide]);

  // 平台堆叠消费自己的滚轮和方向键，避免触发外层章节切换。
  const selectRelativePlatform = (delta: number) => {
    dispatch({
      type: 'SELECT_PLATFORM',
      index: rotatePlatformIndex(
        state.activePlatformIndex,
        delta,
        DOWNLOAD_PLATFORMS.length
      )
    });
  };

  useEffect(() => {
    const stack = platformStackRef.current;
    if (!stack) return;

    // React 合成 wheel 监听可能为 passive，局部滚筒使用原生监听确保能阻止页面输入。
    const handlePlatformWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (!interactive || event.deltaY === 0) return;
      selectRelativePlatform(event.deltaY > 0 ? 1 : -1);
    };

    stack.addEventListener('wheel', handlePlatformWheel, { passive: false });
    return () => {
      stack.removeEventListener('wheel', handlePlatformWheel);
    };
  }, [interactive, state.activePlatformIndex]);

  const handlePlatformKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const direction = event.key === 'ArrowDown' || event.key === 'ArrowRight'
      ? 1
      : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
        ? -1
        : 0;

    if (direction !== 0) {
      event.preventDefault();
      event.stopPropagation();
      if (interactive) selectRelativePlatform(direction);
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      const focusedElement = event.currentTarget.ownerDocument.activeElement;
      if (
        focusedElement instanceof HTMLElement
        && event.currentTarget.contains(focusedElement)
      ) {
        focusedElement.blur();
      } else if (event.target instanceof HTMLElement) {
        event.target.blur();
      }
      dispatch({ type: 'RESET' });
    }
  };

  const handlePlatformPointerDown = (
    event: ReactPointerEvent<HTMLDivElement>
  ) => {
    if (!interactive || event.pointerType === 'mouse') return;

    event.preventDefault();
    event.stopPropagation();
    if (platformDragRef.current) return;

    platformDragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      switched: false
    };

    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // 某些浏览器在指针离开前不会开放捕获，局部状态仍可正常结束。
    }
  };

  const handlePlatformPointerMove = (
    event: ReactPointerEvent<HTMLDivElement>
  ) => {
    const drag = platformDragRef.current;
    if (!drag) return;

    event.preventDefault();
    event.stopPropagation();
    if (drag.pointerId !== event.pointerId) return;
    if (drag.switched) return;

    const deltaY = event.clientY - drag.startY;
    if (Math.abs(deltaY) <= PLATFORM_DRAG_THRESHOLD_PX) return;

    drag.switched = true;
    selectRelativePlatform(deltaY < 0 ? 1 : -1);
  };

  const finishPlatformPointer = (
    event: ReactPointerEvent<HTMLDivElement>
  ) => {
    const drag = platformDragRef.current;
    if (!drag) return;

    event.preventDefault();
    event.stopPropagation();
    if (drag.pointerId !== event.pointerId) return;
    platformDragRef.current = null;

    try {
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture?.(event.pointerId);
      }
    } catch {
      // 指针取消时浏览器可能已自动释放捕获，无需重复处理。
    }
  };

  const handleRootKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return;

    event.preventDefault();
    event.stopPropagation();
    dispatch({ type: 'RESET' });
  };

  const holdSidePreview = (
    side: VisibleDownloadSide,
    source: PreviewHoldSource
  ) => {
    if (interactive) {
      dispatch({ type: 'SET_PREVIEW_HOLD', side, source, held: true });
    }
  };

  const releaseSidePreview = (
    side: VisibleDownloadSide,
    source: PreviewHoldSource
  ) => {
    dispatch({ type: 'SET_PREVIEW_HOLD', side, source, held: false });
  };

  const toggleSideLock = (side: VisibleDownloadSide) => {
    if (!interactive) return;

    dispatch({ type: 'TOGGLE_LOCK', side });
  };

  return (
    <div
      ref={rootRef}
      className={styles.downloadChapter}
      data-testid="download-chapter"
      data-visible-side={visibleSide ?? 'none'}
      data-panel-phase={panelFlow.phase}
      data-pending-side={panelFlow.pendingSide ?? 'none'}
      data-reduced-motion={reducedMotion}
      data-static-fallback={staticFallback}
      data-motion-disabled={motionDisabled}
      onKeyDown={handleRootKeyDown}
    >
      <button
        className={`${styles.sideTrigger} ${styles.faqTrigger}`}
        type="button"
        aria-label="显示常见问题"
        aria-pressed={state.lockedSide === 'faq'}
        disabled={!interactive}
        onPointerEnter={() => holdSidePreview('faq', 'pointer')}
        onPointerLeave={() => releaseSidePreview('faq', 'pointer')}
        onFocus={() => holdSidePreview('faq', 'focus')}
        onBlur={() => releaseSidePreview('faq', 'focus')}
        onClick={() => toggleSideLock('faq')}
      >
        <ChevronRight aria-hidden="true" />
      </button>

      <aside
        className={`${styles.sidePanel} ${styles.faqPanel}`}
        aria-label="常见问题"
        aria-hidden={visibleSide !== 'faq' || panelFlow.phase === 'closing'}
        data-side-panel="faq"
      >
        <div className={styles.panelHeading} data-panel-heading>
          <CircleHelp aria-hidden="true" />
          <div>
            <p>DOWNLOAD HELP</p>
            <h2>常见问题</h2>
          </div>
        </div>
        <ul className={styles.panelList}>
          {FAQ_ITEMS.map((item) => (
            <li key={item.question} data-panel-item>
              <h3>{item.question}</h3>
              <p>{item.answer}</p>
            </li>
          ))}
        </ul>
      </aside>

      <div
        ref={platformStackRef}
        className={styles.platformStack}
        data-testid="download-platform-stack"
        data-active-platform={
          DOWNLOAD_PLATFORMS[state.activePlatformIndex]?.id ?? ''
        }
        data-input-scope="local"
        tabIndex={interactive ? 0 : -1}
        role="group"
        aria-label="选择下载平台"
        onKeyDown={handlePlatformKeyDown}
        onPointerDown={handlePlatformPointerDown}
        onPointerMove={handlePlatformPointerMove}
        onPointerUp={finishPlatformPointer}
        onPointerCancel={finishPlatformPointer}
      >
        <div className={styles.chapterHeading}>
          <p>AI PET DESKTOP</p>
          <h2>选择你的平台</h2>
        </div>

        <div className={styles.cardDeck}>
          {DOWNLOAD_PLATFORMS.map((platform, index) => {
            const isActive = index === state.activePlatformIndex;
            const distance = getCircularDistance(
              index,
              state.activePlatformIndex,
              DOWNLOAD_PLATFORMS.length
            );

            return (
              <article
                key={platform.id}
                className={styles.platformCard}
                data-active={isActive}
                data-platform-id={platform.id}
                data-platform-status={platform.status}
                style={getCardStyle(distance, DOWNLOAD_PLATFORMS.length)}
              >
                <button
                  className={styles.cardSurface}
                  type="button"
                  aria-label={
                    isActive
                      ? `重置下载视图，当前为 ${platform.name}`
                      : `选择 ${platform.name}`
                  }
                  aria-pressed={isActive}
                  disabled={!interactive}
                  onClick={() => {
                    dispatch(
                      isActive
                        ? { type: 'RESET' }
                        : { type: 'SELECT_PLATFORM', index }
                    );
                  }}
                >
                  <span className={styles.platformIcon}>
                    <Monitor aria-hidden="true" />
                  </span>
                  <span className={styles.platformCopy}>
                    <span className={styles.platformName}>{platform.name}</span>
                    <span className={styles.platformSummary}>{platform.summary}</span>
                  </span>
                  <span className={styles.platformVersion}>{platform.versionLabel}</span>
                </button>

                {isActive ? (
                  <div className={styles.cardDetails}>
                    <p>{platform.systemRequirements}</p>
                    {platform.status === 'available' ? (
                      <>
                        <dl className={styles.releaseMeta}>
                          <div>
                            <dt>安装包</dt>
                            <dd>{platform.fileName}</dd>
                          </div>
                          <div>
                            <dt>大小</dt>
                            <dd>{formatReleaseSize(platform.sizeBytes)}</dd>
                          </div>
                          <div>
                            <dt>SHA-256</dt>
                            <dd className={styles.releaseHash}>
                              <code>{platform.sha256}</code>
                            </dd>
                          </div>
                        </dl>
                        <a
                          className={styles.downloadAction}
                          href={platform.downloadUrl}
                          download={platform.fileName}
                        >
                          <Download aria-hidden="true" />
                          下载 {platform.name}
                        </a>
                      </>
                    ) : (
                      <button
                        className={styles.downloadAction}
                        type="button"
                        disabled
                      >
                        <Clock3 aria-hidden="true" />
                        即将支持
                      </button>
                    )}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      </div>

      <aside
        className={`${styles.sidePanel} ${styles.noticePanel}`}
        aria-label="安装前须知"
        aria-hidden={visibleSide !== 'notice' || panelFlow.phase === 'closing'}
        data-side-panel="notice"
      >
        <div className={styles.panelHeading} data-panel-heading>
          <ShieldCheck aria-hidden="true" />
          <div>
            <p>BEFORE INSTALL</p>
            <h2>安装前须知</h2>
          </div>
        </div>
        <ul className={styles.panelList}>
          {INSTALL_NOTICE_ITEMS.map((item) => (
            <li key={item.title} data-panel-item>
              <FileCheck2 aria-hidden="true" />
              <div>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
              </div>
            </li>
          ))}
        </ul>
      </aside>

      <button
        className={`${styles.sideTrigger} ${styles.noticeTrigger}`}
        type="button"
        aria-label="显示安装前须知"
        aria-pressed={state.lockedSide === 'notice'}
        disabled={!interactive}
        onPointerEnter={() => holdSidePreview('notice', 'pointer')}
        onPointerLeave={() => releaseSidePreview('notice', 'pointer')}
        onFocus={() => holdSidePreview('notice', 'focus')}
        onBlur={() => releaseSidePreview('notice', 'focus')}
        onClick={() => toggleSideLock('notice')}
      >
        <ChevronLeft aria-hidden="true" />
      </button>
    </div>
  );
}
