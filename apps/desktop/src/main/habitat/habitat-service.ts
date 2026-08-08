import type { TaskEvent } from '@myself/shared-types';

import {
  selectExplorerCandidate,
  type ExplorerCandidateBinding,
  type ExplorerCandidateWatermark
} from './explorer-candidate-selector';
import type { ExplorerSnapshot } from './explorer-space-protocol';
import type { ExplorerLayerUnsafeReason } from './explorer-window-layer-controller';
import { habitatError, type HabitatErrorCode } from './habitat-errors';
import type {
  HabitatDirectoryAvailability,
  HabitatDirectoryRecord,
  PetHabitatSnapshot
} from './pet-habitat-store';

export type HabitatStableState =
  | 'desktop'
  | 'folder-hidden'
  | 'folder-visible'
  | 'folder-lost';

export type HabitatServiceState =
  | HabitatStableState
  | 'entering'
  | 'revealing'
  | 'recalling';

export type HabitatOperation = 'enter' | 'recall' | 'summon';
export type HabitatEnterReason = 'manual' | 'automatic';

export interface HabitatBlockerSnapshot {
  fileTaskActive: boolean;
  characterSwitching: boolean;
  dragging: boolean;
  chatInteracting: boolean;
  appQuitting: boolean;
  foregroundFullscreen: boolean;
  proactivityMode: 'passive' | 'assistive' | 'autonomous';
}

export interface HabitatServiceSnapshot {
  state: HabitatServiceState;
  directoryId: string | null;
  operation: HabitatOperation | null;
  closed: boolean;
  errorCode?: string;
}

interface HabitatStorePort {
  load(): Promise<PetHabitatSnapshot>;
  save(snapshot: PetHabitatSnapshot): Promise<void>;
}

interface HabitatDirectoryPolicyPort {
  availability(directory: HabitatDirectoryRecord): Promise<HabitatDirectoryAvailability>;
}

interface FolderIdentityResolverPort {
  resolve(candidatePath: string): Promise<
    | { status: 'matched'; directoryId: string }
    | { status: 'hidden' }
  >;
}

interface ExplorerObserverPort {
  start(): Promise<void>;
  startObserving(): Promise<{ ok: true }>;
  stopObserving(): Promise<{ ok: true }>;
}

interface ExplorerLayerPort {
  activate(target: { explorerHwnd: string }): Promise<void>;
  invalidate(reason: ExplorerLayerUnsafeReason): Promise<void>;
}

interface HabitatPetWindowPort {
  getPosition(): { x: number; y: number };
  getLocalOffset(): { x: number; y: number };
  setPosition(x: number, y: number): void;
  hide(): void;
  show(): void;
  focus(): void;
}

export interface HabitatServiceOptions {
  initialSnapshot: PetHabitatSnapshot;
  store: HabitatStorePort;
  directoryPolicy: HabitatDirectoryPolicyPort;
  identityResolver: FolderIdentityResolverPort;
  explorer: ExplorerObserverPort;
  layer: ExplorerLayerPort;
  petWindow: HabitatPetWindowPort;
  openDirectory(path: string): Promise<void>;
  readBlockers(): HabitatBlockerSnapshot;
  now?: () => number;
}

export type HabitatExplorerObservation = ExplorerSnapshot | Error | null | undefined;

interface ActiveOperation {
  key: string;
  kind: HabitatOperation;
  promise: Promise<HabitatServiceSnapshot>;
}

const BLOCKED_AGENT_PHASES = new Set([
  'listening', 'thinking', 'awaiting_confirmation', 'acting'
]);

/**
 * Main 内目录空间的唯一权威协调器；外部能力全部经窄端口注入，类本身不新增系统能力。
 */
export class HabitatService {
  private readonly now: () => number;
  private stableSnapshot: PetHabitatSnapshot;
  private state: HabitatServiceState;
  private directoryId: string | null;
  private activeOperation: ActiveOperation | null = null;
  private agentPhase = 'idle';
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private errorCode: string | undefined;
  private observationToken = 0;
  private binding: ExplorerCandidateBinding | undefined;
  private watermark: ExplorerCandidateWatermark | undefined;

  constructor(private readonly options: HabitatServiceOptions) {
    this.now = options.now ?? Date.now;
    this.stableSnapshot = structuredClone(options.initialSnapshot);
    if (this.stableSnapshot.location.kind === 'folder') {
      this.state = 'folder-hidden';
      this.directoryId = this.stableSnapshot.location.directoryId;
    } else {
      this.state = 'desktop';
      this.directoryId = null;
    }
  }

  snapshot(): HabitatServiceSnapshot {
    return {
      state: this.state,
      directoryId: this.directoryId,
      operation: this.activeOperation?.kind ?? null,
      closed: this.closed,
      ...(this.errorCode === undefined ? {} : { errorCode: this.errorCode })
    };
  }

