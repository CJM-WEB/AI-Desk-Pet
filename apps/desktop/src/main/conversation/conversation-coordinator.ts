import { randomUUID } from 'node:crypto';
import type { ModelMessage } from '@myself/agent-core';
import type {
  HistoryDisclosureDecision,
  TaskEvent
} from '@myself/shared-types';
import type { ConversationDisclosureAdapter } from './conversation-disclosure-adapter';
import type { ConversationHistory } from './conversation-history';
import type { ConversationChatAdapter } from './conversation-chat-adapter';
import type {
  ConversationBehaviorPort,
  ExplicitBehaviorDirective
} from '../characters/character-behavior-director';
import { capabilityIntentRouter } from './capability-intent-router';
import {
  isPublicFileTaskErrorCode,
  publicFileTaskErrorDetails
} from '../agent/file-task-public-errors';

const 最大用户消息字符数 = 4_000;

export interface ChatTurnFactory {
  create(signal: AbortSignal): Promise<{
    adapter: ConversationChatAdapter;
    profileId: string;
    providerIdentity: string;
    providerName: string;
  }>;
}

export type CapabilityTaskKind = 'file' | 'powershell';

export type PreparedCapabilityTarget = Readonly<{
  profileId: string;
  providerIdentity: string;
  providerName: string;
}>;

export interface ConversationCapabilityTaskPort {
  onEvent(listener: (event: TaskEvent, generation: string) => void): () => void;
  prepareTarget(input: {
    generation: string;
    taskKind: CapabilityTaskKind;
  }): Promise<PreparedCapabilityTarget>;
  submit(input: {
    text: string;
    visibleHistory: readonly ModelMessage[];
    generation: string;
    taskKind: CapabilityTaskKind;
  }): Promise<void>;
  cancelActive(): void;
  resolveAction(actionId: string, decision: 'confirm' | 'cancel'): Promise<void>;
  resetForNewConversation(): Promise<void>;
  close(): Promise<void>;
}

export interface ConversationCoordinatorOptions {
  history: ConversationHistory;
  chatTurnFactory: ChatTurnFactory;
  disclosureAdapter: ConversationDisclosureAdapter;
  capabilityTasks: ConversationCapabilityTaskPort;
  behavior: ConversationBehaviorPort;
  emit(event: TaskEvent): void;
  createId?: () => string;
}

type ConversationState =
  | { kind: 'idle' }
  | { kind: 'running_chat'; generation: string; controller: AbortController }
  | { kind: 'preparing_capability_task'; generation: string; controller: AbortController; taskKind: CapabilityTaskKind }
  | { kind: 'awaiting_history_disclosure'; generation: string; requestId: string }
  | { kind: 'running_capability_task'; generation: string; taskKind: CapabilityTaskKind }
  | { kind: 'awaiting_capability_confirmation'; generation: string; taskKind: CapabilityTaskKind }
  | { kind: 'resetting'; generation: string }
  | { kind: 'closed' };

interface TurnContext {
  text: string;
  capabilityText: string;
  explicitDirective: ExplicitBehaviorDirective | null;
  generation: string;
  controller: AbortController;
}

interface PendingChatDisclosure extends TurnContext {
  kind: 'chat_reply';
  requestId: string;
  adapter: ConversationChatAdapter;
  profileId: string;
  providerIdentity: string;
  providerName: string;
}

interface PendingCapabilityDisclosure extends TurnContext {
  kind: 'capability_task';
  requestId: string;
  taskKind: CapabilityTaskKind;
  target: PreparedCapabilityTarget;
}

type PendingHistoryDisclosure = PendingChatDisclosure | PendingCapabilityDisclosure;

interface ActiveCapabilityTurn {
  generation: string;
  text: string;
  taskKind: CapabilityTaskKind;
  target: PreparedCapabilityTarget;
  assistantText: string | null;
  terminalPhase: 'error' | 'cancelled' | null;
}

export class ConversationCoordinator {
  private state: ConversationState = { kind: 'idle' };
  private readonly createId: () => string;
  private generation: string;
  private readonly unsubscribeCapabilityEvents: () => void;
  private pendingDisclosure: PendingHistoryDisclosure | null = null;
  private activeCapabilityTurn: ActiveCapabilityTurn | null = null;
  private closePromise: Promise<void> | null = null;

