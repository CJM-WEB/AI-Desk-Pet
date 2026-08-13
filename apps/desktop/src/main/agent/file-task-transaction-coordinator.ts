import type { VerifiedWriteAction } from '@myself/file-tools';
import {
  characterPlaybackFeedbackSchema,
  safeIdentifierSchema
} from '@myself/character-runtime';

export type FileTaskPlaybackGrant = Readonly<{
  playbackToken: string;
  actionId: string;
  commitFrameId: string | null;
}>;

export type FileTaskPlaybackTerminal = 'completed' | 'interrupted' | 'failed' | 'cancelled';

export type FileTaskCancellationReason =
  | `playback_${FileTaskPlaybackTerminal}`
  | 'playback_start_timeout'
  | 'commit_timeout'
  | 'user_cancelled'
  | 'app_closed';

export type FileTaskResult = Readonly<
  | { status: 'succeeded' }
  | { status: 'failed'; reason: 'execution_failed' }
  | { status: 'cancelled'; reason: FileTaskCancellationReason }
>;

export type FileTaskTransactionState =
  | 'idle'
  | 'confirmed'
  | 'waiting-playback'
  | 'waiting-commit'
  | 'executing'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type FileTaskTransactionSnapshot = Readonly<{
  state: FileTaskTransactionState;
  result: FileTaskResult | null;
}>;

export interface FileTaskTransactionCoordinatorOptions {
  now?: () => number;
  playbackStartTimeoutMs?: number;
  commitTimeoutMs?: number;
  execute(action: VerifiedWriteAction): Promise<void>;
  reportResult(result: FileTaskResult): void;
}

type ConfirmedState = Readonly<{
  state: 'confirmed';
  action: VerifiedWriteAction;
  grant: FileTaskPlaybackGrant;
}>;

type WaitingPlaybackState = Readonly<{
  state: 'waiting-playback';
  action: VerifiedWriteAction;
  grant: FileTaskPlaybackGrant;
  deadlineAtMs: number;
}>;

type WaitingCommitState = Readonly<{
  state: 'waiting-commit';
  action: VerifiedWriteAction;
  grant: FileTaskPlaybackGrant & { commitFrameId: string };
  deadlineAtMs: number;
}>;

type ExecutingState = {
  state: 'executing';
  grant: FileTaskPlaybackGrant;
  playbackTerminal: FileTaskPlaybackTerminal | null;
};

type TerminalState = Readonly<{
  state: 'succeeded' | 'failed' | 'cancelled';
  result: FileTaskResult;
}>;

type TransactionState =
  | ConfirmedState
  | WaitingPlaybackState
  | WaitingCommitState
  | ExecutingState
  | TerminalState;

const DEFAULT_PLAYBACK_START_TIMEOUT_MS = 30_000;
const DEFAULT_COMMIT_TIMEOUT_MS = 30_000;
const fileTaskPlaybackGrantSchema = characterPlaybackFeedbackSchema
  .pick({ playbackToken: true, actionId: true })
  .extend({ commitFrameId: safeIdentifierSchema.nullable() })
  .strict();

