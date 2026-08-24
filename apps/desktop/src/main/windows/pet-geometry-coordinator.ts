import type { Rectangle } from 'electron';
import type { CharacterGeometryBinding } from '../characters/character-behavior-service';
import {
  type PetGeometryRenderView,
  petGeometryRenderViewSchema
} from '../../shared/character-motion-ipc';
import type {
  PetScaleStepInput,
  PetViewportCommitInput
} from '../../shared/pet-window-interaction';
import type { PetVisualGeometryAuthority } from '../characters/pet-visual-geometry';
import type {
  PetPlacementStateSnapshot,
  SettingsStore,
  StoredPetPlacement
} from '../storage/settings-store';
import { migrateLegacyPetPosition, restorePetPlacement } from './pet-position';

const MIN_SCALE_TICK = 5;
const MAX_SCALE_TICK = 20;
const VIEWPORT_ACK_TIMEOUT_MS = 2_000;

type BoundsWindow = {
  getBounds(): Rectangle;
  setBounds(bounds: Rectangle): void;
  isDestroyed(): boolean;
};

type CoordinatorOptions = {
  window: BoundsWindow;
  authority: PetVisualGeometryAuthority;
  settings: Pick<
    SettingsStore,
    'getPetPlacementState' | 'savePetPlacement' | 'commitPetPlacementMigration'
  >;
  getGeometryBinding(): CharacterGeometryBinding | null;
  displays(): readonly Readonly<{ id: string; workAreaDip: Rectangle }>[];
  primaryDisplayId(): string;
  publishRenderView(view: PetGeometryRenderView): void;
  expectProgrammaticPosition(
    point: Readonly<{ x: number; y: number }>
  ): void | (() => void);
  isLayoutBlocked?(): boolean;
  isUserMoving?(): boolean;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
};

type CanonicalViewport = Readonly<{
  baseWidth: number;
  baseHeight: number;
  insetLeft: number;
  insetTop: number;
  insetRight: number;
  insetBottom: number;
}>;