  constructor(private readonly options: ConversationCoordinatorOptions) {
    this.createId = options.createId ?? randomUUID;
    this.generation = this.createId();
    this.options.behavior.reset(this.generation);
    this.unsubscribeCapabilityEvents = options.capabilityTasks.onEvent((event, generation) => {
      this.handleCapabilityEvent(event, generation);
    });
  }

  async submit(text: string): Promise<void> {
    try {
      this.assertIdle();
    } catch (error) {
      throw publicError(error);
    }

    let normalized: string;
    try {
      normalized = normalizeUserText(text);
    } catch (error) {
      const normalizedError = publicError(error);
      this.reportFailure(normalizedError);
      throw normalizedError;
    }

    const context: TurnContext = {
      text: normalized,
      capabilityText: normalized,
      explicitDirective: null,
      generation: this.generation,
      controller: new AbortController()
    };
    this.state = {
      kind: 'running_chat',
      generation: context.generation,
      controller: context.controller
    };
    try {
      this.options.emit({ type: 'message', role: 'user', text: normalized });
      if (!this.isRunning(context)) return;
      this.options.emit({ type: 'phase', phase: 'listening' });
      if (!this.isRunning(context)) return;
      this.options.emit({ type: 'phase', phase: 'thinking' });
      if (!this.isRunning(context)) return;

      const prepared = await this.options.behavior.prepareUserPrompt(normalized);
      if (!this.isRunning(context)) return;
      context.capabilityText = prepared.capabilityText;
      context.explicitDirective = prepared.explicitDirective;

      // Router 是唯一分流权威；能力任务在创建聊天 Provider 前处理。
      const intent = capabilityIntentRouter.route(context.capabilityText);
      if (intent.kind === 'file_task' || intent.kind === 'powershell_task') {
        if (intent.kind === 'powershell_task' && intent.evidence.requestedRunMode === 'background') {
          throw publicErrorForCode('POWERSHELL_BACKGROUND_UNSUPPORTED');
        }
        const taskKind: CapabilityTaskKind = intent.kind === 'file_task' ? 'file' : 'powershell';
        this.state = {
          kind: 'preparing_capability_task',
          generation: context.generation,
          controller: context.controller,
          taskKind
        };
        await this.prepareCapabilityTask(context, taskKind);
        return;
      }

      const target = await this.options.chatTurnFactory.create(context.controller.signal);
      if (!this.isRunning(context)) return;

      const requestId = this.createId();
      const disclosure = this.options.disclosureAdapter.prepare({
        requestId,
        targetProfileId: target.profileId,
        targetProviderIdentity: target.providerIdentity,
        targetProviderName: target.providerName,
        history: this.options.history
      });
      if (!this.isRunning(context)) return;
      if (disclosure.kind === 'confirmation_required') {
        this.pendingDisclosure = {
          kind: 'chat_reply',
          ...context,
          requestId,
          adapter: target.adapter,
          profileId: target.profileId,
          providerIdentity: target.providerIdentity,
          providerName: target.providerName
        };
        this.state = {
          kind: 'awaiting_history_disclosure',
          generation: context.generation,
          requestId
        };
        this.options.emit({
          type: 'history_disclosure_required',
          requestId: disclosure.requestId,
          targetProviderName: disclosure.targetProviderName,
          messageCount: disclosure.messageCount,
          characterCount: disclosure.characterCount
        });
        return;
      }

      await this.runChatReply(
        context,
        target.adapter,
        target.providerIdentity,
        disclosure.messages
      );
    } catch (error) {
      if (!this.ownsTurnContext(context)) {
        if (this.shouldRethrowReportedFileError(error, context)) throw publicError(error);
        return;
      }
      const normalizedError = publicError(error);
      this.pendingDisclosure = null;
      this.state = { kind: 'idle' };
      this.reportFailure(normalizedError);
      throw normalizedError;
    }
  }

