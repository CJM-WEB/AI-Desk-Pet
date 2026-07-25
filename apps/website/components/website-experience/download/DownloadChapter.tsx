'use client';

import { useEffect, useReducer, useRef } from 'react';
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  WheelEvent as ReactWheelEvent
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
import type { DownloadSide } from './download-model';
import styles from './download.module.css';

export interface DownloadChapterProps {
  interactive: boolean;
}

type DownloadCardStyle = CSSProperties & {
  '--card-distance': number;
  '--card-scale': number;
};

function formatFileSize(sizeBytes: number): string {
  return `${(sizeBytes / 1024 / 1024).toFixed(1)} MB`;
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

export function DownloadChapter({ interactive }: DownloadChapterProps) {
  const [state, dispatch] = useReducer(
    reduceDownloadInteraction,
    initialDownloadInteraction
  );
  const rootRef = useRef<HTMLDivElement | null>(null);
  const visibleSide = visibleDownloadSide(state);

  // 每次可见侧栏变化都建立独立作用域，切换或卸载时完整回收动画状态。
  useEffect(() => {
    const scope = rootRef.current;
    if (
      !scope
      || !visibleSide
      || !interactive
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      return;
    }

    const direction = visibleSide === 'faq' ? -1 : 1;
    const context = gsap.context(() => {
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

    return () => context.revert();
  }, [interactive, visibleSide]);

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

  const handlePlatformWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();

    if (!interactive || event.deltaY === 0) return;
    selectRelativePlatform(event.deltaY > 0 ? 1 : -1);
  };

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
    }
  };

  const handleRootKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return;

    event.preventDefault();
    event.stopPropagation();
    dispatch({ type: 'RESET' });
  };

  const previewSide = (side: Exclude<DownloadSide, null>) => {
    if (interactive) dispatch({ type: 'PREVIEW_SIDE', side });
  };

  const clearSidePreview = (side: Exclude<DownloadSide, null>) => {
    dispatch({ type: 'CLEAR_PREVIEW', side });
  };

  const toggleSideLock = (side: Exclude<DownloadSide, null>) => {
    if (interactive) dispatch({ type: 'TOGGLE_LOCK', side });
  };

  return (
    <div
      ref={rootRef}
      className={styles.downloadChapter}
      data-testid="download-chapter"
      data-visible-side={visibleSide ?? 'none'}
      onKeyDown={handleRootKeyDown}
    >
      <button
        className={`${styles.sideTrigger} ${styles.faqTrigger}`}
        type="button"
        aria-label="显示常见问题"
        aria-pressed={state.lockedSide === 'faq'}
        disabled={!interactive}
        onPointerEnter={() => previewSide('faq')}
        onPointerLeave={() => clearSidePreview('faq')}
        onFocus={() => previewSide('faq')}
        onBlur={() => clearSidePreview('faq')}
        onClick={() => toggleSideLock('faq')}
      >
        <ChevronRight aria-hidden="true" />
      </button>

      <aside
        className={`${styles.sidePanel} ${styles.faqPanel}`}
        aria-label="常见问题"
        aria-hidden={visibleSide !== 'faq'}
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
        className={styles.platformStack}
        data-input-scope="local"
        tabIndex={interactive ? 0 : -1}
        role="group"
        aria-label="选择下载平台"
        onWheel={handlePlatformWheel}
        onKeyDown={handlePlatformKeyDown}
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
                            <dd>{formatFileSize(platform.sizeBytes)}</dd>
                          </div>
                        </dl>
                        <a
                          className={styles.downloadAction}
                          href={platform.downloadUrl}
                          download={platform.fileName}
                        >
                          <Download aria-hidden="true" />
                          下载 Windows
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
        aria-hidden={visibleSide !== 'notice'}
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
        onPointerEnter={() => previewSide('notice')}
        onPointerLeave={() => clearSidePreview('notice')}
        onFocus={() => previewSide('notice')}
        onBlur={() => clearSidePreview('notice')}
        onClick={() => toggleSideLock('notice')}
      >
        <ChevronLeft aria-hidden="true" />
      </button>
    </div>
  );
}
