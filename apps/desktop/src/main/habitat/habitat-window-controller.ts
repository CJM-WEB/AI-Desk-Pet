import type { Rectangle } from 'electron';

import type { CharacterMotionService } from '../characters/character-motion-service';
import {
  clampPositionToWorkArea,
  type Point
} from '../windows/window-manager';
import type { PetPositionController } from '../windows/pet-position';
import {
  calculateHabitatMovementRegions
} from './habitat-motion-region';
import type { ExplorerWindowLayerController } from './explorer-window-layer-controller';

export const INTERACTION_RAISE_MAX_DURATION_MS = 10_000;
export const HABITAT_OBSERVATION_MAX_AGE_MS = 1_000;

const MAX_NATIVE_HWND = '18446744073709551615';
const HWND_PATTERN = /^[1-9][0-9]{0,19}$/u;

export type HabitatWindowMode =
  | 'desktop-idle'
  | 'interaction-raised'
  | 'folder-hidden'
  | 'folder-visible'
  | 'lost';

export type HabitatExplorerUnsafeReason =
  | 'explorer-blurred'
  | 'explorer-minimized'
  | 'explorer-closed'
  | 'tab-race'
  | 'hwnd-invalid'
  | 'leave';

export interface HabitatExplorerObservation {
  instanceId: string;
  sequence: number;
  explorerHwnd: string;
  explorerBounds: Rectangle;
  observedAt: number;
  foreground: boolean;
  minimized: boolean;
  localOffset: Point;
}

interface HabitatWindow {
  getBounds(): Rectangle;
  setPosition(x: number, y: number): void;
  setAlwaysOnTop(value: boolean, level?: 'floating'): void;
  isAlwaysOnTop(): boolean;
  isDestroyed(): boolean;
  hide(): void;
  showInactive(): void;
  once(name: 'closed', listener: () => void): void;
  removeListener(name: 'closed', listener: () => void): void;
}

interface HabitatInteractionController {
  setPassthrough(ignore: boolean): void;
}

interface HabitatWindowControllerOptions {
  window: HabitatWindow;
  layer: Pick<ExplorerWindowLayerController, 'activate' | 'dispose'>;
  motion: Pick<CharacterMotionService, 'setSuspended' | 'setMovementRegions'>;
  interaction: HabitatInteractionController;
  position: Pick<PetPositionController, 'setPersistenceMode'>;
  getWorkAreas(): readonly Rectangle[];
  isCurrentExplorerWindow(
    explorerHwnd: string,
    instanceId: string
  ): boolean | Promise<boolean>;
  now?: () => number;
}

function isFiniteRectangle(rectangle: Rectangle): boolean {
  return Number.isFinite(rectangle.x)
    && Number.isFinite(rectangle.y)
    && Number.isFinite(rectangle.width)
    && Number.isFinite(rectangle.height)
    && rectangle.width > 0
    && rectangle.height > 0;
}

function isCanonicalHwnd(hwnd: string): boolean {
  return HWND_PATTERN.test(hwnd)
    && (hwnd.length < MAX_NATIVE_HWND.length || hwnd <= MAX_NATIVE_HWND);
}

function incompleteCleanupError(errors: readonly unknown[]): AggregateError {
  return new AggregateError(errors, 'HABITAT_FAIL_CLOSED_INCOMPLETE');
}

/**
 * 统一编排桌宠窗口模式；原生 Explorer 识别仍由受信观察端完成，本类只消费验证结果。
 */
export class HabitatWindowController {
  private readonly now: () => number;
  private mode: HabitatWindowMode = 'desktop-idle';
  private disposed = false;
  private interactionGeneration = 0;
  private observationGeneration = 0;
  private folderTransitionGeneration = 0;
  private interactionTimer: ReturnType<typeof setTimeout> | undefined;
  private observationTimer: ReturnType<typeof setTimeout> | undefined;
  private latestInstanceId: string | undefined;
  private latestSequence = 0;
  private activeExplorerHwnd: string | undefined;
  private disposePromise: Promise<void> | undefined;