  cancelActive(): void {
    if (
      this.state.kind === 'running_chat'
      || this.state.kind === 'preparing_capability_task'
    ) {
      const cancelCapabilityPreparation = this.state.kind === 'preparing_capability_task';
      const controller = this.state.controller;
      const releasedState: ConversationState = { kind: 'idle' };
      this.state = releasedState;
      this.pendingDisclosure = null;
      if (cancelCapabilityPreparation) this.options.capabilityTasks.cancelActive();
      controller.abort();
      if (this.state === releasedState) {
        this.options.emit({ type: 'phase', phase: 'cancelled' });
      }
      return;
    }
    if (this.state.kind === 'awaiting_history_disclosure') {
      const pending = this.pendingDisclosure;
      const controller = pending?.controller;
      const releasedState: ConversationState = { kind: 'idle' };
      this.state = releasedState;
      this.pendingDisclosure = null;
      if (pending?.kind === 'capability_task') this.options.capabilityTasks.cancelActive();
      controller?.abort();
      if (this.state === releasedState) {
        this.options.emit({ type: 'phase', phase: 'cancelled' });
      }
      return;
    }
    if (
      this.state.kind === 'running_capability_task'
      || this.state.kind === 'awaiting_capability_confirmation'
    ) {
      const releasedState: ConversationState = { kind: 'idle' };
      this.state = releasedState;
      this.options.capabilityTasks.cancelActive();
      if (this.state === releasedState) {
        this.options.emit({ type: 'phase', phase: 'cancelled' });
      }
    }
  }

  async resolveFileAction(
    actionId: string,
    decision: 'confirm' | 'cancel'
  ): Promise<void> {
    const active = this.activeCapabilityTurn;
    if (
      this.state.kind !== 'awaiting_capability_confirmation'
      || active === null
      || active.generation !== this.generation
    ) {
      throw publicErrorForCode('ACTION_EXPIRED');
    }
    this.state = {
      kind: 'running_capability_task',
      generation: active.generation,
      taskKind: active.taskKind
    };
    try {
      await this.options.capabilityTasks.resolveAction(actionId, decision);
    } catch (error) {
      const normalized = publicFileError(error);
      if (this.activeCapabilityTurn === active) {
        this.activeCapabilityTurn = null;
        this.state = { kind: 'idle' };
        this.reportFailure(normalized);
      }
      throw normalized;
    }
  }

  async resolveHistoryDisclosure(
    requestId: string,
    decision: HistoryDisclosureDecision
  ): Promise<void> {
    const pending = this.pendingDisclosure;
    if (
      this.state.kind !== 'awaiting_history_disclosure'
      || this.state.requestId !== requestId
      || pending === null
      || pending.requestId !== requestId
      || pending.generation !== this.generation
    ) {
      throw publicErrorForCode('DISCLOSURE_REQUEST_EXPIRED');
    }

    try {
      const visibleHistory = this.options.disclosureAdapter.resolve({
        requestId,
        targetProfileId: pending.kind === 'chat_reply'
          ? pending.profileId
          : pending.target.profileId,
        decision
      });
      if (!this.ownsPendingDisclosure(pending)) return;
      this.pendingDisclosure = null;
      if (pending.kind === 'chat_reply') {
        this.state = {
          kind: 'running_chat',
          generation: pending.generation,
          controller: pending.controller
        };
        await this.runChatReply(
          pending,
          pending.adapter,
          pending.providerIdentity,
          visibleHistory
        );
      } else {
        await this.submitCapabilityTask(pending, pending.taskKind, pending.target, visibleHistory);
      }
    } catch (error) {
      if (!this.ownsTurnContext(pending)) {
        if (this.shouldRethrowReportedFileError(error, pending)) throw publicError(error);
        return;
      }
      const normalizedError = publicError(error);
      this.pendingDisclosure = null;
      this.state = { kind: 'idle' };
      this.reportFailure(normalizedError);
      throw normalizedError;
    }
  }

