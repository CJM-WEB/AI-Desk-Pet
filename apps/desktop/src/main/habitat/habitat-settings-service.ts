import {
  habitatDashboardSchema,
  habitatErrorCodeSchema,
  type HabitatChooseResult,
  type HabitatDashboardDto,
  type HabitatPreferencesInput,
  type HabitatPublicErrorCode
} from '../../shared/habitat-ipc';
import type { HabitatServiceSnapshot } from './habitat-service';
import type {
  HabitatDirectoryAddResult,
  HabitatDirectoryAvailability,
  HabitatDirectoryRecord,
  HabitatDirectoryRemoveResult,
  HabitatDirectoryToggleResult,
  PetHabitatSnapshot
} from './pet-habitat-store';

interface HabitatSettingsStorePort {
  load(): Promise<PetHabitatSnapshot>;
  updatePreferences(preferences: PetHabitatSnapshot['preferences']): Promise<void>;
  addDirectory(directory: HabitatDirectoryRecord): Promise<HabitatDirectoryAddResult>;
  setDirectoryEnabled(
    directoryId: string,
    enabled: boolean
  ): Promise<HabitatDirectoryToggleResult>;
  removeDirectory(directoryId: string): Promise<HabitatDirectoryRemoveResult>;
}

interface HabitatSettingsDirectoryPolicyPort {
  authorize(
    selectedPath: string,
    existingDirectories: readonly HabitatDirectoryRecord[]
  ): Promise<HabitatDirectoryRecord>;
  availability(directory: HabitatDirectoryRecord): Promise<HabitatDirectoryAvailability>;
}

interface HabitatSettingsRuntimePort {
  snapshot(): HabitatServiceSnapshot;
  enterDirectory(directoryId: string, reason: 'manual'): Promise<unknown>;
  summon(): Promise<unknown>;
  recallToDesktop(): Promise<unknown>;
}

export interface HabitatSettingsServiceOptions {
  store: HabitatSettingsStorePort;
  directoryPolicy: HabitatSettingsDirectoryPolicyPort;
  habitat: HabitatSettingsRuntimePort;
  chooseDirectory(): Promise<string | null>;
}

export class HabitatSettingsError extends Error {
  constructor(readonly code: HabitatPublicErrorCode) {
    super(code);
    this.name = 'HabitatSettingsError';
  }
}

function stableError(error: unknown): HabitatSettingsError {
  if (error instanceof HabitatSettingsError) return error;
  const candidate = error && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : error instanceof Error
      ? error.message
      : null;
  const parsed = habitatErrorCodeSchema.safeParse(candidate);
  return new HabitatSettingsError(
    parsed.success ? parsed.data : 'HABITAT_OPERATION_FAILED'
  );
}

function busyReason(snapshot: HabitatServiceSnapshot): HabitatDashboardDto['busyReason'] {
  if (snapshot.operation === 'enter') return 'entering';
  if (snapshot.operation === 'summon') return 'summoning';
  if (snapshot.operation === 'recall') return 'recalling';
  if (snapshot.operation === 'availability') return 'checking-availability';
  return null;
}

/**
 * 设置页的唯一 Main 协调层：串行化配置写入与空间命令，并在边界处完成脱敏。
 */
