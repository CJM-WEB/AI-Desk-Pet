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

export type PreparedFileTaskTarget = Readonly<{
  profileId: string;
  providerIdentity: string;
  providerName: string;
}>;

export interface ConversationFileTaskPort {
  onEvent(listener: (event: TaskEvent, generation: string) => void): () => void;
  prepareTarget(generation: string): Promise<PreparedFileTaskTarget>;
  submit(input: {
    text: string;
    visibleHistory: readonly ModelMessage[];
    generation: string;
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

interface PendingChatDisclosure extends ChatContext {
  kind: 'chat_plan';
  requestId: string;
  adapter: ConversationTurnAdapter;
  profileId: string;
  providerIdentity: string;
  providerName: string;
}

interface PendingFileDisclosure extends ChatContext {
  kind: 'file_task';
  requestId: string;
  target: PreparedFileTaskTarget;
}

type PendingHistoryDisclosure = PendingChatDisclosure | PendingFileDisclosure;

interface ActiveFileTurn {
  generation: string;
  text: string;
  target: PreparedFileTaskTarget;
  assistantText: string | null;
  terminalPhase: 'error' | 'cancelled' | null;
}

export class ConversationCoordinator {
  private state: ConversationState = { kind: 'idle' };
  private readonly createId: () => string;
  private generation: string;
  private readonly unsubscribeFileEvents: () => void;
  private pendingDisclosure: PendingHistoryDisclosure | null = null;
  private activeFileTurn: ActiveFileTurn | null = null;
  private closePromise: Promise<void> | null = null;

  constructor(private readonly options: ConversationCoordinatorOptions) {
    this.createId = options.createId ?? randomUUID;
    this.generation = this.createId();
    this.unsubscribeFileEvents = options.fileTasks.onEvent((event, generation) => {
      this.handleFileEvent(event, generation);
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
          kind: 'chat_plan',
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
      if (!this.ownsChatContext(context)) {
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
      const pending = this.pendingDisclosure;
      const controller = pending?.controller;
      const releasedState: ConversationState = { kind: 'idle' };
      this.state = releasedState;
      this.pendingDisclosure = null;
      if (pending?.kind === 'file_task') this.options.fileTasks.cancelActive();
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
    actionId: string,
    decision: 'confirm' | 'cancel'
  ): Promise<void> {
    const active = this.activeFileTurn;
    if (
      this.state.kind !== 'awaiting_file_confirmation'
      || active === null
      || active.generation !== this.generation
    ) {
      throw publicErrorForCode('ACTION_EXPIRED');
    }
    this.state = { kind: 'running_file_task', generation: active.generation };
    try {
      await this.options.fileTasks.resolveAction(actionId, decision);
    } catch (error) {
      const normalized = publicFileError(error);
      if (this.activeFileTurn === active) {
        this.activeFileTurn = null;
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
        targetProfileId: pending.kind === 'chat_plan'
          ? pending.profileId
          : pending.target.profileId,
        decision
      });
      if (!this.ownsPendingDisclosure(pending)) return;
      this.pendingDisclosure = null;
      if (pending.kind === 'chat_plan') {
        this.state = {
          kind: 'running_chat',
          generation: pending.generation,
          controller: pending.controller
        };
        await this.runPlan(
          pending,
          pending.adapter,
          pending.providerIdentity,
          visibleHistory
        );
      } else {
        await this.submitFileTask(pending, pending.target, visibleHistory);
      }
    } catch (error) {
      if (!this.ownsChatContext(pending)) {
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
    this.activeFileTurn = null;

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
      await this.options.fileTasks.resetForNewConversation();
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
      ? this.state.controller
      : this.state.kind === 'awaiting_history_disclosure'
        ? this.pendingDisclosure?.controller
        : undefined;
    const cancelFileTask = this.state.kind === 'running_file_task'
      || this.state.kind === 'awaiting_file_confirmation';

    // 先封闭所有公开入口，再逐项尽力清理；任一清理失败都不得恢复旧状态。
    this.state = { kind: 'closed' };
    this.pendingDisclosure = null;
    this.activeFileTurn = null;
    const closing = Promise.resolve().then(async () => {
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
      try {
        await this.options.fileTasks.close();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) throw publicError(failures[0]);
    });
    this.closePromise = closing;
    return closing;
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
      await this.prepareFileTask(context);
      return;
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

  private ownsPendingDisclosure(pending: PendingHistoryDisclosure): boolean {
    return this.state.kind === 'awaiting_history_disclosure'
      && this.state.requestId === pending.requestId
      && this.pendingDisclosure === pending
      && pending.generation === this.generation;
  }

  /** 文件目标在 Main 内先完成授权与 Provider 快照，再据此计算本轮历史披露。 */
  private async prepareFileTask(context: ChatContext): Promise<void> {
    let target: PreparedFileTaskTarget;
    try {
      target = await this.options.fileTasks.prepareTarget(context.generation);
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
        kind: 'file_task',
        ...context,
        requestId,
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
    await this.submitFileTask(context, target, disclosure.messages);
  }

  private async submitFileTask(
    context: ChatContext,
    target: PreparedFileTaskTarget,
    visibleHistory: readonly ModelMessage[]
  ): Promise<void> {
    if (context.generation !== this.generation) return;
    const active: ActiveFileTurn = {
      generation: context.generation,
      text: context.text,
      target,
      assistantText: null,
      terminalPhase: null
    };
    this.activeFileTurn = active;
    this.state = { kind: 'running_file_task', generation: context.generation };
    try {
      await this.options.fileTasks.submit({
        text: context.text,
        visibleHistory,
        generation: context.generation
      });
    } catch (error) {
      if (active.generation !== this.generation || this.isClosed()) return;
      const normalized = publicFileError(error);
      if (active.terminalPhase === 'error') throw reportedFileError(normalized);
      if (active.terminalPhase === 'cancelled' || this.activeFileTurn !== active) return;
      this.activeFileTurn = null;
      this.state = {
        kind: 'running_chat',
        generation: context.generation,
        controller: context.controller
      };
      throw normalized;
    }
  }

  /** 文件事件只能更新当前 generation；终态在公开前先完成 Main 历史与状态提交。 */
  private handleFileEvent(event: TaskEvent, generation: string): void {
    if (this.state.kind === 'closed' || generation !== this.generation) return;
    const active = this.activeFileTurn;
    if (active?.generation === generation) {
      if (event.type === 'message' && event.role === 'assistant') {
        active.assistantText = event.text;
      }
      if (
        event.type === 'pending_action'
        || (event.type === 'phase' && event.phase === 'awaiting_confirmation')
      ) {
        this.state = { kind: 'awaiting_file_confirmation', generation };
      }
      if (event.type === 'phase' && event.phase === 'success') {
        if (active.assistantText !== null) {
          this.options.history.append({
            userText: active.text,
            assistantText: active.assistantText,
            providerIdentity: active.target.providerIdentity
          });
        }
        this.activeFileTurn = null;
        this.state = { kind: 'idle' };
      }
      if (
        event.type === 'phase'
        && (event.phase === 'error' || event.phase === 'cancelled')
      ) {
        active.terminalPhase = event.phase;
        this.activeFileTurn = null;
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

  private shouldRethrowReportedFileError(error: unknown, context: ChatContext): boolean {
    return isReportedFileError(error)
      && context.generation === this.generation
      && this.state.kind !== 'closed'
      && this.state.kind !== 'resetting';
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
    FILE_AUTHORIZATION_REQUIRED: '请先在设置中授权文件目录。',
    FILE_DISCLOSURE_DENIED: '文件数据类别未授权。',
    ACTION_EXPIRED: '待确认操作已经失效，请重新发起任务。',
    PATH_INVALID: '文件路径无效。',
    PATH_OUTSIDE_ROOT: '文件路径超出授权目录。',
    TARGET_EXISTS: '目标已经存在，未执行覆盖。',
    ENTRY_NOT_FOUND: '指定条目不存在。',
    PERMISSION_DENIED: 'Windows 拒绝了本地文件操作。',
    TOOL_PERMISSION_DENIED: '该工具操作未获本地权限策略允许。',
    FILE_TASK_USER_CANCELLED: '文件操作已取消。',
    FILE_TASK_PLAYBACK_UNAVAILABLE: '当前角色无法播放文件搬运动画。',
    FILE_TASK_PLAYBACK_CANCELLED: '搬运动画未完成，文件未被移动。',
    FILE_TASK_PLAYBACK_TIMEOUT: '等待搬运动画超时，文件未被移动。',
    FILE_TASK_EXECUTION_FAILED: '文件操作执行失败。',
    PROVIDER_AUTHENTICATION_FAILED: '模型服务身份认证失败，请检查 API Key。',
    PROVIDER_ENDPOINT_NOT_FOUND: '模型服务地址不可用。',
    PROVIDER_RATE_LIMITED: '模型服务当前繁忙，请稍后重试。',
    PROVIDER_SERVER_ERROR: '模型服务发生错误，请稍后重试。',
    PROVIDER_TIMEOUT: '模型请求超时。',
    SETTINGS_INCOMPLETE: '请先完成模型服务设置。',
    AGENT_INTERNAL_ERROR: '任务执行失败，请重试。'
});

const 文件端口公开错误代码 = new Set([
  'FILE_AUTHORIZATION_REQUIRED',
  'FILE_DISCLOSURE_DENIED',
  'ACTION_EXPIRED',
  'PATH_INVALID',
  'PATH_OUTSIDE_ROOT',
  'TARGET_EXISTS',
  'ENTRY_NOT_FOUND',
  'PERMISSION_DENIED',
  'TOOL_PERMISSION_DENIED',
  'FILE_TASK_USER_CANCELLED',
  'FILE_TASK_PLAYBACK_UNAVAILABLE',
  'FILE_TASK_PLAYBACK_CANCELLED',
  'FILE_TASK_PLAYBACK_TIMEOUT',
  'FILE_TASK_EXECUTION_FAILED'
]);
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
  const code = Object.hasOwn(公开错误消息, candidate)
    && (!文件端口公开错误代码.has(candidate) || trustedFileError)
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
  if (!文件端口公开错误代码.has(candidate)) return publicError(error);
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

function publicErrorForCode(code: string): Error & { code: string } {
  const normalizedCode = Object.hasOwn(公开错误消息, code)
    ? code
    : 'AGENT_INTERNAL_ERROR';
  return Object.assign(new Error(公开错误消息[normalizedCode]!), {
    code: normalizedCode
  });
}
