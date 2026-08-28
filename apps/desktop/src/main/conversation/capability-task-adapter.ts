import type { FilePlanningHint, ModelMessage } from '@myself/agent-core';
import type { TaskEvent } from '@myself/shared-types';
import type {
  AgentFileTaskOutcome,
  AgentFileTaskSubmission,
  AgentTrustedToolResult
} from '../agent/agent-service';
import type {
  CapabilityTaskKind,
  ConversationCapabilityTaskPort,
  PreparedCapabilityTarget
} from './conversation-coordinator';

export interface CapabilityTaskAgentPort {
  submitFileTask(input: AgentFileTaskSubmission): Promise<AgentFileTaskOutcome>;
  cancelActive(): void;
  confirm(actionId: string): Promise<void>;
  cancelAction(actionId: string): void;
  resetForNewConversation(): Promise<void>;
  close(): void;
}

export type PreparedAgentTarget = PreparedCapabilityTarget & Readonly<{
  service: CapabilityTaskAgentPort;
}>;

export interface CapabilityTaskAdapterOptions {
  getAuthorizedRootPath(taskKind: CapabilityTaskKind): Promise<string | null>;
  createAgentTarget(input: {
    generation: string;
    taskKind: CapabilityTaskKind;
    emit: (event: TaskEvent) => void;
    emitTrustedToolResult: (result: AgentTrustedToolResult) => void;
  }): PreparedAgentTarget;
  /** 仅创建 Provider/授权根指纹，不得构造 Agent 或公告工具。 */
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

type OwnedAgent = {
  service: CapabilityTaskAgentPort;
  owner: symbol;
  generation: string;
  target: PreparedCapabilityTarget;
};

export class CapabilityTaskAdapter implements ConversationCapabilityTaskPort {
  private readonly listeners = new Set<(event: TaskEvent, generation: string) => void>();
  private readonly trustedResultListeners = new Set<(
    result: AgentTrustedToolResult,
    generation: string,
    target: PreparedCapabilityTarget
  ) => void>();
  private active: ActiveSubmission | null = null;
  private inFlightOwner: symbol | null = null;
  private preparingOwner: symbol | null = null;
  private agent: OwnedAgent | null = null;
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
    result: AgentTrustedToolResult,
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
    continuationTarget?: PreparedCapabilityTarget;
  }): Promise<PreparedCapabilityTarget> {
    const target = await this.prepareSnapshotForSubmission(input);
    if (!this.agent) await this.activateTarget({ ...input, target });
    return this.agent?.target ?? target;
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
    continuationTarget?: PreparedCapabilityTarget;
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
      const previousAgent = this.agent;
      if (previousAgent && input.continuationTarget !== undefined) {
        const authorizedRoot = await this.options.getAuthorizedRootPath(input.taskKind);
        this.assertOwned(owner);
        if (typeof authorizedRoot !== 'string' || authorizedRoot.trim().length === 0) {
          throw adapterError('FILE_AUTHORIZATION_REQUIRED');
        }
        const target = this.options.createTargetSnapshot(input);
        this.assertOwned(owner);
        if (previousAgent.generation === input.generation
          && sameTarget(previousAgent.target, input.continuationTarget)
          && sameTarget(previousAgent.target, target)) {
          this.active.target = previousAgent.target;
          return previousAgent.target;
        }
      }
      if (previousAgent) {
        this.agent = null;
        const cleanup = this.resetOwnedAgent(previousAgent);
        this.prepareCleanupPromise = cleanup;
        try {
          await cleanup;
        } finally {
          if (this.prepareCleanupPromise === cleanup) this.prepareCleanupPromise = null;
        }
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
    if (this.agent) throw adapterError('TASK_ALREADY_ACTIVE');
    const owned = this.createOwnedAgent(prepared.owner, input.generation, input.taskKind);
    if (!sameTarget(owned.target, input.target)) {
      await this.resetOwnedAgent(owned);
      if (this.agent === owned) this.agent = null;
      throw adapterError('FILE_TARGET_MISMATCH');
    }
    prepared.target = owned.target;
  }

  async submit(input: {
    text: string;
    visibleHistory: readonly ModelMessage[];
    generation: string;
    taskKind: CapabilityTaskKind;
    planningHint?: FilePlanningHint;
    privatePlanningContext?: string;
  }): Promise<AgentFileTaskOutcome> {
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
      // 披露后再次读取授权；Provider 则固定使用 prepareTarget 已创建的同一 Agent。
      const authorizedRoot = await this.options.getAuthorizedRootPath(prepared.taskKind);
      this.assertOwned(owner);
      if (typeof authorizedRoot !== 'string' || authorizedRoot.trim().length === 0) {
        throw adapterError('FILE_AUTHORIZATION_REQUIRED');
      }

      const ownedAgent = this.agent;
      if (!ownedAgent || ownedAgent.target !== prepared.target) {
        throw adapterError('FILE_TARGET_MISMATCH');
      }
      this.assertOwned(owner);
      const submissionOwner = Symbol('capability-task-submission');
      prepared.submissionOwner = submissionOwner;
      const submission: AgentFileTaskSubmission = {
        text: input.text,
        visibleHistory: input.visibleHistory,
        submissionOwner,
        ...(input.planningHint === undefined ? {} : { planningHint: input.planningHint }),
        ...(input.privatePlanningContext === undefined
          ? {}
          : { privatePlanningContext: input.privatePlanningContext })
      };
      return await ownedAgent.service.submitFileTask(submission);
    } finally {
      if (this.inFlightOwner === owner) this.inFlightOwner = null;
      const active = this.active;
      if (active?.owner === owner && !active.awaitingConfirmation) {
        active.submissionOwner = null;
        this.active = null;
      }
    }
  }

  cancelActive(): void {
    const active = this.active;
    if (!active) return;
    this.agent?.service.cancelActive();
    if (this.active?.owner === active.owner) this.active = null;
    // 仅准备阶段尚未进入 Agent 不可逆执行，可立即撤销 owner 允许下一请求接管。
    if (this.preparingOwner === active.owner) {
      this.preparingOwner = null;
      if (this.inFlightOwner === active.owner) this.inFlightOwner = null;
    }
  }

  async resolveAction(actionId: string, decision: 'confirm' | 'cancel'): Promise<void> {
    this.assertOpen();
    const active = this.active;
    const service = this.agent?.service;
    if (!active || !service) throw adapterError('ACTION_EXPIRED');
    if (this.inFlightOwner) throw adapterError('TASK_ALREADY_ACTIVE');
    const owner = active.owner;
    // 每次决议先消费当前等待态；Agent 若在同一调用栈内发布下一张确认卡，
    // publishAgentEvent 会重新置位，从而保留原任务 owner 与能力快照绑定。
    active.awaitingConfirmation = false;
    this.inFlightOwner = owner;
    try {
      if (decision === 'confirm') {
        await service.confirm(actionId);
      } else {
        service.cancelAction(actionId);
      }
    } finally {
      if (this.inFlightOwner === owner) this.inFlightOwner = null;
      const retained = this.active;
      if (
        retained?.owner === owner
        && (decision === 'cancel' || !retained.awaitingConfirmation)
      ) {
        this.active = null;
      }
    }
  }

  async resetForNewConversation(): Promise<void> {
    if (this.resetPromise) return this.resetPromise;
    this.assertOpen();
    const owned = this.agent;
    this.active = null;
    this.inFlightOwner = null;
    this.preparingOwner = null;
    this.agent = null;
    const pendingPrepareCleanup = this.prepareCleanupPromise;
    const resetting = this.finishOwnedAgentCleanup(pendingPrepareCleanup, owned);
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
    const owned = this.agent;
    const pendingReset = this.resetPromise;
    const pendingPrepareCleanup = this.prepareCleanupPromise;
    this.active = null;
    this.inFlightOwner = null;
    this.preparingOwner = null;
    this.agent = null;
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
        await this.resetOwnedAgent(owned);
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) throw failures[0];
    });
    this.closePromise = closing;
    return closing;
  }

  private createOwnedAgent(
    submissionOwner: symbol,
    generation: string,
    taskKind: CapabilityTaskKind
  ): OwnedAgent {
    if (this.agent) throw adapterError('TASK_ALREADY_ACTIVE');
    const owner = Symbol('file-task-agent');
    const prepared = this.options.createAgentTarget({
      generation,
      taskKind,
      emit: event => this.publishAgentEvent(event, owner),
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
      capabilityRevision: prepared.capabilityRevision
    });
    const owned = { service, owner, generation, target };
    this.agent = owned;
    return owned;
  }

  private disposeDetachedService(service: CapabilityTaskAgentPort): void {
    for (const cleanup of [
      () => service.cancelActive(),
      () => service.close()
    ]) {
      try {
        cleanup();
      } catch {
        // 未安装实例的清理失败不具备覆盖所有权错误的权限。
      }
    }
  }

  private publishAgentEvent(event: TaskEvent, agentOwner: symbol): void {
    const active = this.active;
    if (!active || this.closed || this.agent?.owner !== agentOwner) return;

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

  private publishTrustedToolResult(result: AgentTrustedToolResult, agentOwner: symbol): void {
    const active = this.active;
    const owned = this.agent;
    if (!active || !owned || this.closed || owned.owner !== agentOwner
      || active.target !== owned.target || active.submissionOwner === null
      || result.submissionOwner !== active.submissionOwner) return;
    for (const listener of [...this.trustedResultListeners]) {
      listener(result, active.generation, owned.target);
    }
  }

  private async resetOwnedAgent(owned: OwnedAgent | null): Promise<void> {
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

  /** 生命周期先收敛已脱离字段的旧 Agent，再清理当前持有实例。 */
  private async finishOwnedAgentCleanup(
    pendingCleanup: Promise<void> | null,
    owned: OwnedAgent | null
  ): Promise<void> {
    let firstFailure: unknown;
    try {
      if (pendingCleanup) await pendingCleanup;
    } catch (error) {
      firstFailure = error;
    }
    try {
      await this.resetOwnedAgent(owned);
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
    if (this.resetPromise) throw adapterError('TASK_ALREADY_ACTIVE');
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