  constructor(private readonly options: HabitatWindowControllerOptions) {
    this.now = options.now ?? Date.now;
    options.window.once('closed', this.handleWindowClosed);
  }

  getMode(): HabitatWindowMode {
    return this.mode;
  }

  /** 临时提升只在桌面模式生效，返回的结束函数与本次交互令牌绑定。 */
  beginInteraction(): () => void {
    this.requireActiveWindow();
    if (this.mode !== 'desktop-idle' && this.mode !== 'interaction-raised') {
      throw new Error('HABITAT_INTERACTION_MODE_UNSAFE');
    }
    try {
      this.options.window.setAlwaysOnTop(true, 'floating');
    } catch (error) {
      const hadRecoveryTimer = this.interactionTimer !== undefined;
      this.hideAfterTopmostFailure();
      if (!hadRecoveryTimer) {
        const recoveryGeneration = ++this.interactionGeneration;
        this.armInteractionTimeout(recoveryGeneration);
      }
      throw error;
    }
    this.cancelInteractionTimer();
    const generation = ++this.interactionGeneration;
    this.mode = 'interaction-raised';
    this.armInteractionTimeout(generation);
    return () => this.finishInteraction(generation);
  }

  /**
   * 目录可见切换保持“watchdog → 暂停 → 安全坐标 → 显示 → 相邻层级 → 恢复”顺序。
   */
  async showFolder(observation: HabitatExplorerObservation): Promise<void> {
    this.requireActiveWindow();
    const transitionGeneration = ++this.folderTransitionGeneration;
    // 新代次在首次异步身份校验前原子接管 watchdog，不留可见空窗。
    this.armObservationTimeout(observation.observedAt, transitionGeneration);
    const safeObservation = await this.isSafeObservation(observation);
    if (transitionGeneration !== this.folderTransitionGeneration) {
      throw new Error('HABITAT_TRANSITION_SUPERSEDED');
    }
    if (!safeObservation) {
      await this.failClosed('lost');
      throw new Error('HABITAT_EXPLORER_UNSAFE');
    }

    let failedClosedByThisTransition = false;
    try {
      this.cancelInteractionTimer();
      this.interactionGeneration += 1;
      this.options.window.setAlwaysOnTop(false);
      this.options.motion.setSuspended(true);
      this.options.interaction.setPassthrough(true);
      this.options.position.setPersistenceMode('disabled');

      const windowBounds = this.options.window.getBounds();
      const regions = calculateHabitatMovementRegions({
        explorerBounds: observation.explorerBounds,
        workAreas: this.options.getWorkAreas(),
        windowSize: windowBounds
      });
      if (regions.length === 0) throw new Error('HABITAT_REGION_UNAVAILABLE');

      this.options.motion.setMovementRegions(regions);
      const desired = {
        x: observation.explorerBounds.x + observation.localOffset.x,
        y: observation.explorerBounds.y + observation.localOffset.y
      };
      const region = regions.find(candidate => this.canPlaceAt(desired, windowBounds, candidate))
        ?? regions[0]!;
      const position = clampPositionToWorkArea(desired, windowBounds, region);
      this.options.window.setPosition(position.x, position.y);
      this.options.window.showInactive();
      await this.options.layer.activate({ explorerHwnd: observation.explorerHwnd });
      if (transitionGeneration !== this.folderTransitionGeneration) {
        throw new Error('HABITAT_TRANSITION_SUPERSEDED');
      }

      // moveAbove 后立即复核，避免异步边界内前台窗口已经变化。
      const stillCurrent = await this.isCurrentExplorer(observation);
      if (transitionGeneration !== this.folderTransitionGeneration) {
        throw new Error('HABITAT_TRANSITION_SUPERSEDED');
      }
      if (!stillCurrent || this.options.window.isDestroyed()) {
        failedClosedByThisTransition = true;
        await this.failClosed('lost');
        throw new Error('HABITAT_EXPLORER_UNSAFE');
      }
      this.options.position.setPersistenceMode('folder');
      this.options.motion.setSuspended(false);
      this.mode = 'folder-visible';
      this.latestInstanceId = observation.instanceId;
      this.latestSequence = observation.sequence;
      this.activeExplorerHwnd = observation.explorerHwnd;
      this.armObservationTimeout(observation.observedAt, transitionGeneration);
    } catch (error) {
      if (
        !failedClosedByThisTransition
        && transitionGeneration !== this.folderTransitionGeneration
      ) {
        throw new Error('HABITAT_TRANSITION_SUPERSEDED');
      }
      if (!failedClosedByThisTransition) {
        await this.failClosed('lost');
      }
      throw error;
    }
  }

