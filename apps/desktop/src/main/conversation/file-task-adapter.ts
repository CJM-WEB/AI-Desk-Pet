import type { ModelMessage } from '@myself/agent-core';
import type { TaskEvent } from '@myself/shared-types';
import type {
  AgentFileTaskSubmission,
  AgentService
} from '../agent/agent-service';
import type { FileTaskPlaybackTerminal } from '../agent/file-task-transaction-coordinator';
import type { ConversationFileTaskPort } from './conversation-coordinator';

export interface FileTaskAdapterOptions {
  getAuthorizedRootPath(): Promise<string | null>;
  createAgentService(emit: (event: TaskEvent) => void): AgentService;
}

type ActiveSubmission = {
  generation: string;
  owner: symbol;
  awaitingConfirmation: boolean;
};

type OwnedAgent = {
  service: AgentService;
  owner: symbol;
};

export class FileTaskAdapter implements ConversationFileTaskPort {
  private readonly listeners = new Set<(event: TaskEvent, generation: string) => void>();
  private active: ActiveSubmission | null = null;
  private inFlightOwner: symbol | null = null;
  private agent: OwnedAgent | null = null;
  private closed = false;

  constructor(private readonly options: FileTaskAdapterOptions) {}

  onEvent(listener: (event: TaskEvent, generation: string) => void): () => void {
    if (this.closed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async submit(input: {
    text: string;
    visibleHistory: readonly ModelMessage[];
    generation: string;
  }): Promise<void> {
    this.assertOpen();
    if (this.active || this.inFlightOwner) throw adapterError('TASK_ALREADY_ACTIVE');

    const owner = Symbol('file-task-submission');
    this.inFlightOwner = owner;
    this.active = {
      generation: input.generation,
      owner,
      awaitingConfirmation: false
    };
    try {
      const authorizedRoot = await this.options.getAuthorizedRootPath();
      this.assertOwned(owner);
      if (typeof authorizedRoot !== 'string' || authorizedRoot.trim().length === 0) {
        throw adapterError('FILE_AUTHORIZATION_REQUIRED');
      }

      const ownedAgent = this.getOrCreateAgent();
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
    try {
      if (decision === 'confirm') {
        await service.confirm(actionId);
      } else {
        service.cancelAction(actionId);
      }
    } finally {
      if (this.active?.owner === active.owner) this.active = null;
    }
  }

  async resetForNewConversation(): Promise<void> {
    this.releaseOwnedState();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.releaseOwnedState();
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

  private getOrCreateAgent(): OwnedAgent {
    if (this.agent) return this.agent;
    const owner = Symbol('file-task-agent');
    const service = this.options.createAgentService(event => {
      this.publishAgentEvent(event, owner);
    });
    const owned = { service, owner };
    this.agent = owned;
    return owned;
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

  private releaseOwnedState(): void {
    const owned = this.agent;
    this.active = null;
    this.inFlightOwner = null;
    this.agent = null;
    this.listeners.clear();
    if (!owned) return;

    let firstFailure: unknown;
    for (const cleanup of [
      () => owned.service.cancelActive(),
      () => owned.service.close()
    ]) {
      try {
        cleanup();
      } catch (error) {
        firstFailure ??= error;
      }
    }
    if (firstFailure !== undefined) throw firstFailure;
  }

  private assertOpen(): void {
    if (this.closed) throw adapterError('CONVERSATION_CLOSED');
  }

  private assertOwned(owner: symbol): void {
    this.assertOpen();
    if (this.active?.owner !== owner) throw adapterError('TASK_CANCELLED');
  }
}

function adapterError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
