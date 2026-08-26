import type { Rectangle } from 'electron';
import type {
  CharacterMotionPoint,
  CharacterMotionSnapshot
} from '../../shared/character-motion-ipc';
import type { TaskEvent } from '@myself/shared-types';
import { advanceMotion } from '../../shared/character-motion-math';
import type { CharacterMotionIntent } from './character-behavior-director';
import type { PetGeometrySnapshot } from './pet-visual-geometry';
import { clampIntegerWindowPositionToVisualWorkArea } from '../windows/window-manager';

type WindowBounds = Rectangle;

export type CharacterMotionWindow = {
  getBounds(): WindowBounds;
  setPosition(x: number, y: number): void;
};

export type CharacterMotionServiceOptions = {
  window: CharacterMotionWindow;
  getDisplays(): readonly Readonly<{ id: string; workAreaDip: Rectangle }>[];
  getGeometrySnapshot(): PetGeometrySnapshot | null;
  now?: () => number;
  maxDeltaMs?: number;
  random?: () => number;
};
export type CharacterUserMoveSource = 'native' | 'controller';
const DEFAULT_SPEED = 160;
const RANDOM_WANDER_ARRIVAL_TOLERANCE_DIP = 24;
const FAR_WANDER_MINIMUM_RATIO = 0.6;
const FAR_WANDER_SAMPLE_ATTEMPTS = 3;
const RELATIVE_DISTANCE_FACTOR = Object.freeze({
  near: 0.5,
  medium: 1,
  far: 2
} as const);

function integerPosition(point: CharacterMotionPoint): CharacterMotionPoint {
  return { x: Math.round(point.x), y: Math.round(point.y) };
}

function workAreaContainsPoint(
  point: CharacterMotionPoint,
  area: Rectangle
): boolean {
  return point.x >= area.x
    && point.y >= area.y
    && point.x < area.x + area.width
    && point.y < area.y + area.height;
}

function intersectionArea(left: Rectangle, right: Rectangle): number {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width)
    - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height)
    - Math.max(left.y, right.y));
  return width * height;
}

function distanceToRectangle(point: CharacterMotionPoint, rectangle: Rectangle): number {
  const dx = Math.max(rectangle.x - point.x, 0, point.x - (rectangle.x + rectangle.width));
  const dy = Math.max(rectangle.y - point.y, 0, point.y - (rectangle.y + rectangle.height));
  return dx * dx + dy * dy;
}

function squaredDistance(left: CharacterMotionPoint, right: CharacterMotionPoint): number {
  const dx = left.x - right.x;
  const dy = left.y - right.y;
  return dx * dx + dy * dy;
}

/** 远距目标只在当前单屏可达矩形中采样；反复命中近点时确定性选择最远角。 */
function sampleFarWorkAreaTarget(input: Readonly<{
  current: CharacterMotionPoint;
  minimumX: number;
  minimumY: number;
  maximumX: number;
  maximumY: number;
  random: () => number;
}>): CharacterMotionPoint {
  const corners = [
    { x: input.minimumX, y: input.minimumY },
    { x: input.maximumX, y: input.minimumY },
    { x: input.minimumX, y: input.maximumY },
    { x: input.maximumX, y: input.maximumY }
  ];
  const farthest = corners.reduce((best, candidate) => (
    squaredDistance(input.current, candidate) > squaredDistance(input.current, best)
      ? candidate
      : best
  ));
  const minimumSquaredDistance = squaredDistance(input.current, farthest)
    * FAR_WANDER_MINIMUM_RATIO * FAR_WANDER_MINIMUM_RATIO;
  for (let attempt = 0; attempt < FAR_WANDER_SAMPLE_ATTEMPTS; attempt += 1) {
    const candidate = {
      x: input.minimumX + (input.maximumX - input.minimumX) * input.random(),
      y: input.minimumY + (input.maximumY - input.minimumY) * input.random()
    };
    if (squaredDistance(input.current, candidate) >= minimumSquaredDistance) return candidate;
  }
  return farthest;
}