type ViewportWaiter = {
  kind: 'scale-ack' | 'rollback-ack';
  expected: PetViewportCommitInput['viewportInWindowDip'];
  previous: PetViewportCommitInput['viewportInWindowDip'] | null;
  resolve(viewport: PetViewportCommitInput['viewportInWindowDip']): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

export type PetGeometryRelativeInspection = Readonly<{
  revision: number;
  scaleTick: number;
  settled: boolean;
  viewportInWindowDip: Rectangle;
  footOffsetInViewportDip: Readonly<{ x: number; y: number }>;
}>;

/**
 * Main 单 FIFO 编排窗口、几何权威与位置持久化；Renderer 只提供实际 viewport ack。
 */
export class PetGeometryCoordinator {
  private queue = Promise.resolve();
  private drainPromise: Promise<void> | null = null;
  private cachedViewport: PetViewportCommitInput['viewportInWindowDip'] | null = null;
  private canonical: CanonicalViewport | null = null;
  private committedTick = 10;
  private requestedTick = 10;
  private waiter: ViewportWaiter | null = null;
  private initialized = false;
  private committedBindingGeneration: number | null = null;
  private frozen = false;
  private viewportDirty = false;
  private placementDirty = false;
  private bindingDirty = false;
  /** ready 恢复的脚底是持久事实；OS 量化期间只允许窗口事务暂时偏离，不能反向覆盖它。 */
  private readyRestoreTarget: StoredPetPlacement | null = null;
  /** actual 可在容差内成为持久 target，但后续 viewport 仍从本轮理想脚底反算，避免量化累积。 */
  private readyRestoreIdealFoot: Readonly<{ x: number; y: number }> | null = null;
  private moveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: CoordinatorOptions) {}

  commitViewport(input: PetViewportCommitInput): Promise<void> {
    const viewport = structuredClone(input.viewportInWindowDip);
    const waiter = this.waiter;
    if (waiter) {
      const matches = waiter.kind === 'rollback-ack'
        ? sameViewport(waiter.expected, viewport)
        : !waiter.previous || !sameViewport(waiter.previous, viewport);
      if (!matches) return Promise.resolve();
      this.waiter = null;
      this.clearTimer(waiter.timer);
      this.cachedViewport = viewport;
      waiter.resolve(viewport);
      return Promise.resolve();
    }
    const previous = this.cachedViewport;
    this.cachedViewport = viewport;
    if (!this.initialized) {
      if (this.frozen) return Promise.resolve();
      return this.enqueue(() => this.initializeFromViewport(viewport));
    }
    if (!previous || !sameViewportSize(previous, viewport)) {
      this.viewportDirty = !this.activeShapeMatches(viewport);
    }
    if (
      this.readyRestoreTarget
      && !this.readyRestoreSatisfied()
      && (!previous || !sameViewport(previous, viewport))
    ) this.viewportDirty = true;
    if (this.frozen || this.options.isLayoutBlocked?.()) return Promise.resolve();
    return this.resumePendingLayout();
  }

  stepScale(input: PetScaleStepInput): Promise<void> {
    this.requestedTick = clampTick(this.requestedTick + input.step);
    if (this.frozen || this.options.isLayoutBlocked?.()) return Promise.resolve();
    return this.resumePendingLayout();
  }

  /** 拖拽或自动运动释放后消费此前保留的最终 tick，不丢失用户滚轮意图。 */
  resumePendingLayout(): Promise<void> {
    if (
      this.frozen
      || this.options.isLayoutBlocked?.()
      || (
        !this.viewportDirty && !this.placementDirty && !this.bindingDirty
        && this.committedTick === this.requestedTick
      )
    ) return Promise.resolve();
    if (this.drainPromise) return this.drainPromise;
    const running = this.enqueue(() => this.drainPendingLayout(false));
    this.drainPromise = running.finally(() => {
      this.drainPromise = null;
    });
    return this.drainPromise;
  }

  initialize(): Promise<void> {
    if (this.initialized || !this.cachedViewport || this.frozen) return Promise.resolve();
    return this.enqueue(() => this.initializeFromViewport(this.cachedViewport!));
  }

  /** 正式行为绑定晚于 viewport 或发生切换时，复用缓存 viewport 与同一几何 FIFO。 */
  refreshBinding(): Promise<void> {
    if (this.frozen || !this.cachedViewport) return Promise.resolve();
    const available = this.options.getGeometryBinding();
    if (!available || available.generation === this.committedBindingGeneration) {
      this.bindingDirty = false;
      return Promise.resolve();
    }
    this.bindingDirty = true;
    if (this.options.isLayoutBlocked?.()) return Promise.resolve();
    return this.resumePendingLayout();
  }

  handleWindowMoved(): void {
    if (this.frozen || !this.initialized || this.waiter) return;
    const userMoving = this.options.isUserMoving?.() ?? true;
    if (this.readyRestoreTarget && !userMoving) return;
    const layoutBlocked = this.options.isLayoutBlocked?.() ?? false;
    // ready 恢复目标只允许真实用户拖拽接管；程序化窗口消息不能改写持久脚底。
    if (this.readyRestoreTarget) {
      this.readyRestoreTarget = null;
      this.readyRestoreIdealFoot = null;
    }
    this.placementDirty = true;
    if (layoutBlocked) return;
    if (this.moveTimer) this.clearTimer(this.moveTimer);
    const schedule = this.options.setTimeout ?? globalThis.setTimeout;
    this.moveTimer = schedule(() => {
      this.moveTimer = null;
      void this.enqueue(() => this.drainPendingLayout(false)).catch(() => undefined);
    }, 250);
  }

  /** 普通 move 与退出 flush 后续复用同一 FIFO；G4 不在运动 tick 内改写目标。 */
  async freezeAndFlush(): Promise<void> {
    this.frozen = true;
    if (this.moveTimer) {
      this.clearTimer(this.moveTimer);
      this.moveTimer = null;
    }
    await this.enqueue(() => this.drainPendingLayout(true));
    await this.queue;
  }

  /** viewport/placement 收敛优先于缩放，确保 wheel 以最终拖拽脚底为起点。 */
  private async drainPendingLayout(ignoreBlocked: boolean): Promise<void> {
    while (ignoreBlocked || !this.options.isLayoutBlocked?.()) {
      if (this.bindingDirty) {
        await this.applyPendingBinding();
        continue;
      }
      if (this.viewportDirty || this.placementDirty) {
        await this.settleViewportAndPlacement();
        continue;
      }
      if (this.committedTick !== this.requestedTick) {
        await this.applyScale(this.requestedTick);
        continue;
      }
      return;
    }
  }

  private activeShapeMatches(
    viewport: PetViewportCommitInput['viewportInWindowDip']
  ): boolean {
    const snapshot = this.options.authority.getSnapshot();
    const layout = snapshot ? this.options.authority.getShapeLayout(snapshot.revision) : null;
    return Boolean(layout
      && layout.viewportSizeDip.width === viewport.width
      && layout.viewportSizeDip.height === viewport.height);
  }

  private readyRestoreSatisfied(): boolean {
    const target = this.readyRestoreTarget;
    if (!target) return true;
    const snapshot = this.options.authority.getSnapshot();
    return Boolean(snapshot
      && snapshot.characterId === target.characterId
      && snapshot.scale === target.scale
      && snapshot.displayId === target.displayId
      && samePoint(snapshot.footAnchorDip, target.footAnchorDip));
  }

  /**
   * 非缩放 settle 只改 shape key；有 placementDirty 时采纳当前窗口，
   * 否则保留已提交脚底并仅校正原点。
   */
  private async settleViewportAndPlacement(): Promise<void> {
    const viewport = this.cachedViewport;
    const oldSnapshot = this.options.authority.getSnapshot();
    if (!viewport || !oldSnapshot) {
      this.viewportDirty = false;
      this.placementDirty = false;
      return;
    }
    const restoreTarget = this.readyRestoreTarget;
    const restoreIdealFoot = this.readyRestoreIdealFoot;
    const adoptCurrentWindow = this.placementDirty && !restoreTarget;
    this.viewportDirty = false;
    this.placementDirty = false;
    if (this.activeShapeMatches(viewport) && !restoreTarget) {
      if (adoptCurrentWindow) await this.persistCurrentWindowPlacement();
      return;
    }

    const binding = this.requireBinding();
    const oldBounds = this.options.window.getBounds();
    const oldCanonical = this.canonical;
    const shape = this.updateShape(binding, this.committedTick, viewport);
    const layout = this.requireShapeLayout(shape.revision);
    const footOffset = footOffsetInWindow(viewport, layout.footOffsetInViewportDip);
    const preservedFoot = restoreIdealFoot
      ?? restoreTarget?.footAnchorDip
      ?? oldSnapshot.footAnchorDip;
    const candidateBounds = adoptCurrentWindow
      ? oldBounds
      : {
          x: preservedFoot.x - footOffset.x,
          y: preservedFoot.y - footOffset.y,
          width: oldBounds.width,
          height: oldBounds.height
        };
    const candidateFoot = adoptCurrentWindow
      ? { x: candidateBounds.x + footOffset.x, y: candidateBounds.y + footOffset.y }
      : preservedFoot;
    const display = this.requireDisplayForPlacement(
      candidateBounds,
      candidateFoot,
      oldSnapshot.displayId
    );
    const prepared = this.options.authority.preparePlacement({
      baseRevision: shape.revision,
      viewportInWindowDip: viewport,
      windowBoundsDip: candidateBounds,
      display
    });
    if (!prepared.ok) {
      this.options.authority.discardPendingShape();
      throw new Error(prepared.code);
    }
    let transaction: Readonly<{ token: string; baseRevision: number }> | null = {
      token: prepared.token,
      baseRevision: shape.revision
    };
    const boundsChanged = !sameBounds(oldBounds, candidateBounds);
    try {
      if (boundsChanged) {
        this.setCoordinatorBounds(candidateBounds);
        const actualBounds = this.options.window.getBounds();
        if (!sameBounds(actualBounds, candidateBounds)) {
          this.options.authority.rollbackPreparedPlacement(transaction);
          transaction = null;
          // 普通布局采纳 OS actual；ready 恢复则保留持久脚底，等待真实 viewport 后再校正原点。
          if (!restoreTarget) this.placementDirty = true;
          const actualShape = this.updateShape(binding, this.committedTick, viewport);
          const actualDisplay = this.requireDisplayForPlacement(actualBounds, {
            x: actualBounds.x + footOffset.x,
            y: actualBounds.y + footOffset.y
          }, display.id);
          const actualPrepared = this.options.authority.preparePlacement({
            baseRevision: actualShape.revision,
            viewportInWindowDip: viewport,
            windowBoundsDip: actualBounds,
            display: actualDisplay
          });
          if (!actualPrepared.ok) {
            this.options.authority.discardPendingShape();
            throw new Error(actualPrepared.code);
          }
          transaction = { token: actualPrepared.token, baseRevision: actualShape.revision };
        }
      }
      const committed = this.commitPrepared(transaction, binding.generation);
      const restoredExactly = Boolean(restoreTarget
        && samePoint(committed.footAnchorDip, restoreTarget.footAnchorDip));
      const acceptsActualQuantization = Boolean(
        restoreTarget
        && footWithinQuantizationTolerance(
          committed.footAnchorDip,
          restoreTarget.footAnchorDip
        )
      );
      if (acceptsActualQuantization) {
        this.readyRestoreTarget = placementFromSnapshot(committed);
      }
      if (restoreTarget && !restoredExactly && !acceptsActualQuantization) {
        await this.options.settings.savePetPlacement(restoreTarget);
      } else {
        await this.saveSnapshot(committed);
      }
      this.options.authority.discardPreparedPlacement(transaction);
      transaction = null;
      this.canonical = canonicalViewport(viewport, this.committedTick, committed.windowBoundsDip);
      this.committedBindingGeneration = binding.generation;
      this.publish(committed);
    } catch (error) {
      this.readyRestoreTarget = restoreTarget;
      this.readyRestoreIdealFoot = restoreIdealFoot;
      if (transaction) this.options.authority.rollbackPreparedPlacement(transaction);
      else this.options.authority.discardPendingShape();
      this.canonical = oldCanonical;
      if (boundsChanged && !this.options.window.isDestroyed()) {
        this.setCoordinatorBounds(oldBounds);
      }
      throw error;
    } finally {
      if (this.cachedViewport && !this.activeShapeMatches(this.cachedViewport)) {
        this.viewportDirty = true;
      }
    }
  }

  private async persistCurrentWindowPlacement(): Promise<void> {
    const snapshot = this.options.authority.getSnapshot();
    const viewport = this.cachedViewport;
    if (!snapshot || !viewport) return;
    const bounds = this.options.window.getBounds();
    const layout = this.options.authority.getShapeLayout(snapshot.revision);
    if (!layout) throw new Error('PET_GEOMETRY_SHAPE_MISSING');
    const footOffset = footOffsetInWindow(viewport, layout.footOffsetInViewportDip);
    const display = this.requireDisplayForPlacement(bounds, {
      x: bounds.x + footOffset.x,
      y: bounds.y + footOffset.y
    }, snapshot.displayId);
    const prepared = this.options.authority.preparePlacement({
      baseRevision: snapshot.revision,
      viewportInWindowDip: viewport,
      windowBoundsDip: bounds,
      display
    });
    if (!prepared.ok) throw new Error(prepared.code);
    const transaction = { token: prepared.token, baseRevision: snapshot.revision };
    try {
      const committed = this.commitPrepared(transaction, this.requireBinding().generation);
      await this.saveSnapshot(committed);
      this.options.authority.discardPreparedPlacement(transaction);
    } catch (error) {
      this.options.authority.rollbackPreparedPlacement(transaction);
      // 用户移动已经发生；失败只回滚内部事实，实际窗口保持原位并等待同 FIFO 重试。
      this.placementDirty = true;
      throw error;
    }
  }

  isLayoutInFlight(): boolean {
    return this.waiter !== null;
  }

  /**
   * 只返回窗口局部几何，供 Main 的 E2E 私有边界证明收敛关系；禁止包含屏幕坐标。
   */
  inspectRelativeGeometry(): PetGeometryRelativeInspection | null {
    const snapshot = this.options.authority.getSnapshot();
    const viewport = this.cachedViewport;
    const layout = snapshot ? this.options.authority.getShapeLayout(snapshot.revision) : null;
    if (!snapshot || !viewport || !layout) return null;
    return Object.freeze({
      revision: snapshot.revision,
      scaleTick: this.committedTick,
      settled: this.initialized
        && this.waiter === null
        && !this.viewportDirty
        && !this.placementDirty
        && !this.bindingDirty
        && this.readyRestoreSatisfied()
        && this.committedTick === this.requestedTick
        && this.activeShapeMatches(viewport),
      viewportInWindowDip: Object.freeze({ ...viewport }),
      footOffsetInViewportDip: Object.freeze({ ...layout.footOffsetInViewportDip })
    });
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const running = this.queue.then(operation);
    this.queue = running.catch(() => undefined);
    return running;
  }

  private async initializeFromViewport(
    viewport: PetViewportCommitInput['viewportInWindowDip']
  ): Promise<void> {
    if (this.initialized || this.frozen) return;
    const binding = this.requireBinding();
    const state = await this.options.settings.getPetPlacementState(binding.manifest.id);
    const scale = state.kind === 'ready' && state.placement?.characterId === binding.manifest.id
      ? state.placement.scale
      : 1;
    const tick = clampTick(Math.round(scale * 10));
    const oldCanonical = this.canonical;
    this.canonical = canonicalViewport(viewport, tick, this.options.window.getBounds());
    try {
    await this.applyLayout(tick, viewport, state);
      const snapshot = this.options.authority.getSnapshot();
      if (snapshot) this.canonical = canonicalViewport(viewport, tick, snapshot.windowBoundsDip);
      this.committedTick = tick;
      this.requestedTick = tick;
    this.initialized = true;
      const latestViewport = this.cachedViewport;
      if (latestViewport && (
        !this.activeShapeMatches(latestViewport)
        || !this.readyRestoreSatisfied()
      )) {
        this.viewportDirty = true;
        await this.drainPendingLayout(false);
      }
    } catch (error) {
      this.canonical = oldCanonical;
      throw error;
    }
  }

  private async applyScale(tick: number): Promise<void> {
    if (!this.initialized || !this.canonical) {
      if (!this.cachedViewport) return;
      await this.initializeFromViewport(this.cachedViewport);
      if (!this.initialized) return;
    }
    const binding = this.requireBinding();
    const expectedViewport = viewportForTick(this.canonical!, tick);
    const oldBounds = this.options.window.getBounds();
    const oldViewport = this.cachedViewport;
    const oldCanonical = this.canonical;
    const oldSnapshot = this.options.authority.getSnapshot();
    const oldReadyRestoreTarget = this.readyRestoreTarget;
    const oldReadyRestoreIdealFoot = this.readyRestoreIdealFoot;
    if (!oldSnapshot || !oldViewport) return;
    const scaleDesiredFoot = oldReadyRestoreTarget
      ? oldReadyRestoreIdealFoot ?? oldReadyRestoreTarget.footAnchorDip
      : oldSnapshot.footAnchorDip;
    let transaction: Readonly<{ token: string; baseRevision: number }> | null = null;
    let targetBounds = oldBounds;
    try {
      const expectedShape = this.updateShape(binding, tick, expectedViewport);
      const expectedLayout = this.requireShapeLayout(expectedShape.revision);
      targetBounds = boundsForFoot(
        scaleDesiredFoot,
        expectedViewport,
        expectedLayout.footOffsetInViewportDip,
        {
          width: expectedViewport.width + this.canonical!.insetLeft + this.canonical!.insetRight,
          height: expectedViewport.height + this.canonical!.insetTop + this.canonical!.insetBottom
        }
      );
      let display = this.requireDisplayForPlacement(
        targetBounds,
        scaleDesiredFoot,
        oldSnapshot.displayId
      );
      const expectedPrepared = this.options.authority.preparePlacement({
        baseRevision: expectedShape.revision,
        viewportInWindowDip: expectedViewport,
        windowBoundsDip: targetBounds,
        display
      });
      if (!expectedPrepared.ok) {
        this.options.authority.discardPendingShape();
        throw new Error(expectedPrepared.code);
      }
      transaction = { token: expectedPrepared.token, baseRevision: expectedShape.revision };
      const actualViewport = sameBounds(oldBounds, targetBounds)
        ? expectedViewport
        : await this.setBoundsAndWait(
            targetBounds,
            'scale-ack',
            expectedViewport,
            oldViewport
          );

      if (!sameViewport(actualViewport, expectedViewport)) {
        this.options.authority.rollbackPreparedPlacement(transaction);
        transaction = null;
        const actualShape = this.updateShape(binding, tick, actualViewport);
        const actualLayout = this.requireShapeLayout(actualShape.revision);
        const correctedBounds = boundsForFoot(
          scaleDesiredFoot,
          actualViewport,
          actualLayout.footOffsetInViewportDip,
          { width: targetBounds.width, height: targetBounds.height }
        );
        const actualPrepared = this.options.authority.preparePlacement({
          baseRevision: actualShape.revision,
          viewportInWindowDip: actualViewport,
          windowBoundsDip: correctedBounds,
          display
        });
        if (!actualPrepared.ok) {
          this.options.authority.discardPendingShape();
          throw new Error(actualPrepared.code);
        }
        transaction = { token: actualPrepared.token, baseRevision: actualShape.revision };
        if (!sameBounds(targetBounds, correctedBounds)) {
          this.setCoordinatorBounds(correctedBounds);
          targetBounds = correctedBounds;
        }
      }

      const finalBounds = this.options.window.getBounds();
      if (!sameBounds(finalBounds, targetBounds)) {
        this.options.authority.rollbackPreparedPlacement(transaction);
        transaction = null;
        const finalViewport = this.cachedViewport!;
        const finalShape = this.updateShape(binding, tick, finalViewport);
        const finalLayout = this.requireShapeLayout(finalShape.revision);
        const finalFootOffset = footOffsetInWindow(
          finalViewport,
          finalLayout.footOffsetInViewportDip
        );
        display = this.requireDisplayForPlacement(
          finalBounds,
          {
            x: finalBounds.x + finalFootOffset.x,
            y: finalBounds.y + finalFootOffset.y
          },
          oldSnapshot.displayId
        );
        const finalPrepared = this.options.authority.preparePlacement({
          baseRevision: finalShape.revision,
          viewportInWindowDip: finalViewport,
          windowBoundsDip: finalBounds,
          display
        });
        if (!finalPrepared.ok) {
          this.options.authority.discardPendingShape();
          throw new Error(finalPrepared.code);
        }
        transaction = { token: finalPrepared.token, baseRevision: finalShape.revision };
        targetBounds = finalBounds;
      }

      const committed = this.commitPrepared(transaction, binding.generation);
      const nextReadyRestoreTarget = oldReadyRestoreTarget
        && oldReadyRestoreTarget.characterId === committed.characterId
        ? {
            ...oldReadyRestoreTarget,
            scale: committed.scale,
            displayId: committed.displayId
          }
        : null;
      if (
        nextReadyRestoreTarget
        && !samePoint(nextReadyRestoreTarget.footAnchorDip, committed.footAnchorDip)
      ) {
        await this.options.settings.savePetPlacement(nextReadyRestoreTarget);
      } else {
        await this.saveSnapshot(committed);
      }
      this.options.authority.discardPreparedPlacement(transaction);
      transaction = null;
      this.readyRestoreTarget = nextReadyRestoreTarget;
      this.readyRestoreIdealFoot = nextReadyRestoreTarget
        ? scaleDesiredFoot
        : null;
      if (nextReadyRestoreTarget && !this.readyRestoreSatisfied()) {
        this.viewportDirty = true;
      }
      this.committedBindingGeneration = binding.generation;
      this.committedTick = tick;
      this.publish(committed);
    } catch (error) {
      this.readyRestoreTarget = oldReadyRestoreTarget;
      this.readyRestoreIdealFoot = oldReadyRestoreIdealFoot;
      if (transaction) this.options.authority.rollbackPreparedPlacement(transaction);
      else this.options.authority.discardPendingShape();
      this.canonical = oldCanonical;
      this.cachedViewport = oldViewport;
      if (!this.options.window.isDestroyed()) {
        if (!sameBounds(this.options.window.getBounds(), oldBounds)) {
          await this.setBoundsAndWait(oldBounds, 'rollback-ack', oldViewport, null)
            .catch(() => undefined);
          this.cachedViewport = oldViewport;
        }
      }
      throw error;
    }
  }

  private async applyLayout(
    tick: number,
    viewport: PetViewportCommitInput['viewportInWindowDip'],
    state: PetPlacementStateSnapshot
  ): Promise<void> {
    const binding = this.requireBinding();
    const oldBounds = this.options.window.getBounds();
    const oldViewport = this.cachedViewport;
    const oldSnapshot = this.options.authority.getSnapshot();
    const oldReadyRestoreTarget = this.readyRestoreTarget;
    const oldReadyRestoreIdealFoot = this.readyRestoreIdealFoot;
    const hasReadyRestoreSource = state.kind === 'ready'
      && oldSnapshot?.characterId !== binding.manifest.id
      && state.placement?.characterId === binding.manifest.id;
    const shape = this.options.authority.updateShape({
      manifest: binding.manifest,
      skinId: binding.skinId,
      actionId: binding.actionId,
      actionRevision: binding.actionRevision,
      resourceRevision: binding.resourceRevision,
      direction: binding.direction,
      scale: tick / 10,
      viewportSizeDip: { width: viewport.width, height: viewport.height }
    }, binding.manifest.id);
    if (!shape.ok) throw new Error(shape.code);
    const layout = this.options.authority.getShapeLayout(shape.revision);
    if (!layout) throw new Error('PET_GEOMETRY_SHAPE_MISSING');
    const windowSize = this.canonical
      ? {
          width: viewport.width + this.canonical.insetLeft + this.canonical.insetRight,
          height: viewport.height + this.canonical.insetTop + this.canonical.insetBottom
        }
      : { width: oldBounds.width, height: oldBounds.height };
    const footOffset = {
      x: viewport.x + layout.footOffsetInViewportDip.x,
      y: viewport.y + layout.footOffsetInViewportDip.y
    };
    const displays = this.options.displays();
    let placement: StoredPetPlacement;
    let windowPosition: Readonly<{ x: number; y: number }>;
    if (state.kind === 'pending-legacy') {
      const migrated = migrateLegacyPetPosition({
        legacyPosition: state.windowPosition,
        characterId: binding.manifest.id,
        geometry: {
          geometryRevision: shape.revision,
          windowSizeDip: windowSize,
          footOffsetInWindowDip: footOffset,
          visualBoundsFromFootDip: layout.visualBoundsFromFootDip
        },
        displays,
        primaryDisplayId: this.options.primaryDisplayId()
      });
      if (!migrated.ok) throw new Error(migrated.code);
      placement = { ...migrated.placement, scale: tick / 10 };
      windowPosition = migrated.windowPosition;
    } else {
      const previous = oldSnapshot && oldSnapshot.characterId === binding.manifest.id
        ? {
            characterId: binding.manifest.id,
            scale: tick / 10,
            footAnchorDip: oldSnapshot.footAnchorDip,
            displayId: oldSnapshot.displayId
          }
        : state.placement?.characterId === binding.manifest.id
          ? { ...state.placement, scale: tick / 10 }
          : null;
      const restored = restorePetPlacement({
        savedPlacement: previous,
        characterId: binding.manifest.id,
        geometryForScale: () => ({
          geometryRevision: shape.revision,
          windowSizeDip: windowSize,
          footOffsetInWindowDip: footOffset,
          visualBoundsFromFootDip: layout.visualBoundsFromFootDip
        }),
        displays,
        primaryDisplayId: this.options.primaryDisplayId()
      });
      if (!restored.ok) throw new Error(restored.code);
      placement = restored.placement;
      windowPosition = restored.windowPosition;
    }
    const candidateBounds = {
      x: windowPosition.x,
      y: windowPosition.y,
      width: windowSize.width,
      height: windowSize.height
    };
    const display = displays.find(item => item.id === placement.displayId)
      ?? displays.find(item => item.id === this.options.primaryDisplayId());
    if (!display) throw new Error('PET_GEOMETRY_DISPLAY_INVALID');
    const prepared = this.options.authority.preparePlacement({
      baseRevision: shape.revision,
      viewportInWindowDip: viewport,
      windowBoundsDip: candidateBounds,
      display
    });
    if (!prepared.ok) {
      this.options.authority.discardPendingShape();
      throw new Error(prepared.code);
    }
    let transaction: Readonly<{ token: string; baseRevision: number }> | null = {
      token: prepared.token,
      baseRevision: shape.revision
    };
    let boundsChanged = false;
    this.readyRestoreTarget = hasReadyRestoreSource ? placement : null;
    this.readyRestoreIdealFoot = hasReadyRestoreSource ? placement.footAnchorDip : null;
    try {
      if (this.options.window.isDestroyed()) throw new Error('PET_GEOMETRY_WINDOW_INVALID');
      boundsChanged = !sameBounds(oldBounds, candidateBounds);
      if (boundsChanged) {
        this.setCoordinatorBounds(candidateBounds);
        const actualBounds = this.options.window.getBounds();
        if (!sameBounds(actualBounds, candidateBounds)) {
          this.options.authority.rollbackPreparedPlacement(transaction);
          transaction = null;
          const actualShape = this.updateShape(binding, tick, viewport);
          const actualDisplay = this.requireDisplayForPlacement(actualBounds, {
            x: actualBounds.x + footOffset.x,
            y: actualBounds.y + footOffset.y
          }, display.id);
          const actualPrepared = this.options.authority.preparePlacement({
            baseRevision: actualShape.revision,
            viewportInWindowDip: viewport,
            windowBoundsDip: actualBounds,
            display: actualDisplay
          });
          if (!actualPrepared.ok) {
            this.options.authority.discardPendingShape();
            throw new Error(actualPrepared.code);
          }
          transaction = { token: actualPrepared.token, baseRevision: actualShape.revision };
          if (!hasReadyRestoreSource) {
            placement = placementFromSnapshot(actualPrepared.snapshot);
          }
        }
      }
      const committed = this.commitPrepared(transaction, binding.generation);
      const committedPlacement = placementFromSnapshot(committed);
      placement = this.readyRestoreTarget ?? committedPlacement;
      if (state.kind === 'pending-legacy') {
        await this.options.settings.commitPetPlacementMigration({
          expectedWindowPosition: state.windowPosition,
          placement
        });
      } else {
        await this.options.settings.savePetPlacement(placement);
      }
      this.options.authority.discardPreparedPlacement(transaction);
      transaction = null;
      this.committedBindingGeneration = binding.generation;
      this.publish(committed);
      if (this.readyRestoreTarget && !this.readyRestoreSatisfied()) {
        this.viewportDirty = true;
      }
    } catch (error) {
      this.readyRestoreTarget = oldReadyRestoreTarget;
      this.readyRestoreIdealFoot = oldReadyRestoreIdealFoot;
      if (transaction) this.options.authority.rollbackPreparedPlacement(transaction);
      else this.options.authority.discardPendingShape();
      if (boundsChanged && !this.options.window.isDestroyed()) {
        this.setCoordinatorBounds(oldBounds);
        if (oldViewport) this.cachedViewport = oldViewport;
      }
      throw error;
    }
  }

  private publish(snapshot: NonNullable<ReturnType<PetVisualGeometryAuthority['getSnapshot']>>): void {
    const view = petGeometryRenderViewSchema.parse({
      revision: snapshot.revision,
      scale: snapshot.scale,
      visualBoundsInWindowDip: snapshot.visualBoundsInWindowDip
    });
    try { this.options.publishRenderView(view); } catch { /* 广播失败不回滚已持久化事实。 */ }
  }

  private requireBinding(): CharacterGeometryBinding {
    const binding = this.options.getGeometryBinding();
    if (!binding) throw new Error('PET_GEOMETRY_BINDING_UNAVAILABLE');
    return binding;
  }

  private updateShape(
    binding: CharacterGeometryBinding,
    tick: number,
    viewport: PetViewportCommitInput['viewportInWindowDip']
  ) {
    const shape = this.options.authority.updateShape({
      manifest: binding.manifest,
      skinId: binding.skinId,
      actionId: binding.actionId,
      actionRevision: binding.actionRevision,
      resourceRevision: binding.resourceRevision,
      direction: binding.direction,
      scale: tick / 10,
      viewportSizeDip: { width: viewport.width, height: viewport.height }
    }, binding.manifest.id);
    if (!shape.ok) throw new Error(shape.code);
    return shape;
  }

  private requireShapeLayout(revision: number) {
    const layout = this.options.authority.getShapeLayout(revision);
    if (!layout) throw new Error('PET_GEOMETRY_SHAPE_MISSING');
    return layout;
  }

  /** 用户跨屏后按实际窗口与视觉脚底裁决 display；旧 id 只用于同分稳定选择。 */
  private requireDisplayForPlacement(
    bounds: Rectangle,
    footAnchorDip: Readonly<{ x: number; y: number }>,
    preferredId: string
  ) {
    const displays = this.options.displays();
    const containingFoot = displays.filter(display => pointInside(
      footAnchorDip,
      display.workAreaDip
    ));
    const candidates = containingFoot.length > 0 ? containingFoot : displays;
    let selected = candidates.find(display => display.id === preferredId) ?? candidates[0];
    let selectedArea = selected ? rectangleIntersectionArea(bounds, selected.workAreaDip) : 0;
    for (const display of candidates) {
      const area = rectangleIntersectionArea(bounds, display.workAreaDip);
      if (area > selectedArea) {
        selected = display;
        selectedArea = area;
      }
    }
    if (!selected || selectedArea <= 0) throw new Error('PET_GEOMETRY_DISPLAY_INVALID');
    return selected;
  }

  private async applyPendingBinding(): Promise<void> {
    const binding = this.options.getGeometryBinding();
    if (!binding || binding.generation === this.committedBindingGeneration) {
      this.bindingDirty = false;
      return;
    }
    this.bindingDirty = false;
    try {
      if (!this.initialized) {
        await this.initializeFromViewport(this.cachedViewport!);
      } else {
        const viewport = viewportForTick(this.canonical!, this.committedTick);
        const state = await this.options.settings.getPetPlacementState(binding.manifest.id);
        await this.applyLayout(this.committedTick, viewport, state);
      }
    } catch (error) {
      this.bindingDirty = true;
      throw error;
    }
    const latest = this.options.getGeometryBinding();
    this.bindingDirty = Boolean(
      latest && latest.generation !== this.committedBindingGeneration
    );
  }

  private commitPrepared(
    transaction: Readonly<{ token: string; baseRevision: number }>,
    bindingGeneration: number
  ) {
    if (this.requireBinding().generation !== bindingGeneration) {
      throw new Error('PET_GEOMETRY_BINDING_STALE');
    }
    const committed = this.options.authority.commitPreparedPlacement(transaction);
    if (!committed.ok || !committed.snapshot) {
      throw new Error(committed.ok ? 'PET_GEOMETRY_COMMIT_INVALID' : committed.code);
    }
    return committed.snapshot;
  }

  private async saveSnapshot(
    snapshot: NonNullable<ReturnType<PetVisualGeometryAuthority['getSnapshot']>>
  ): Promise<void> {
    await this.options.settings.savePetPlacement({
      characterId: snapshot.characterId,
      scale: snapshot.scale,
      footAnchorDip: snapshot.footAnchorDip,
      displayId: snapshot.displayId
    });
  }

  private setBoundsAndWait(
    bounds: Rectangle,
    kind: ViewportWaiter['kind'],
    expected: PetViewportCommitInput['viewportInWindowDip'],
    previous: PetViewportCommitInput['viewportInWindowDip'] | null
  ): Promise<PetViewportCommitInput['viewportInWindowDip']> {
    const acknowledged = this.waitForViewport(kind, expected, previous);
    try {
      this.setCoordinatorBounds(bounds);
    } catch (error) {
      const waiter = this.waiter;
      if (waiter) {
        this.waiter = null;
        this.clearTimer(waiter.timer);
      }
      throw error;
    }
    return acknowledged;
  }

  private setCoordinatorBounds(bounds: Rectangle): void {
    const cancelExpectation = this.options.expectProgrammaticPosition({
      x: bounds.x,
      y: bounds.y
    });
    try {
      this.options.window.setBounds(bounds);
    } catch (error) {
      cancelExpectation?.();
      throw error;
    }
  }

  private waitForViewport(
    kind: ViewportWaiter['kind'],
    expected: PetViewportCommitInput['viewportInWindowDip'],
    previous: PetViewportCommitInput['viewportInWindowDip'] | null
  ): Promise<PetViewportCommitInput['viewportInWindowDip']> {
    return new Promise((resolve, reject) => {
      const schedule = this.options.setTimeout ?? globalThis.setTimeout;
      const timer = schedule(() => {
        if (this.waiter?.timer === timer) this.waiter = null;
        reject(new Error('PET_GEOMETRY_VIEWPORT_ACK_TIMEOUT'));
      }, VIEWPORT_ACK_TIMEOUT_MS);
      this.waiter = { kind, expected, previous, resolve, reject, timer };
    });
  }

  private clearTimer(timer: ReturnType<typeof setTimeout>): void {
    (this.options.clearTimeout ?? globalThis.clearTimeout)(timer);
  }
}

