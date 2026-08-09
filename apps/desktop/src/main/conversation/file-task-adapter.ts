import type { ModelMessage } from '@myself/agent-core';
import type { TaskEvent } from '@myself/shared-types';
import type { AgentFileTaskSubmission } from '../agent/agent-service';
import type { FileTaskPlaybackTerminal } from '../agent/file-task-transaction-coordinator';
import type {
  ConversationFileTaskPort,
  PreparedFileTaskTarget
} from './conversation-coordinator';

export interface FileTaskAgentPort {
  submitFileTask(input: AgentFileTaskSubmission): Promise<void>;
  cancelActive(): void;
  confirm(actionId: string): Promise<void>;
  cancelAction(actionId: string): void;
  resetForNewConversation(): Promise<void>;
  close(): void;
  onPlaybackStarted(playbackToken: string, actionId: string): boolean;
  onPlaybackTerminal(
    playbackToken: string,
    actionId: string,
    terminal: FileTaskPlaybackTerminal
  ): boolean;
  onCommitFrame(playbackToken: string, actionId: string, frameId: string): boolean;
  advanceFileTaskTransaction(): boolean;
  invalidateFileTaskPlaybackGrant(): boolean;
}

export type PreparedAgentTarget = PreparedFileTaskTarget & Readonly<{
  service: FileTaskAgentPort;
}>;

export interface FileTaskAdapterOptions {
  getAuthorizedRootPath(): Promise<string | null>;
  createAgentTarget(emit: (event: TaskEvent) => void): PreparedAgentTarget;
}

type ActiveSubmission = {
  generation: string;
  owner: symbol;
  awaitingConfirmation: boolean;
  target: PreparedFileTaskTarget | null;
};

type OwnedAgent = {
  service: FileTaskAgentPort;
  owner: symbol;
  target: PreparedFileTaskTarget;
};

export class FileTaskAdapter implements ConversationFileTaskPort {
  private readonly listeners = new Set<(event: TaskEvent, generation: string) => void>();
  private active: ActiveSubmission | null = null;
  private inFlightOwner: symbol | null = null;
  private agent: OwnedAgent | null = null;
  private resetPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private closed = false;

  constructor(private readonly options: FileTaskAdapterOptions) {}

  onEvent(listener: (event: TaskEvent, generation: string) => void): () => void {
    if (this.closed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prepareTarget(generation: string): Promise<PreparedFileTaskTarget> {
    this.assertAvailable();
    if (this.active || this.inFlightOwner) throw adapterError('TASK_ALREADY_ACTIVE');

    const owner = Symbol('file-task-submission');
    this.inFlightOwner = owner;
    this.active = {
      generation,
      owner,
      awaitingConfirmation: false,
      target: null
    };
    try {
      const previousAgent = this.agent;
      if (previousAgent) {
        this.agent = null;
        await this.resetOwnedAgent(previousAgent);
        this.assertOwned(owner);
      }
      const authorizedRoot = await this.options.getAuthorizedRootPath();
      this.assertOwned(owner);
      if (typeof authorizedRoot !== 'string' || authorizedRoot.trim().length === 0) {
        throw adapterError('FILE_AUTHORIZATION_REQUIRED');
      }
      const ownedAgent = this.createOwnedAgent(owner);
      this.assertOwned(owner);
      this.active.target = ownedAgent.target;
      return ownedAgent.target;
    } catch (error) {
      if (this.active?.owner === owner) this.active = null;
      throw error;
    } finally {
      if (this.inFlightOwner === owner) this.inFlightOwner = null;
    }
  }

  async submit(input: {
    text: string;
    visibleHistory: readonly ModelMessage[];
    generation: string;
  }): Promise<void> {
    this.assertAvailable();
    const prepared = this.active;
    if (
      !prepared
      || prepared.generation !== input.generation
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
      const authorizedRoot = await this.options.getAuthorizedRootPath();
      this.assertOwned(owner);
      if (typeof authorizedRoot !== 'string' || authorizedRoot.trim().length === 0) {
        throw adapterError('FILE_AUTHORIZATION_REQUIRED');
      }

      const ownedAgent = this.agent;
      if (!ownedAgent || ownedAgent.target !== prepared.target) {
        throw adapterError('FILE_TARGET_MISMATCH');
      }
      this.assertOwned(owner);
      const submission: AgentFileTaskSubmission = {
        text: input.text,
        visibleHistory: input.visibleHistory
      };
      await ownedAgent.service.submitFileTask(submission);
    } finally {
      if (this.inFlightOwner === owner) this.inFlightOwner = null;
      const active = this.active;
      if (active?.owner === owner && !active.awaitingConfirmation) {
        this.active = null;
      }
    }
  }

  cancelActive(): void {
    const active = this.active;
    if (!active) return;
    this.agent?.service.cancelActive();
    if (this.active?.owner === active.owner) this.active = null;
  }

  async resolveAction(actionId: string, decision: 'confirm' | 'cancel'): Promise<void> {
    this.assertOpen();
    const active = this.active;
    const service = this.agent?.service;
    if (!active || !service) throw adapterError('ACTION_EXPIRED');
    if (this.inFlightOwner) throw adapterError('TASK_ALREADY_ACTIVE');
    const owner = active.owner;
    this.inFlightOwner = owner;
    try {
      if (decision === 'confirm') {
        await service.confirm(actionId);
      } else {
        service.cancelAction(actionId);
      }
    } finally {
      if (this.inFlightOwner === owner) this.inFlightOwner = null;
      if (this.active?.owner === owner) this.active = null;
    }
  }

  async resetForNewConversation(): Promise<void> {
    if (this.resetPromise) return this.resetPromise;
    this.assertOpen();
    const owned = this.agent;
    this.active = null;
    this.inFlightOwner = null;
    this.agent = null;
    const resetting = this.resetOwnedAgent(owned);
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
    this.active = null;
    this.inFlightOwner = null;
    this.agent = null;
    this.listeners.clear();
    const closing = Promise.resolve().then(async () => {
      const failures: unknown[] = [];
      try {
        if (pendingReset) await pendingReset;
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

  onPlaybackStarted(playbackToken: string, actionId: string): boolean {
    return this.agent?.service.onPlaybackStarted(playbackToken, actionId) ?? false;
  }

  onPlaybackTerminal(
    playbackToken: string,
    actionId: string,
    terminal: FileTaskPlaybackTerminal
  ): boolean {
    return this.agent?.service.onPlaybackTerminal(playbackToken, actionId, terminal) ?? false;
  }

  onCommitFrame(playbackToken: string, actionId: string, frameId: string): boolean {
    return this.agent?.service.onCommitFrame(playbackToken, actionId, frameId) ?? false;
  }

  advanceFileTaskTransaction(): boolean {
    return this.agent?.service.advanceFileTaskTransaction() ?? false;
  }

  invalidateFileTaskPlaybackGrant(): boolean {
    return this.agent?.service.invalidateFileTaskPlaybackGrant() ?? false;
  }

  private createOwnedAgent(submissionOwner: symbol): OwnedAgent {
    if (this.agent) throw adapterError('TASK_ALREADY_ACTIVE');
    const owner = Symbol('file-task-agent');
    const prepared = this.options.createAgentTarget(event => {
      this.publishAgentEvent(event, owner);
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
      providerName: prepared.providerName
    });
    const owned = { service, owner, target };
    this.agent = owned;
    return owned;
  }

  private disposeDetachedService(service: FileTaskAgentPort): void {
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
