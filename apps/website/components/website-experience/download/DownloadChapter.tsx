'use client';

import dynamic from 'next/dynamic';
import { gsap } from 'gsap';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Clock3, Download } from 'lucide-react';
import { formatReleaseSize } from '../../../lib/release-manifest';
import { recordOfficialDownloadClick } from '../../../lib/official-download-metric-client';
import { LIQUID_GLASS_RIPPLE_EVENT } from '../../home-experience/LiquidGlassHome';
import { interpolateMessage, useI18n } from '../../i18n/I18nProvider';
import type { Translate } from '../../i18n/i18n-types';
import type { PointerPoint } from '../../home-experience/types';
import type { ChapterRuntimeProps } from '../types';
import { PointerTiltText } from '../visual/PointerTiltText';
import { createDownloadContent } from './download-content';
import type { DownloadPlatform } from './download-content';
import styles from './download.module.css';

const DownloadModelViewer = dynamic(
  () => import('./DownloadModelViewer').then((module) => module.DownloadModelViewer),
  { ssr: false }
);

export type DownloadChapterProps = ChapterRuntimeProps;

const INITIAL_POINTER: PointerPoint = { x: 0, y: 0 };

function getModelUrl(platform: DownloadPlatform) {
  return platform.id === 'macos' ? '/newMac.glb' : '/newWindows.glb';
}

interface TypewriterTextProps {
  startIndex: number;
  text: string;
}

/** 使用逐字弹入的纯视觉层，原始文本节点仍完整保留语义。 */
function TypewriterText({ startIndex, text }: TypewriterTextProps) {
  return (
    <>
      <span className={styles.typingVisual} aria-hidden="true">
        {Array.from(text).map((character, index) => (
          <span
            key={`${startIndex}-${index}-${character}`}
            className={styles.typingChar}
            style={{ '--typing-index': startIndex + index } as CSSProperties}
          >
            {character === ' ' ? '\u00a0' : character}
          </span>
        ))}
      </span>
      <span className={styles.typewriterAccessible}>{text}</span>
    </>
  );
}

