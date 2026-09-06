import { randomUUID } from 'node:crypto';
import type { ChatSubmissionIntent } from '../../shared/myself-api';
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
import type { CodingTaskOutcome, CodingTaskToolResult } from '../agent/coding-task-service';
import { capabilityIntentRouter } from './capability-intent-router';
import {
  isPublicFileTaskErrorCode,
  publicFileTaskErrorDetails
} from '../agent/file-task-public-errors';
import { ProviderResponseError } from '../providers/provider-response-error';

const 最大用户消息字符数 = 4_000;
const 任务级授权有效期毫秒 = 2 * 60 * 1_000;

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
  directory: string;
  modelId: string;
  approvedCommands: readonly string[];
  /** Main 内部能力快照指纹，绑定授权根与完整 Provider 设置。 */
  capabilityRevision: string;
}>;

export interface ConversationCapabilityTaskPort {
  onEvent(listener: (event: TaskEvent, generation: string) => void): () => void;
  onTrustedToolResult(listener: (
    result: CodingTaskToolResult,
    generation: string,
    target: PreparedCapabilityTarget
  ) => void): () => void;
  prepareTarget(input: {
    generation: string;
    taskKind: CapabilityTaskKind;
  }): Promise<PreparedCapabilityTarget>;
  prepareSnapshot(input: {
    generation: string;
    taskKind: CapabilityTaskKind;
  }): Promise<PreparedCapabilityTarget>;
  activateTarget(input: {
    generation: string;
    taskKind: CapabilityTaskKind;
    target: PreparedCapabilityTarget;
  }): Promise<void>;
  submit(input: {
    text: string;
    visibleHistory: readonly ModelMessage[];
    generation: string;
    taskKind: CapabilityTaskKind;
  }): Promise<CodingTaskOutcome>;
  cancelActive(): void | Promise<void>;
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
  | { kind: 'awaiting_capability_authorization'; generation: string; requestId: string }
  | { kind: 'resetting'; generation: string }
  | { kind: 'closed' };

interface TurnContext {
  explicitPlaybackToken?: string;
  text: string;
  capabilityText: string;
  explicitDirective: ExplicitBehaviorDirective | null;
  generation: string;
  controller: AbortController;
  modelEscalation?: 'allowed' | 'blocked';
}

type PendingCapabilityAuthorization = Readonly<{
  requestId: string;
  context: TurnContext;
  taskKind: CapabilityTaskKind;
  target: PreparedCapabilityTarget;
  visibleHistory: readonly ModelMessage[];
  expiresAtMs: number;
}>;

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
  terminalPhase: 'success' | 'error' | 'cancelled' | null;
  outcomeReady: boolean;
}

export class ConversationCoordinator {
  private assistantTurnSequence = 0;
  private state: ConversationState = { kind: 'idle' };
  private readonly createId: () => string;
  private generation: string;
  private readonly unsubscribeCapabilityEvents: () => void;
  private readonly unsubscribeTrustedToolResults: () => void;
  private resultSummary: { operations: number; lastExit?: number; phase: 'success' | 'error' | 'cancelled' | null } | null = null;
  private backgroundTask: Promise<void> | null = null;
  private pendingDisclosure: PendingHistoryDisclosure | null = null;
  private activeCapabilityTurn: ActiveCapabilityTurn | null = null;
  private pendingCapabilityAuthorization: PendingCapabilityAuthorization | null = null;
  private closePromise: Promise<void> | null = null;

  constructor(private readonly options: ConversationCoordinatorOptions) {
    this.createId = options.createId ?? randomUUID;
    this.generation = this.createId();
    this.options.behavior.reset(this.generation);
    this.unsubscribeCapabilityEvents = options.capabilityTasks.onEvent((event, generation) => {
      this.handleCapabilityEvent(event, generation);
    });
    this.unsubscribeTrustedToolResults = options.capabilityTasks.onTrustedToolResult(
      (result, generation, target) => this.handleTrustedToolResult(result, generation, target)
    );
  }