  async resetConversation(): Promise<void> {
    if (this.state.kind === 'closed') throw publicErrorForCode('CONVERSATION_CLOSED');
    if (this.state.kind === 'resetting') throw publicErrorForCode('TASK_ALREADY_ACTIVE');

    const controller = this.state.kind === 'running_chat'
      || this.state.kind === 'preparing_capability_task'
      ? this.state.controller
      : this.state.kind === 'awaiting_history_disclosure'
        ? this.pendingDisclosure?.controller
        : undefined;
    const nextGeneration = this.createId();
    this.generation = nextGeneration;
    const resettingState: ConversationState = {
      kind: 'resetting',
      generation: nextGeneration
    };
    this.state = resettingState;
    this.pendingDisclosure = null;
    this.activeCapabilityTurn = null;

    const failures: unknown[] = [];
    try {
      controller?.abort();
    } catch (error) {
      failures.push(error);
    }
    try {
      this.options.disclosureAdapter.reset();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.options.capabilityTasks.resetForNewConversation();
    } catch (error) {
      failures.push(error);
    }
    try {
      this.options.behavior.reset(nextGeneration);
    } catch (error) {
      failures.push(error);
    }
    try {
      this.options.history.clear();
    } catch (error) {
      failures.push(error);
    }

    if (failures.length > 0) throw publicError(failures[0]);
    if (this.state !== resettingState) return;
    this.options.emit({ type: 'conversation_reset', generation: nextGeneration });
    if (this.state === resettingState) this.state = { kind: 'idle' };
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.state.kind === 'closed') return Promise.resolve();
    const controller = this.state.kind === 'running_chat'
      || this.state.kind === 'preparing_capability_task'
      ? this.state.controller
      : this.state.kind === 'awaiting_history_disclosure'
        ? this.pendingDisclosure?.controller
        : undefined;
    const cancelCapabilityTask = this.state.kind === 'running_capability_task'
      || this.state.kind === 'awaiting_capability_confirmation';

    // 先封闭所有公开入口，再逐项尽力清理；任一清理失败都不得恢复旧状态。
    this.state = { kind: 'closed' };
    this.pendingDisclosure = null;
    this.activeCapabilityTurn = null;
    const closing = Promise.resolve().then(async () => {
      const failures: unknown[] = [];
      for (const cleanup of [
        () => this.unsubscribeCapabilityEvents(),
        () => controller?.abort(),
        () => {
          if (cancelCapabilityTask) this.options.capabilityTasks.cancelActive();
        },
        () => this.options.disclosureAdapter.reset()
      ]) {
        try {
          cleanup();
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        await this.options.capabilityTasks.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await this.options.behavior.close();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) throw publicError(failures[0]);
    });
    this.closePromise = closing;
    return closing;
  }

  /** 在可见文本写入历史前复核控制器与会话代次，隔离迟到模型响应。 */
  private async runChatReply(
    context: TurnContext,
    adapter: ConversationChatAdapter,
    providerIdentity: string,
    visibleHistory: readonly ModelMessage[]
  ): Promise<void> {
    if (!this.isRunning(context)) return;
    const reply = await adapter.respond({
      history: visibleHistory,
      text: context.text,
      behaviorContext: this.options.behavior.getChatContext(),
      signal: context.controller.signal
    });
    if (!this.isRunning(context)) return;
    this.options.behavior.completeUserPrompt({
      generation: context.generation,
      explicitDirective: context.explicitDirective,
      providerPlan: reply.behaviorPlan ?? null
    });
    if (!this.isRunning(context)) return;
    this.options.emit({ type: 'message', role: 'assistant', text: reply.text });
    if (!this.isRunning(context)) return;
    if (reply.emotion !== undefined) {
      this.options.emit({ type: 'character_emotion', label: reply.emotion });
      if (!this.isRunning(context)) return;
    }
    this.options.history.append({
      userText: context.text,
      assistantText: reply.text,
      providerIdentity
    });
    if (!this.isRunning(context)) return;
    this.state = { kind: 'idle' };
    this.options.emit({ type: 'phase', phase: 'success' });
  }

  private isRunning(context: TurnContext): boolean {
    return (
      this.state.kind === 'running_chat'
      || this.state.kind === 'preparing_capability_task'
    )
      && this.state.generation === context.generation
      && this.state.controller === context.controller
      && context.generation === this.generation;
  }

  private ownsTurnContext(context: TurnContext): boolean {
    if (this.isRunning(context)) return true;
    return this.state.kind === 'awaiting_history_disclosure'
      && this.state.generation === context.generation
      && this.pendingDisclosure?.controller === context.controller;
  }

  private ownsPendingDisclosure(pending: PendingHistoryDisclosure): boolean {
    return this.state.kind === 'awaiting_history_disclosure'
      && this.state.requestId === pending.requestId
      && this.pendingDisclosure === pending
      && pending.generation === this.generation;
  }

