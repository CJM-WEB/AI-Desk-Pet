import {
  selectCharacterAction,
  type ActionSelectionInput,
  type ActionSelectionResult,
  type CharacterManifestV1
} from '@myself/character-runtime';
import type { Rectangle } from 'electron';
import type {
  CharacterMotionPoint,
  CharacterMotionSnapshot
} from '../../shared/character-motion-ipc';
import type { TaskEvent } from '@myself/shared-types';
import { advanceMotion } from '../../shared/character-motion-math';

type WindowBounds = Rectangle;

export type CharacterMotionWindow = {
  getBounds(): WindowBounds;
  setPosition(x: number, y: number): void;
};

export type CharacterMotionServiceOptions = {
  window: CharacterMotionWindow;
  getWorkAreas(): readonly Rectangle[];
  now?: () => number;
  maxDeltaMs?: number;
  idleIntervalMs?: number;
  recentActionLimit?: number;
  selectAction?: (input: ActionSelectionInput) => ActionSelectionResult;
  random?: () => number;
  createPlaybackToken?: () => string;
  playbackTokenTtlMs?: number;
};
export type CharacterMotionIntent = 'wander' | 'return-visible';

const DEFAULT_SPEED = 160;

function integerPosition(point: CharacterMotionPoint): CharacterMotionPoint {
  return { x: Math.round(point.x), y: Math.round(point.y) };
}

function containingWorkArea(
  point: CharacterMotionPoint,
  workAreas: readonly Rectangle[]
): Rectangle | undefined {
  return workAreas.find(area => (
    point.x >= area.x
    && point.y >= area.y
    && point.x <= area.x + area.width
    && point.y <= area.y + area.height
  )) ?? workAreas[0];
}

/** Main 是窗口坐标与运动时钟的唯一权威。 */
export class CharacterMotionService {
  private readonly now: () => number;
  private readonly maxDeltaMs: number;
  private readonly idleIntervalMs: number;
  private readonly recentActionLimit: number;
  private readonly selectAction: (input: ActionSelectionInput) => ActionSelectionResult;
  private readonly listeners = new Set<(snapshot: CharacterMotionSnapshot) => void>();
  private readonly recentActionIds: string[] = [];
  private target: CharacterMotionPoint;
  private speed = DEFAULT_SPEED;
  private lastTickMs: number;
  private nextIdleAt: number;
  private idleAllowedAt = 0;
  private revision = 0;
  private direction: 'left' | 'right' = 'right';
  private carrying = false;
  private latestSnapshot: CharacterMotionSnapshot;
  private readonly expectedProgrammaticPositions: CharacterMotionPoint[] = [];
  private readonly pendingPlaybackTokens = new Map<string, {
    actionId: string;
    characterId: string;
    revision: number;
    expiresAt: number;
  }>();
  private userMoving = false;
  private suspended = false;
  private suspendedAtMs = 0;
  private movementRegions: Rectangle[] | null = null;

  constructor(private readonly options: CharacterMotionServiceOptions) {
    this.now = options.now ?? performance.now.bind(performance);
    this.maxDeltaMs = options.maxDeltaMs ?? 100;
    this.idleIntervalMs = options.idleIntervalMs ?? 10_000;
    this.recentActionLimit = options.recentActionLimit ?? 4;
    this.selectAction = options.selectAction ?? selectCharacterAction;
    const bounds = options.window.getBounds();
    this.target = { x: bounds.x, y: bounds.y };
    this.lastTickMs = this.now();
    this.nextIdleAt = this.lastTickMs + this.idleIntervalMs;
    this.latestSnapshot = {
      revision: 0,
      timestampMs: this.lastTickMs,
      position: { x: bounds.x, y: bounds.y },
      target: { ...this.target },
      direction: 'right',
      moving: false,
      carrying: false
    };
  }

  moveTo(target: CharacterMotionPoint, speed = DEFAULT_SPEED): void {
    if (
      !Number.isFinite(target.x)
      || !Number.isFinite(target.y)
      || !Number.isFinite(speed)
      || speed < 0
    ) {
      throw new Error('CHARACTER_MOTION_INPUT_INVALID');
    }
    const bounds = this.options.window.getBounds();
    this.target = this.constrainTarget(target, bounds);
    if (this.target.x !== bounds.x) {
      this.direction = this.target.x < bounds.x ? 'left' : 'right';
    }
    this.speed = speed;
  }

