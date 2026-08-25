import { randomBytes } from 'node:crypto';
import type { VerifiedWriteAction } from '@myself/file-tools';
import { pendingActionSchema, type PendingAction } from '@myself/shared-types';
import type { VerifiedPowerShellAction } from './powershell-tool';

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

/** 私有执行票据与公开确认摘要分离，Renderer 永远不接触执行能力。 */
export type VerifiedCapabilityAction =
  | Readonly<{ category: 'file'; action: VerifiedWriteAction }>
  | Readonly<{ category: 'powershell'; action: VerifiedPowerShellAction }>;

export type PendingExecution = Readonly<{
  verifiedAction: VerifiedCapabilityAction;
  continuationToken: string;
  /** Main 私有真实工具名；edit_file 可复用 apply_patch 公开确认卡而不混淆回注事实。 */
  resultToolName: string;
  /** 多文件补丁只在 Main 内排队；每项仍由 PendingActionStore 单独签发和消费。 */
  remainingVerifiedActions?: readonly VerifiedCapabilityAction[];
  completedTargetRelativePaths?: readonly string[];
}>;

/** 对联合类型逐分支省略由存储层签发的字段，避免抹平动作专属摘要。 */
export type PendingActionDraft = PendingAction extends infer Action
  ? Action extends PendingAction
    ? Omit<Action, 'actionId' | 'createdAt' | 'expiresAt'>
    : never
  : never;

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

  issue(publicData: PendingActionDraft, privateExecution: PendingExecution): PendingAction {
    const now = this.now();
    const publicAction = pendingActionSchema.parse({
      ...publicData,
      actionId: randomBytes(24).toString('base64url'),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMilliseconds).toISOString()
    });
    const previous = this.current;
    this.current = { publicAction: { ...publicAction }, privateExecution };
    if (previous) this.onDiscard(previous.privateExecution, 'new_task');
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