function requirePositiveTimeout(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name}_INVALID`);
  }
  return value;
}

/**
 * Main 内的单事务提交闸门：私有写动作只有消费可信播放里程碑后才会执行。
 * 状态联合类型同时限定每一阶段可持有的数据，避免以分散布尔值推断提交权。
 */
export class FileTaskTransactionCoordinator {
  readonly #now: () => number;
  readonly #playbackStartTimeoutMs: number;
  readonly #commitTimeoutMs: number;
  readonly #execute: (action: VerifiedWriteAction) => Promise<void>;
  readonly #reportResult: (result: FileTaskResult) => void;
  #current: TransactionState | null = null;
  #closed = false;

  constructor(options: FileTaskTransactionCoordinatorOptions) {
    this.#now = options.now ?? Date.now;
    this.#playbackStartTimeoutMs = requirePositiveTimeout(
      options.playbackStartTimeoutMs ?? DEFAULT_PLAYBACK_START_TIMEOUT_MS,
      'PLAYBACK_START_TIMEOUT'
    );
    this.#commitTimeoutMs = requirePositiveTimeout(
      options.commitTimeoutMs ?? DEFAULT_COMMIT_TIMEOUT_MS,
      'COMMIT_TIMEOUT'
    );
    this.#execute = options.execute;
    this.#reportResult = options.reportResult;
  }

  begin(action: VerifiedWriteAction, grant: FileTaskPlaybackGrant): void {
    if (this.#closed) {
      throw new Error('COORDINATOR_CLOSED');
    }
    if (this.#isActive(this.#current)) {
      throw new Error('TRANSACTION_ACTIVE');
    }
    const parsedGrant = fileTaskPlaybackGrantSchema.safeParse(grant);
    if (!parsedGrant.success) {
      throw new Error('INVALID_PLAYBACK_GRANT');
    }
    const boundGrant: FileTaskPlaybackGrant = Object.freeze({ ...parsedGrant.data });

    // confirmed 是用户确认与播放授权已绑定的显式边界；随后原子进入等待播放。
    const confirmed: ConfirmedState = { state: 'confirmed', action, grant: boundGrant };
    this.#current = confirmed;
    this.#current = {
      state: 'waiting-playback',
      action: confirmed.action,
      grant: confirmed.grant,
      deadlineAtMs: this.#now() + this.#playbackStartTimeoutMs
    };
  }

  snapshot(): FileTaskTransactionSnapshot {
    const current = this.#current;
    if (!current) {
      return Object.freeze({ state: 'idle', result: null });
    }
    return Object.freeze({
      state: current.state,
      result: current.state === 'succeeded' || current.state === 'failed' || current.state === 'cancelled'
        ? current.result
        : null
    });
  }

  onPlaybackStarted(playbackToken: string, actionId: string): boolean {
    const current = this.#current;
    if (
      current?.state !== 'waiting-playback'
      || !this.#matchesGrant(current.grant, playbackToken, actionId)
    ) {
      return false;
    }

    if (current.grant.commitFrameId === null) {
      this.#commit(current.action, current.grant);
      return true;
    }

    this.#current = {
      state: 'waiting-commit',
      action: current.action,
      grant: {
        ...current.grant,
        commitFrameId: current.grant.commitFrameId
      },
      deadlineAtMs: this.#now() + this.#commitTimeoutMs
    };
    return true;
  }

  onCommitFrame(
    playbackToken: string,
    actionId: string,
    frameId: string
  ): boolean {
    const current = this.#current;
    if (
      current?.state !== 'waiting-commit'
      || !this.#matchesGrant(current.grant, playbackToken, actionId)
      || current.grant.commitFrameId !== frameId
    ) {
      return false;
    }

    this.#commit(current.action, current.grant);
    return true;
  }

  onPlaybackTerminal(
    playbackToken: string,
    actionId: string,
    terminal: FileTaskPlaybackTerminal
  ): boolean {
    const current = this.#current;
    if (
      !current
      || (current.state !== 'waiting-playback'
        && current.state !== 'waiting-commit'
        && current.state !== 'executing')
      || !this.#matchesGrant(current.grant, playbackToken, actionId)
    ) {
      return false;
    }

    if (current.state === 'executing') {
      if (current.playbackTerminal !== null) {
        return false;
      }
      current.playbackTerminal = terminal;
      return true;
    }

    this.#settle({ status: 'cancelled', reason: `playback_${terminal}` });
    return true;
  }

  advance(): boolean {
    const current = this.#current;
    if (!current || this.#now() < ('deadlineAtMs' in current ? current.deadlineAtMs : Infinity)) {
      return false;
    }
    if (current.state === 'waiting-playback') {
      this.#settle({ status: 'cancelled', reason: 'playback_start_timeout' });
      return true;
    }
    if (current.state === 'waiting-commit') {
      this.#settle({ status: 'cancelled', reason: 'commit_timeout' });
      return true;
    }
    return false;
  }

  cancel(reason: FileTaskCancellationReason = 'user_cancelled'): boolean {
    const current = this.#current;
    if (current?.state !== 'waiting-playback' && current?.state !== 'waiting-commit') {
      return false;
    }
    this.#settle({ status: 'cancelled', reason });
    return true;
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    const current = this.#current;
    if (current?.state === 'waiting-playback' || current?.state === 'waiting-commit') {
      this.#settle({ status: 'cancelled', reason: 'app_closed' });
    }
  }

  #commit(action: VerifiedWriteAction, grant: FileTaskPlaybackGrant): void {
    const executing: ExecutingState = {
      state: 'executing',
      grant,
      playbackTerminal: null
    };
    this.#current = executing;

    let execution: Promise<void>;
    try {
      execution = this.#execute(action);
    } catch {
      this.#settleExecution(executing, { status: 'failed', reason: 'execution_failed' });
      return;
    }
    void execution.then(
      () => this.#settleExecution(executing, { status: 'succeeded' }),
      () => this.#settleExecution(executing, { status: 'failed', reason: 'execution_failed' })
    );
  }

  #settleExecution(executing: ExecutingState, result: FileTaskResult): void {
    // 旧 Promise 不得覆盖后续事务；正常情况下单活动约束会让引用始终匹配。
    if (this.#current !== executing) {
      return;
    }
    this.#settle(result);
  }

  #settle(result: FileTaskResult): void {
    this.#current = {
      state: result.status,
      result: Object.freeze(result)
    };
    try {
      this.#reportResult(result);
    } catch {
      // 结果观察者不能反向改写已经发生的系统事实或重新执行文件动作。
    }
  }

  #matchesGrant(
    grant: FileTaskPlaybackGrant,
    playbackToken: string,
    actionId: string
  ): boolean {
    return grant.playbackToken === playbackToken && grant.actionId === actionId;
  }

  #isActive(state: TransactionState | null): boolean {
    return state?.state === 'confirmed'
      || state?.state === 'waiting-playback'
      || state?.state === 'waiting-commit'
      || state?.state === 'executing';
  }
}