function clampTick(tick: number): number {
  return Math.min(MAX_SCALE_TICK, Math.max(MIN_SCALE_TICK, tick));
}

function canonicalViewport(
  viewport: PetViewportCommitInput['viewportInWindowDip'],
  tick: number,
  bounds: Rectangle
): CanonicalViewport {
  const scale = tick / 10;
  return {
    baseWidth: viewport.width / scale,
    baseHeight: viewport.height / scale,
    insetLeft: viewport.x,
    insetTop: viewport.y,
    insetRight: bounds.width - viewport.x - viewport.width,
    insetBottom: bounds.height - viewport.y - viewport.height
  };
}

function viewportForTick(canonical: CanonicalViewport, tick: number) {
  return {
    x: canonical.insetLeft,
    y: canonical.insetTop,
    width: Math.round(canonical.baseWidth * tick / 10),
    height: Math.round(canonical.baseHeight * tick / 10)
  };
}

function sameViewport(left: Rectangle, right: Rectangle): boolean {
  return left.x === right.x && left.y === right.y
    && left.width === right.width && left.height === right.height;
}

function sameViewportSize(left: Rectangle, right: Rectangle): boolean {
  return left.width === right.width && left.height === right.height;
}

function samePoint(
  left: Readonly<{ x: number; y: number }>,
  right: Readonly<{ x: number; y: number }>
): boolean {
  return left.x === right.x && left.y === right.y;
}

