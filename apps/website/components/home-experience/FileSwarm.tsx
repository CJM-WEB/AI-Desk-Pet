'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, FocusEvent, PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { EXPERIENCE_CONFIG } from './config';
import {
  advanceParticle,
  createSeededRandom,
  spawnParticle
} from './swarm-model';
import type { FileParticle } from './swarm-model';
import type { FileKind, PointerPoint } from './types';
import type { FilePreviewContentSource } from '../website-experience/shared-visual-model';
import {
  FilePreview,
  type PreviewAnchorRect,
  type PreviewInputMode
} from './FilePreview';
import styles from './home-experience.module.css';

const FILE_KINDS: readonly FileKind[] = [
  'txt',
  'pdf',
  'ppt',
  'xls',
  'img',
  'empty',
  'folder'
];

export const FILE_ASSETS: Record<FileKind, string> = {
  txt: '/TxtIcon.png',
  pdf: '/PDFIcon.png',
  ppt: '/PPTIcon.png',
  xls: '/XLSIcon.png',
  img: '/IMGIcon.png',
  empty: '/empty.png',
  folder: '/Noempty.png'
};

export interface FileSwarmProps {
  running: boolean;
  generating: boolean;
  exitProgress: number;
  pointer: PointerPoint;
  isPaused: boolean;
  maxActive: number;
  safeZoneRatio: number;
  reducedMotion?: boolean;
  previewSource?: FilePreviewContentSource;
  previewContainer?: HTMLElement | null;
  onInitializationError?: () => void;
}

interface SpawnBoundFilePreviewContentSource extends FilePreviewContentSource {
  bindToSpawn(particleId: string): readonly string[];
  read(particleId: string): readonly string[] | null;
  release(particleId: string): void;
}

interface ActivePreview {
  particleId: string;
  inputMode: PreviewInputMode;
  anchorRect: PreviewAnchorRect | null;
}

export interface PreviewHoldState {
  pointer: boolean;
  focus: boolean;
  mode: PreviewInputMode | null;
}

export type PreviewHoldEvent = 'pointer-enter' | 'pointer-leave' | 'focus' | 'blur';

export function resolveSwarmSeed(
  search: string,
  fallbackSeed: () => number
): number {
  const rawSeed = new URLSearchParams(search).get('seed');
  if (rawSeed !== null && /^[+-]?\d+$/.test(rawSeed)) {
    const parsed = Number(rawSeed);
    if (Number.isSafeInteger(parsed)) {
      return parsed;
    }
  }

  return fallbackSeed();
}

export function canGenerateParticle(input: {
  generating: boolean;
  isPaused: boolean;
  activeCount: number;
  disabledKindCount: number;
  maxActive: number;
}): boolean {
  return input.generating
    && !input.isPaused
    && input.activeCount < input.maxActive
    && input.disabledKindCount < FILE_KINDS.length;
}

export function selectEnabledFileKind(
  random: () => number,
  disabledKinds: ReadonlySet<FileKind>
): FileKind | null {
  const enabledKinds = FILE_KINDS.filter((kind) => !disabledKinds.has(kind));
  if (enabledKinds.length === 0) {
    return null;
  }

  const index = Math.min(
    enabledKinds.length - 1,
    Math.floor(Math.max(0, random()) * enabledKinds.length)
  );
  return enabledKinds[index]!;
}

export function transitionPreviewHold(
  current: PreviewHoldState,
  event: PreviewHoldEvent
): PreviewHoldState {
  const pointer = event === 'pointer-enter'
    ? true
    : event === 'pointer-leave'
      ? false
      : current.pointer;
  const focus = event === 'focus'
    ? true
    : event === 'blur'
      ? false
      : current.focus;

  return {
    pointer,
    focus,
    mode: pointer ? 'pointer' : focus ? 'keyboard' : null
  };
}

export function computeFrameStep(
  previousFrameAt: number | null,
  frameAt: number
): { deltaMs: number; nextFrameAt: number } {
  return {
    deltaMs: previousFrameAt === null ? 0 : Math.max(0, frameAt - previousFrameAt),
    nextFrameAt: frameAt
  };
}

export function advanceSwarmFrame(
  particles: FileParticle[],
  deltaMs: number
): FileParticle[] {
  if (particles.length === 0 || deltaMs <= 0 || particles.every((particle) => particle.isHeld)) {
    return particles;
  }

  const next: FileParticle[] = [];
  for (const particle of particles) {
    if (particle.isHeld) {
      next.push(particle);
      continue;
    }

    const advanced = advanceParticle(particle, deltaMs);
    if (advanced.remainingMs <= 0) {
      continue;
    }

    next.push(advanced.phase === 'entering'
      ? { ...advanced, phase: 'floating' }
      : advanced);
  }

  return next;
}