  /** 隐藏和候选切换期间冻结运动时钟，恢复时不补走暂停时间。 */
  setSuspended(suspended: boolean): void {
    if (this.suspended === suspended) return;
    const now = Math.max(this.lastTickMs, this.now());
    this.suspended = suspended;
    if (suspended) {
      this.suspendedAtMs = now;
      this.expectedProgrammaticPositions.splice(0);
      return;
    }
    const suspendedDuration = Math.max(0, now - this.suspendedAtMs);
    this.lastTickMs = now;
    this.nextIdleAt += suspendedDuration;
    if (Number.isFinite(this.idleAllowedAt)) this.idleAllowedAt += suspendedDuration;
  }

  /** null 恢复桌面工作区；显式矩形只保留能容纳当前窗口的区域。 */
  setMovementRegions(rectangles: readonly Rectangle[] | null): void {
    if (rectangles === null) {
      this.movementRegions = null;
    } else {
      const bounds = this.options.window.getBounds();
      const nextRegions = rectangles
        .filter(rectangle => (
          Number.isFinite(rectangle.x)
          && Number.isFinite(rectangle.y)
          && Number.isFinite(rectangle.width)
          && Number.isFinite(rectangle.height)
          && rectangle.width >= bounds.width
          && rectangle.height >= bounds.height
        ))
        .map(rectangle => ({ ...rectangle }));
      if (
        !this.suspended
        && !nextRegions.some(region => this.regionContainsBounds(region, bounds))
      ) {
        throw new Error('CHARACTER_MOTION_REGION_TRANSITION_UNSAFE');
      }
      this.movementRegions = nextRegions;
    }
    this.target = this.constrainTarget(this.target, this.options.window.getBounds());
  }

  tick(): CharacterMotionSnapshot {
    if (this.suspended) return structuredClone(this.latestSnapshot);
    const now = Math.max(this.lastTickMs, this.now());
    const bounds = this.options.window.getBounds();
    if (this.userMoving) {
      const position = { x: bounds.x, y: bounds.y };
      this.target = position;
      this.lastTickMs = now;
      this.latestSnapshot = {
        revision: ++this.revision,
        timestampMs: now,
        position,
        target: { ...position },
        direction: this.direction,
        moving: false,
        carrying: this.carrying
      };
      for (const listener of [...this.listeners]) listener(this.latestSnapshot);
      return structuredClone(this.latestSnapshot);
    }
    const next = advanceMotion({
      current: { x: bounds.x, y: bounds.y },
      target: this.target,
      speed: this.speed,
      deltaMs: Math.max(0, now - this.lastTickMs),
      maxDeltaMs: this.maxDeltaMs
    });
    const position = integerPosition(next.position);
    if (position.x !== bounds.x || position.y !== bounds.y) {
      this.expectedProgrammaticPositions.push(position);
      if (this.expectedProgrammaticPositions.length > 64) {
        this.expectedProgrammaticPositions.shift();
      }
      this.options.window.setPosition(position.x, position.y);
    }
    this.lastTickMs = now;
    this.latestSnapshot = {
      revision: ++this.revision,
      timestampMs: now,
      position,
      target: { ...this.target },
      direction: this.direction,
      moving: !next.arrived,
      carrying: this.carrying
    };
    for (const listener of [...this.listeners]) listener(this.latestSnapshot);
    return structuredClone(this.latestSnapshot);
  }

  getSnapshot(): CharacterMotionSnapshot {
    return structuredClone(this.latestSnapshot);
  }