  enterDirectory(
    directoryId: string,
    reason: HabitatEnterReason
  ): Promise<HabitatServiceSnapshot> {
    if (this.closed) return Promise.reject(habitatError('HABITAT_CLOSED'));
    if (
      this.directoryId === directoryId
      && this.state !== 'desktop'
      && this.state !== 'entering'
      && this.state !== 'recalling'
    ) return Promise.resolve(this.snapshot());
    return this.beginOperation(`enter:${directoryId}:${reason}`, 'enter', () => (
      this.performEnter(directoryId, reason)
    ));
  }

  summon(): Promise<HabitatServiceSnapshot> {
    if (this.closed) return Promise.reject(habitatError('HABITAT_CLOSED'));
    return this.beginOperation('summon', 'summon', () => this.performSummon());
  }

  recallToDesktop(): Promise<HabitatServiceSnapshot> {
    if (this.closed) return Promise.reject(habitatError('HABITAT_CLOSED'));
    if (this.state === 'desktop') return Promise.resolve(this.snapshot());
    return this.beginOperation('recall', 'recall', () => this.performRecall());
  }

  async observeExplorer(observation: HabitatExplorerObservation): Promise<void> {
    if (this.closed || this.state === 'desktop' || this.state === 'entering' || this.state === 'recalling') {
      return;
    }
    const token = ++this.observationToken;
    if (!(observation && !(observation instanceof Error) && observation.type === 'explorer-snapshot')) {
      await this.conceal('explorer-closed', false, 'HABITAT_OBSERVER_FAILED');
      return;
    }
    if (observation.status === 'unavailable') {
      await this.conceal('explorer-closed', true, 'HABITAT_OBSERVER_FAILED');
      return;
    }
    if (observation.status === 'ambiguous') {
      await this.conceal('tab-race');
      return;
    }
    if (observation.status === 'none') {
      await this.conceal('explorer-blurred');
      return;
    }
    if (this.state === 'folder-lost') {
      await this.hideAndInvalidate('leave');
      return;
    }

    // 新的路径事实尚未完成身份复核时必须先隐藏，不能沿用旧标签页的可见性。
    await this.conceal('tab-race');
    let resolution: Awaited<ReturnType<FolderIdentityResolverPort['resolve']>>;
    try {
      resolution = await this.options.identityResolver.resolve(observation.path);
    } catch {
      await this.conceal('tab-race');
      return;
    }
    if (token !== this.observationToken || this.closed) return;
    if (
      resolution.status !== 'matched'
      || resolution.directoryId !== this.directoryId
    ) {
      await this.conceal('tab-race');
      return;
    }

    const observedAt = this.now();
    const selected = selectExplorerCandidate({
      activeInstanceId: observation.instanceId,
      frame: {
        instanceId: observation.instanceId,
        sequence: observation.sequence,
        foregroundHwnd: observation.hwnd,
        now: observedAt,
        destroyed: false,
        candidates: [{
          candidateId: `${observation.instanceId}:${observation.hwnd}`,
          hwnd: observation.hwnd,
          activationSequence: observation.sequence,
          observedAt,
          expiresAt: observedAt + 1_000,
          foreground: observation.foreground,
          minimized: observation.minimized,
          search: observation.search,
          ambiguous: false,
          match: resolution
        }]
      },
      ...(this.binding === undefined ? {} : { previous: this.binding }),
      ...(this.watermark === undefined ? {} : { watermark: this.watermark })
    });
    this.watermark = selected.watermark ?? undefined;
    if (selected.status !== 'selected') {
      await this.conceal('tab-race');
      return;
    }

    this.state = 'revealing';
    try {
      await this.options.layer.activate({ explorerHwnd: selected.binding.hwnd });
      if (token !== this.observationToken || this.closed) {
        await this.hideAndInvalidate('tab-race');
        this.restoreFolderStableState();
        return;
      }
      this.binding = selected.binding;
      this.state = 'folder-visible';
      this.errorCode = undefined;
      this.options.petWindow.show();
    } catch {
      await this.conceal('tab-race', false, 'HABITAT_WINDOW_FAILED');
    }
  }

  async handleDirectoryAvailability(): Promise<HabitatServiceSnapshot> {
    if (this.closed) throw habitatError('HABITAT_CLOSED');
    if (this.state === 'desktop' || this.directoryId === null) return this.snapshot();
    const loaded = await this.options.store.load();
    const directory = loaded.directories.find(candidate => (
      candidate.id === this.directoryId && candidate.enabled
    ));
    const available = directory === undefined
      ? false
      : await this.options.directoryPolicy.availability(directory) === 'available';
    if (!available) {
      await this.conceal('explorer-closed', true, 'HABITAT_DIRECTORY_UNAVAILABLE');
      return this.snapshot();
    }

    this.stableSnapshot = structuredClone(loaded);
    if (this.state === 'folder-lost') {
      this.state = 'folder-hidden';
      this.errorCode = undefined;
      try {
        await this.startObserving();
      } catch {
        await this.conceal('explorer-closed', true, 'HABITAT_OBSERVER_FAILED');
        throw habitatError('HABITAT_OBSERVER_FAILED');
      }
    }
    return this.snapshot();
  }

