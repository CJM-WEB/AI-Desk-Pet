import type { TaskEvent } from '@myself/shared-types';

import {
  selectExplorerCandidate,
  type ExplorerCandidateBinding,
  type ExplorerCandidateWatermark
} from './explorer-candidate-selector';
import type { ExplorerSnapshot } from './explorer-space-protocol';
import type { ExplorerLayerUnsafeReason } from './explorer-window-layer-controller';
import {
  HabitatServiceError,
  habitatError,
  type HabitatErrorCode
} from './habitat-errors';
import type {
  HabitatDirectoryAvailability,
  HabitatDirectoryRecord,
  HabitatLocationUpdate,
  HabitatLocationUpdateResult,
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

export type HabitatOperation = 'enter' | 'recall' | 'summon' | 'availability';
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

export interface ExplorerAuthoritySnapshot {
  nonce: string;
  revision: number;
  instanceId: string | null;
}

type HabitatExplorerBinding = ExplorerCandidateBinding & {
  nonce: string;
};

type HabitatExplorerWatermark = ExplorerCandidateWatermark & {
  nonce: string;
};

export interface HabitatServiceSnapshot {
  state: HabitatServiceState;
  directoryId: string | null;
  operation: HabitatOperation | null;
  closed: boolean;
  errorCode?: HabitatErrorCode;
}

/** opener 只能接收服务刚复核过的目录记录，禁止外部重新拼装路径。 */
export interface HabitatDirectoryOpenRequest {
  directory: Readonly<HabitatDirectoryRecord>;
  signal: AbortSignal;
}

interface HabitatStorePort {
  load(): Promise<PetHabitatSnapshot>;
  updateLocation(update: HabitatLocationUpdate): Promise<HabitatLocationUpdateResult>;
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
  observerInitiallyActive?: boolean;
  store: HabitatStorePort;
  directoryPolicy: HabitatDirectoryPolicyPort;
  identityResolver: FolderIdentityResolverPort;
  explorer: ExplorerObserverPort;
  layer: ExplorerLayerPort;
  petWindow: HabitatPetWindowPort;
  openDirectory(request: HabitatDirectoryOpenRequest): Promise<void>;
  readBlockers(): HabitatBlockerSnapshot;
  readExplorerAuthority(): ExplorerAuthoritySnapshot;
  now?: () => number;
}

export type HabitatExplorerObservation = ExplorerSnapshot | Error | null | undefined;

interface ActiveOperation {
  key: string;
  kind: HabitatOperation;
  epoch: number;
  promise: Promise<HabitatServiceSnapshot>;
}

type ObserverLifecycle = 'idle' | 'starting' | 'observing';

const BLOCKED_AGENT_PHASES = new Set([
  'listening', 'thinking', 'awaiting_confirmation', 'acting'
]);

/**
 * Main 内目录空间的唯一权威协调器；所有异步 continuation 都受同一单调 epoch 约束。
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
  private errorCode: HabitatErrorCode | undefined;
  private epoch = 0;
  private binding: HabitatExplorerBinding | undefined;
  private watermark: HabitatExplorerWatermark | undefined;
  private observerLifecycle: ObserverLifecycle = 'idle';
  private desktopRecoveryPending = false;

  constructor(private readonly options: HabitatServiceOptions) {
    this.now = options.now ?? Date.now;
    this.stableSnapshot = structuredClone(options.initialSnapshot);
    if (this.stableSnapshot.location.kind === 'folder') {
      this.state = 'folder-hidden';
      this.directoryId = this.stableSnapshot.location.directoryId;
      if (options.observerInitiallyActive === true) this.observerLifecycle = 'observing';
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
    const active = this.activeResult(`enter:${directoryId}:${reason}`);
    if (active !== null) return active;
    if (this.closed) return Promise.reject(habitatError('HABITAT_CLOSED'));
    if (
      this.directoryId === directoryId
      && this.state !== 'desktop'
      && this.state !== 'entering'
      && this.state !== 'recalling'
    ) return Promise.resolve(this.snapshot());
    return this.beginOperation(`enter:${directoryId}:${reason}`, 'enter', epoch => (
      this.performEnter(epoch, directoryId, reason)
    ));
  }

  summon(signal: AbortSignal = new AbortController().signal): Promise<HabitatServiceSnapshot> {
    const active = this.activeResult('summon');
    if (active !== null) return active;
    if (this.closed) return Promise.reject(habitatError('HABITAT_CLOSED'));
    return this.beginOperation('summon', 'summon', epoch => this.performSummon(epoch, signal));
  }

  recallToDesktop(): Promise<HabitatServiceSnapshot> {
    const active = this.activeResult('recall');
    if (active !== null) return active;
    if (this.closed) return Promise.reject(habitatError('HABITAT_CLOSED'));
    if (this.state === 'desktop' && !this.desktopRecoveryPending) {
      return Promise.resolve(this.snapshot());
    }
    return this.beginOperation('recall', 'recall', epoch => this.performRecall(epoch));
  }

  handleDirectoryAvailability(): Promise<HabitatServiceSnapshot> {
    const active = this.activeResult('availability');
    if (active !== null) return active;
    if (this.closed) return Promise.reject(habitatError('HABITAT_CLOSED'));
    if (this.state === 'desktop' && !this.desktopRecoveryPending) {
      return Promise.resolve(this.snapshot());
    }
    return this.beginOperation('availability', 'availability', epoch => (
      this.performDirectoryAvailability(epoch)
    ));
  }

  async observeExplorer(observation: HabitatExplorerObservation): Promise<void> {
    const fatal = !(
      observation
      && !(observation instanceof Error)
      && observation.type === 'explorer-snapshot'
    );
    if (this.closed) return;
    if (fatal) {
      // fatal 先换代 operation authority；清理完成后立即释放旧事务，迟到 continuation 只会失败。
      const cancelledOperation = this.activeOperation;
      this.observerLifecycle = 'idle';
      const epoch = this.advanceEpoch();
      try {
        if (this.state !== 'desktop') {
          await this.conceal(epoch, 'explorer-closed', true, 'HABITAT_OBSERVER_FAILED');
        }
      } finally {
        if (this.activeOperation === cancelledOperation) this.activeOperation = null;
      }
      return;
    }
    if (
      this.activeOperation !== null
      || this.state === 'desktop'
      || this.state === 'entering'
      || this.state === 'recalling'
    ) return;
    let authority: ExplorerAuthoritySnapshot;
    try {
      authority = this.readAuthority();
    } catch {
      const epoch = this.advanceEpoch();
      await this.conceal(epoch, 'explorer-closed', true, 'HABITAT_OBSERVER_FAILED');
      throw habitatError('HABITAT_OBSERVER_FAILED');
    }
    if (!this.observationMatchesAuthority(observation, authority)) {
      if (
        (this.state === 'folder-visible' || this.state === 'revealing')
        && !this.bindingMatchesAuthority(authority)
      ) {
        const epoch = this.advanceEpoch();
        await this.conceal(epoch, 'tab-race');
      }
      return;
    }
    const epoch = this.advanceEpoch();

    if (observation.status === 'unavailable') {
      await this.conceal(epoch, 'explorer-closed', true, 'HABITAT_OBSERVER_FAILED');
      return;
    }
    if (observation.status === 'ambiguous') {
      await this.conceal(epoch, 'tab-race');
      return;
    }
    if (observation.status === 'none') {
      await this.conceal(epoch, 'explorer-blurred');
      return;
    }
    if (this.state === 'folder-lost') return;

    await this.conceal(epoch, 'tab-race');
    if (!await this.retainObservation(epoch, observation) || this.isRevealBlocked()) return;

    let resolution: Awaited<ReturnType<FolderIdentityResolverPort['resolve']>>;
    try {
      resolution = await this.options.identityResolver.resolve(observation.path);
    } catch {
      if (this.isCurrentEpoch(epoch) && !this.closed) {
        await this.conceal(epoch, 'tab-race');
      }
      return;
    }
    if (!await this.retainObservation(epoch, observation) || this.isRevealBlocked()) return;
    if (
      resolution.status !== 'matched'
      || resolution.directoryId !== this.directoryId
    ) {
      await this.conceal(epoch, 'tab-race');
      return;
    }

    let observedAt: number;
    try {
      observedAt = this.now();
    } catch {
      await this.conceal(epoch, 'tab-race', false, 'HABITAT_OBSERVER_FAILED');
      throw habitatError('HABITAT_OBSERVER_FAILED');
    }
    const selected = selectExplorerCandidate({
      activeInstanceId: authority.instanceId ?? '',
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
      ...(
        this.watermark === undefined || this.watermark.nonce !== observation.nonce
          ? {}
          : { watermark: this.watermark }
      )
    });
    if (!await this.retainObservation(epoch, observation)) return;
    this.watermark = selected.watermark === null
      ? undefined
      : { ...selected.watermark, nonce: observation.nonce };
    if (selected.status !== 'selected') {
      await this.conceal(epoch, 'tab-race');
      return;
    }

    this.binding = { ...selected.binding, nonce: observation.nonce };
    this.state = 'revealing';
    try {
      await this.options.layer.activate({ explorerHwnd: selected.binding.hwnd });
    } catch {
      if (!this.isCurrentEpoch(epoch) || this.closed) return;
      await this.conceal(epoch, 'tab-race', false, 'HABITAT_WINDOW_FAILED');
      throw habitatError('HABITAT_WINDOW_FAILED');
    }
    if (!await this.retainObservation(epoch, observation)) return;
    if (this.isRevealBlocked()) {
      await this.conceal(epoch, 'leave');
      return;
    }

    this.state = 'folder-visible';
    this.errorCode = undefined;
    try {
      this.options.petWindow.show();
    } catch {
      if (!this.isCurrentEpoch(epoch) || this.closed) return;
      await this.conceal(epoch, 'leave', false, 'HABITAT_WINDOW_FAILED');
      throw habitatError('HABITAT_WINDOW_FAILED');
    }
  }

  async handleTaskEvent(event: TaskEvent): Promise<void> {
    if (this.closed || event.type !== 'phase') return;
    this.agentPhase = event.phase;
    if (!BLOCKED_AGENT_PHASES.has(event.phase)) return;
    if (this.state !== 'folder-visible' && this.state !== 'revealing') return;
    const epoch = this.advanceEpoch();
    await this.conceal(epoch, 'leave');
  }

  async handleUserInteraction(): Promise<void> {
    if (this.closed || (this.state !== 'folder-visible' && this.state !== 'revealing')) return;
    const epoch = this.advanceEpoch();
    await this.conceal(epoch, 'leave');
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    const pending = this.activeOperation?.kind === 'enter'
      || this.activeOperation?.kind === 'recall'
      || this.activeOperation?.kind === 'availability'
      ? this.activeOperation.promise
      : undefined;
    const startupOverlap = this.observerLifecycle === 'starting';
    this.closed = true;
    const epoch = this.advanceEpoch();
    this.errorCode = undefined;
    this.restoreStableState();
    this.closePromise = this.performClose(epoch, pending, startupOverlap);
    return this.closePromise;
  }

  private activeResult(key: string): Promise<HabitatServiceSnapshot> | null {
    if (this.activeOperation === null) return null;
    return this.activeOperation.key === key
      ? this.activeOperation.promise
      : Promise.reject(habitatError('HABITAT_OPERATION_BUSY'));
  }

  private beginOperation(
    key: string,
    kind: HabitatOperation,
    work: (epoch: number) => Promise<HabitatServiceSnapshot>
  ): Promise<HabitatServiceSnapshot> {
    const epoch = this.advanceEpoch();
    let operation!: ActiveOperation;
    const promise = Promise.resolve()
      .then(() => work(epoch))
      .catch(error => {
        const mapped = this.mapError(error, 'HABITAT_OPERATION_FAILED');
        if (this.isCurrentEpoch(epoch) && !this.closed) this.errorCode = mapped.code;
        throw mapped;
      })
      .finally(() => {
        if (this.activeOperation === operation) this.activeOperation = null;
      });
    operation = { key, kind, epoch, promise };
    this.activeOperation = operation;
    return promise;
  }

  private async performEnter(
    epoch: number,
    directoryId: string,
    reason: HabitatEnterReason
  ): Promise<HabitatServiceSnapshot> {
    try {
      return await this.performCurrentEnter(epoch, directoryId, reason);
    } catch (error) {
      if (this.isCurrentEpoch(epoch) && !this.closed && this.state === 'entering') {
        this.restoreStableState();
      }
      throw error;
    }
  }

  /** enter 尚未提交稳定位置时，任何失败都由外层恢复到原稳定态。 */
  private async performCurrentEnter(
    epoch: number,
    directoryId: string,
    reason: HabitatEnterReason
  ): Promise<HabitatServiceSnapshot> {
    if (this.state !== 'desktop') throw habitatError('HABITAT_STATE_INVALID');
    if (this.stableSnapshot.location.kind !== 'desktop') {
      throw habitatError('HABITAT_STATE_INVALID');
    }
    const previousDesktopLocation = structuredClone(this.stableSnapshot.location);
    this.state = 'entering';
    this.errorCode = undefined;
    const loaded = await this.storeLoad();
    this.assertOperation(epoch);
    const directory = loaded.directories.find(candidate => (
      candidate.id === directoryId && candidate.enabled
    ));
    if (directory === undefined) throw habitatError('HABITAT_DIRECTORY_NOT_FOUND');
    const availability = await this.directoryAvailability(directory);
    this.assertOperation(epoch);
    if (availability !== 'available') throw habitatError('HABITAT_DIRECTORY_UNAVAILABLE');
    this.assertEntryAllowed(reason);

    let location: Extract<PetHabitatSnapshot['location'], { kind: 'folder' }>;
    try {
      location = {
        kind: 'folder',
        directoryId,
        enteredAt: new Date(this.now()).toISOString(),
        previousDesktopPosition: this.options.petWindow.getPosition(),
        localOffset: this.options.petWindow.getLocalOffset()
      };
    } catch {
      throw habitatError('HABITAT_WINDOW_FAILED');
    }
    const committed = await this.storeUpdateLocation({
      expected: previousDesktopLocation,
      expectedDirectory: directory,
      location
    });
    this.assertOperation(epoch);
    if (committed.status === 'conflict') throw habitatError('HABITAT_DIRECTORY_UNAVAILABLE');
    try {
      this.assertEntryAllowed(reason);
    } catch (error) {
      if (committed.status !== 'updated') {
        await this.adoptAuthorityAndConceal(epoch, committed.snapshot);
        throw error;
      }
      let compensated: HabitatLocationUpdateResult;
      try {
        compensated = await this.storeUpdateLocation({
          expected: committed.snapshot.location,
          location: previousDesktopLocation
        });
        this.assertOperation(epoch);
      } catch (compensationError) {
        if (this.isCurrentEpoch(epoch) && !this.closed) {
          await this.adoptAuthorityAndConceal(epoch, committed.snapshot);
        }
        throw compensationError;
      }
      await this.adoptAuthorityAndConceal(epoch, compensated.snapshot);
      throw error;
    }
    this.stableSnapshot = structuredClone(committed.snapshot);
    this.directoryId = directoryId;
    this.state = 'folder-hidden';

    const cleanupError = await this.cleanupCurrent(epoch, 'leave');
    this.assertOperation(epoch);
    if (cleanupError !== null) throw this.fail(cleanupError);
    try {
      await this.ensureObserving(epoch);
    } catch (error) {
      const mapped = this.mapError(error, 'HABITAT_OBSERVER_FAILED');
      if (this.isCurrentEpoch(epoch) && !this.closed) {
        await this.conceal(epoch, 'explorer-closed', true, mapped.code);
      }
      throw mapped;
    }
    this.assertOperation(epoch);
    return this.snapshot();
  }

  private async performRecall(epoch: number): Promise<HabitatServiceSnapshot> {
    this.errorCode = undefined;
    if (this.stableSnapshot.location.kind === 'folder') {
      const previous = this.stableSnapshot.location;
      this.state = 'recalling';
      const committed = await this.storeUpdateLocation({
        expected: previous,
        location: { kind: 'desktop', position: previous.previousDesktopPosition }
      });
      this.assertOperation(epoch);
      if (committed.status === 'conflict' && committed.snapshot.location.kind !== 'desktop') {
        await this.adoptAuthorityAndConceal(epoch, committed.snapshot);
        throw habitatError('HABITAT_STATE_INVALID');
      }
      this.stableSnapshot = structuredClone(committed.snapshot);
    }
    if (this.stableSnapshot.location.kind !== 'desktop') {
      throw habitatError('HABITAT_STATE_INVALID');
    }
    this.directoryId = null;
    this.state = 'recalling';
    this.desktopRecoveryPending = true;
    await this.recoverDesktop(epoch);
    return this.snapshot();
  }

  private async recoverDesktop(epoch: number): Promise<void> {
    const errors: HabitatErrorCode[] = [];
    const stopError = await this.stopObserver();
    this.assertOperation(epoch);
    if (stopError !== null) errors.push(stopError);

    if (this.isCurrentEpoch(epoch)) {
      try {
        this.options.petWindow.hide();
      } catch {
        errors.push('HABITAT_WINDOW_FAILED');
      }
    }
    if (this.isCurrentEpoch(epoch)) {
      try {
        await this.options.layer.invalidate('leave');
      } catch {
        errors.push('HABITAT_WINDOW_FAILED');
      }
    }
    this.assertOperation(epoch);

    let position = this.stableSnapshot.location.kind === 'desktop'
      ? this.stableSnapshot.location.position
      : null;
    if (position === null) {
      try {
        position = this.options.petWindow.getPosition();
      } catch {
        errors.push('HABITAT_WINDOW_FAILED');
      }
    }
    let positioned = position !== null;
    if (position !== null) {
      try {
        this.options.petWindow.setPosition(position.x, position.y);
      } catch {
        positioned = false;
        errors.push('HABITAT_WINDOW_FAILED');
      }
    }
    if (positioned) {
      try {
        this.options.petWindow.show();
      } catch {
        errors.push('HABITAT_WINDOW_FAILED');
      }
    }

    if (errors.length > 0) {
      this.state = 'recalling';
      this.desktopRecoveryPending = true;
      throw this.fail(errors[0]!);
    }
    this.binding = undefined;
    this.watermark = undefined;
    this.state = 'desktop';
    this.desktopRecoveryPending = false;
    this.errorCode = undefined;
  }

  private async performSummon(
    epoch: number,
    signal: AbortSignal
  ): Promise<HabitatServiceSnapshot> {
    this.assertSummonOperation(epoch, signal);
    this.errorCode = undefined;
    if (this.state === 'desktop') {
      try {
        this.options.petWindow.show();
        this.options.petWindow.focus();
      } catch {
        throw habitatError('HABITAT_WINDOW_FAILED');
      }
      return this.snapshot();
    }
    if (this.directoryId === null) throw habitatError('HABITAT_STATE_INVALID');
    const loaded = await this.awaitSummonBoundary(this.storeLoad(), epoch, signal);
    const directory = loaded.directories.find(candidate => (
      candidate.id === this.directoryId && candidate.enabled
    ));
    if (directory === undefined) throw habitatError('HABITAT_DIRECTORY_UNAVAILABLE');
    const availability = await this.awaitSummonBoundary(
      this.directoryAvailability(directory),
      epoch,
      signal
    );
    if (availability !== 'available') throw habitatError('HABITAT_DIRECTORY_UNAVAILABLE');
    try {
      await this.awaitSummonBoundary(
        this.options.openDirectory({ directory, signal }),
        epoch,
        signal
      );
    } catch (error) {
      throw this.mapError(error, 'HABITAT_SUMMON_FAILED');
    }
    await this.ensureObserving(epoch, signal);
    this.assertSummonOperation(epoch, signal);
    return this.snapshot();
  }

  private async performDirectoryAvailability(epoch: number): Promise<HabitatServiceSnapshot> {
    const loaded = await this.storeLoad();
    this.assertOperation(epoch);
    if (loaded.location.kind === 'desktop') {
      this.stableSnapshot = structuredClone(loaded);
      this.directoryId = null;
      this.state = 'recalling';
      this.desktopRecoveryPending = true;
      await this.recoverDesktop(epoch);
      return this.snapshot();
    }
    const folderLocation = loaded.location;
    const locationChanged = this.stableSnapshot.location.kind !== 'folder'
      || this.stableSnapshot.location.directoryId !== folderLocation.directoryId;
    if (locationChanged) {
      const cleanupError = await this.cleanupCurrent(epoch, 'leave');
      this.assertOperation(epoch);
      this.binding = undefined;
      this.watermark = undefined;
      this.state = 'folder-hidden';
      if (cleanupError !== null) throw this.fail(cleanupError);
    }
    const directory = loaded.directories.find(candidate => (
      candidate.id === folderLocation.directoryId && candidate.enabled
    ));
    const available = directory === undefined
      ? false
      : await this.directoryAvailability(directory) === 'available';
    this.assertOperation(epoch);
    this.stableSnapshot = structuredClone(loaded);
    this.directoryId = folderLocation.directoryId;
    if (!available) {
      if (locationChanged) {
        this.state = 'folder-lost';
        this.errorCode = 'HABITAT_DIRECTORY_UNAVAILABLE';
        return this.snapshot();
      }
      await this.conceal(epoch, 'explorer-closed', true, 'HABITAT_DIRECTORY_UNAVAILABLE');
      return this.snapshot();
    }
    if (locationChanged) {
      this.errorCode = undefined;
      await this.ensureObserving(epoch);
      this.assertOperation(epoch);
      return this.snapshot();
    }
    if (this.state === 'folder-lost') {
      this.state = 'folder-hidden';
      this.errorCode = undefined;
      await this.ensureObserving(epoch);
      this.assertOperation(epoch);
    }
    return this.snapshot();
  }

  private async ensureObserving(epoch: number, signal?: AbortSignal): Promise<void> {
    if (this.observerLifecycle === 'observing') return;
    this.assertOptionalSummonOperation(epoch, signal);
    this.observerLifecycle = 'starting';
    const starting = Promise.resolve().then(() => this.options.explorer.start());
    try {
      if (signal === undefined) {
        await starting;
        this.assertOperation(epoch);
      } else {
        await this.awaitSummonBoundary(starting, epoch, signal);
      }
    } catch (error) {
      this.observerLifecycle = 'idle';
      throw this.mapError(error, 'HABITAT_OBSERVER_FAILED');
    }
    this.assertOptionalSummonOperation(epoch, signal);
    const observing = Promise.resolve().then(() => this.options.explorer.startObserving());
    try {
      if (signal === undefined) {
        await observing;
        this.assertOperation(epoch);
      } else {
        await this.awaitSummonBoundary(observing, epoch, signal);
      }
      this.observerLifecycle = 'observing';
    } catch (error) {
      this.observerLifecycle = 'idle';
      if (signal?.aborted) {
        // 已发出的桥调用不能撤回；迟到成功时仅在没有新观察者的前提下收敛资源。
        void observing
          .then(async () => {
            if (this.observerLifecycle === 'idle') await this.stopObserver(true);
          })
          .catch(() => undefined);
      }
      throw this.mapError(error, 'HABITAT_OBSERVER_FAILED');
    }
    this.assertOptionalSummonOperation(epoch, signal);
  }

  private async stopObserver(force = false): Promise<HabitatErrorCode | null> {
    if (!force && this.observerLifecycle === 'idle') return null;
    try {
      await this.options.explorer.stopObserving();
      this.observerLifecycle = 'idle';
      return null;
    } catch {
      return 'HABITAT_OBSERVER_FAILED';
    }
  }

  private async performClose(
    epoch: number,
    pending: Promise<HabitatServiceSnapshot> | undefined,
    startupOverlap: boolean
  ): Promise<void> {
    const errors: HabitatErrorCode[] = [];
    const stopError = await this.stopObserver();
    if (stopError !== null) errors.push(stopError);
    const cleanupError = await this.cleanupCurrent(epoch, 'leave');
    if (cleanupError !== null) errors.push(cleanupError);
    await pending?.catch(() => undefined);
    if (startupOverlap) {
      const finalStopError = await this.stopObserver(true);
      if (finalStopError !== null) errors.push(finalStopError);
    }
    if (errors.length > 0) throw this.fail(errors[0]!);
  }

  private async conceal(
    epoch: number,
    reason: ExplorerLayerUnsafeReason,
    lost = false,
    errorCode?: HabitatErrorCode
  ): Promise<void> {
    const cleanupError = await this.cleanupCurrent(epoch, reason);
    if (!this.isCurrentEpoch(epoch)) return;
    this.binding = undefined;
    if (lost) this.state = 'folder-lost';
    else if (this.state !== 'folder-lost') this.state = 'folder-hidden';
    const code = errorCode ?? cleanupError;
    if (code !== null && code !== undefined) this.errorCode = code;
    if (cleanupError !== null) throw this.fail(cleanupError);
  }

  /** 每个副作用前复核 epoch；调用后的异步结果不得改写新 authority。 */
  private async cleanupCurrent(
    epoch: number,
    reason: ExplorerLayerUnsafeReason
  ): Promise<HabitatErrorCode | null> {
    if (!this.isCurrentEpoch(epoch)) return null;
    let error: HabitatErrorCode | null = null;
    try {
      this.options.petWindow.hide();
    } catch {
      error = 'HABITAT_WINDOW_FAILED';
    }
    if (!this.isCurrentEpoch(epoch)) return error;
    try {
      await this.options.layer.invalidate(reason);
    } catch {
      error = 'HABITAT_WINDOW_FAILED';
    }
    return error;
  }

  /** 采纳并发 location authority；只有窗口清理成功后才发布 folder-hidden。 */
  private async adoptAuthorityAndConceal(
    epoch: number,
    snapshot: PetHabitatSnapshot
  ): Promise<void> {
    this.stableSnapshot = structuredClone(snapshot);
    if (this.stableSnapshot.location.kind === 'desktop') {
      this.binding = undefined;
      this.watermark = undefined;
      this.restoreStableState();
      return;
    }

    this.directoryId = this.stableSnapshot.location.directoryId;
    this.state = 'recalling';
    const cleanupError = await this.cleanupCurrent(epoch, 'leave');
    this.assertOperation(epoch);
    this.binding = undefined;
    this.watermark = undefined;
    if (cleanupError !== null) throw this.fail(cleanupError);
    this.state = 'folder-hidden';
  }

  private assertEntryAllowed(reason: HabitatEnterReason): void {
    let blockers: HabitatBlockerSnapshot;
    try {
      blockers = this.options.readBlockers();
    } catch {
      throw habitatError('HABITAT_ENTRY_BLOCKED');
    }
    if (reason === 'automatic' && blockers.proactivityMode !== 'autonomous') {
      throw habitatError('HABITAT_AUTOMATION_BLOCKED');
    }
    if (this.isBlocked(blockers)) throw habitatError('HABITAT_ENTRY_BLOCKED');
  }

  private isRevealBlocked(): boolean {
    try {
      return this.isBlocked(this.options.readBlockers());
    } catch {
      return true;
    }
  }

  private isBlocked(blockers: HabitatBlockerSnapshot): boolean {
    return BLOCKED_AGENT_PHASES.has(this.agentPhase)
      || blockers.fileTaskActive
      || blockers.characterSwitching
      || blockers.dragging
      || blockers.chatInteracting
      || blockers.appQuitting
      || blockers.foregroundFullscreen;
  }

  private readAuthority(): ExplorerAuthoritySnapshot {
    try {
      return this.options.readExplorerAuthority();
    } catch {
      throw habitatError('HABITAT_OBSERVER_FAILED');
    }
  }

  private observationMatchesAuthority(
    observation: HabitatExplorerObservation,
    authority: ExplorerAuthoritySnapshot
  ): boolean {
    if (!(observation && !(observation instanceof Error) && observation.type === 'explorer-snapshot')) {
      return true;
    }
    return observation.nonce === authority.nonce
      && observation.sequence === authority.revision
      && (observation.status !== 'ready' || observation.instanceId === authority.instanceId);
  }

  private bindingMatchesAuthority(authority: ExplorerAuthoritySnapshot): boolean {
    return this.binding !== undefined
      && this.binding.nonce === authority.nonce
      && this.binding.instanceId === authority.instanceId
      && this.binding.sequence === authority.revision;
  }

  /** 外部 authority 换代时，只有仍持有当前 epoch 的观察可以执行失败关闭。 */
  private async retainObservation(
    epoch: number,
    observation: ExplorerSnapshot
  ): Promise<boolean> {
    if (!this.isCurrentEpoch(epoch) || this.closed) return false;
    let authority: ExplorerAuthoritySnapshot;
    try {
      authority = this.readAuthority();
    } catch {
      await this.conceal(epoch, 'explorer-closed', true, 'HABITAT_OBSERVER_FAILED');
      throw habitatError('HABITAT_OBSERVER_FAILED');
    }
    if (!this.observationMatchesAuthority(observation, authority)) {
      await this.conceal(epoch, 'tab-race');
      return false;
    }
    return true;
  }

  private async storeLoad(): Promise<PetHabitatSnapshot> {
    try {
      return await this.options.store.load();
    } catch (error) {
      throw this.mapError(error, 'HABITAT_STORAGE_FAILED');
    }
  }

  private async storeUpdateLocation(
    update: HabitatLocationUpdate
  ): Promise<HabitatLocationUpdateResult> {
    try {
      return await this.options.store.updateLocation(update);
    } catch (error) {
      throw this.mapError(error, 'HABITAT_STORAGE_FAILED');
    }
  }

  private async directoryAvailability(
    directory: HabitatDirectoryRecord
  ): Promise<HabitatDirectoryAvailability> {
    try {
      return await this.options.directoryPolicy.availability(directory);
    } catch {
      throw habitatError('HABITAT_DIRECTORY_UNAVAILABLE');
    }
  }

  private advanceEpoch(): number {
    this.epoch += 1;
    return this.epoch;
  }

  private isCurrentEpoch(epoch: number): boolean {
    return epoch === this.epoch;
  }

  private assertOperation(epoch: number): void {
    if (this.closed) throw habitatError('HABITAT_CLOSED');
    if (!this.isCurrentEpoch(epoch)) throw habitatError('HABITAT_OPERATION_BUSY');
  }

  private assertOptionalSummonOperation(epoch: number, signal?: AbortSignal): void {
    if (signal === undefined) this.assertOperation(epoch);
    else this.assertSummonOperation(epoch, signal);
  }

  private assertSummonOperation(epoch: number, signal: AbortSignal): void {
    if (signal.aborted) throw habitatError('HABITAT_SUMMON_FAILED');
    this.assertOperation(epoch);
  }

  /**
   * 取消只终止本服务对依赖结果的授权；Promise 仍挂有处理器，迟到完成不会继续推进状态机。
   */
  private async awaitSummonBoundary<T>(
    operation: Promise<T>,
    epoch: number,
    signal: AbortSignal
  ): Promise<T> {
    this.assertSummonOperation(epoch, signal);
    let rejectAborted!: (error: HabitatServiceError) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAborted = reject;
    });
    const handleAbort = () => rejectAborted(habitatError('HABITAT_SUMMON_FAILED'));
    signal.addEventListener('abort', handleAbort, { once: true });
    try {
      const result = await Promise.race([operation, aborted]);
      this.assertSummonOperation(epoch, signal);
      return result;
    } finally {
      signal.removeEventListener('abort', handleAbort);
    }
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

  private fail(code: HabitatErrorCode): HabitatServiceError {
    this.errorCode = code;
    return habitatError(code);
  }

  private mapError(error: unknown, fallback: HabitatErrorCode): HabitatServiceError {
    if (error instanceof HabitatServiceError) return error;
    if (error instanceof Error) {
      if (error.message === 'HABITAT_STORAGE_CHANGED') {
        return habitatError('HABITAT_STORAGE_CHANGED');
      }
      if (error.message === 'HABITAT_STORAGE_FAILED') {
        return habitatError('HABITAT_STORAGE_FAILED');
      }
    }
    return habitatError(fallback);
  }
}
