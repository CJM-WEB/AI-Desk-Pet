import { randomBytes } from 'node:crypto';
import type { VerifiedWriteAction } from '@myself/file-tools';
import type { PendingAction } from '@myself/shared-types';

export type PendingActionClearReason =
  | 'new_task'
  | 'action_cancelled'
  | 'expired'
  | 'root_changed'
  | 'provider_changed'
  | 'task_cancelled'
  | 'application_exit';

export interface PendingActionStoreOptions {
  now?: () => number;
  ttlMilliseconds?: number;
  onDiscard?: (execution: PendingExecution, reason: PendingActionClearReason) => void;
}

export type PendingExecution = {
  verifiedAction: VerifiedWriteAction;
  continuationToken: string;
};

type PendingActionPublicData = Omit<PendingAction, 'actionId' | 'createdAt' | 'expiresAt'>;

type StoredPendingAction = {
  publicAction: PendingAction;
  privateExecution: PendingExecution;
};

export class PendingActionStore {
  private current: StoredPendingAction | null = null;
  private readonly now: () => number;
  private readonly ttlMilliseconds: number;
  private readonly onDiscard: (
    execution: PendingExecution,
    reason: PendingActionClearReason
  ) => void;

  constructor(options: PendingActionStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMilliseconds = options.ttlMilliseconds ?? 120_000;
    this.onDiscard = options.onDiscard ?? (() => undefined);
  }

  issue(publicData: PendingActionPublicData, privateExecution: PendingExecution): PendingAction {
    if (this.current) this.onDiscard(this.current.privateExecution, 'new_task');
    const now = this.now();
    const publicAction: PendingAction = {
      ...publicData,
      actionId: randomBytes(24).toString('base64url'),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMilliseconds).toISOString()
    };
    this.current = { publicAction: { ...publicAction }, privateExecution };
    return { ...publicAction };
  }

  consume(actionId: string): PendingExecution {
    const item = this.current;
    if (!item || item.publicAction.actionId !== actionId) {
      throw new Error('ACTION_EXPIRED');
    }
    this.current = null;
    if (Date.parse(item.publicAction.expiresAt) <= this.now()) {
      this.onDiscard(item.privateExecution, 'expired');
      throw new Error('ACTION_EXPIRED');
    }
    return item.privateExecution;
  }

  cancel(actionId: string): void {
    if (!this.current || this.current.publicAction.actionId !== actionId) {
      throw new Error('ACTION_EXPIRED');
    }
    const item = this.current;
    this.current = null;
    this.onDiscard(item.privateExecution, 'action_cancelled');
  }

  clear(reason: PendingActionClearReason): void {
    const item = this.current;
    this.current = null;
    if (item) this.onDiscard(item.privateExecution, reason);
  }
}
