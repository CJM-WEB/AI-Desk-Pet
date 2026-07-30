'use client';

import { useEffect, useReducer, useRef, useState } from 'react';
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent
} from 'react';
import {
  CircleHelp,
  Clock3,
  Download,
  FileCheck2,
  Monitor,
  ShieldCheck
} from 'lucide-react';
import {
  DOWNLOAD_PLATFORMS,
  FAQ_ITEMS,
  INSTALL_NOTICE_ITEMS
} from './download-content';
import {
  initialDownloadInteraction,
  reduceDownloadInteraction,
  resolveDownloadSideMode,
  rotatePlatformIndex
} from './download-model';
import type {
  PreviewHoldSource,
  VisibleDownloadSide
} from './download-model';
import { formatReleaseSize } from '../../../lib/release-manifest';
import type { PointerPoint } from '../../home-experience/types';
import { PointerTiltText } from '../visual/PointerTiltText';
import type { ChapterRuntimeProps } from '../types';
import styles from './download.module.css';

export type DownloadChapterProps = ChapterRuntimeProps;

type DownloadCardStyle = CSSProperties & {
  '--card-distance': number;
  '--card-scale': number;
};

type PlatformPointerDrag = {
  pointerId: number;
  startY: number;
  switched: boolean;
};

const MOBILE_QUERY = '(max-width: 760px)';
const PLATFORM_DRAG_THRESHOLD_PX = 40;
const INITIAL_POINTER: PointerPoint = { x: 0, y: 0 };

// 计算最短循环距离，使平台数量增加后仍保持连续堆叠。
function getCircularDistance(index: number, activeIndex: number, length: number): number {
  if (length <= 1) return 0;

  const forward = (index - activeIndex + length) % length;
  const backward = forward - length;
  return Math.abs(forward) < Math.abs(backward) ? forward : backward;
}

function getCardStyle(distance: number, length: number): DownloadCardStyle {
  const depth = Math.abs(distance);

  return {
    '--card-distance': distance,
    '--card-scale': Math.max(0.78, 1 - depth * 0.08),
    opacity: Math.max(0.28, 1 - depth * 0.34),
    zIndex: length - depth
  };
}

function useMobileMode() {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;

    try {
      const mediaQuery = window.matchMedia(MOBILE_QUERY);
      const sync = () => setIsMobile(mediaQuery.matches);
      sync();
      mediaQuery.addEventListener?.('change', sync);
      return () => mediaQuery.removeEventListener?.('change', sync);
    } catch {
      // 父级控制器会进入统一静态降级，章节自身保持桌面基础布局。
      setIsMobile(false);
    }
  }, []);

  return isMobile;
}