  async handleTaskEvent(event: TaskEvent): Promise<void> {
    if (this.closed || event.type !== 'phase') return;
    this.agentPhase = event.phase;
    if (BLOCKED_AGENT_PHASES.has(event.phase)) await this.concealForInteraction();
  }

  async handleUserInteraction(): Promise<void> {
    if (this.closed) return;
    await this.concealForInteraction();
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    const pendingStableWrite = this.activeOperation?.kind === 'enter'
      || this.activeOperation?.kind === 'recall'
      ? this.activeOperation.promise
      : undefined;
    this.closed = true;
    this.observationToken += 1;
    this.restoreStableState();
    this.closePromise = this.performClose(pendingStableWrite);
    return this.closePromise;
  }

  /** 同类同参命令共享正在进行的结果，其他命令在权威迁移期间失败关闭。 */
  private beginOperation(
    key: string,
    kind: HabitatOperation,
    work: () => Promise<HabitatServiceSnapshot>
  ): Promise<HabitatServiceSnapshot> {
    if (this.activeOperation !== null) {
      return this.activeOperation.key === key
        ? this.activeOperation.promise
        : Promise.reject(habitatError('HABITAT_OPERATION_BUSY'));
    }
    let operation!: ActiveOperation;
    const promise = work().finally(() => {
      if (this.activeOperation === operation) this.activeOperation = null;
    });
    operation = { key, kind, promise };
    this.activeOperation = operation;
    return promise;
  }

  private async performEnter(
    directoryId: string,
    reason: HabitatEnterReason
  ): Promise<HabitatServiceSnapshot> {
    if (this.state !== 'desktop') throw habitatError('HABITAT_STATE_INVALID');
    this.state = 'entering';
    this.errorCode = undefined;
    let persisted = false;
    try {
      const loaded = await this.options.store.load();
      const directory = loaded.directories.find(candidate => (
        candidate.id === directoryId && candidate.enabled
      ));
      if (directory === undefined) throw habitatError('HABITAT_DIRECTORY_NOT_FOUND');
      if (await this.options.directoryPolicy.availability(directory) !== 'available') {
        throw habitatError('HABITAT_DIRECTORY_UNAVAILABLE');
      }
      this.assertOpen();
      this.assertEntryAllowed(reason);

      const next: PetHabitatSnapshot = {
        ...loaded,
        location: {
          kind: 'folder',
          directoryId,
          enteredAt: new Date(this.now()).toISOString(),
          previousDesktopPosition: this.options.petWindow.getPosition(),
          localOffset: this.options.petWindow.getLocalOffset()
        }
      };
      await this.options.store.save(next);
      persisted = true;
      this.stableSnapshot = structuredClone(next);
      this.directoryId = directoryId;
      this.state = 'folder-hidden';
      if (this.closed) throw habitatError('HABITAT_CLOSED');

      await this.hideAndInvalidate('leave');
      try {
        await this.startObserving();
      } catch {
        await this.conceal('explorer-closed', true, 'HABITAT_OBSERVER_FAILED');
        throw habitatError('HABITAT_OBSERVER_FAILED');
      }
      return this.snapshot();
    } catch (error) {
      if (!persisted) {
        this.state = 'desktop';
        this.directoryId = null;
      }
      this.captureError(error);
      throw error;
    }
  }

  private async performRecall(): Promise<HabitatServiceSnapshot> {
    if (
      this.directoryId === null
      || this.stableSnapshot.location.kind !== 'folder'
    ) throw habitatError('HABITAT_STATE_INVALID');
    const previousState = this.state;
    const previousLocation = this.stableSnapshot.location;
    this.state = 'recalling';
    this.errorCode = undefined;
    try {
      const loaded = await this.options.store.load();
      const latestLocation = loaded.location.kind === 'folder'
        && loaded.location.directoryId === this.directoryId
        ? loaded.location
        : previousLocation;
      const next: PetHabitatSnapshot = {
        ...loaded,
        location: {
          kind: 'desktop',
          position: latestLocation.previousDesktopPosition
        }
      };
      await this.options.store.save(next);
      this.stableSnapshot = structuredClone(next);
      this.directoryId = null;
      this.state = 'desktop';
      this.observationToken += 1;
      this.binding = undefined;
      this.watermark = undefined;
      await this.stopObservingSafely();
      await this.hideAndInvalidate('leave');
      if (this.closed) throw habitatError('HABITAT_CLOSED');
      this.options.petWindow.setPosition(
        latestLocation.previousDesktopPosition.x,
        latestLocation.previousDesktopPosition.y
      );
      this.options.petWindow.show();
      return this.snapshot();
    } catch (error) {
      if (this.stableSnapshot.location.kind === 'folder') {
        this.state = previousState;
        this.directoryId = previousLocation.directoryId;
      }
      this.captureError(error);
      throw error;
    }
  }