  /** 用户离开目录模式时仍保留独立的 folder-hidden 状态。 */
  hideFolder(): Promise<void> {
    return this.failClosed('folder-hidden');
  }

  /** 失焦、最小化、关闭或观察不确定统一由 Habitat 自身失败关闭。 */
  loseExplorer(_reason: HabitatExplorerUnsafeReason): Promise<void> {
    return this.failClosed('lost');
  }

  /** 从目录模式返回普通桌面层级，不保留相邻层级或目录坐标持久化。 */
  async enterDesktopIdle(): Promise<void> {
    this.requireActiveWindow();
    await this.failClosed('folder-hidden');
    this.options.motion.setMovementRegions(null);
    this.options.position.setPersistenceMode('desktop');
    this.options.window.showInactive();
    this.options.motion.setSuspended(false);
    this.mode = 'desktop-idle';
  }

  /** 释放时取消所有延迟任务，并让 layer 完成自身幂等清理。 */
  dispose(): Promise<void> {
    if (this.disposePromise !== undefined) return this.disposePromise;
    this.disposed = true;
    this.folderTransitionGeneration += 1;
    this.cancelInteractionTimer();
    this.cancelObservationTimer();
    this.options.window.removeListener('closed', this.handleWindowClosed);
    this.disposePromise = this.disposeSafely();
    return this.disposePromise;
  }

