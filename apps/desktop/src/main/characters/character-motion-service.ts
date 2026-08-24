import type { Rectangle } from 'electron';
import type {
  CharacterMotionPoint,
  CharacterMotionSnapshot
} from '../../shared/character-motion-ipc';
import type { TaskEvent } from '@myself/shared-types';
import { advanceMotion } from '../../shared/character-motion-math';
import type { CharacterMotionIntent } from './character-behavior-director';

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
  random?: () => number;
};
const DEFAULT_SPEED = 160;
const RELATIVE_DISTANCE_FACTOR = Object.freeze({
  near: 0.5,
  medium: 1,
  far: 2
} as const);

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
  private readonly listeners = new Set<(snapshot: CharacterMotionSnapshot) => void>();
  private target: CharacterMotionPoint;
  private speed = DEFAULT_SPEED;
  private lastTickMs: number;
  private revision = 0;
  private direction: 'left' | 'right' = 'right';
  private carrying = false;
  private latestSnapshot: CharacterMotionSnapshot;
  private readonly expectedProgrammaticPositions: CharacterMotionPoint[] = [];
  private userMoving = false;

  constructor(private readonly options: CharacterMotionServiceOptions) {
    this.now = options.now ?? performance.now.bind(performance);
    this.maxDeltaMs = options.maxDeltaMs ?? 100;
    const bounds = options.window.getBounds();
    this.target = { x: bounds.x, y: bounds.y };
    this.lastTickMs = this.now();
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

  tick(): CharacterMotionSnapshot {
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

  /**
   * Windows 也可能为 setBounds 发出 will-move；命中预登记目标时仍属于程序化移动。
   * 真正用户拖动没有匹配目标，才撤销自动运动所有权。
   */
  beginUserMove(nextPosition?: CharacterMotionPoint): void {
    if (
      nextPosition
      && this.expectedProgrammaticPositions.some(expected => (
        Math.round(nextPosition.x) === expected.x && Math.round(nextPosition.y) === expected.y
      ))
    ) return;
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

  /** 只消费可信任务事件类型，不读取 message/error 文案推导结果。 */
  applyTaskEvent(event: TaskEvent): void {
    if (event.type === 'character_carrying') {
      this.setCarrying(event.carrying);
    }
  }

  /** 几何 FIFO 只查询拖动占用，不接触 Renderer 身份或全局坐标。 */
  isUserMoving(): boolean {
    return this.userMoving;
  }

  /** 几何事务在调用 BrowserWindow.setBounds 前登记目标，避免 moved 被误判为用户接管。 */
  expectProgrammaticPosition(point: CharacterMotionPoint): () => void {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      throw new Error('CHARACTER_MOTION_INPUT_INVALID');
    }
    const position = integerPosition(point);
    const previousTarget = { ...this.target };
    let rebasedTarget = false;
    if (
      !this.latestSnapshot.moving
      && this.target.x === this.latestSnapshot.position.x
      && this.target.y === this.latestSnapshot.position.y
    ) {
      // 隐藏 BrowserWindow 可能不发 move/moved，静止 target 必须在 setBounds 前同步。
      this.target = position;
      rebasedTarget = true;
    }
    this.expectedProgrammaticPositions.push(position);
    if (this.expectedProgrammaticPositions.length > 64) {
      this.expectedProgrammaticPositions.shift();
    }
    return () => {
      const expectedIndex = this.expectedProgrammaticPositions.indexOf(position);
      // 已由窗口消息消费的预期位置不是失败残留，不能反向撤销已发生的移动。
      if (expectedIndex < 0) return;
      this.expectedProgrammaticPositions.splice(expectedIndex, 1);
      if (
        rebasedTarget
        && this.target.x === position.x
        && this.target.y === position.y
      ) {
        this.target = previousTarget;
      }
    };
  }

  /** 对象化意图不接受绝对坐标，所有目标继续经过同一窗口矩形边界钳制。 */
  requestIntent(intent: CharacterMotionIntent): void {
    const bounds = this.options.window.getBounds();
    const areas = this.availableMovementRegions();
    const area = containingWorkArea({ x: bounds.x, y: bounds.y }, areas) ?? areas[0];
    if (!area) return;
    if (intent.kind === 'return-visible') {
      this.moveTo({ x: area.x, y: area.y });
      return;
    }
    if (intent.kind === 'relative') {
      const factor = RELATIVE_DISTANCE_FACTOR[intent.distance];
      const horizontal = intent.direction === 'left' || intent.direction === 'right';
      const distance = (horizontal ? bounds.width : bounds.height) * factor;
      const offset = intent.direction === 'left' || intent.direction === 'up'
        ? -distance
        : distance;
      this.moveTo({
        x: horizontal ? bounds.x + offset : bounds.x,
        y: horizontal ? bounds.y : bounds.y + offset
      });
      return;
    }
    if (intent.kind === 'region') {
      const maximumX = Math.max(area.x, area.x + area.width - bounds.width);
      const maximumY = Math.max(area.y, area.y + area.height - bounds.height);
      this.moveTo({
        x: intent.region.includes('left')
          ? area.x
          : intent.region.includes('right')
            ? maximumX
            : bounds.x,
        y: intent.region.includes('top')
          ? area.y
          : intent.region.includes('bottom')
            ? maximumY
            : bounds.y
      });
      return;
    }
    const random = this.options.random ?? Math.random;
    if (intent.scope === 'short') {
      this.moveTo({
        x: bounds.x + (random() * 2 - 1) * bounds.width,
        y: bounds.y + (random() * 2 - 1) * bounds.height
      });
      return;
    }
    const maximumX = Math.max(area.x, area.x + area.width - bounds.width);
    const maximumY = Math.max(area.y, area.y + area.height - bounds.height);
    this.moveTo({
      x: area.x + (maximumX - area.x) * random(),
      y: area.y + (maximumY - area.y) * random()
    });
  }

  /** 停止只撤销当前空间目标，不重置窗口、角色状态或播放调度。 */
  stop(): void {
    const bounds = this.options.window.getBounds();
    this.target = { x: bounds.x, y: bounds.y };
    this.speed = DEFAULT_SPEED;
  }

  private availableMovementRegions(): readonly Rectangle[] {
    return this.options.getWorkAreas();
  }

  private constrainTarget(
    target: CharacterMotionPoint,
    bounds: WindowBounds
  ): CharacterMotionPoint {
    const areas = this.availableMovementRegions();
    const area = containingWorkArea(target, areas);
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

}

type MotionWindowEvents = CharacterMotionWindow & {
  on(
    name: 'will-move' | 'move' | 'moved',
    listener: (event?: unknown, newBounds?: Rectangle) => void
  ): void;
  removeListener(
    name: 'will-move' | 'move' | 'moved',
    listener: (event?: unknown, newBounds?: Rectangle) => void
  ): void;
};

/** 统一生产窗口事件接线，确保 Windows 用户拖拽先于 move/moved 接管。 */
export function bindCharacterMotionWindow(
  window: MotionWindowEvents,
  service: Pick<CharacterMotionService, 'beginUserMove' | 'handleWindowMoved' | 'endUserMove'>
): () => void {
  const onWillMove = (_event?: unknown, newBounds?: Rectangle): void => (
    service.beginUserMove(newBounds ? { x: newBounds.x, y: newBounds.y } : undefined)
  );
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