  /** 区分服务自身移动事件与用户拖动，用户位置会成为新的权威目标。 */
  handleWindowMoved(): void {
    const bounds = this.options.window.getBounds();
    const position = { x: bounds.x, y: bounds.y };
    if (this.suspended) {
      this.target = position;
      this.latestSnapshot = {
        ...this.latestSnapshot,
        position,
        target: { ...position },
        moving: false
      };
      return;
    }
    if (!this.userMoving) {
      const expectedIndex = this.expectedProgrammaticPositions.findIndex(expected => (
        position.x === expected.x && position.y === expected.y
      ));
      if (expectedIndex >= 0) {
        this.expectedProgrammaticPositions.splice(expectedIndex, 1);
        return;
      }
    }
    this.target = position;
    this.lastTickMs = Math.max(this.lastTickMs, this.now());
    this.latestSnapshot = {
      revision: ++this.revision,
      timestampMs: this.lastTickMs,
      position,
      target: { ...position },
      direction: this.direction,
      moving: false,
      carrying: this.carrying
    };
    for (const listener of [...this.listeners]) listener(this.latestSnapshot);
  }

  /** Windows 的 will-move 只代表用户手动移动，立即撤销所有自动运动所有权。 */
  beginUserMove(): void {
    this.userMoving = true;
    this.expectedProgrammaticPositions.splice(0);
    const bounds = this.options.window.getBounds();
    this.target = { x: bounds.x, y: bounds.y };
    this.lastTickMs = Math.max(this.lastTickMs, this.now());
  }

  endUserMove(): void {
    if (!this.userMoving) return;
    this.handleWindowMoved();
    this.userMoving = false;
  }

  issueIdlePlayback(input: {
    actionId: string;
    characterId: string;
    revision: number;
  }): string {
    const now = Math.max(this.lastTickMs, this.now());
    this.purgePlaybackTokens(now);
    const token = (this.options.createPlaybackToken ?? randomUUID)();
    this.pendingPlaybackTokens.set(token, {
      ...input,
      expiresAt: now + (this.options.playbackTokenTtlMs ?? 30_000)
    });
    return token;
  }

  confirmIdlePlayback(input: {
    playbackToken: string;
    actionId: string;
    characterId: string;
  }): void {
    const now = Math.max(this.lastTickMs, this.now());
    this.purgePlaybackTokens(now);
    const pending = this.pendingPlaybackTokens.get(input.playbackToken);
    if (pending) this.pendingPlaybackTokens.delete(input.playbackToken);
    if (
      !pending
      || pending.actionId !== input.actionId
      || pending.characterId !== input.characterId
    ) {
      throw new Error('CHARACTER_PLAYBACK_UNAUTHORIZED');
    }
    this.recordPlayedAction(input.actionId);
  }

  private purgePlaybackTokens(now: number): void {
    for (const [token, pending] of this.pendingPlaybackTokens) {
      if (pending.expiresAt < now) this.pendingPlaybackTokens.delete(token);
    }
  }