/** Windows DIP 原点量化允许每轴最多 0.5 DIP；超限仍保留 desired 等待后续真实 viewport。 */
function footWithinQuantizationTolerance(
  actual: Readonly<{ x: number; y: number }>,
  desired: Readonly<{ x: number; y: number }>
): boolean {
  return Math.abs(actual.x - desired.x) <= 0.5
    && Math.abs(actual.y - desired.y) <= 0.5;
}

function footOffsetInWindow(
  viewport: Rectangle,
  footOffsetInViewport: Readonly<{ x: number; y: number }>
) {
  return {
    x: viewport.x + footOffsetInViewport.x,
    y: viewport.y + footOffsetInViewport.y
  };
}

function boundsForFoot(
  footAnchorDip: Readonly<{ x: number; y: number }>,
  viewport: Rectangle,
  footOffsetInViewport: Readonly<{ x: number; y: number }>,
  size: Readonly<{ width: number; height: number }>
): Rectangle {
  const offset = footOffsetInWindow(viewport, footOffsetInViewport);
  return {
    x: footAnchorDip.x - offset.x,
    y: footAnchorDip.y - offset.y,
    width: size.width,
    height: size.height
  };
}

function placementFromSnapshot(
  snapshot: NonNullable<ReturnType<PetVisualGeometryAuthority['getSnapshot']>>
): StoredPetPlacement {
  return {
    characterId: snapshot.characterId,
    scale: snapshot.scale,
    footAnchorDip: snapshot.footAnchorDip,
    displayId: snapshot.displayId
  };
}

function sameBounds(left: Rectangle, right: Rectangle): boolean {
  return sameViewport(left, right);
}

function pointInside(
  point: Readonly<{ x: number; y: number }>,
  rectangle: Rectangle
): boolean {
  return point.x >= rectangle.x && point.x < rectangle.x + rectangle.width
    && point.y >= rectangle.y && point.y < rectangle.y + rectangle.height;
}

function rectangleIntersectionArea(left: Rectangle, right: Rectangle): number {
  const width = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x)
  );
  const height = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y)
  );
  const area = width * height;
  return Number.isFinite(area) ? area : 0;
}
