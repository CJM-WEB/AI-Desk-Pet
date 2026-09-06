import type { ModelMessage } from '@myself/agent-core';
import type { TaskEvent } from '@myself/shared-types';
import type {
  CodingTaskOutcome,
  CodingTaskSubmission,
  CodingTaskToolResult
} from '../agent/coding-task-service';
import type {
  CapabilityTaskKind,
  ConversationCapabilityTaskPort,
  PreparedCapabilityTarget
} from './conversation-coordinator';

export interface CapabilityTaskServicePort {
  submitFileTask(input: CodingTaskSubmission): Promise<CodingTaskOutcome>;
  cancelActive(): void | Promise<void>;
  confirm(actionId: string): Promise<void>;
  cancelAction(actionId: string): void | Promise<void>;
  resetForNewConversation(): Promise<void>;
  close(): void | Promise<void>;
}

export type PreparedCodingTaskTarget = PreparedCapabilityTarget & Readonly<{
  service: CapabilityTaskServicePort;
}>;

export interface CapabilityTaskAdapterOptions {
  getAuthorizedRootPath(taskKind: CapabilityTaskKind): Promise<string | null>;
  createCodingTaskTarget(input: {
    generation: string;
    taskKind: CapabilityTaskKind;
    emit: (event: TaskEvent) => void;
    emitTrustedToolResult: (result: CodingTaskToolResult) => void;
  }): PreparedCodingTaskTarget;
  /** 仅创建 Provider/授权根指纹，不得构造 CodingTaskService 或公告工具。 */
  createTargetSnapshot(input: {
    generation: string;
    taskKind: CapabilityTaskKind;
  }): PreparedCapabilityTarget;
}

type ActiveSubmission = {
  generation: string;
  taskKind: CapabilityTaskKind;
  owner: symbol;
  awaitingConfirmation: boolean;
  target: PreparedCapabilityTarget | null;
  submissionOwner: symbol | null;
};

type OwnedCodingTaskService = {
  service: CapabilityTaskServicePort;
  owner: symbol;
  generation: string;
  target: PreparedCapabilityTarget;
};

export class CapabilityTaskAdapter implements ConversationCapabilityTaskPort {
  private readonly listeners = new Set<(event: TaskEvent, generation: string) => void>();
  private readonly trustedResultListeners = new Set<(
    result: CodingTaskToolResult,
    generation: string,
    target: PreparedCapabilityTarget
  ) => void>();
  private active: ActiveSubmission | null = null;
  private inFlightOwner: symbol | null = null;
  private replyOwner: symbol | null = null;
  private cancelPromise: Promise<void> | null = null;
  private preparingOwner: symbol | null = null;
  private codingTask: OwnedCodingTaskService | null = null;
  private prepareCleanupPromise: Promise<void> | null = null;
  private resetPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private closed = false;

  constructor(private readonly options: CapabilityTaskAdapterOptions) {}