  /** 能力目标在 Main 内先完成授权与 Provider 快照，再据此计算本轮历史披露。 */
  private async prepareCapabilityTask(
    context: TurnContext,
    taskKind: CapabilityTaskKind
  ): Promise<void> {
    let target: PreparedCapabilityTarget;
    try {
      target = await this.options.capabilityTasks.prepareTarget({
        generation: context.generation,
        taskKind
      });
    } catch (error) {
      throw publicFileError(error);
    }
    if (!this.isRunning(context)) return;
    const requestId = this.createId();
    const disclosure = this.options.disclosureAdapter.prepare({
      requestId,
      targetProfileId: target.profileId,
      targetProviderIdentity: target.providerIdentity,
      targetProviderName: target.providerName,
      history: this.options.history
    });
    if (!this.isRunning(context)) return;
    if (disclosure.kind === 'confirmation_required') {
      this.pendingDisclosure = {
        kind: 'capability_task',
        ...context,
        requestId,
        taskKind,
        target
      };
      this.state = {
        kind: 'awaiting_history_disclosure',
        generation: context.generation,
        requestId
      };
      this.options.emit({
        type: 'history_disclosure_required',
        requestId: disclosure.requestId,
        targetProviderName: disclosure.targetProviderName,
        messageCount: disclosure.messageCount,
        characterCount: disclosure.characterCount
      });
      return;
    }
    await this.submitCapabilityTask(context, taskKind, target, disclosure.messages);
  }

  private async submitCapabilityTask(
    context: TurnContext,
    taskKind: CapabilityTaskKind,
    target: PreparedCapabilityTarget,
    visibleHistory: readonly ModelMessage[]
  ): Promise<void> {
    if (context.generation !== this.generation) return;
    const active: ActiveCapabilityTurn = {
      generation: context.generation,
      text: context.text,
      taskKind,
      target,
      assistantText: null,
      terminalPhase: null
    };
    this.activeCapabilityTurn = active;
    this.state = { kind: 'running_capability_task', generation: context.generation, taskKind };
    try {
      await this.options.capabilityTasks.submit({
        text: context.capabilityText,
        visibleHistory,
        generation: context.generation,
        taskKind
      });
    } catch (error) {
      if (active.generation !== this.generation || this.isClosed()) return;
      const normalized = publicFileError(error);
      if (active.terminalPhase === 'error') throw reportedFileError(normalized);
      if (active.terminalPhase === 'cancelled' || this.activeCapabilityTurn !== active) return;
      this.activeCapabilityTurn = null;
      this.state = {
        kind: 'running_chat',
        generation: context.generation,
        controller: context.controller
      };
      throw normalized;
    }
  }

  /** 能力事件只能更新当前 generation；终态在公开前先完成 Main 历史与状态提交。 */
  private handleCapabilityEvent(event: TaskEvent, generation: string): void {
    if (this.state.kind === 'closed' || generation !== this.generation) return;
    const active = this.activeCapabilityTurn;
    if (active?.generation === generation) {
      if (event.type === 'message' && event.role === 'assistant') {
        active.assistantText = event.text;
      }
      if (
        event.type === 'pending_action'
        || (event.type === 'phase' && event.phase === 'awaiting_confirmation')
      ) {
        this.state = {
          kind: 'awaiting_capability_confirmation',
          generation,
          taskKind: active.taskKind
        };
      }
      if (event.type === 'phase' && event.phase === 'success') {
        if (active.assistantText !== null) {
          this.options.history.append({
            userText: active.text,
            assistantText: active.assistantText,
            providerIdentity: active.target.providerIdentity
          });
        }
        this.activeCapabilityTurn = null;
        this.state = { kind: 'idle' };
      }
      if (
        event.type === 'phase'
        && (event.phase === 'error' || event.phase === 'cancelled')
      ) {
        active.terminalPhase = event.phase;
        this.activeCapabilityTurn = null;
        this.state = { kind: 'idle' };
      }
    }
    this.options.emit(event);
  }

  private assertIdle(): void {
    if (this.state.kind === 'closed') throw publicErrorForCode('CONVERSATION_CLOSED');
    if (this.state.kind !== 'idle') throw publicErrorForCode('TASK_ALREADY_ACTIVE');
  }