  subscribe(listener: (snapshot: CharacterMotionSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 搬运状态只接受 Main 内部可信调用，并随权威运动快照广播。 */
  setCarrying(carrying: boolean): void {
    if (this.carrying === carrying) return;
    this.carrying = carrying;
    const now = Math.max(this.lastTickMs, this.now());
    this.lastTickMs = now;
    this.latestSnapshot = {
      ...this.latestSnapshot,
      revision: ++this.revision,
      timestampMs: now,
      carrying
    };
    for (const listener of [...this.listeners]) listener(this.latestSnapshot);
  }

  recordPlayedAction(actionId: string): void {
    if (!actionId) return;
    if (this.recentActionIds.at(-1) === actionId) return;
    this.recentActionIds.push(actionId);
    if (this.recentActionIds.length > this.recentActionLimit) {
      this.recentActionIds.splice(0, this.recentActionIds.length - this.recentActionLimit);
    }
  }

  /** 只消费可信任务事件类型，不读取 message/error 文案推导结果。 */
  applyTaskEvent(event: TaskEvent): void {
    const now = Math.max(this.lastTickMs, this.now());
    if (event.type === 'character_carrying') {
      this.setCarrying(event.carrying);
      return;
    }
    if (event.type === 'phase') {
      if (event.phase === 'idle' || event.phase === 'cancelled') {
        this.idleAllowedAt = now;
      } else if (event.phase === 'success' || event.phase === 'error') {
        this.idleAllowedAt = now + 1_500;
      } else {
        this.idleAllowedAt = Number.POSITIVE_INFINITY;
      }
      this.nextIdleAt = now + this.idleIntervalMs;
    }
    if (event.type === 'pending_action') {
      this.idleAllowedAt = Number.POSITIVE_INFINITY;
      this.nextIdleAt = now + this.idleIntervalMs;
    }
  }

  pollIdle(
    manifest: CharacterManifestV1,
    direction: 'left' | 'right',
    random: () => number
  ): ActionSelectionResult | null {
    if (this.suspended) return null;
    const now = this.now();
    if (now < this.nextIdleAt || now < this.idleAllowedAt) return null;
    this.nextIdleAt = now + this.idleIntervalMs;
    const result = this.selectAction({
      manifest,
      stateId: 'idle',
      direction,
      recentActionIds: [...this.recentActionIds],
      random
    });
    return result;
  }

  requestIntent(intent: CharacterMotionIntent): void {
    const bounds = this.options.window.getBounds();
    const areas = this.availableMovementRegions();
    const area = containingWorkArea({ x: bounds.x, y: bounds.y }, areas) ?? areas[0];
    if (!area) return;
    if (intent === 'return-visible') {
      this.moveTo({ x: area.x, y: area.y });
      return;
    }
    const random = this.options.random ?? Math.random;
    const maximumX = Math.max(area.x, area.x + area.width - bounds.width);
    const maximumY = Math.max(area.y, area.y + area.height - bounds.height);
    this.moveTo({
      x: area.x + (maximumX - area.x) * random(),
      y: area.y + (maximumY - area.y) * random()
    });
  }

  private availableMovementRegions(): readonly Rectangle[] {
    return this.movementRegions ?? this.options.getWorkAreas();
  }

  private constrainTarget(
    target: CharacterMotionPoint,
    bounds: WindowBounds
  ): CharacterMotionPoint {
    const areas = this.availableMovementRegions();
    const currentArea = this.movementRegions?.find(area => (
      this.regionContainsBounds(area, bounds)
    ));
    const area = currentArea ?? containingWorkArea(target, areas);
    if (!area) return { x: bounds.x, y: bounds.y };
    return {
      x: Math.min(
        Math.max(area.x, area.x + area.width - bounds.width),
        Math.max(area.x, target.x)
      ),
      y: Math.min(
        Math.max(area.y, area.y + area.height - bounds.height),
        Math.max(area.y, target.y)
      )
    };
  }

  private regionContainsBounds(region: Rectangle, bounds: WindowBounds): boolean {
    return bounds.x >= region.x
      && bounds.y >= region.y
      && bounds.x + bounds.width <= region.x + region.width
      && bounds.y + bounds.height <= region.y + region.height;
  }
}

type MotionWindowEvents = CharacterMotionWindow & {
  on(name: 'will-move' | 'move' | 'moved', listener: () => void): void;
  removeListener(name: 'will-move' | 'move' | 'moved', listener: () => void): void;
};

/** 统一生产窗口事件接线，确保 Windows 用户拖拽先于 move/moved 接管。 */
export function bindCharacterMotionWindow(
  window: MotionWindowEvents,
  service: Pick<CharacterMotionService, 'beginUserMove' | 'handleWindowMoved' | 'endUserMove'>
): () => void {
  const onWillMove = (): void => service.beginUserMove();
  const onMove = (): void => service.handleWindowMoved();
  const onMoved = (): void => service.endUserMove();
  window.on('will-move', onWillMove);
  window.on('move', onMove);
  window.on('moved', onMoved);
  return () => {
    window.removeListener('will-move', onWillMove);
    window.removeListener('move', onMove);
    window.removeListener('moved', onMoved);
  };
}

export function startCharacterMotionTimers(options: {
  tick(): void;
  poll(): void;
  isDestroyed(): boolean;
  tickIntervalMs: number;
  idleIntervalMs: number;
}): { destroy(): void } {
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(tickTimer);
    clearInterval(idleTimer);
  };
  const guard = (operation: () => void): void => {
    if (stopped) return;
    if (options.isDestroyed()) {
      stop();
      return;
    }
    operation();
  };
  const tickTimer = setInterval(() => guard(options.tick), options.tickIntervalMs);
  const idleTimer = setInterval(() => guard(options.poll), options.idleIntervalMs);
  return { destroy: stop };
}
import { randomUUID } from 'node:crypto';