/** 统一按脚底命中、可见交集、脚底距离与稳定平局顺序选屏。 */
function selectDisplayForGeometry<T extends Readonly<{
  id: string;
  workAreaDip: Rectangle;
}>>(
  foot: CharacterMotionPoint,
  visual: Rectangle,
  displays: readonly T[],
  preferredId: string
): T | undefined {
  const ranked = displays.map((display, index) => ({
    display,
    index,
    containsFoot: workAreaContainsPoint(foot, display.workAreaDip),
    intersection: intersectionArea(visual, display.workAreaDip),
    distance: distanceToRectangle(foot, display.workAreaDip),
    preferred: display.id === preferredId
  }));
  return ranked.sort((left, right) => Number(right.containsFoot) - Number(left.containsFoot)
      || right.intersection - left.intersection
      || left.distance - right.distance
      || Number(right.preferred) - Number(left.preferred)
      || left.index - right.index)[0]?.display;
}

/** Main 是窗口坐标与运动时钟的唯一权威。 */
export class CharacterMotionService {
  private readonly now: () => number;
  private readonly maxDeltaMs: number;
  private readonly listeners = new Set<(snapshot: CharacterMotionSnapshot) => void>();
  private target: CharacterMotionPoint;
  private speed = DEFAULT_SPEED;
  private arrivalToleranceDip = 0;
  private lastTickMs: number;
  private revision = 0;
  private direction: 'left' | 'right' = 'right';
  private carrying = false;
  private latestSnapshot: CharacterMotionSnapshot;
  private readonly expectedProgrammaticPositions: CharacterMotionPoint[] = [];
  /** 原生窗口事件与桌宠控制器分别持有拖拽所有权，禁止一方释放另一方。 */
  private readonly userMoveOwners = new Set<CharacterUserMoveSource>();

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

  moveTo(target: CharacterMotionPoint, speed = DEFAULT_SPEED, arrivalToleranceDip = 0): void {
    if (
      !Number.isFinite(target.x)
      || !Number.isFinite(target.y)
      || !Number.isFinite(speed)
      || speed < 0
      || !Number.isFinite(arrivalToleranceDip)
      || arrivalToleranceDip < 0
    ) {
      throw new Error('CHARACTER_MOTION_INPUT_INVALID');
    }
    const bounds = this.options.window.getBounds();
    const geometry = this.options.getGeometrySnapshot();
    const constrained = geometry ? this.constrainTarget(target, geometry) : null;
    this.target = constrained ?? { x: bounds.x, y: bounds.y };
    if (this.target.x !== bounds.x) {
      this.direction = this.target.x < bounds.x ? 'left' : 'right';
    }
    this.speed = speed;
    this.arrivalToleranceDip = arrivalToleranceDip;
  }

