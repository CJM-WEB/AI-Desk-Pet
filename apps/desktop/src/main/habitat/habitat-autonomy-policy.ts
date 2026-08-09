import type { HabitatErrorCode } from './habitat-errors';
import type {
  PetHabitatSnapshot
} from './pet-habitat-store';

export interface HabitatAutonomyBlockers {
  taskActive: boolean;
  confirmationPending: boolean;
  chatInteracting: boolean;
  dragging: boolean;
  characterSwitching: boolean;
  foregroundFullscreen: boolean;
  appQuitting: boolean;
  bridgeDegraded: boolean;
}

export interface HabitatAutonomyInput {
  snapshot: PetHabitatSnapshot;
  proactivityMode: 'passive' | 'assistive' | 'autonomous';
  idle: boolean;
  habitatState: 'desktop' | 'folder-hidden' | 'folder-visible' | 'folder-lost';
  blockers: HabitatAutonomyBlockers;
}

export type HabitatAutonomyDecision =
  | { kind: 'entered'; directoryId: string }
  | { kind: 'failed'; code: HabitatErrorCode }
  | { kind: 'skipped'; reason: string };

export interface HabitatAutonomyPolicyOptions {
  enterDirectory(directoryId: string, reason: 'automatic'): Promise<unknown>;
  recallToDesktop(): Promise<unknown>;
  recordFailure(code: HabitatErrorCode): void;
  now(): number;
  random(): number;
  cooldownMs: number;
}

const HABITAT_ERROR_CODES = new Set<HabitatErrorCode>([
  'HABITAT_CLOSED',
  'HABITAT_OPERATION_BUSY',
  'HABITAT_STATE_INVALID',
  'HABITAT_ENTRY_BLOCKED',
  'HABITAT_AUTOMATION_BLOCKED',
  'HABITAT_DIRECTORY_NOT_FOUND',
  'HABITAT_DIRECTORY_UNAVAILABLE',
  'HABITAT_STORAGE_CHANGED',
  'HABITAT_STORAGE_FAILED',
  'HABITAT_OBSERVER_FAILED',
  'HABITAT_SUMMON_FAILED',
  'HABITAT_WINDOW_FAILED',
  'HABITAT_OPERATION_FAILED'
]);

function stableFailureCode(error: unknown): HabitatErrorCode {
  const candidate = error && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : error instanceof Error
      ? error.message
      : null;
  return typeof candidate === 'string' && HABITAT_ERROR_CODES.has(candidate as HabitatErrorCode)
    ? candidate as HabitatErrorCode
    : 'HABITAT_OPERATION_FAILED';
}

function hasStaticBlocker(blockers: HabitatAutonomyBlockers): boolean {
  return blockers.taskActive
    || blockers.confirmationPending
    || blockers.chatInteracting
    || blockers.dragging
    || blockers.characterSwitching
    || blockers.appQuitting
    || blockers.bridgeDegraded;
}

/**
 * 自动藏身只消费 Main 已有状态与配置，不读取目录内容，也不调用 Agent。
 */
export class HabitatAutonomyPolicy {
  private idleSince: number | null = null;
  private lastAttemptAt: number | null = null;
  private lastDirectoryId: string | null = null;
  private attemptInFlight = false;

  constructor(private readonly options: HabitatAutonomyPolicyOptions) {}

  async tick(
    input: HabitatAutonomyInput,
    sampleForegroundFullscreen?: () => Promise<boolean>
  ): Promise<HabitatAutonomyDecision> {
    if (!input.snapshot.preferences.enabled || !input.snapshot.preferences.autoHideEnabled) {
      this.idleSince = null;
      return { kind: 'skipped', reason: 'disabled' };
    }
    if (input.proactivityMode !== 'autonomous') {
      this.idleSince = null;
      return { kind: 'skipped', reason: 'proactivity-mode' };
    }
    if (input.habitatState !== 'desktop') {
      this.idleSince = null;
      return { kind: 'skipped', reason: 'not-desktop' };
    }
    const enabledDirectories = input.snapshot.directories.filter(directory => directory.enabled);
    if (enabledDirectories.length === 0) {
      this.idleSince = null;
      return { kind: 'skipped', reason: 'no-directory' };
    }
    if (!input.idle) {
      this.idleSince = null;
      return { kind: 'skipped', reason: 'not-idle' };
    }
    if (
      hasStaticBlocker(input.blockers)
      || (!sampleForegroundFullscreen && input.blockers.foregroundFullscreen)
    ) {
      this.idleSince = null;
      return { kind: 'skipped', reason: 'blocked' };
    }
    if (this.attemptInFlight) {
      return { kind: 'skipped', reason: 'busy' };
    }

    const now = this.options.now();
    if (this.idleSince === null) this.idleSince = now;
    if (now - this.idleSince < input.snapshot.preferences.idleDelayMs) {
      return { kind: 'skipped', reason: 'idle-delay' };
    }
    if (
      this.lastAttemptAt !== null
      && now - this.lastAttemptAt < this.options.cooldownMs
    ) {
      return { kind: 'skipped', reason: 'cooldown' };
    }

    const candidates = enabledDirectories.filter(directory => (
      directory.id !== this.lastDirectoryId
    ));
    if (candidates.length === 0) {
      return { kind: 'skipped', reason: 'same-directory' };
    }
    this.attemptInFlight = true;
    try {
      if (sampleForegroundFullscreen) {
        let foregroundFullscreen = true;
        try {
          foregroundFullscreen = await sampleForegroundFullscreen();
        } catch {
          // 平台探针失败时按前台全屏处理，不泄露私有错误。
        }
        if (foregroundFullscreen) {
          this.idleSince = null;
          return { kind: 'skipped', reason: 'blocked' };
        }
      }
      const sample = this.options.random();
      const random = Number.isFinite(sample)
        ? Math.min(Math.max(sample, 0), 1 - Number.EPSILON)
        : 0;
      const directory = candidates[Math.floor(random * candidates.length)]!;
      this.lastAttemptAt = now;
      this.lastDirectoryId = directory.id;
      this.idleSince = null;
      await this.options.enterDirectory(directory.id, 'automatic');
      return { kind: 'entered', directoryId: directory.id };
    } catch (error) {
      const code = stableFailureCode(error);
      try {
        await this.options.recallToDesktop();
      } catch {
        // 自动失败恢复不升级为新能力，也不记录私有依赖错误。
      }
      try {
        this.options.recordFailure(code);
      } catch {
        // 日志端口异常不能覆盖自动策略的稳定结果。
      }
      return { kind: 'failed', code };
    } finally {
      this.attemptInFlight = false;
    }
  }
}