  private readonly handleWindowClosed = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    this.folderTransitionGeneration += 1;
    this.cancelInteractionTimer();
    this.cancelObservationTimer();
    void this.options.layer.dispose().catch(() => {
      // closed 后已不能再触碰窗口，layer 释放失败不得产生未处理拒绝。
    });
  };

  private finishInteraction(generation: number): void {
    if (
      this.disposed
      || generation !== this.interactionGeneration
    ) return;
    this.cancelInteractionTimer();
    if (this.options.window.isDestroyed()) return;
    try {
      this.options.window.setAlwaysOnTop(false);
      this.mode = 'desktop-idle';
    } catch {
      this.hideAfterTopmostFailure();
    }
  }

  private async isSafeObservation(observation: HabitatExplorerObservation): Promise<boolean> {
    const age = this.now() - observation.observedAt;
    if (
      observation.instanceId.length === 0
      || !Number.isSafeInteger(observation.sequence)
      || observation.sequence <= 0
      || !isCanonicalHwnd(observation.explorerHwnd)
      || !isFiniteRectangle(observation.explorerBounds)
      || !Number.isFinite(observation.localOffset.x)
      || !Number.isFinite(observation.localOffset.y)
      || !Number.isFinite(age)
      || age < 0
      || age > HABITAT_OBSERVATION_MAX_AGE_MS
      || !observation.foreground
      || observation.minimized
      || (
        observation.instanceId === this.latestInstanceId
        && observation.sequence <= this.latestSequence
      )
      || (
        this.mode === 'folder-visible'
        && this.activeExplorerHwnd !== observation.explorerHwnd
      )
    ) return false;
    return this.isCurrentExplorer(observation);
  }

  private async isCurrentExplorer(observation: HabitatExplorerObservation): Promise<boolean> {
    try {
      return await this.options.isCurrentExplorerWindow(
        observation.explorerHwnd,
        observation.instanceId
      );
    } catch {
      return false;
    }
  }

  private canPlaceAt(point: Point, size: Rectangle, region: Rectangle): boolean {
    return point.x >= region.x
      && point.y >= region.y
      && point.x + size.width <= region.x + region.width
      && point.y + size.height <= region.y + region.height;
  }

  /** 所有不安全分支共用同一本地失败关闭路径。 */
  private async failClosed(
    mode: Extract<HabitatWindowMode, 'folder-hidden' | 'lost'>
  ): Promise<void> {
    this.folderTransitionGeneration += 1;
    this.cancelInteractionTimer();
    this.interactionGeneration += 1;
    this.cancelObservationTimer();
    this.observationGeneration += 1;
    const errors: unknown[] = [];
    this.collectLocalSafetyCleanup(errors);
    this.mode = mode;
    this.activeExplorerHwnd = undefined;
    if (errors.length > 0) throw incompleteCleanupError(errors);
  }

  private armObservationTimeout(observedAt: number, transitionGeneration: number): void {
    this.cancelObservationTimer();
    const remaining = Math.max(
      0,
      HABITAT_OBSERVATION_MAX_AGE_MS - Math.max(0, this.now() - observedAt)
    );
    const generation = ++this.observationGeneration;
    this.observationTimer = setTimeout(() => {
      if (
        this.disposed
        || generation !== this.observationGeneration
        || transitionGeneration !== this.folderTransitionGeneration
      ) return;
      this.observationTimer = undefined;
      void this.loseExplorer('tab-race').catch(() => {
        // watchdog 已执行全量失败关闭，聚合错误只能在异步边界封闭。
      });
    }, remaining);
  }

  /** 交互计时器只调用不抛出的回落路径。 */
  private armInteractionTimeout(generation: number): void {
    this.interactionTimer = setTimeout(
      () => this.finishInteraction(generation),
      INTERACTION_RAISE_MAX_DURATION_MS
    );
  }

  /** topmost 状态不确定时先隐藏，再次 best-effort 清除层级。 */
  private hideAfterTopmostFailure(): void {
    if (this.options.window.isDestroyed()) return;
    try {
      this.options.window.hide();
    } catch {
      // 隐藏与销毁竞态不得向 timer / finish 传播。
    }
    try {
      this.options.window.setAlwaysOnTop(false);
    } catch {
      // 窗口已隐藏，清除失败也不得重新显示。
    }
    this.mode = 'lost';
  }

  /** 本地清理单点失败不得短路，隐藏始终是第一个窗口副作用。 */
  private collectLocalSafetyCleanup(errors: unknown[]): void {
    let windowAvailable = true;
    try {
      windowAvailable = !this.options.window.isDestroyed();
    } catch (error) {
      errors.push(error);
    }
    if (windowAvailable) {
      this.captureCleanupError(errors, () => this.options.window.hide());
      this.captureCleanupError(errors, () => this.options.window.setAlwaysOnTop(false));
    }
    this.captureCleanupError(errors, () => this.options.motion.setSuspended(true));
    this.captureCleanupError(errors, () => this.options.interaction.setPassthrough(true));
    this.captureCleanupError(
      errors,
      () => this.options.position.setPersistenceMode('disabled')
    );
  }

  private captureCleanupError(errors: unknown[], operation: () => void): void {
    try {
      operation();
    } catch (error) {
      errors.push(error);
    }
  }

  private async disposeSafely(): Promise<void> {
    const errors: unknown[] = [];
    this.collectLocalSafetyCleanup(errors);
    this.mode = 'lost';
    this.activeExplorerHwnd = undefined;
    try {
      await this.options.layer.dispose();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) throw incompleteCleanupError(errors);
  }

  private cancelInteractionTimer(): void {
    if (this.interactionTimer !== undefined) clearTimeout(this.interactionTimer);
    this.interactionTimer = undefined;
  }

  private cancelObservationTimer(): void {
    if (this.observationTimer !== undefined) clearTimeout(this.observationTimer);
    this.observationTimer = undefined;
  }

  private requireActiveWindow(): void {
    if (this.disposed) throw new Error('HABITAT_WINDOW_CONTROLLER_DISPOSED');
    if (this.options.window.isDestroyed()) throw new Error('HABITAT_WINDOW_DESTROYED');
  }
}
export { createForegroundFullscreenProbe } from './foreground-fullscreen-probe';