  tick(): CharacterMotionSnapshot {
    const now = Math.max(this.lastTickMs, this.now());
    const bounds = this.options.window.getBounds();
    if (this.userMoveOwners.size > 0) {
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
    const geometry = this.options.getGeometrySnapshot();
    const constrainedTarget = geometry ? this.constrainTarget(this.target, geometry) : null;
    if (!geometry || !constrainedTarget) {
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
    this.target = constrainedTarget;
    const next = advanceMotion({
      current: { x: bounds.x, y: bounds.y },
      target: this.target,
      speed: this.speed,
      deltaMs: Math.max(0, now - this.lastTickMs),
      maxDeltaMs: this.maxDeltaMs,
      arrivalToleranceDip: this.arrivalToleranceDip
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
    if (this.userMoveOwners.size === 0) {
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
  beginUserMove(
    nextPosition?: CharacterMotionPoint,
    source: CharacterUserMoveSource = 'native'
  ): void {
    if (
      nextPosition
      && this.expectedProgrammaticPositions.some(expected => (
        Math.round(nextPosition.x) === expected.x && Math.round(nextPosition.y) === expected.y
      ))
    ) return;
    this.userMoveOwners.add(source);
    this.expectedProgrammaticPositions.splice(0);
    const bounds = this.options.window.getBounds();
    this.target = { x: bounds.x, y: bounds.y };
    this.lastTickMs = Math.max(this.lastTickMs, this.now());
  }

  endUserMove(source: CharacterUserMoveSource = 'native'): void {
    if (!this.userMoveOwners.has(source)) return;
    this.handleWindowMoved();
    this.userMoveOwners.delete(source);
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
    return this.userMoveOwners.size > 0;
  }

  /** 几何事务在调用 BrowserWindow.setBounds 前登记目标，避免 moved 被误判为用户接管。 */
  expectProgrammaticPosition(point: CharacterMotionPoint): () => void {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      throw new Error('CHARACTER_MOTION_INPUT_INVALID');
    }
    const position = integerPosition(point);
    const bounds = this.options.window.getBounds();
    const previousTarget = { ...this.target };
    const delta = { x: position.x - bounds.x, y: position.y - bounds.y };
    // 布局改变窗口原点时，静止目标跟随新原点，活动目标以同一差值重基。
    this.target = this.target.x === bounds.x && this.target.y === bounds.y
      ? position
      : { x: this.target.x + delta.x, y: this.target.y + delta.y };
    const rebasedTarget = { ...this.target };
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
        this.target.x === rebasedTarget.x
        && this.target.y === rebasedTarget.y
      ) {
        this.target = previousTarget;
      }
    };
  }

  /** 对象化意图不接受绝对坐标，距离与边界只消费 Main 可见几何快照。 */
  requestIntent(intent: CharacterMotionIntent): CharacterMotionSnapshot | null {
    const bounds = this.options.window.getBounds();
    const geometry = this.options.getGeometrySnapshot();
    if (!geometry) {
      this.target = { x: bounds.x, y: bounds.y };
      return null;
    }
    const displays = this.options.getDisplays();
    const footOffset = this.footOffsetInWindow(geometry);
    if (!footOffset) return null;
    const currentFoot = { x: bounds.x + footOffset.x, y: bounds.y + footOffset.y };
    const currentVisual = {
      x: bounds.x + geometry.visualBoundsInWindowDip.x,
      y: bounds.y + geometry.visualBoundsInWindowDip.y,
      width: geometry.visualBoundsInWindowDip.width,
      height: geometry.visualBoundsInWindowDip.height
    };
    const display = selectDisplayForGeometry(
      currentFoot,
      currentVisual,
      displays,
      geometry.displayId
    );
    if (!display) return null;
    const area = display.workAreaDip;
    const visual = geometry.visualBoundsInWindowDip;
    if (intent.kind === 'return-visible') {
      this.moveTo({ x: bounds.x, y: bounds.y });
      return this.tick();
    }
    if (intent.kind === 'relative') {
      const factor = RELATIVE_DISTANCE_FACTOR[intent.distance];
      const horizontal = intent.direction === 'left' || intent.direction === 'right';
      const distance = (horizontal ? visual.width : visual.height) * factor;
      const offset = intent.direction === 'left' || intent.direction === 'up'
        ? -distance
        : distance;
      this.moveTo({
        x: horizontal ? bounds.x + offset : bounds.x,
        y: horizontal ? bounds.y : bounds.y + offset
      });
      return this.tick();
    }
    if (intent.kind === 'region') {
      this.moveTo({
        x: intent.region.includes('left')
          ? area.x - visual.x
          : intent.region.includes('right')
            ? area.x + area.width - visual.x - visual.width
            : bounds.x,
        y: intent.region.includes('top')
          ? area.y - visual.y
          : intent.region.includes('bottom')
            ? area.y + area.height - visual.y - visual.height
        : bounds.y
      });
      return this.tick();
    }
    const random = this.options.random ?? Math.random;
    if (intent.scope === 'short') {
      this.moveTo({
        x: bounds.x + (random() * 2 - 1) * visual.width,
        y: bounds.y + (random() * 2 - 1) * visual.height
      });
      return this.tick();
    }
    const minimumX = area.x - visual.x;
    const minimumY = area.y - visual.y;
    const maximumX = area.x + area.width - visual.x - visual.width;
    const maximumY = area.y + area.height - visual.y - visual.height;
    const target = intent.distance === 'far'
      ? sampleFarWorkAreaTarget({
          current: { x: bounds.x, y: bounds.y },
          minimumX,
          minimumY,
          maximumX,
          maximumY,
          random
        })
      : {
          x: minimumX + (maximumX - minimumX) * random(),
          y: minimumY + (maximumY - minimumY) * random()
        };
    this.moveTo(target, DEFAULT_SPEED, RANDOM_WANDER_ARRIVAL_TOLERANCE_DIP);
    return this.tick();
  }

  /** 停止只撤销当前空间目标，不重置窗口、角色状态或播放调度。 */
  stop(): void {
    const bounds = this.options.window.getBounds();
    this.target = { x: bounds.x, y: bounds.y };
    this.speed = DEFAULT_SPEED;
    this.arrivalToleranceDip = 0;
  }

  private footOffsetInWindow(
    geometry: PetGeometrySnapshot
  ): CharacterMotionPoint | null {
    const offset = {
      x: geometry.footAnchorDip.x - geometry.windowBoundsDip.x,
      y: geometry.footAnchorDip.y - geometry.windowBoundsDip.y
    };
    return Number.isFinite(offset.x) && Number.isFinite(offset.y) ? offset : null;
  }

  private constrainTarget(
    target: CharacterMotionPoint,
    geometry: PetGeometrySnapshot
  ): CharacterMotionPoint | null {
    const displays = this.options.getDisplays();
    const footOffset = this.footOffsetInWindow(geometry);
    if (!footOffset || displays.length === 0) return null;
    const targetFoot = { x: target.x + footOffset.x, y: target.y + footOffset.y };
    const targetVisual = {
      x: target.x + geometry.visualBoundsInWindowDip.x,
      y: target.y + geometry.visualBoundsInWindowDip.y,
      width: geometry.visualBoundsInWindowDip.width,
      height: geometry.visualBoundsInWindowDip.height
    };
    const display = selectDisplayForGeometry(
      targetFoot,
      targetVisual,
      displays,
      geometry.displayId
    );
    if (!display) return null;
    return clampIntegerWindowPositionToVisualWorkArea({
      windowPositionDip: target,
      visualBoundsInWindowDip: geometry.visualBoundsInWindowDip,
      workAreaDip: display.workAreaDip
    });
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
    & Partial<Pick<CharacterMotionService, 'isUserMoving'>>,
  callbacks: Readonly<{
    onUserMoveStarted?(): void;
    onUserMoveEnded?(): void;
  }> = {}
): () => void {
  let movedTimer: ReturnType<typeof setTimeout> | undefined;
  let nativeMoveActive = false;
  const onWillMove = (_event?: unknown, newBounds?: Rectangle): void => {
    if (movedTimer) clearTimeout(movedTimer);
    movedTimer = undefined;
    const wasActive = nativeMoveActive;
    service.beginUserMove(newBounds ? { x: newBounds.x, y: newBounds.y } : undefined);
    nativeMoveActive = service.isUserMoving?.() ?? true;
    if (!wasActive && nativeMoveActive) callbacks.onUserMoveStarted?.();
  };
  const onMove = (): void => {
    if (!nativeMoveActive) {
      const bounds = window.getBounds();
      service.beginUserMove({ x: bounds.x, y: bounds.y });
      nativeMoveActive = service.isUserMoving?.() ?? true;
      if (nativeMoveActive) callbacks.onUserMoveStarted?.();
    }
    service.handleWindowMoved();
  };
  // Windows 原生拖拽会连续发 moved；静默 250ms 才代表用户真正松手。
  const onMoved = (): void => {
    if (!nativeMoveActive) return;
    if (movedTimer) clearTimeout(movedTimer);
    movedTimer = setTimeout(() => {
      movedTimer = undefined;
      service.endUserMove();
      nativeMoveActive = false;
      callbacks.onUserMoveEnded?.();
    }, 250);
  };
  window.on('will-move', onWillMove);
  window.on('move', onMove);
  window.on('moved', onMoved);
  return () => {
    if (movedTimer) clearTimeout(movedTimer);
    if (nativeMoveActive) {
      service.endUserMove();
      callbacks.onUserMoveEnded?.();
    }
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
