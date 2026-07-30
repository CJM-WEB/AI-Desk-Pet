import { EXPERIENCE_CONFIG } from './config';
import { CONTENT_POOL, pickPreviewIndex } from './content-pool';
import type { PreviewContent } from './content-pool';
import type { FileKind } from './types';

const VIEWPORT_MARGIN = 24;
const PARTICLE_GAP = 18;
const MAX_SPAWN_ATTEMPTS = 24;
const LEAVING_THRESHOLD_MS = 500;
const FILE_KINDS: readonly FileKind[] = ['txt', 'pdf', 'ppt', 'xls', 'img', 'empty', 'folder'];

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SpawnViewport {
  width: number;
  height: number;
  safeZoneRatio: number;
}

export interface FileParticle extends Rect {
  id: string;
  kind: FileKind;
  preview: PreviewContent;
  previewIndex?: number;
  rotation: number;
  scale: number;
  remainingMs: number;
  isHeld: boolean;
  phase: 'entering' | 'floating' | 'leaving';
}

export function createSeededRandom(seed: number): () => number {
  let value = seed >>> 0;

  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

export function isPlacementAllowed(
  candidate: Rect,
  existing: readonly Rect[],
  viewport: SpawnViewport
): boolean {
  if (!isInsideViewport(candidate, viewport) || intersects(candidate, safeZone(viewport))) {
    return false;
  }

  return existing.every((rect) => !intersects(candidate, expandRect(rect, PARTICLE_GAP)));
}

export function spawnParticle(input: {
  id: string;
  now: number;
  viewport: SpawnViewport;
  existing: readonly Rect[];
  random: () => number;
  pool?: Record<FileKind, readonly PreviewContent[]>;
}): FileParticle | null {
  const { random, viewport, pool = CONTENT_POOL } = input;
  const kind = FILE_KINDS[Math.floor(random() * FILE_KINDS.length)]!;
  const previewIndex = pickPreviewIndex(kind, random, pool);
  const preview = pool[kind][previewIndex]!;
  const size = 96 + random() * 48;
  const positionWidth = viewport.width - (VIEWPORT_MARGIN * 2) - size;
  const positionHeight = viewport.height - (VIEWPORT_MARGIN * 2) - size;
  const rotation = -8 + random() * 16;
  const scale = 0.88 + random() * 0.24;
  const [minimumLifetime, maximumLifetime] = EXPERIENCE_CONFIG.swarm.lifetimeMs;
  const remainingMs = minimumLifetime + random() * (maximumLifetime - minimumLifetime);

  if (positionWidth < 0 || positionHeight < 0) {
    return null;
  }

  // 位置候选共用粒子的既定外观和预览，仅在有效位置出现时创建粒子。
  for (let attempt = 0; attempt < MAX_SPAWN_ATTEMPTS; attempt += 1) {
    const candidate: Rect = {
      x: VIEWPORT_MARGIN + random() * positionWidth,
      y: VIEWPORT_MARGIN + random() * positionHeight,
      width: size,
      height: size
    };

    if (isPlacementAllowed(candidate, input.existing, viewport)) {
      return {
        id: input.id,
        kind,
        preview,
        previewIndex,
        ...candidate,
        rotation,
        scale,
        remainingMs,
        isHeld: false,
        phase: 'entering'
      };
    }
  }

  return null;
}

export function advanceParticle(particle: FileParticle, deltaMs: number): FileParticle {
  if (particle.isHeld) {
    return particle;
  }

  const remainingMs = Math.max(0, particle.remainingMs - Math.max(0, deltaMs));

  return {
    ...particle,
    remainingMs,
    phase: remainingMs <= LEAVING_THRESHOLD_MS ? 'leaving' : particle.phase
  };
}

function isInsideViewport(rect: Rect, viewport: SpawnViewport): boolean {
  return rect.x >= VIEWPORT_MARGIN
    && rect.y >= VIEWPORT_MARGIN
    && rect.x + rect.width <= viewport.width - VIEWPORT_MARGIN
    && rect.y + rect.height <= viewport.height - VIEWPORT_MARGIN;
}

function safeZone(viewport: SpawnViewport): Rect {
  const width = viewport.width * viewport.safeZoneRatio;
  const height = viewport.height * viewport.safeZoneRatio;

  return {
    x: (viewport.width - width) / 2,
    y: (viewport.height - height) / 2,
    width,
    height
  };
}

function expandRect(rect: Rect, amount: number): Rect {
  return {
    x: rect.x - amount,
    y: rect.y - amount,
    width: rect.width + amount * 2,
    height: rect.height + amount * 2
  };
}

function intersects(first: Rect, second: Rect): boolean {
  return first.x < second.x + second.width
    && first.x + first.width > second.x
    && first.y < second.y + second.height
    && first.y + first.height > second.y;
}