function toAnchorRect(rect: DOMRect): PreviewAnchorRect {
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height
  };
}

function isSpawnBoundPreviewSource(
  source: FilePreviewContentSource | undefined
): source is SpawnBoundFilePreviewContentSource {
  const candidate = source as Partial<SpawnBoundFilePreviewContentSource> | undefined;
  return typeof candidate?.bindToSpawn === 'function'
    && typeof candidate.read === 'function'
    && typeof candidate.release === 'function';
}

/**
 * 管理文件粒子的单一 RAF、生成计时器、保持状态与失败类型隔离。
 */
export function FileSwarm({
  running,
  generating,
  exitProgress,
  pointer,
  isPaused,
  maxActive,
  safeZoneRatio,
  reducedMotion = false,
  previewSource,
  previewContainer = null,
  onInitializationError
}: FileSwarmProps) {
  const [particles, setParticles] = useState<FileParticle[]>([]);
  const [activePreview, setActivePreview] = useState<ActivePreview | null>(null);
  const [previewTweenState, setPreviewTweenState] = useState<'active' | 'inactive'>('inactive');
  const exitComplete = exitProgress >= 1;
  const particlesRef = useRef<FileParticle[]>([]);
  const activePreviewRef = useRef<ActivePreview | null>(null);
  const disabledKindsRef = useRef(new Set<FileKind>());
  const holdStatesRef = useRef(new Map<string, PreviewHoldState>());
  const focusAnchorsRef = useRef(new Map<string, PreviewAnchorRect>());
  const previewSourceRef = useRef(previewSource);
  const randomRef = useRef<(() => number) | null>(null);
  const frameRef = useRef<number | null>(null);
  const spawnTimerRef = useRef<number | null>(null);
  const particleSequenceRef = useRef(0);

  const commitParticles = useCallback((
    update: (current: FileParticle[]) => FileParticle[]
  ) => {
    setParticles((current) => {
      const next = update(current);
      particlesRef.current = next;
      return next;
    });
  }, []);

  const commitActivePreview = useCallback((next: ActivePreview | null) => {
    activePreviewRef.current = next;
    setActivePreview(next);
  }, []);

  const clearFrame = useCallback(() => {
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  }, []);

  const clearSpawnTimer = useCallback(() => {
    if (spawnTimerRef.current !== null) {
      window.clearTimeout(spawnTimerRef.current);
      spawnTimerRef.current = null;
    }
  }, []);

  const bindPreviewToSpawn = useCallback((particleId: string) => {
    const source = previewSourceRef.current;
    if (isSpawnBoundPreviewSource(source)) {
      source.bindToSpawn(particleId);
    }
  }, []);

  const releasePreviewBindings = useCallback((particleIds: readonly string[]) => {
    const source = previewSourceRef.current;
    if (!isSpawnBoundPreviewSource(source)) {
      return;
    }

    new Set(particleIds).forEach((particleId) => {
      source.release(particleId);
    });
  }, []);

  useEffect(() => {
    const previousSource = previewSourceRef.current;
    if (previousSource === previewSource) {
      return;
    }

    const particleIds = particlesRef.current.map((particle) => particle.id);
    if (isSpawnBoundPreviewSource(previousSource)) {
      particleIds.forEach((particleId) => previousSource.release(particleId));
    }
    previewSourceRef.current = previewSource;
    if (isSpawnBoundPreviewSource(previewSource)) {
      particleIds.forEach((particleId) => previewSource.bindToSpawn(particleId));
    }
  }, [previewSource]);

  const applyHoldEvent = useCallback((
    particleId: string,
    event: PreviewHoldEvent,
    focusAnchor?: PreviewAnchorRect
  ) => {
    const current = holdStatesRef.current.get(particleId) ?? {
      pointer: false,
      focus: false,
      mode: null
    };
    const next = transitionPreviewHold(current, event);

    if (focusAnchor) {
      focusAnchorsRef.current.set(particleId, focusAnchor);
    }
    if (next.mode) {
      holdStatesRef.current.set(particleId, next);
    } else {
      holdStatesRef.current.delete(particleId);
      focusAnchorsRef.current.delete(particleId);
    }

    commitParticles((items) => items.map((item) => (
      item.id === particleId ? { ...item, isHeld: next.mode !== null } : item
    )));

    const isActivationEvent = event === 'pointer-enter' || event === 'focus';
    if (next.mode && (
      isActivationEvent
      || activePreviewRef.current?.particleId === particleId
    )) {
      commitActivePreview({
        particleId,
        inputMode: next.mode,
        anchorRect: next.mode === 'keyboard'
          ? focusAnchorsRef.current.get(particleId) ?? null
          : null
      });
    } else if (!next.mode && activePreviewRef.current?.particleId === particleId) {
      commitActivePreview(null);
    }
  }, [commitActivePreview, commitParticles]);

  const handlePointerEnter = useCallback((
    particleId: string,
    _event: PointerEvent<HTMLButtonElement>
  ) => {
    applyHoldEvent(particleId, 'pointer-enter');
  }, [applyHoldEvent]);

  const handlePointerLeave = useCallback((particleId: string) => {
    applyHoldEvent(particleId, 'pointer-leave');
  }, [applyHoldEvent]);

  const handleFocus = useCallback((
    particleId: string,
    event: FocusEvent<HTMLButtonElement>
  ) => {
    applyHoldEvent(
      particleId,
      'focus',
      toAnchorRect(event.currentTarget.getBoundingClientRect())
    );
  }, [applyHoldEvent]);

  const handleBlur = useCallback((particleId: string) => {
    applyHoldEvent(particleId, 'blur');
  }, [applyHoldEvent]);

  const handleImageError = useCallback((particleId: string, kind: FileKind) => {
    disabledKindsRef.current.add(kind);
    holdStatesRef.current.delete(particleId);
    focusAnchorsRef.current.delete(particleId);
    commitParticles((items) => items.map((item) => (
      item.id === particleId
        ? {
            ...item,
            isHeld: false,
            phase: 'leaving',
            remainingMs: Math.min(item.remainingMs, 240)
          }
        : item
    )));

    if (activePreviewRef.current?.particleId === particleId) {
      commitActivePreview(null);
    }
    if (disabledKindsRef.current.size === FILE_KINDS.length) {
      clearSpawnTimer();
    }
  }, [clearSpawnTimer, commitActivePreview, commitParticles]);

  useEffect(() => {
    if (!generating || isPaused) {
      clearSpawnTimer();
      return;
    }

    try {
      randomRef.current ??= createSeededRandom(resolveSwarmSeed(
        window.location.search,
        () => crypto.getRandomValues(new Uint32Array(1))[0]!
      ));
    } catch {
      clearSpawnTimer();
      onInitializationError?.();
      return;
    }
    const random = randomRef.current;
    let cancelled = false;

    const scheduleNextSpawn = () => {
      if (cancelled || disabledKindsRef.current.size === FILE_KINDS.length) {
        return;
      }

      const [minimumDelay, maximumDelay] = EXPERIENCE_CONFIG.swarm.spawnIntervalMs;
      const delay = minimumDelay + random() * (maximumDelay - minimumDelay);
      spawnTimerRef.current = window.setTimeout(() => {
        spawnTimerRef.current = null;
        if (cancelled || disabledKindsRef.current.size === FILE_KINDS.length) {
          return;
        }

        commitParticles((current) => {
          if (!canGenerateParticle({
            generating,
            isPaused,
            activeCount: current.length,
            disabledKindCount: disabledKindsRef.current.size,
            maxActive
          })) {
            return current;
          }

          const selectedKind = selectEnabledFileKind(random, disabledKindsRef.current);
          if (!selectedKind) {
            return current;
          }

          const selectedIndex = FILE_KINDS.indexOf(selectedKind);
          let selectingKind = true;
          const particleRandom = () => {
            if (selectingKind) {
              selectingKind = false;
              return (selectedIndex + 0.5) / FILE_KINDS.length;
            }
            return random();
          };
          const particle = spawnParticle({
            id: `file-${particleSequenceRef.current++}`,
            now: performance.now(),
            viewport: {
              width: window.innerWidth,
              height: window.innerHeight,
              safeZoneRatio
            },
            existing: current,
            random: particleRandom
          });

          if (!particle) {
            return current;
          }

          bindPreviewToSpawn(particle.id);

          return [
            ...current,
            reducedMotion && particle.phase === 'entering'
              ? { ...particle, phase: 'floating' }
              : particle
          ];
        });
        scheduleNextSpawn();
      }, delay);
    };

    scheduleNextSpawn();
    return () => {
      cancelled = true;
      clearSpawnTimer();
    };
  }, [
    bindPreviewToSpawn,
    clearSpawnTimer,
    commitParticles,
    generating,
    isPaused,
    maxActive,
    onInitializationError,
    reducedMotion,
    safeZoneRatio
  ]);

  useEffect(() => {
    if (!running || isPaused || exitComplete || reducedMotion) {
      clearFrame();
      if (exitComplete) {
        releasePreviewBindings(particlesRef.current.map((particle) => particle.id));
        particlesRef.current = [];
        setParticles([]);
        holdStatesRef.current.clear();
        focusAnchorsRef.current.clear();
        commitActivePreview(null);
      } else if (reducedMotion) {
        commitParticles((items) => {
          if (!items.some((item) => item.phase === 'entering')) {
            return items;
          }

          return items.map((item) => (
            item.phase === 'entering'
              ? { ...item, phase: 'floating' }
              : item
          ));
        });
      }
      return;
    }

    let cancelled = false;
    let previousFrame: number | null = null;
    const tick = (frameAt: number) => {
      if (cancelled) {
        return;
      }

      const frameStep = computeFrameStep(previousFrame, frameAt);
      previousFrame = frameStep.nextFrameAt;
      const current = particlesRef.current;
      const next = advanceSwarmFrame(current, frameStep.deltaMs);
      if (next !== current) {
        const nextIds = new Set(next.map((particle) => particle.id));
        releasePreviewBindings(
          current
            .filter((particle) => !nextIds.has(particle.id))
            .map((particle) => particle.id)
        );
        particlesRef.current = next;
        setParticles(next);

        const activeId = activePreviewRef.current?.particleId;
        if (activeId && !next.some((particle) => particle.id === activeId)) {
          holdStatesRef.current.delete(activeId);
          focusAnchorsRef.current.delete(activeId);
          commitActivePreview(null);
        }
      }

      frameRef.current = window.requestAnimationFrame(tick);
    };

    frameRef.current = window.requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      clearFrame();
    };
  }, [
    clearFrame,
    commitActivePreview,
    commitParticles,
    exitComplete,
    isPaused,
    reducedMotion,
    releasePreviewBindings,
    running
  ]);

  useEffect(() => () => {
    clearFrame();
    clearSpawnTimer();
    releasePreviewBindings(particlesRef.current.map((particle) => particle.id));
  }, [clearFrame, clearSpawnTimer, releasePreviewBindings]);

  const activeParticle = activePreview
    ? particles.find((particle) => particle.id === activePreview.particleId) ?? null
    : null;

  return (
    <>
      <div
        className={styles.fileSwarm}
        data-active-count={particles.length}
        data-disabled-count={disabledKindsRef.current.size}
        data-paused={isPaused}
        data-preview-tween-state={previewTweenState}
      >
        <div className={styles.fileSwarmIcons}>
        {particles.map((particle, index) => {
          const particleStyle = {
            '--file-x': `${particle.x}px`,
            '--file-y': `${particle.y}px`,
            '--file-size': `${particle.width}px`,
            '--file-rotation': `${particle.rotation}deg`,
            '--file-scale': particle.scale,
            '--file-float-delay': `${(index % 5) * -0.32}s`
          } as CSSProperties;

          return (
            <button
              key={particle.id}
              className={styles.fileParticle}
              type="button"
              data-testid="file-icon"
              data-phase={particle.phase}
              data-held={particle.isHeld}
              aria-label={`预览 ${particle.preview.title}`}
              style={particleStyle}
              onPointerEnter={(event) => handlePointerEnter(particle.id, event)}
              onPointerLeave={() => handlePointerLeave(particle.id)}
              onFocus={(event) => handleFocus(particle.id, event)}
              onBlur={() => handleBlur(particle.id)}
            >
              <span className={styles.fileIconMotion}>
                <img
                  className={styles.fileIconImage}
                  src={FILE_ASSETS[particle.kind]}
                  alt=""
                  draggable="false"
                  onError={() => handleImageError(particle.id, particle.kind)}
                />
              </span>
            </button>
          );
        })}
        </div>
      </div>

      {previewContainer ? createPortal(
        <FilePreview
          particle={activeParticle}
          pointer={pointer}
          anchorRect={activePreview?.anchorRect ?? null}
          inputMode={activePreview?.inputMode ?? 'pointer'}
          reducedMotion={reducedMotion}
          previewSource={previewSource}
          onInitializationError={onInitializationError}
          onQuickToStateChange={setPreviewTweenState}
        />,
        previewContainer
      ) : null}
    </>
  );
}