  async submit(text: string, submissionIntent: ChatSubmissionIntent = 'auto'): Promise<void> {
    if (submissionIntent === 'auto' && this.handleAwaitingConfirmationFollowUp(text)) return;
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

    if (submissionIntent === 'auto' && this.resultSummary !== null && this.resultSummary.phase !== null
      && /^(?:上一个任务|任务|上次任务)?(?:完成了吗|成功了吗|结束了吗)[？?。]?$/u.test(normalized)) {
      const summary = this.resultSummary;
      this.options.emit({ type: 'message', role: 'user', text: normalized });
      this.options.emit({ type: 'message', role: 'assistant', text: `上一个任务已结束，状态：${summary.phase === 'success' ? '运行结束' : summary.phase === 'error' ? '失败' : '已取消'}。收到 ${summary.operations} 项实际工具结果。${summary.lastExit === undefined ? '' : `最近命令退出码：${summary.lastExit}。`}` });
      this.options.emit({ type: 'phase', phase: 'success' });
      return;
    }
    if (capabilityIntentRouter.route(normalized).kind !== 'chat') this.resultSummary = null;

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

      // 明确入口保留原文，跳过角色改写和陪伴模型；授权仍由原范围流程裁决。
      if (submissionIntent === 'task') {
        const intent = capabilityIntentRouter.route(normalized);
        if (intent.kind === 'powershell_task' && intent.evidence.requestedRunMode === 'background') {
          throw publicErrorForCode('POWERSHELL_BACKGROUND_UNSUPPORTED');
        }
        this.state = {
          kind: 'preparing_capability_task',
          generation: context.generation,
          controller: context.controller,
          taskKind: 'file'
        };
        await this.prepareCapabilityTask(context, 'file');
        return;
      }

      const prepared = await this.options.behavior.prepareUserPrompt(normalized);
      if (!this.isRunning(context)) return;
      context.capabilityText = prepared.capabilityText;
      context.explicitDirective = prepared.explicitDirective;
      if (prepared.explicitPlaybackToken !== undefined) context.explicitPlaybackToken = prepared.explicitPlaybackToken;

      const intent = capabilityIntentRouter.route(context.capabilityText);
      if (intent.kind === 'chat') context.modelEscalation = intent.modelEscalation;
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

  async cancelActive(): Promise<void> {
    if (this.state.kind !== 'idle' && this.state.kind !== 'resetting' && this.state.kind !== 'closed') {
      this.options.behavior.cancelActive();
    }
    if (this.state.kind === 'awaiting_capability_authorization') {
      this.pendingCapabilityAuthorization = null;
      await this.options.capabilityTasks.cancelActive();
      this.state = { kind: 'idle' };
      this.options.emit({ type: 'phase', phase: 'cancelled' });
      return;
    }
    if (
      this.state.kind === 'running_chat'
      || this.state.kind === 'preparing_capability_task'
    ) {
      const cancelCapabilityPreparation = this.state.kind === 'preparing_capability_task';
      const controller = this.state.controller;
      const releasedState: ConversationState = { kind: 'idle' };
      this.state = releasedState;
      this.pendingDisclosure = null;
      if (cancelCapabilityPreparation) await this.options.capabilityTasks.cancelActive();
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
      if (pending?.kind === 'capability_task') await this.options.capabilityTasks.cancelActive();
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
      await this.options.capabilityTasks.cancelActive();
    }
  }

  async resolveCapabilityAuthorization(
    requestId: string,
    decision: 'confirm' | 'cancel'
  ): Promise<void> {
    const pending = this.pendingCapabilityAuthorization;
    if (this.state.kind !== 'awaiting_capability_authorization'
      || pending === null || pending.requestId !== requestId
      || pending.context.generation !== this.generation) {
      throw publicErrorForCode('ACTION_EXPIRED');
    }
    this.pendingCapabilityAuthorization = null;
    if (Date.now() >= pending.expiresAtMs) {
      await this.options.capabilityTasks.cancelActive();
      this.state = { kind: 'idle' };
      const expired = publicErrorForCode('ACTION_EXPIRED');
      this.reportFailure(expired);
      throw expired;
    }
    if (decision === 'cancel') {
      await this.options.capabilityTasks.cancelActive();
      this.options.emit({
        type: 'message', role: 'assistant', text: '已取消进入本地任务，未执行任何操作。'
      });
      this.state = { kind: 'idle' };
      this.options.emit({ type: 'phase', phase: 'cancelled' });
      return;
    }
    this.state = {
      kind: 'preparing_capability_task',
      generation: pending.context.generation,
      controller: pending.context.controller,
      taskKind: pending.taskKind
    };
    try {
      await this.options.capabilityTasks.activateTarget({
        generation: pending.context.generation,
        taskKind: pending.taskKind,
        target: pending.target
      });
      const running = this.submitCapabilityTask(pending.context, pending.taskKind, pending.target, pending.visibleHistory);
      this.backgroundTask = running;
      void running.then(() => { if (this.backgroundTask === running) this.backgroundTask = null; }, () => { if (this.backgroundTask === running) this.backgroundTask = null; });
    } catch (error) {
      const normalized = publicFileError(error);
      await this.options.capabilityTasks.cancelActive();
      this.state = { kind: 'idle' };
      this.reportFailure(normalized);
      throw normalized;
    }
  }

  async resolveFileAction(
    actionId: string,
    decision: 'confirm' | 'cancel'
  ): Promise<void> {
    const active = this.activeCapabilityTurn;
    if (
      (this.state.kind !== 'awaiting_capability_confirmation' && this.state.kind !== 'running_capability_task')
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
        this.state = { kind: 'awaiting_capability_confirmation', generation: active.generation, taskKind: active.taskKind };
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
        this.requestCapabilityScope(pending, pending.taskKind, pending.target, visibleHistory);
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
    this.pendingCapabilityAuthorization = null;
    this.resultSummary = null;

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
    this.pendingCapabilityAuthorization = null;
    this.resultSummary = null;
    const closing = Promise.resolve().then(async () => {
      const failures: unknown[] = [];
      for (const cleanup of [
        () => this.unsubscribeCapabilityEvents(),
        () => this.unsubscribeTrustedToolResults(),
        () => controller?.abort(),
        async () => {
          if (cancelCapabilityTask) await this.options.capabilityTasks.cancelActive();
        },
        () => this.options.disclosureAdapter.reset()
      ]) {
        try {
          await cleanup();
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
    const turnId = `assistant-${++this.assistantTurnSequence}`;
    const bufferedDeltas: string[] = [];
    // 同步捕获公开快照和宿主标记；后者绝不进入模型请求或 Renderer。
    const expressionContext = this.options.behavior.captureExpressionContext();
    const behaviorContext = this.options.behavior.getChatContext();
    const reply = await adapter.respond({
      history: visibleHistory,
      text: context.text,
      behaviorContext,
      explicitPlaybackRequested: context.explicitDirective?.kind === 'play' && context.explicitPlaybackToken === undefined,
      signal: context.controller.signal,
      onTextDelta: delta => {
        if (delta.length === 0 || !this.isRunning(context)) return;
        bufferedDeltas.push(delta);
      }
    });
    if (!this.isRunning(context)) return;
    if (context.modelEscalation === 'allowed' && reply.capabilityPlan?.kind === 'agent_task') {
      await this.prepareModelCapabilityAuthorization(context, reply);
      return;
    }
    // 能力计划判定前的正文只保存在 Main；普通聊天确认后才允许提交给 Renderer。
    const streamStarted = bufferedDeltas.length > 0;
    if (streamStarted) {
      this.options.emit({ type: 'assistant_message_start', turnId });
      for (const delta of bufferedDeltas) {
        if (!this.isRunning(context)) return;
        this.options.emit({ type: 'assistant_message_delta', turnId, delta });
      }
    }
    await this.options.behavior.completeUserPrompt({
      generation: context.generation,
      context: expressionContext,
      eventId: turnId,
      explicitDirective: context.explicitDirective,
      movementControl: reply.movementControl ?? null,
      ...(context.explicitPlaybackToken === undefined ? {} : { explicitPlaybackToken: context.explicitPlaybackToken }),
      ...(reply.moodUpdate === undefined ? {} : { moodUpdate: reply.moodUpdate }),
      ...(reply.expressionPlan === undefined ? {} : { expressionPlan: reply.expressionPlan }),
      ...(reply.explicitPlayback === undefined ? {} : { explicitPlayback: reply.explicitPlayback })
    });
    if (!this.isRunning(context)) return;
    this.options.emit(streamStarted
      ? { type: 'assistant_message_commit', turnId, text: reply.text }
      : { type: 'message', role: 'assistant', text: reply.text });
    if (!this.isRunning(context)) return;
    this.options.history.append({
      userText: context.text,
      assistantText: reply.text,
      providerIdentity
    });
    if (!this.isRunning(context)) return;
    this.options.behavior.handleChatResponseFinished();
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

  /** 所有本地任务先固定目标、完成历史披露，再等待任务范围确认。 */
  private async prepareCapabilityTask(context: TurnContext, taskKind: CapabilityTaskKind): Promise<void> {
    let target: PreparedCapabilityTarget;
    try { target = await this.options.capabilityTasks.prepareSnapshot({ generation: context.generation, taskKind }); }
    catch (error) { throw publicFileError(error); }
    if (!this.isRunning(context)) return;
    await this.continuePreparedCapabilityTask(context, taskKind, target);
  }

  private async prepareModelCapabilityAuthorization(context: TurnContext, _reply: Awaited<ReturnType<ConversationChatAdapter['respond']>>): Promise<void> {
    await this.prepareCapabilityTask(context, 'file');
  }

  private requestCapabilityScope(context: TurnContext, taskKind: CapabilityTaskKind, target: PreparedCapabilityTarget, visibleHistory: readonly ModelMessage[]): void {
    this.resultSummary = null;
    const requestId = this.createId();
    const expiresAtMs = Date.now() + 任务级授权有效期毫秒;
    this.pendingCapabilityAuthorization = { requestId, context, taskKind, target, visibleHistory, expiresAtMs };
    this.state = { kind: 'awaiting_capability_authorization', generation: context.generation, requestId };
    this.options.emit({ type: 'capability_authorization_required', requestId, capability: taskKind,
      requestSummary: summarizeCapabilityRequest(context.text), targetProviderName: target.providerName,
      directory: target.directory, modelId: target.modelId, actions: ['read', 'create', 'edit'], approvedCommands: [...target.approvedCommands],
      expiresAt: new Date(expiresAtMs).toISOString() });
  }

  private async continuePreparedCapabilityTask(
    context: TurnContext,
    taskKind: CapabilityTaskKind,
    target: PreparedCapabilityTarget
  ): Promise<void> {
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
      this.pendingDisclosure = { kind: 'capability_task', ...context, requestId, taskKind, target };
      this.state = { kind: 'awaiting_history_disclosure', generation: context.generation, requestId };
      this.options.emit({
        type: 'history_disclosure_required',
        requestId: disclosure.requestId,
        targetProviderName: disclosure.targetProviderName,
        messageCount: disclosure.messageCount,
        characterCount: disclosure.characterCount
      });
      return;
    }
    this.requestCapabilityScope(context, taskKind, target, disclosure.messages);
  }

  private async submitCapabilityTask(
    context: TurnContext,
    taskKind: CapabilityTaskKind,
    target: PreparedCapabilityTarget,
    visibleHistory: readonly ModelMessage[]
  ): Promise<void> {
    if (context.generation !== this.generation) return;
    this.resultSummary = { operations: 0, phase: null };
    const active: ActiveCapabilityTurn = {
      generation: context.generation,
      text: context.text,
      taskKind,
      target,
      assistantText: null,
      terminalPhase: null,
      outcomeReady: false
    };
    this.activeCapabilityTurn = active;
    this.state = { kind: 'running_capability_task', generation: context.generation, taskKind };
    try {
      await this.options.capabilityTasks.submit({ text: context.capabilityText, visibleHistory, generation: context.generation, taskKind });
      active.outcomeReady = true;
      if (active.terminalPhase !== null && this.activeCapabilityTurn === active) {
        this.activeCapabilityTurn = null;
        this.state = { kind: 'idle' };
        this.options.emit({ type: 'phase', phase: active.terminalPhase });
      }
    } catch (error) {
      if (active.generation !== this.generation || this.isClosed()) return;
      const normalized = publicFileError(error);
      if (active.terminalPhase !== null || this.activeCapabilityTurn !== active) return;
      this.activeCapabilityTurn = null;
      this.state = { kind: 'idle' };
      this.reportFailure(normalized);
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
        event.type === 'task_permission_required'
        || (event.type === 'phase' && event.phase === 'awaiting_confirmation')
      ) {
        this.state = {
          kind: 'awaiting_capability_confirmation',
          generation,
          taskKind: active.taskKind
        };
      }
      if (event.type === 'phase' && (event.phase === 'success' || event.phase === 'error' || event.phase === 'cancelled')) {
        if (active.assistantText !== null) {
          this.options.history.append({
            userText: active.text,
            assistantText: active.assistantText,
            providerIdentity: active.target.providerIdentity
          });
        }
        active.terminalPhase = event.phase;
        if (this.resultSummary) this.resultSummary.phase = event.phase;
        // 提交 Promise 结算后再释放协调器入口，避免终态事件内同步重入新任务。
        if (!active.outcomeReady) return;
        this.activeCapabilityTurn = null;
        this.state = { kind: 'idle' };
      }

    }
    this.options.emit(event);
  }

  private handleTrustedToolResult(
    result: CodingTaskToolResult,
    generation: string,
    target: PreparedCapabilityTarget
  ): void {
    const active = this.activeCapabilityTurn;
    if (!active || generation !== this.generation || active.target !== target || !this.resultSummary) return;
    this.resultSummary.operations += 1;
    if (result.exit !== undefined) this.resultSummary.lastExit = result.exit;
  }

  private handleAwaitingConfirmationFollowUp(text: unknown): boolean {
    if (this.state.kind !== 'awaiting_capability_confirmation' || typeof text !== 'string' || !isBareContinueFollowUp(text)) return false;
    this.options.emit({ type: 'message', role: 'assistant', text: '请先处理当前权限确认卡。' });
    return true;
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

function summarizeCapabilityRequest(text: string): string {
  return Array.from(text.replace(/\s+/gu, ' ').trim()).slice(0, 240).join('');
}

function isBareContinueFollowUp(text: string): boolean {
  return /^(?:继续(?:执行)?|接着(?:执行)?|continue|go on)[。！!]?$/iu
    .test(text.normalize('NFKC').trim());
}

const 公开错误消息: Readonly<Record<string, string>> = Object.freeze({
    INPUT_INVALID: '消息不能为空且不能超过 4000 个字符。',
    TASK_ALREADY_ACTIVE: '已有任务正在运行。',
    CONVERSATION_CLOSED: '当前会话已经关闭。',
    DISCLOSURE_REQUEST_EXPIRED: '历史披露确认已失效，请重新提交消息。',
    FILE_TARGET_MISMATCH: '文件授权目录或模型配置已经变化，请重新提交完整文件请求。',
    POWERSHELL_BACKGROUND_UNSUPPORTED: '暂不支持后台 PowerShell 任务，请改为前台执行。',
    PROVIDER_AUTHENTICATION_FAILED: '模型服务身份认证失败，请检查 API Key。',
    PROVIDER_ENDPOINT_NOT_FOUND: '模型服务地址不可用。',
    PROVIDER_RATE_LIMITED: '模型服务当前繁忙，请稍后重试。',
    PROVIDER_SERVER_ERROR: '模型服务发生错误，请稍后重试。',
    PROVIDER_TIMEOUT: '模型请求超时。',
    PROVIDER_MALFORMED_RESPONSE: '模型响应格式不兼容，请重试。',
    SETTINGS_INCOMPLETE: '请先完成模型服务设置。',
    CODING_MODEL_PROTOCOL_UNSUPPORTED: '当前模型协议暂不支持编程任务，请选择 DeepSeek 或内置 Qwen。',
    LOCAL_MODEL_LOADING: '本地模型正在加载，请稍后重试。',
    LOCAL_MODEL_FAULTED: '本地模型启动失败，请前往设置查看。',
    LOCAL_MODEL_DISABLED: '内置本地模型已关闭。',
    LOCAL_MODEL_SWITCHING: '本地模型正在切换，请稍后重试。',
    AGENT_INTERNAL_ERROR: '任务执行失败，请重试。'
});

const 可信文件端口错误 = Symbol('trusted-file-task-error');
const 已公开文件错误 = Symbol('reported-file-task-error');

function publicError(error: unknown): Error & { code: string } {
  if (error instanceof ProviderResponseError) {
    return publicErrorForCode('PROVIDER_MALFORMED_RESPONSE');
  }
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
  const message = 公开错误消息[normalizedCode]!;
  return Object.assign(new Error(message), { code: normalizedCode });
}