  private isClosed(): boolean {
    return this.state.kind === 'closed';
  }

  private shouldRethrowReportedFileError(error: unknown, context: TurnContext): boolean {
    return isReportedFileError(error)
      && context.generation === this.generation
      && this.state.kind !== 'closed'
      && this.state.kind !== 'resetting';
  }

  private reportFailure(error: Error & { code: string; nextAction?: string }): void {
    const boundaryState = this.state;
    this.options.emit({
      type: 'error',
      code: error.code,
      message: error.message,
      ...(error.nextAction === undefined ? {} : { nextAction: error.nextAction })
    });
    if (this.state !== boundaryState) return;
    this.options.emit({ type: 'phase', phase: 'error' });
  }
}

function normalizeUserText(input: unknown): string {
  const normalized = typeof input === 'string' ? input.trim() : '';
  const characters = Array.from(normalized).length;
  if (characters < 1 || characters > 最大用户消息字符数) {
    throw publicErrorForCode('INPUT_INVALID');
  }
  return normalized;
}

const 公开错误消息: Readonly<Record<string, string>> = Object.freeze({
    INPUT_INVALID: '消息不能为空且不能超过 4000 个字符。',
    TASK_ALREADY_ACTIVE: '已有任务正在运行。',
    CONVERSATION_CLOSED: '当前会话已经关闭。',
    DISCLOSURE_REQUEST_EXPIRED: '历史披露确认已失效，请重新提交消息。',
    POWERSHELL_BACKGROUND_UNSUPPORTED: '暂不支持后台 PowerShell 任务，请改为前台执行。',
    PROVIDER_AUTHENTICATION_FAILED: '模型服务身份认证失败，请检查 API Key。',
    PROVIDER_ENDPOINT_NOT_FOUND: '模型服务地址不可用。',
    PROVIDER_RATE_LIMITED: '模型服务当前繁忙，请稍后重试。',
    PROVIDER_SERVER_ERROR: '模型服务发生错误，请稍后重试。',
    PROVIDER_TIMEOUT: '模型请求超时。',
    SETTINGS_INCOMPLETE: '请先完成模型服务设置。',
    AGENT_INTERNAL_ERROR: '任务执行失败，请重试。'
});

const 可信文件端口错误 = Symbol('trusted-file-task-error');
const 已公开文件错误 = Symbol('reported-file-task-error');

function publicError(error: unknown): Error & { code: string } {
  const candidate = error instanceof Error
    && 'code' in error
    && typeof error.code === 'string'
    ? error.code
    : 'AGENT_INTERNAL_ERROR';
  const trustedFileError = error instanceof Error
    && 可信文件端口错误 in error
    && error[可信文件端口错误] === true;
  const code = (Object.hasOwn(公开错误消息, candidate) || isPublicFileTaskErrorCode(candidate))
    && (!isPublicFileTaskErrorCode(candidate) || trustedFileError)
    ? candidate
    : 'AGENT_INTERNAL_ERROR';
  return publicErrorForCode(code);
}

function publicFileError(error: unknown): Error & { code: string } {
  const candidate = error instanceof Error
    && 'code' in error
    && typeof error.code === 'string'
    ? error.code
    : '';
  if (!isPublicFileTaskErrorCode(candidate)) return publicError(error);
  return Object.assign(publicErrorForCode(candidate), {
    [可信文件端口错误]: true as const
  });
}

function reportedFileError(error: Error & { code: string }): Error & { code: string } {
  return Object.assign(error, { [已公开文件错误]: true as const });
}

function isReportedFileError(error: unknown): boolean {
  return error instanceof Error
    && 已公开文件错误 in error
    && error[已公开文件错误] === true;
}

function publicErrorForCode(code: string): Error & { code: string; nextAction?: string } {
  const fileError = publicFileTaskErrorDetails(code);
  if (fileError !== null) return Object.assign(new Error(fileError.message), { code, ...fileError });
  const normalizedCode = Object.hasOwn(公开错误消息, code) ? code : 'AGENT_INTERNAL_ERROR';
  return Object.assign(new Error(公开错误消息[normalizedCode]!), { code: normalizedCode });
}