export function DownloadChapter({
  interactive,
  isPaused = false,
  reducedMotion = false,
  staticFallback = false,
  transitionProgress = 2
}: DownloadChapterProps) {
  const { t: rawTranslate } = useI18n();
  const t = useCallback<Translate>((key, values) => (
    interpolateMessage(rawTranslate(key), values)
  ), [rawTranslate]);
  const content = useMemo(() => createDownloadContent(t), [t]);
  const [activePlatformIndex, setActivePlatformIndex] = useState(0);
  const [pointer, setPointer] = useState<PointerPoint>(INITIAL_POINTER);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const pointerFrameRef = useRef<number | null>(null);
  const pointerTargetRef = useRef<PointerPoint>(INITIAL_POINTER);
  const wordRef = useRef<HTMLDivElement | null>(null);
  const copyRef = useRef<HTMLDivElement | null>(null);
  const selectorRef = useRef<HTMLDivElement | null>(null);
  const switchTimelineRef = useRef<gsap.core.Timeline | null>(null);
  const [switching, setSwitching] = useState(false);
  const [modelMountReady, setModelMountReady] = useState(false);
  const staticPresentation = reducedMotion || staticFallback;
  const motionDisabled = reducedMotion || staticFallback || isPaused;
  const progress = Math.min(1, Math.max(0, transitionProgress - 1));
  const finalProgress = Math.min(1, Math.max(0, (progress - 0.78) / 0.22));
  const platformProgress = Math.min(1, Math.max(0, (progress - 0.92) / 0.08));
  const modelEntryProgress = platformProgress;
  const exitProgress = Math.min(1, Math.max(0, transitionProgress - 2));
  const platformInteractive = interactive || progress >= 0.82;
  const activePlatform = content.platforms[activePlatformIndex] ?? content.platforms[0]!;
  const modelActive = progress >= 0.92 && transitionProgress < 2.98;

  useEffect(() => {
    if (!modelActive || staticPresentation) {
      setModelMountReady(false);
      return;
    }

    // 稍后挂载大型模型，优先保证下载章节过渡首帧稳定。
    const timer = window.setTimeout(() => setModelMountReady(true), 120);
    return () => window.clearTimeout(timer);
  }, [modelActive, staticPresentation]);

  useEffect(() => {
    const syncViewport = () => {
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    };
    const syncPointer = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse') return;
      pointerTargetRef.current = { x: event.clientX, y: event.clientY };
      if (pointerFrameRef.current !== null) return;
      pointerFrameRef.current = window.requestAnimationFrame(() => {
        pointerFrameRef.current = null;
        setPointer(pointerTargetRef.current);
      });
    };
    syncViewport();
    let resizeRegistered = false;
    let pointerRegistered = false;
    try {
      window.addEventListener('resize', syncViewport, { passive: true });
      resizeRegistered = true;
      window.addEventListener('pointermove', syncPointer, { passive: true });
      pointerRegistered = true;
    } catch {
      // 标题倾斜属于渐进增强；监听失败时回滚局部监听，保留章节与全局滚轮导航。
      if (resizeRegistered) window.removeEventListener('resize', syncViewport);
    }
    return () => {
      if (resizeRegistered) window.removeEventListener('resize', syncViewport);
      if (pointerRegistered) window.removeEventListener('pointermove', syncPointer);
      if (pointerFrameRef.current !== null) {
        window.cancelAnimationFrame(pointerFrameRef.current);
        pointerFrameRef.current = null;
      }
    };
  }, []);

  useEffect(() => () => {
    switchTimelineRef.current?.kill();
  }, []);

  const selectPlatform = (index: number) => {
    if (!platformInteractive || switching || index === activePlatformIndex) return;
    const word = wordRef.current;
    const copy = copyRef.current;
    setActivePlatformIndex(index);
    if (!word || !copy || motionDisabled) {
      return;
    }

    switchTimelineRef.current?.kill();
    setSwitching(true);
    switchTimelineRef.current = gsap.timeline({
      defaults: { ease: 'power3.inOut' },
      onComplete: () => {
        // 清除 GSAP 行内位移，让平台大字稳定回到 CSS 最终位置。
        gsap.set([word, copy], { clearProps: 'transform' });
        setSwitching(false);
      }
    }).fromTo([word, copy], { x: '130vw' }, { x: 0, duration: 0.78 });
  };

  useEffect(() => {
    const selectFromPointer = (event: PointerEvent) => {
      if (event.button !== 0 || !platformInteractive) return;
      const buttons = selectorRef.current?.querySelectorAll('button');
      if (!buttons) return;
      buttons.forEach((button, index) => {
        const bounds = button.getBoundingClientRect();
        if (
          event.clientX >= bounds.left
          && event.clientX <= bounds.right
          && event.clientY >= bounds.top
          && event.clientY <= bounds.bottom
        ) {
          selectPlatform(index);
        }
      });
    };
    window.addEventListener('pointerdown', selectFromPointer, true);
    return () => window.removeEventListener('pointerdown', selectFromPointer, true);
  });

  const noticeAccessibilityText = [
    t('download.notice.label'),
    ...content.installNoticeItems.flatMap((item) => [item.title, item.body]),
    t('download.faq.label'),
    ...content.faqItems.slice(0, 3).flatMap((item) => [item.question, item.answer])
  ].join(' ');
  const packageRows: Array<[string, string]> = (() => {
    if (activePlatform.status === 'available') {
      return [
        [t('download.package'), activePlatform.fileName],
        [t('download.size'), formatReleaseSize(activePlatform.sizeBytes)],
        ['SHA-256', activePlatform.sha256]
      ];
    }
    if (activePlatform.status === 'unpublished') {
      return [
        [t('download.package'), activePlatform.fileName],
        ['Release', `v${activePlatform.versionLabel}`]
      ];
    }
    return [
      [t('download.package'), activePlatform.versionLabel],
      ['System', activePlatform.systemRequirements]
    ];
  })();
  let packageTypingIndex = 0;
  const createTypingRun = (text: string) => {
    const run = { startIndex: packageTypingIndex, text };
    packageTypingIndex += Array.from(text).length + 2;
    return run;
  };
  const summaryTyping = createTypingRun(activePlatform.summary);
  const systemTyping = createTypingRun(activePlatform.systemRequirements);
  const packageRowsTyping = packageRows.map(([label, value]) => ({
    label: createTypingRun(label),
    value: createTypingRun(value)
  }));

  return (
    <div
      className={styles.downloadChapter}
      data-testid="download-chapter"
      data-active-platform={activePlatform.id}
      data-paused={isPaused}
      data-reduced-motion={reducedMotion}
      data-static-fallback={staticFallback}
      data-motion-disabled={motionDisabled}
      style={{
        '--download-progress': progress,
        '--download-final-progress': finalProgress,
        '--platform-progress': platformProgress,
        '--download-header-y': `${(1 - progress) * -30}vh`,
        '--download-title-exit-y': `${exitProgress * -130}vh`,
        '--download-selector-exit-x': `${exitProgress * 120}vw`,
        '--download-glass-x': `${(1 - progress) * -58 - exitProgress * 110}vw`,
        '--platform-offset': `${platformProgress >= 0.999 ? 0 : (1 - platformProgress) * 130}vw`,
        '--platform-exit-x': `${exitProgress * 120}vw`
      } as CSSProperties}
    >
      <header className={styles.platformHeader}>
        <PointerTiltText
          pointer={pointer}
          viewport={viewport}
          disabled={motionDisabled}
          className={styles.platformTitleTilt!}
        >
          <h2>{t('download.title')}</h2>
        </PointerTiltText>
        <div
          ref={selectorRef}
          className={styles.platformSelector}
          role="group"
          aria-label={t('download.platform.group')}
        >
          {content.platforms.map((platform, index) => (
            <button
              key={platform.id}
              type="button"
              aria-label={index === activePlatformIndex
                ? t('download.platform.current', { name: platform.name })
                : t('download.platform.select', { name: platform.name })}
              aria-pressed={index === activePlatformIndex}
              data-active={index === activePlatformIndex}
              disabled={!platformInteractive || switching}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.stopPropagation();
                selectPlatform(index);
              }}
              onClick={() => selectPlatform(index)}
            >
              {platform.name}
            </button>
          ))}
        </div>
      </header>

      <section
        className={styles.glassCopy}
        aria-label={`${t('download.notice.label')} · ${t('download.faq.label')}`}
        onPointerDown={(event) => {
          if (motionDisabled || progress <= 0.12) return;
          window.dispatchEvent(new CustomEvent(LIQUID_GLASS_RIPPLE_EVENT, {
            detail: {
              clientX: event.clientX,
              clientY: event.clientY,
              strength: 1.65
            }
          }));
        }}
      >
        <p className={styles.accessibleCopy} data-layout-ignore aria-live="polite">
          {modelActive ? noticeAccessibilityText : ''}
        </p>
      </section>

      <section className={styles.modelStage}>
        <div ref={wordRef} className={styles.platformWordLayer}>
          <PointerTiltText
            pointer={pointer}
            viewport={viewport}
            disabled={motionDisabled}
            className={styles.platformWordTilt!}
          >
            <p className={styles.platformWord}>{activePlatform.name}</p>
          </PointerTiltText>
        </div>
        {modelActive && modelMountReady && !staticPresentation ? (
          <DownloadModelViewer
            active={modelActive}
            entryProgress={modelEntryProgress}
            exitProgress={exitProgress}
            modelUrl={getModelUrl(activePlatform)}
            motionDisabled={motionDisabled}
            paused={isPaused}
            platformName={activePlatform.name}
          />
        ) : null}
        <div ref={copyRef} className={styles.platformCopy}>
          <div
            key={`${activePlatform.id}-${modelActive ? 'active' : 'idle'}`}
            className={styles.packageInfo}
            data-typing-active={modelActive}
          >
            <p><TypewriterText {...summaryTyping} /></p>
            <p><TypewriterText {...systemTyping} /></p>
            <dl>
              {packageRowsTyping.map(({ label, value }) => (
                <div key={label.text}>
                  <dt><TypewriterText {...label} /></dt>
                  <dd><TypewriterText {...value} /></dd>
                </div>
              ))}
            </dl>
          </div>
          {activePlatform.status === 'available' ? (
            <a
              className={styles.downloadAction}
              href={activePlatform.downloadUrl}
              onClick={() => {
                if (activePlatform.id === 'windows-x64') recordOfficialDownloadClick();
              }}
            >
              <Download aria-hidden="true" />
              {t('download.download', { name: activePlatform.name })}
            </a>
          ) : (
            <button className={styles.downloadAction} type="button" disabled>
              <Clock3 aria-hidden="true" />
              {activePlatform.status === 'unpublished'
                ? t('download.unpublished')
                : t('download.comingSoon')}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
