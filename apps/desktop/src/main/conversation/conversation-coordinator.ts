import { randomUUID } from 'node:crypto';
import type { ModelMessage } from '@myself/agent-core';
import type {
  HistoryDisclosureDecision,
  TaskEvent
} from '@myself/shared-types';
import type { ConversationDisclosureAdapter } from './conversation-disclosure-adapter';
import type { ConversationHistory } from './conversation-history';
import type { ConversationTurnAdapter } from './conversation-turn-adapter';

const 最大用户消息字符数 = 4_000;

export interface ChatTurnFactory {
  create(signal: AbortSignal): Promise<{
    adapter: ConversationTurnAdapter;
    profileId: string;
    providerIdentity: string;
    providerName: string;
  }>;
}

export interface ConversationFileTaskPort {
  onEvent(listener: (event: TaskEvent, generation: string) => void): () => void;
  submit(input: {
    text: string;
    visibleHistory: readonly ModelMessage[];
    generation: string;
  }): Promise<void>;
  cancelActive(): void;
  resolveAction(actionId: string, decision: 'confirm' | 'cancel'): Promise<void>;
  resetForNewConversation(): Promise<void>;
}

export interface ConversationCoordinatorOptions {
  history: ConversationHistory;
  chatTurnFactory: ChatTurnFactory;
  disclosureAdapter: ConversationDisclosureAdapter;
  fileTasks: ConversationFileTaskPort;
  emit(event: TaskEvent): void;
  createId?: () => string;
}

type ConversationState =
  | { kind: 'idle' }
  | { kind: 'running_chat'; generation: string; controller: AbortController }
  | { kind: 'awaiting_history_disclosure'; generation: string; requestId: string }
  | { kind: 'running_file_task'; generation: string }
  | { kind: 'awaiting_file_confirmation'; generation: string }
  | { kind: 'resetting'; generation: string }
  | { kind: 'closed' };

interface ChatContext {
  text: string;
  generation: string;
  controller: AbortController;
}

interface PendingHistoryDisclosure extends ChatContext {
  requestId: string;
  adapter: ConversationTurnAdapter;
  profileId: string;
  providerIdentity: string;
  providerName: string;
}

export class ConversationCoordinator {
  private state: ConversationState = { kind: 'idle' };
  private readonly createId: () => string;
  private readonly generation: string;
  private readonly unsubscribeFileEvents: () => void;
  private pendingDisclosure: PendingHistoryDisclosure | null = null;