  private async performSummon(): Promise<HabitatServiceSnapshot> {
    if (this.state === 'desktop') {
      try {
        this.options.petWindow.show();
        this.options.petWindow.focus();
        return this.snapshot();
      } catch {
        this.errorCode = 'HABITAT_WINDOW_FAILED';
        throw habitatError('HABITAT_WINDOW_FAILED');
      }
    }
    if (this.directoryId === null) throw habitatError('HABITAT_STATE_INVALID');
    const loaded = await this.options.store.load();
    const directory = loaded.directories.find(candidate => (
      candidate.id === this.directoryId && candidate.enabled
    ));
    if (directory === undefined) throw habitatError('HABITAT_DIRECTORY_NOT_FOUND');
    try {
      await this.options.openDirectory(directory.absolutePath);
      this.assertOpen();
      await this.startObserving();
      return this.snapshot();
    } catch (error) {
      if (error instanceof Error && error.message === 'HABITAT_CLOSED') throw error;
      this.errorCode = 'HABITAT_SUMMON_FAILED';
      throw habitatError('HABITAT_SUMMON_FAILED');
    }
  }

  private assertEntryAllowed(reason: HabitatEnterReason): void {
    const blockers = this.options.readBlockers();
    if (reason === 'automatic' && blockers.proactivityMode !== 'autonomous') {
      throw habitatError('HABITAT_AUTOMATION_BLOCKED');
    }
    if (
      BLOCKED_AGENT_PHASES.has(this.agentPhase)
      || blockers.fileTaskActive
      || blockers.characterSwitching
      || blockers.dragging
      || blockers.chatInteracting
      || blockers.appQuitting
      || blockers.foregroundFullscreen
    ) throw habitatError('HABITAT_ENTRY_BLOCKED');
  }

  private async startObserving(): Promise<void> {
    await this.options.explorer.start();
    await this.options.explorer.startObserving();
  }

  private async stopObservingSafely(): Promise<void> {
    try {
      await this.options.explorer.stopObserving();
    } catch {
      // 召回和关闭不能依赖观察器仍可用。
    }
  }

  private async concealForInteraction(): Promise<void> {
    if (this.state !== 'folder-visible' && this.state !== 'revealing') return;
    this.observationToken += 1;
    await this.conceal('leave');
  }

  private async conceal(
    reason: ExplorerLayerUnsafeReason,
    lost = false,
    errorCode?: HabitatErrorCode
  ): Promise<void> {
    await this.hideAndInvalidate(reason);
    this.binding = undefined;
    if (lost) this.state = 'folder-lost';
    else if (this.state !== 'folder-lost') this.state = 'folder-hidden';
    if (errorCode !== undefined) this.errorCode = errorCode;
  }

  /** 明确先隐藏桌宠，再撤销 Explorer 相邻层级。 */
  private async hideAndInvalidate(reason: ExplorerLayerUnsafeReason): Promise<void> {
    try {
      this.options.petWindow.hide();
    } catch {
      this.errorCode = 'HABITAT_WINDOW_FAILED';
    }
    await this.options.layer.invalidate(reason);
  }

  private async performClose(
    pendingStableWrite: Promise<HabitatServiceSnapshot> | undefined
  ): Promise<void> {
    await this.stopObservingSafely();
    await this.hideAndInvalidate('leave');
    await pendingStableWrite?.catch(() => undefined);
  }

  private restoreStableState(): void {
    if (this.stableSnapshot.location.kind === 'desktop') {
      this.state = 'desktop';
      this.directoryId = null;
    } else {
      this.state = 'folder-hidden';
      this.directoryId = this.stableSnapshot.location.directoryId;
    }
  }

  private restoreFolderStableState(): void {
    if (this.stableSnapshot.location.kind === 'folder') {
      this.state = 'folder-hidden';
      this.directoryId = this.stableSnapshot.location.directoryId;
    } else {
      this.state = 'desktop';
      this.directoryId = null;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw habitatError('HABITAT_CLOSED');
  }

  private captureError(error: unknown): void {
    if (error instanceof Error && /^[A-Z][A-Z0-9_]+$/u.test(error.message)) {
      this.errorCode = error.message;
    }
  }
}