  onEvent(listener: (event: TaskEvent, generation: string) => void): () => void {
    if (this.closed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onTrustedToolResult(listener: (
    result: CodingTaskToolResult,
    generation: string,
    target: PreparedCapabilityTarget
  ) => void): () => void {
    if (this.closed) return () => undefined;
    this.trustedResultListeners.add(listener);
    return () => this.trustedResultListeners.delete(listener);
  }

  async prepareTarget(input: {
    generation: string;
    taskKind: CapabilityTaskKind;
  }): Promise<PreparedCapabilityTarget> {
    const target = await this.prepareSnapshotForSubmission(input);
    if (!this.codingTask) await this.activateTarget({ ...input, target });
    return this.codingTask?.target ?? target;
  }

  async prepareSnapshot(input: {
    generation: string;
    taskKind: CapabilityTaskKind;
  }): Promise<PreparedCapabilityTarget> {
    return this.prepareSnapshotForSubmission(input);
  }

  private async prepareSnapshotForSubmission(input: {
    generation: string;
    taskKind: CapabilityTaskKind;
  }): Promise<PreparedCapabilityTarget> {
    this.assertAvailable();
    if (this.active || this.inFlightOwner) throw adapterError('TASK_ALREADY_ACTIVE');

    const owner = Symbol('file-task-submission');
    this.inFlightOwner = owner;
    this.preparingOwner = owner;
    this.active = {
      generation: input.generation,
      taskKind: input.taskKind,
      owner,
      awaitingConfirmation: false,
      target: null,
      submissionOwner: null
    };
    try {
      const pendingCleanup = this.prepareCleanupPromise;
      if (pendingCleanup) {
        await pendingCleanup;
        this.assertOwned(owner);
      }
      const previousCodingTask = this.codingTask;
      if (previousCodingTask) {
        this.codingTask = null;
        const cleanup = this.resetOwnedCodingTaskService(previousCodingTask);
        this.prepareCleanupPromise = cleanup;
        await cleanup;
        // 只有确认清理成功才移除闸门；拒绝态须跨重试、reset 与 close 持续保留。
        if (this.prepareCleanupPromise === cleanup) this.prepareCleanupPromise = null;
        this.assertOwned(owner);
      }
      const authorizedRoot = await this.options.getAuthorizedRootPath(input.taskKind);
      this.assertOwned(owner);
      if (typeof authorizedRoot !== 'string' || authorizedRoot.trim().length === 0) {
        throw adapterError('FILE_AUTHORIZATION_REQUIRED');
      }
      const target = this.options.createTargetSnapshot(input);
      this.assertOwned(owner);
      this.active.target = target;
      return target;
    } catch (error) {
      if (this.active?.owner === owner) this.active = null;
      throw error;
    } finally {
      if (this.inFlightOwner === owner) this.inFlightOwner = null;
      if (this.preparingOwner === owner) this.preparingOwner = null;
    }
  }

  async activateTarget(input: {
    generation: string;
    taskKind: CapabilityTaskKind;
    target: PreparedCapabilityTarget;
  }): Promise<void> {
    const prepared = this.active;
    if (!prepared || prepared.generation !== input.generation
      || prepared.taskKind !== input.taskKind || prepared.target !== input.target) {
      throw adapterError('FILE_TARGET_NOT_PREPARED');
    }
    if (this.codingTask) throw adapterError('TASK_ALREADY_ACTIVE');
    const owned = this.createOwnedCodingTaskService(prepared.owner, input.generation, input.taskKind);
    if (!sameTarget(owned.target, input.target)) {
      await this.resetOwnedCodingTaskService(owned);
      if (this.codingTask === owned) this.codingTask = null;
      throw adapterError('FILE_TARGET_MISMATCH');
    }
    // 指纹复核后沿用已授权快照引用，让协调器与私有工具事实保持同一目标身份。
    owned.target = input.target;
    prepared.target = input.target;
  }

  async submit(input: {
    text: string;
    visibleHistory: readonly ModelMessage[];
    generation: string;
    taskKind: CapabilityTaskKind;
  }): Promise<CodingTaskOutcome> {
    this.assertAvailable();
    const prepared = this.active;
    if (
      !prepared
      || prepared.generation !== input.generation
      || prepared.taskKind !== input.taskKind
      || prepared.target === null
      || this.inFlightOwner
    ) {
      throw adapterError(prepared || this.inFlightOwner
        ? 'TASK_ALREADY_ACTIVE'
        : 'FILE_TARGET_NOT_PREPARED');
    }
    const owner = prepared.owner;
    this.inFlightOwner = owner;
    try {
      // 披露后再次读取授权；Provider 则固定使用 prepareTarget 已创建的同一 CodingTaskService。
      const authorizedRoot = await this.options.getAuthorizedRootPath(prepared.taskKind);
      this.assertOwned(owner);
      if (typeof authorizedRoot !== 'string' || authorizedRoot.trim().length === 0) {
        throw adapterError('FILE_AUTHORIZATION_REQUIRED');
      }

      const currentTarget = this.options.createTargetSnapshot({ generation: input.generation, taskKind: input.taskKind });
      if (!sameTarget(currentTarget, prepared.target)) throw adapterError('FILE_TARGET_MISMATCH');

      const ownedCodingTask = this.codingTask;
      if (!ownedCodingTask || ownedCodingTask.target !== prepared.target) {
        throw adapterError('FILE_TARGET_MISMATCH');
      }
      this.assertOwned(owner);
      const submissionOwner = Symbol('capability-task-submission');
      prepared.submissionOwner = submissionOwner;
      const submission: CodingTaskSubmission = {
        text: input.text,
        visibleHistory: input.visibleHistory,
        submissionOwner,
      };
      return await ownedCodingTask.service.submitFileTask(submission);
    } finally {
      if (this.inFlightOwner === owner) this.inFlightOwner = null;
      const active = this.active;
      if (active?.owner === owner && !active.awaitingConfirmation) {
        active.submissionOwner = null;
        this.active = null;
      }
    }
  }

  async cancelActive(): Promise<void> {
    if (this.cancelPromise) return this.cancelPromise;
    const active = this.active;
    if (!active) return;
    // 仅准备阶段尚未进入 CodingTaskService 不可逆执行，可立即撤销 owner 允许下一请求接管。
    if (this.preparingOwner === active.owner) {
      this.active = null;
      this.preparingOwner = null;
      if (this.inFlightOwner === active.owner) this.inFlightOwner = null;
      return;
    }
    // 取消请求本身不释放任务；宿主 run/close 的结算构成下一任务的进入屏障。
    const cancelling = Promise.resolve(this.codingTask?.service.cancelActive()).then(() => {
      if (this.active?.owner === active.owner) this.active = null;
    });
    this.cancelPromise = cancelling;
    await cancelling;
    if (this.cancelPromise === cancelling) this.cancelPromise = null;
  }

  async resolveAction(actionId: string, decision: 'confirm' | 'cancel'): Promise<void> {
    this.assertOpen();
    const active = this.active;
    const service = this.codingTask?.service;
    if (!active || !service) throw adapterError('ACTION_EXPIRED');
    if (this.replyOwner || this.cancelPromise) throw adapterError('TASK_ALREADY_ACTIVE');
    const owner = active.owner;
    // 每次决议先消费当前等待态；CodingTaskService 若在同一调用栈内发布下一张确认卡，
    // publishCodingTaskEvent 会重新置位，从而保留原任务 owner 与能力快照绑定。
    active.awaitingConfirmation = false;
    this.replyOwner = owner;
    try {
      if (decision === 'confirm') {
        await service.confirm(actionId);
      } else {
        await service.cancelAction(actionId);
      }
    } finally {
      if (this.replyOwner === owner) this.replyOwner = null;
      const retained = this.active;
      if (
        retained?.owner === owner
        && this.inFlightOwner !== owner
        && !retained.awaitingConfirmation
      ) {
        this.active = null;
      }
    }
  }

  async resetForNewConversation(): Promise<void> {
    if (this.resetPromise) return this.resetPromise;
    this.assertOpen();
    const owned = this.codingTask;
    this.active = null;
    this.inFlightOwner = null;
    this.preparingOwner = null;
    this.codingTask = null;
    const pendingPrepareCleanup = this.prepareCleanupPromise;
    const resetting = this.finishOwnedCodingTaskServiceCleanup(pendingPrepareCleanup, owned);
    this.resetPromise = resetting;
    try {
      await resetting;
      if (this.resetPromise === resetting) this.resetPromise = null;
    } catch (error) {
      // 清理失败时保留 resetting 闸门，禁止复用可能仍持有旧能力的 Adapter。
      throw error;
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.closed) return Promise.resolve();
    this.closed = true;
    const owned = this.codingTask;
    const pendingReset = this.resetPromise;
    const pendingPrepareCleanup = this.prepareCleanupPromise;
    this.active = null;
    this.inFlightOwner = null;
    this.preparingOwner = null;
    this.codingTask = null;
    this.listeners.clear();
    this.trustedResultListeners.clear();
    const closing = Promise.resolve().then(async () => {
      const failures: unknown[] = [];
      try {
        const pendingCleanup = pendingReset ?? pendingPrepareCleanup;
        if (pendingCleanup) await pendingCleanup;
      } catch (error) {
        failures.push(error);
      }
      try {
        await this.resetOwnedCodingTaskService(owned);
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) throw failures[0];
    });
    this.closePromise = closing;
    return closing;
  }

  private createOwnedCodingTaskService(
    submissionOwner: symbol,
    generation: string,
    taskKind: CapabilityTaskKind
  ): OwnedCodingTaskService {
    if (this.codingTask) throw adapterError('TASK_ALREADY_ACTIVE');
    const owner = Symbol('coding-task-service');
    const prepared = this.options.createCodingTaskTarget({
      generation,
      taskKind,
      emit: event => this.publishCodingTaskEvent(event, owner),
      emitTrustedToolResult: result => this.publishTrustedToolResult(result, owner)
    });
    const service = prepared?.service;
    try {
      if (
        !service
        || typeof prepared.profileId !== 'string'
        || prepared.profileId.length === 0
        || typeof prepared.providerIdentity !== 'string'
        || prepared.providerIdentity.length === 0
        || typeof prepared.providerName !== 'string'
        || prepared.providerName.length === 0
        || typeof prepared.capabilityRevision !== 'string'
        || prepared.capabilityRevision.length === 0
      ) {
        throw adapterError('FILE_TARGET_INVALID');
      }
      this.assertOwned(submissionOwner);
    } catch (error) {
      // 工厂同步重入已撤销所有权时，新实例只能尽力关闭，不能覆盖主状态错误。
      this.disposeDetachedService(service);
      throw error;
    }
    const target = Object.freeze({
      profileId: prepared.profileId,
      providerIdentity: prepared.providerIdentity,
      providerName: prepared.providerName,
      directory: prepared.directory,
      modelId: prepared.modelId,
      approvedCommands: prepared.approvedCommands,
      capabilityRevision: prepared.capabilityRevision
    });
    const owned = { service, owner, generation, target };
    this.codingTask = owned;
    return owned;
  }

  private disposeDetachedService(service: CapabilityTaskServicePort): void {
    for (const cleanup of [
      () => service.cancelActive(),
      () => service.close()
    ]) {
      try {
        void Promise.resolve(cleanup()).catch(() => undefined);
      } catch {
        // 未安装实例的清理失败不具备覆盖所有权错误的权限。
      }
    }
  }

  private publishCodingTaskEvent(event: TaskEvent, serviceOwner: symbol): void {
    const active = this.active;
    if (!active || this.closed || this.codingTask?.owner !== serviceOwner) return;

    for (const listener of [...this.listeners]) {
      listener(event, active.generation);
    }

    if (event.type === 'phase' && event.phase === 'awaiting_confirmation') {
      active.awaitingConfirmation = true;
      return;
    }
    if (
      event.type === 'phase'
      && (event.phase === 'success' || event.phase === 'error' || event.phase === 'cancelled')
      && this.active === active
    ) {
      this.active = null;
    }
  }

  private publishTrustedToolResult(result: CodingTaskToolResult, serviceOwner: symbol): void {
    const active = this.active;
    const owned = this.codingTask;
    if (!active || !owned || this.closed || owned.owner !== serviceOwner
      || active.target !== owned.target || active.submissionOwner === null
      || result.submissionOwner !== active.submissionOwner) return;
    for (const listener of [...this.trustedResultListeners]) {
      listener(result, active.generation, owned.target);
    }
  }

  private async resetOwnedCodingTaskService(owned: OwnedCodingTaskService | null): Promise<void> {
    if (!owned) return;

    let firstFailure: unknown;
    for (const cleanup of [
      () => owned.service.resetForNewConversation(),
      () => owned.service.close()
    ]) {
      try {
        await cleanup();
      } catch (error) {
        firstFailure ??= error;
      }
    }
    if (firstFailure !== undefined) throw firstFailure;
  }

  /** 生命周期先收敛已脱离字段的旧 CodingTaskService，再清理当前持有实例。 */
  private async finishOwnedCodingTaskServiceCleanup(
    pendingCleanup: Promise<void> | null,
    owned: OwnedCodingTaskService | null
  ): Promise<void> {
    let firstFailure: unknown;
    try {
      if (pendingCleanup) await pendingCleanup;
    } catch (error) {
      firstFailure = error;
    }
    try {
      await this.resetOwnedCodingTaskService(owned);
    } catch (error) {
      firstFailure ??= error;
    }
    if (firstFailure !== undefined) throw firstFailure;
  }

  private assertOpen(): void {
    if (this.closed) throw adapterError('CONVERSATION_CLOSED');
  }

  private assertAvailable(): void {
    this.assertOpen();
    if (this.resetPromise || this.cancelPromise || this.replyOwner) throw adapterError('TASK_ALREADY_ACTIVE');
  }

  private assertOwned(owner: symbol): void {
    this.assertOpen();
    if (this.active?.owner !== owner) throw adapterError('TASK_CANCELLED');
  }
}

function adapterError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function sameTarget(left: PreparedCapabilityTarget, right: PreparedCapabilityTarget): boolean {
  return left.profileId === right.profileId
    && left.providerIdentity === right.providerIdentity
    && left.providerName === right.providerName
    && left.capabilityRevision === right.capabilityRevision;
}