  constructor(private readonly options: ConversationCoordinatorOptions) {
    this.createId = options.createId ?? randomUUID;
    this.generation = this.createId();
    this.unsubscribeFileEvents = options.fileTasks.onEvent((event, generation) => {
      // 文件端口只携带内部代次；旧会话事件不得越过 Coordinator。
      if (this.state.kind !== 'closed' && generation === this.generation) {
        this.options.emit(event);
      }
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

    const context: ChatContext = {
      text: normalized,
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

      await this.runPlan(context, target.adapter, target.providerIdentity, disclosure.messages);
    } catch (error) {
      if (!this.ownsChatContext(context)) return;
      const normalizedError = publicError(error);
      this.pendingDisclosure = null;
      this.state = { kind: 'idle' };
      this.reportFailure(normalizedError);
      throw normalizedError;
    }
  }

  cancelActive(): void {
    if (this.state.kind === 'running_chat') {
      const controller = this.state.controller;
      const releasedState: ConversationState = { kind: 'idle' };
      this.state = releasedState;
      this.pendingDisclosure = null;
      controller.abort();
      if (this.state === releasedState) {
        this.options.emit({ type: 'phase', phase: 'cancelled' });
      }
      return;
    }
    if (this.state.kind === 'awaiting_history_disclosure') {
      const controller = this.pendingDisclosure?.controller;
      const releasedState: ConversationState = { kind: 'idle' };
      this.state = releasedState;
      this.pendingDisclosure = null;
      controller?.abort();
      if (this.state === releasedState) {
        this.options.emit({ type: 'phase', phase: 'cancelled' });
      }
      return;
    }
    if (
      this.state.kind === 'running_file_task'
      || this.state.kind === 'awaiting_file_confirmation'
    ) {
      const releasedState: ConversationState = { kind: 'idle' };
      this.state = releasedState;
      this.options.fileTasks.cancelActive();
      if (this.state === releasedState) {
        this.options.emit({ type: 'phase', phase: 'cancelled' });
      }
    }
  }

  async resolveFileAction(
    _actionId: string,
    _decision: 'confirm' | 'cancel'
  ): Promise<void> {
    return this.rejectNotReady('FILE_TASK_ROUTE_NOT_READY');
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

    this.state = {
      kind: 'running_chat',
      generation: pending.generation,
      controller: pending.controller
    };
    try {
      const visibleHistory = this.options.disclosureAdapter.resolve({
        requestId,
        targetProfileId: pending.profileId,
        decision
      });
      if (!this.isRunning(pending)) return;
      this.pendingDisclosure = null;
      await this.runPlan(
        pending,
        pending.adapter,
        pending.providerIdentity,
        visibleHistory
      );
    } catch (error) {
      if (!this.ownsChatContext(pending)) return;
      const normalizedError = publicError(error);
      this.pendingDisclosure = null;
      this.state = { kind: 'idle' };
      this.reportFailure(normalizedError);
      throw normalizedError;
    }
  }

  async resetConversation(): Promise<void> {
    return this.rejectNotReady('CONVERSATION_RESET_NOT_READY');
  }

  async close(): Promise<void> {
    if (this.state.kind === 'closed') return;
    const controller = this.state.kind === 'running_chat'
      ? this.state.controller
      : this.state.kind === 'awaiting_history_disclosure'
        ? this.pendingDisclosure?.controller
        : undefined;
    const cancelFileTask = this.state.kind === 'running_file_task'
      || this.state.kind === 'awaiting_file_confirmation';

    // 先封闭所有公开入口，再逐项尽力清理；任一清理失败都不得恢复旧状态。
    this.state = { kind: 'closed' };
    this.pendingDisclosure = null;
    const failures: unknown[] = [];
    for (const cleanup of [
      () => this.unsubscribeFileEvents(),
      () => controller?.abort(),
      () => {
        if (cancelFileTask) this.options.fileTasks.cancelActive();
      },
      () => this.options.disclosureAdapter.reset()
    ]) {
      try {
        cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw publicError(failures[0]);
  }

  /** 在可见文本写入历史前复核控制器与会话代次，隔离迟到模型响应。 */
  private async runPlan(
    context: ChatContext,
    adapter: ConversationTurnAdapter,
    providerIdentity: string,
    visibleHistory: readonly ModelMessage[]
  ): Promise<void> {
    if (!this.isRunning(context)) return;
    const plan = await adapter.plan({
      history: visibleHistory,
      text: context.text,
      signal: context.controller.signal
    });
    if (!this.isRunning(context)) return;
    if (plan.kind === 'file_task') {
      throw publicErrorForCode('FILE_TASK_ROUTE_NOT_READY');
    }

    const assistantText = plan.kind === 'chat_reply' ? plan.text : plan.question;
    this.options.history.append({
      userText: context.text,
      assistantText,
      providerIdentity
    });
    if (!this.isRunning(context)) return;
    this.options.emit({ type: 'message', role: 'assistant', text: assistantText });
    if (!this.isRunning(context)) return;
    if (plan.kind === 'chat_reply' && plan.emotion !== undefined) {
      this.options.emit({ type: 'character_emotion', label: plan.emotion });
      if (!this.isRunning(context)) return;
    }
    this.state = { kind: 'idle' };
    this.options.emit({ type: 'phase', phase: 'success' });
  }

  private isRunning(context: ChatContext): boolean {
    return this.state.kind === 'running_chat'
      && this.state.generation === context.generation
      && this.state.controller === context.controller
      && context.generation === this.generation;
  }

  private ownsChatContext(context: ChatContext): boolean {
    if (this.isRunning(context)) return true;
    return this.state.kind === 'awaiting_history_disclosure'
      && this.state.generation === context.generation
      && this.pendingDisclosure?.controller === context.controller;
  }

  private assertIdle(): void {
    if (this.state.kind === 'closed') throw publicErrorForCode('CONVERSATION_CLOSED');
    if (this.state.kind !== 'idle') throw publicErrorForCode('TASK_ALREADY_ACTIVE');
  }

  private async rejectNotReady(code: string): Promise<never> {
    throw publicErrorForCode(code);
  }

  private reportFailure(error: Error & { code: string }): void {
    const boundaryState = this.state;
    this.options.emit({
      type: 'error',
      code: error.code,
      message: error.message
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
    FILE_TASK_ROUTE_NOT_READY: '文件任务路由尚未接管。',
    CONVERSATION_RESET_NOT_READY: '新会话重置尚未接管。',
    PROVIDER_AUTHENTICATION_FAILED: '模型服务身份认证失败，请检查 API Key。',
    PROVIDER_ENDPOINT_NOT_FOUND: '模型服务地址不可用。',
    PROVIDER_RATE_LIMITED: '模型服务当前繁忙，请稍后重试。',
    PROVIDER_SERVER_ERROR: '模型服务发生错误，请稍后重试。',
    PROVIDER_TIMEOUT: '模型请求超时。',
    SETTINGS_INCOMPLETE: '请先完成模型服务设置。',
    AGENT_INTERNAL_ERROR: '任务执行失败，请重试。'
});

function publicError(error: unknown): Error & { code: string } {
  const candidate = error instanceof Error
    && 'code' in error
    && typeof error.code === 'string'
    ? error.code
    : 'AGENT_INTERNAL_ERROR';
  const code = Object.hasOwn(公开错误消息, candidate)
    ? candidate
    : 'AGENT_INTERNAL_ERROR';
  return publicErrorForCode(code);
}

function publicErrorForCode(code: string): Error & { code: string } {
  const normalizedCode = Object.hasOwn(公开错误消息, code)
    ? code
    : 'AGENT_INTERNAL_ERROR';
  return Object.assign(new Error(公开错误消息[normalizedCode]!), {
    code: normalizedCode
  });
}