export class HabitatSettingsService {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: HabitatSettingsServiceOptions) {}

  getDashboard(): Promise<HabitatDashboardDto> {
    return this.enqueue(() => this.buildDashboard());
  }

  chooseAndAddDirectory(): Promise<HabitatChooseResult> {
    return this.enqueue(async () => {
      let selectedPath: string | null;
      try {
        selectedPath = await this.options.chooseDirectory();
      } catch {
        throw new HabitatSettingsError('HABITAT_DIALOG_FAILED');
      }
      if (selectedPath === null) {
        return { kind: 'cancelled', dashboard: await this.buildDashboard() };
      }

      const snapshot = await this.options.store.load();
      const directory = await this.options.directoryPolicy.authorize(
        selectedPath,
        snapshot.directories
      );
      const result = await this.options.store.addDirectory(directory);
      if (result === 'duplicate') {
        throw new HabitatSettingsError('HABITAT_DIRECTORY_DUPLICATE');
      }
      if (result === 'conflict') {
        throw new HabitatSettingsError('HABITAT_DIRECTORY_IDENTITY_CONFLICT');
      }
      return { kind: 'added', dashboard: await this.buildDashboard() };
    });
  }

  setDirectoryEnabled(
    directoryId: string,
    enabled: boolean
  ): Promise<HabitatDashboardDto> {
    return this.enqueue(async () => {
      const result = await this.options.store.setDirectoryEnabled(directoryId, enabled);
      if (result === 'missing') {
        throw new HabitatSettingsError('HABITAT_DIRECTORY_NOT_FOUND');
      }
      return this.buildDashboard();
    });
  }

  removeDirectory(directoryId: string): Promise<HabitatDashboardDto> {
    return this.enqueue(async () => {
      const result = await this.options.store.removeDirectory(directoryId);
      if (result === 'missing') {
        throw new HabitatSettingsError('HABITAT_DIRECTORY_NOT_FOUND');
      }
      if (result === 'in-use') {
        throw new HabitatSettingsError('HABITAT_DIRECTORY_IN_USE');
      }
      return this.buildDashboard();
    });
  }

  savePreferences(input: HabitatPreferencesInput): Promise<HabitatDashboardDto> {
    return this.enqueue(async () => {
      await this.options.store.updatePreferences({ ...input });
      return this.buildDashboard();
    });
  }

  enterDirectory(directoryId: string): Promise<HabitatDashboardDto> {
    return this.enqueue(async () => {
      const snapshot = await this.options.store.load();
      if (snapshot.preferences.enabled !== true) {
        throw new HabitatSettingsError('HABITAT_DISABLED');
      }
      const directory = snapshot.directories.find(candidate => candidate.id === directoryId);
      if (!directory) throw new HabitatSettingsError('HABITAT_DIRECTORY_NOT_FOUND');
      if (!directory.enabled) throw new HabitatSettingsError('HABITAT_DIRECTORY_DISABLED');
      await this.options.habitat.enterDirectory(directoryId, 'manual');
      return this.buildDashboard();
    });
  }

  summon(): Promise<HabitatDashboardDto> {
    return this.enqueue(async () => {
      const snapshot = await this.options.store.load();
      if (snapshot.preferences.enabled !== true) {
        throw new HabitatSettingsError('HABITAT_DISABLED');
      }
      await this.options.habitat.summon();
      return this.buildDashboard();
    });
  }

  recall(): Promise<HabitatDashboardDto> {
    return this.enqueue(async () => {
      await this.options.habitat.recallToDesktop();
      return this.buildDashboard();
    });
  }

  private async buildDashboard(): Promise<HabitatDashboardDto> {
    const snapshot = await this.options.store.load();
    const runtime = this.options.habitat.snapshot();
    const availability = await Promise.all(snapshot.directories.map(async directory => (
      this.options.directoryPolicy.availability(directory)
    )));
    const directories = snapshot.directories.map((directory, index) => ({
      id: directory.id,
      displayName: directory.displayName,
      pathHint: directory.pathHint,
      enabled: directory.enabled,
      availability: availability[index] ?? 'unavailable' as const
    }));
    const current: HabitatDashboardDto['current'] = snapshot.location.kind === 'folder'
      ? {
          kind: 'folder',
          directoryId: snapshot.location.directoryId,
          visibility: runtime.state === 'folder-visible'
            ? 'visible'
            : runtime.state === 'folder-lost'
              ? 'lost'
              : 'hidden'
        }
      : { kind: 'desktop' };
    const error = habitatErrorCodeSchema.safeParse(runtime.errorCode);
    return habitatDashboardSchema.parse({
      enabled: snapshot.preferences.enabled ?? false,
      autoHideEnabled: snapshot.preferences.autoHideEnabled,
      idleDelayMs: snapshot.preferences.idleDelayMs,
      directories,
      current,
      busyReason: busyReason(runtime),
      errorCode: error.success ? error.data : null
    });
  }

  /** 拒绝并发穿插配置快照与状态机写入，失败后队列仍继续服务。 */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      try {
        return await operation();
      } catch (error) {
        throw stableError(error);
      }
    };
    const result = this.queue.then(run, run);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