export function DownloadChapter({
  interactive,
  isPaused = false,
  reducedMotion = false,
  staticFallback = false
}: DownloadChapterProps) {
  const [state, dispatch] = useReducer(
    reduceDownloadInteraction,
    initialDownloadInteraction
  );
  const [pointer, setPointer] = useState<PointerPoint>(INITIAL_POINTER);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const rootRef = useRef<HTMLDivElement | null>(null);
  const platformStackRef = useRef<HTMLDivElement | null>(null);
  const platformDragRef = useRef<PlatformPointerDrag | null>(null);
  const isMobile = useMobileMode();
  const motionDisabled = reducedMotion || staticFallback || isPaused;
  const sideMode = resolveDownloadSideMode(state, isMobile);
  const visibleSide = sideMode.side;

  useEffect(() => {
    const syncViewport = () => {
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    };
    syncViewport();
    window.addEventListener('resize', syncViewport);
    return () => window.removeEventListener('resize', syncViewport);
  }, []);

  // 平台堆叠消费自己的滚轮，避免触发外层章节切换。
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

    const handlePlatformWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (!interactive || event.deltaY === 0) return;
      selectRelativePlatform(event.deltaY > 0 ? 1 : -1);
    };

    stack.addEventListener('wheel', handlePlatformWheel, { passive: false });
    return () => stack.removeEventListener('wheel', handlePlatformWheel);
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
      dispatch({ type: 'RESET' });
      event.currentTarget.blur();
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
  };

  const handlePlatformPointerMove = (
    event: ReactPointerEvent<HTMLDivElement>
  ) => {
    const drag = platformDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || drag.switched) return;

    event.preventDefault();
    event.stopPropagation();
    const deltaY = event.clientY - drag.startY;
    if (Math.abs(deltaY) <= PLATFORM_DRAG_THRESHOLD_PX) return;

    drag.switched = true;
    selectRelativePlatform(deltaY < 0 ? 1 : -1);
  };

  const finishPlatformPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (platformDragRef.current?.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    platformDragRef.current = null;
  };

  const holdDesktopPreview = (
    side: VisibleDownloadSide,
    source: PreviewHoldSource,
    held: boolean
  ) => {
    if (!interactive || isMobile) return;
    dispatch({ type: 'SET_DESKTOP_PREVIEW_HOLD', side, source, held });
  };

  const handleSideClick = (
    event: ReactPointerEvent<HTMLButtonElement> | React.MouseEvent<HTMLButtonElement>,
    side: VisibleDownloadSide
  ) => {
    event.stopPropagation();
    if (interactive && isMobile) {
      dispatch({ type: 'OPEN_MOBILE_SIDE', side });
    }
  };

  return (
    <div
      ref={rootRef}
      className={styles.downloadChapter}
      data-testid="download-chapter"
      data-visible-side={visibleSide ?? 'none'}
      data-side-mode={sideMode.kind}
      data-paused={isPaused}
      data-reduced-motion={reducedMotion}
      data-static-fallback={staticFallback}
      data-motion-disabled={motionDisabled}
      onPointerMove={(event) => {
        if (event.pointerType === 'mouse') {
          setPointer({ x: event.clientX, y: event.clientY });
        }
      }}
      onClick={(event) => {
        if (isMobile && event.target === event.currentTarget) {
          dispatch({ type: 'CLOSE_MOBILE_SIDE' });
        }
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && isMobile) {
          dispatch({ type: 'CLOSE_MOBILE_SIDE' });
        }
      }}
    >
      <button
        className={`${styles.sideSensor} ${styles.faqSensor}`}
        type="button"
        aria-label="显示常见问题"
        disabled={!interactive}
        onPointerEnter={() => holdDesktopPreview('faq', 'pointer', true)}
        onPointerLeave={() => holdDesktopPreview('faq', 'pointer', false)}
        onFocus={() => holdDesktopPreview('faq', 'focus', true)}
        onBlur={() => holdDesktopPreview('faq', 'focus', false)}
        onClick={(event) => handleSideClick(event, 'faq')}
      >
        <span>常见问题</span>
      </button>

      <aside
        className={`${styles.sidePanel} ${styles.faqPanel}`}
        aria-label="常见问题"
        aria-hidden={visibleSide !== 'faq'}
        data-side-panel="faq"
        data-input-scope="local"
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
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handlePlatformKeyDown}
        onPointerDown={handlePlatformPointerDown}
        onPointerMove={handlePlatformPointerMove}
        onPointerUp={finishPlatformPointer}
        onPointerCancel={finishPlatformPointer}
      >
        <div className={styles.chapterHeading}>
          <PointerTiltText
            pointer={pointer}
            viewport={viewport}
            disabled={motionDisabled || isMobile}
          >
            <p>AI PET DESKTOP</p>
          </PointerTiltText>
          <PointerTiltText
            pointer={pointer}
            viewport={viewport}
            disabled={motionDisabled || isMobile}
          >
            <h2>选择你的平台</h2>
          </PointerTiltText>
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
                  aria-label={isActive ? `当前平台为 ${platform.name}` : `选择 ${platform.name}`}
                  aria-pressed={isActive}
                  disabled={!interactive}
                  onClick={() => dispatch({ type: 'SELECT_PLATFORM', index })}
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
                          <div><dt>安装包</dt><dd>{platform.fileName}</dd></div>
                          <div><dt>大小</dt><dd>{formatReleaseSize(platform.sizeBytes)}</dd></div>
                          <div><dt>SHA-256</dt><dd className={styles.releaseHash}><code>{platform.sha256}</code></dd></div>
                        </dl>
                        <a className={styles.downloadAction} href={platform.downloadUrl}>
                          <Download aria-hidden="true" />
                          下载 {platform.name}
                        </a>
                      </>
                    ) : platform.status === 'unpublished' ? (
                      <>
                        <dl className={styles.releaseMeta}>
                          <div><dt>计划安装包</dt><dd>{platform.fileName}</dd></div>
                          <div><dt>计划发布标签</dt><dd>{platform.plannedReleaseTag}</dd></div>
                        </dl>
                        <button className={styles.downloadAction} type="button" disabled>
                          <Clock3 aria-hidden="true" />
                          尚未发布
                        </button>
                      </>
                    ) : (
                      <button className={styles.downloadAction} type="button" disabled>
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
        aria-hidden={visibleSide !== 'notice'}
        data-side-panel="notice"
        data-input-scope="local"
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
              <div><h3>{item.title}</h3><p>{item.body}</p></div>
            </li>
          ))}
        </ul>
      </aside>

      <button
        className={`${styles.sideSensor} ${styles.noticeSensor}`}
        type="button"
        aria-label="显示安装前须知"
        disabled={!interactive}
        onPointerEnter={() => holdDesktopPreview('notice', 'pointer', true)}
        onPointerLeave={() => holdDesktopPreview('notice', 'pointer', false)}
        onFocus={() => holdDesktopPreview('notice', 'focus', true)}
        onBlur={() => holdDesktopPreview('notice', 'focus', false)}
        onClick={(event) => handleSideClick(event, 'notice')}
      >
        <span>安装前须知</span>
      </button>
    </div>
  );
}
