import { randomUUID } from 'node:crypto';
import type {
  AgentEvent,
  AgentLoop,
  ModelMessage,
  ModelProvider,
  RunContext,
  ToolDefinition,
  ToolRuntime
} from '@myself/agent-core';
import type { CharacterAgentBehaviorIntent } from '@myself/character-runtime';
import type { ToolRequest, TaskEvent } from '@myself/shared-types';
import type { VerifiedWriteAction } from '@myself/file-tools';
import type {
  PowerShellRunResult,
  PowerShellTool,
  VerifiedPowerShellAction
} from './powershell-tool';
import type {
  PendingActionClearReason,
  PendingActionDraft,
  PendingActionStore
} from './pending-action-store';
import {
  FileTaskTransactionCoordinator,
  type FileTaskPlaybackTerminal,
  type FileTaskResult
} from './file-task-transaction-coordinator';

const MAX_USER_TEXT_LENGTH = 4_000;

export interface AgentFileTools {
  executeRead(request: ToolRequest): Promise<unknown>;
  preview(request: ToolRequest): Promise<VerifiedWriteAction>;
  executeWrite(action: VerifiedWriteAction): Promise<void>;
}

interface AgentSessionBase {
  provider: ModelProvider;
  fallbackProviders?: ModelProvider[];
  tools: ToolDefinition[];
  toolRuntime: ToolRuntime;
  messages: ModelMessage[];
}

/** 会话只拥有当前能力任务的执行端口，避免跨任务暴露工具。 */
export type AgentSession = AgentSessionBase & (
  | Readonly<{
      taskKind: 'file';
      fileTools: AgentFileTools;
      fileDisclosureAllowed: boolean;
    }>
  | Readonly<{
      taskKind: 'powershell';
      powershell: PowerShellTool;
      workingDirectory: string;
      workingDirectoryLabel: string;
      generation: string;
    }>
);

export interface AgentFileTaskSubmission {
  text: string;
  visibleHistory: readonly ModelMessage[];
}

export interface AgentTaskCarryPort {
  beginTaskCarry(): Readonly<{
    playbackToken: string;
    actionId: string;
    commitFrameId: string | null;
  }>;
  endTaskCarry(): void;
}

export interface AgentServiceOptions {
  loop: AgentLoop;
  pending: PendingActionStore;
  createSession(signal?: AbortSignal): Promise<AgentSession>;
  emit(event: TaskEvent): void;
  emitBehaviorIntent?(intent: CharacterAgentBehaviorIntent): void;
  taskCarry?: AgentTaskCarryPort;
  createConversationId?: () => string;
}

type ActiveFileTask = {
  action: VerifiedWriteAction;
  session: AgentSession;
  resolveResult(result: FileTaskResult): void;
};

type CapabilityExecution = import('./pending-action-store').PendingExecution;

function errorCode(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  if (error instanceof Error && error.message === 'ACTION_EXPIRED') return 'ACTION_EXPIRED';
  return 'AGENT_INTERNAL_ERROR';
}

function publicErrorEvent(error: unknown): Extract<TaskEvent, { type: 'error' }> {
  const code = errorCode(error);
  if (code === 'FILE_DISCLOSURE_DENIED') {
    return {
      type: 'error',
      code,
      message: '文件数据类别未授权。'
    };
  }
  const messages: Record<string, string> = {
    ACTION_EXPIRED: '待确认操作已失效，请重新发起任务。',
    PATH_INVALID: '文件路径无效。',
    PATH_OUTSIDE_ROOT: '文件路径超出授权目录。',
    TARGET_EXISTS: '目标已经存在，未执行覆盖。',
    ENTRY_NOT_FOUND: '指定条目不存在。',
    PERMISSION_DENIED: 'Windows 拒绝了本地文件操作。',
    PROVIDER_AUTHENTICATION_FAILED: '模型服务身份认证失败，请检查 API Key。',
    PROVIDER_ENDPOINT_NOT_FOUND: '模型服务地址不可用。',
    PROVIDER_RATE_LIMITED: '模型服务当前繁忙，请稍后重试。',
    PROVIDER_SERVER_ERROR: '模型服务发生错误，请稍后重试。',
    PROVIDER_TIMEOUT: '模型请求超时。',
    SETTINGS_INCOMPLETE: '请先完成模型服务和授权目录设置。',
    TASK_ALREADY_ACTIVE: '已有任务正在运行。',
    INPUT_INVALID: '消息不能为空且不能超过 4000 个字符。',
    TOOL_PERMISSION_DENIED: '该工具操作未获本地权限策略允许。',
    CAPABILITY_PLAN_PROTOCOL_INVALID: '能力任务需要先调用真实工具，或提出格式正确的澄清问题。',
    FILE_TASK_USER_CANCELLED: '回收站操作已取消，文件未被移动。',
    FILE_TASK_PLAYBACK_UNAVAILABLE: '当前角色无法播放搬运动作，文件未被移动。',
    FILE_TASK_PLAYBACK_CANCELLED: '搬运动画未完成，文件未被移动。',
    FILE_TASK_PLAYBACK_TIMEOUT: '等待搬运动画超时，文件未被移动。',
    FILE_TASK_EXECUTION_FAILED: '移入回收站失败，文件仍保留在原位置。'
  };
  return {
    type: 'error',
    code,
    message: messages[code] ?? '任务执行失败，请重试。'
  };
}

function isRetryable(error: unknown): boolean {
  return error instanceof Error && 'retryable' in error && error.retryable === true;
}

function providerWithOneRetry(provider: ModelProvider): ModelProvider {
  return {
    async respond(request, signal) {
      try {
        return await provider.respond(request, signal);
      } catch (error) {
        if (!isRetryable(error) || signal.aborted) throw error;
        return provider.respond(request, signal);
      }
    }
  };
}

function providerWithFallback(
  primary: ModelProvider,
  fallbackProviders: readonly ModelProvider[]
): ModelProvider {
  const providers = [primary, ...fallbackProviders].map(providerWithOneRetry);
  let activeProviderIndex = 0;
  return {
    async respond(request, signal) {
      for (let index = activeProviderIndex; index < providers.length; index += 1) {
        try {
          const response = await providers[index]!.respond(request, signal);
          activeProviderIndex = index;
          return response;
        } catch (error) {
          if (!isRetryable(error) || signal.aborted || index === providers.length - 1) {
            throw error;
          }
        }
      }
      throw new Error('PROVIDER_FALLBACK_EXHAUSTED');
    }
  };
}

function snapshotVisibleHistory(value: unknown): readonly ModelMessage[] | null {
  if (!Array.isArray(value)) return null;
  const snapshot: ModelMessage[] = [];
  for (const candidate of value) {
    if (typeof candidate !== 'object' || candidate === null) return null;
    const prototype = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(candidate);
    if (
      keys.length !== 2
      || !Object.hasOwn(candidate, 'role')
      || !Object.hasOwn(candidate, 'content')
    ) {
      return null;
    }
    const record = candidate as Record<string, unknown>;
    if (
      (record.role !== 'user' && record.role !== 'assistant')
      || typeof record.content !== 'string'
    ) {
      return null;
    }
    snapshot.push(Object.freeze({
      role: record.role,
      content: record.content
    }));
  }
  return Object.freeze(snapshot);
}

function writeResult(action: VerifiedWriteAction): Record<string, unknown> {
  return {
    ok: true,
    toolName: action.operation,
    targetRelativePath: action.targetRelativePath
  };
}

/** 执行端口的 ok 字段是确认续跑后的本地能力事实。 */
function capabilityResultOk(result: unknown): boolean {
  return typeof result === 'object'
    && result !== null
    && (result as Record<string, unknown>)['ok'] === true;
}

function assertNever(value: never): never {
  throw new Error(`未处理的能力操作：${String(value)}`);
}

function actionSummary(action: VerifiedWriteAction): string {
  switch (action.operation) {
    case 'create_file': return `创建文件 ${action.targetRelativePath}`;
    case 'apply_patch': return `修改文件 ${action.targetRelativePath}`;
    case 'delete_file': return `删除文件 ${action.targetRelativePath}`;
    default: return assertNever(action);
  }
}

export class AgentService {
  private readonly loop: AgentLoop;
  private readonly pending: PendingActionStore;
  private readonly createSession: (signal?: AbortSignal) => Promise<AgentSession>;
  private readonly emit: (event: TaskEvent) => void;
  private readonly emitBehaviorIntent:
    | ((intent: CharacterAgentBehaviorIntent) => void)
    | undefined;
  private readonly createConversationId: () => string;
  private readonly taskCarry: AgentTaskCarryPort | undefined;
  private readonly fileTaskCoordinator: FileTaskTransactionCoordinator;
  private activeController: AbortController | null = null;
  private activeFileTask: ActiveFileTask | null = null;
  private pendingSession: AgentSession | null = null;
  private activeSession: AgentSession | null = null;
  private taskOwner: symbol | null = null;
  private irreversibleExecution: {
    promise: Promise<void>;
    resolve(): void;
  } | null = null;
  private readonly historyBoundSessions = new WeakSet<AgentSession>();
  private readonly reportedFailures = new WeakSet<object>();

  hasReportedFailure(error: unknown): boolean {
    return typeof error === 'object'
      && error !== null
      && this.reportedFailures.has(error);
  }

  constructor(options: AgentServiceOptions) {
    this.loop = options.loop;
    this.pending = options.pending;
    this.createSession = options.createSession;
    this.emit = options.emit;
    this.emitBehaviorIntent = options.emitBehaviorIntent;
    this.taskCarry = options.taskCarry;
    this.createConversationId = options.createConversationId ?? randomUUID;
    this.fileTaskCoordinator = new FileTaskTransactionCoordinator({
      execute: action => this.executeFileTask(action),
      reportResult: result => this.activeFileTask?.resolveResult(result)
    });
  }

  async submitFileTask(input: AgentFileTaskSubmission): Promise<void> {
    const normalized = typeof input?.text === 'string' ? input.text.trim() : '';
    const visibleHistory = snapshotVisibleHistory(input?.visibleHistory);
    if (
      normalized.length === 0
      || normalized.length > MAX_USER_TEXT_LENGTH
      || visibleHistory === null
    ) {
      const error = Object.assign(new Error('INPUT_INVALID'), { code: 'INPUT_INVALID' });
      this.emitFailure(error);
      throw error;
    }
    this.assertIdle();
    this.clearPending('new_task');

    const owner = Symbol('agent-file-task');
    this.taskOwner = owner;
    const controller = new AbortController();
    this.activeController = controller;
    try {
      const session = await this.createSession(controller.signal);
      this.activeSession = session;
      if (visibleHistory.length > 0) this.historyBoundSessions.add(session);
      await this.forward(
        this.loop.run(
          normalized,
          this.runContext(session, controller.signal, visibleHistory)
        ),
        session,
        owner
      );
    } catch (error) {
      this.emitFailure(error, owner);
      throw error;
    } finally {
      if (this.activeController === controller) this.activeController = null;
      if (this.taskOwner === owner && this.pendingSession === null) {
        this.taskOwner = null;
        this.activeSession = null;
      }
    }
  }

  cancelActive(): void {
    if (this.activeController) {
      this.fileTaskCoordinator.cancel();
      this.activeController.abort();
      return;
    }
    if (this.pendingSession) {
      const owner = this.taskOwner;
      this.clearPending('task_cancelled');
      this.publish({ type: 'phase', phase: 'cancelled' }, owner);
      if (this.taskOwner === owner) this.taskOwner = null;
    }
  }

  async confirm(actionId: string): Promise<void> {
    this.assertIdle();
    let execution;
    try {
      execution = this.pending.consume(actionId);
    } catch (error) {
      this.emitFailure(error);
      throw error;
    }

    const session = this.pendingSession;
    const owner = this.taskOwner;
    this.pendingSession = null;
    if (!session || !owner) {
      this.loop.discard(execution.continuationToken);
      const error = new Error('ACTION_EXPIRED');
      this.emitFailure(error);
      throw error;
    }

    const controller = new AbortController();
    this.activeController = controller;
    const isDeleteFile = execution.verifiedAction.category === 'file'
      && execution.verifiedAction.action.operation === 'delete_file';
    if (isDeleteFile) {
      try {
        return await this.confirmDeleteFile(
          execution as CapabilityExecution & {
            verifiedAction: Readonly<{ category: 'file'; action: VerifiedWriteAction }>;
          },
          session,
          controller,
          owner
        );
      } finally {
        if (this.taskOwner === owner && this.pendingSession === null) {
          this.taskOwner = null;
          this.activeSession = null;
        }
      }
    }
    let capabilityResult: { kind: 'file' | 'powershell'; ok: boolean } | null = null;
    try {
      this.publish({ type: 'phase', phase: 'acting' }, owner);
      this.assertTaskOwned(owner, controller.signal);
      const result = await this.executeCapability(execution, session, controller.signal, owner);
      capabilityResult = {
        kind: execution.verifiedAction.category,
        ok: capabilityResultOk(result)
      };
      await this.forward(
        this.loop.resume(
          execution.continuationToken,
          result,
          this.runContext(session, controller.signal)
        ),
        session,
        owner
      );
    } catch (error) {
      if (!capabilityResult) this.loop.discard(execution.continuationToken);
      if (capabilityResult) {
        this.publish(capabilityResult.kind === 'file' && capabilityResult.ok
          ? {
              type: 'error',
              code: 'PROVIDER_SUMMARY_FAILED_AFTER_WRITE',
              message: '本地文件操作已成功，但模型总结失败。',
              nextAction: '可以查看文件结果，或稍后重新请求总结。'
            }
          : {
              type: 'error',
              code: 'PROVIDER_SUMMARY_FAILED_AFTER_CAPABILITY_RESULT',
              message: '本地能力操作已结束，但模型总结失败。',
              nextAction: '可以查看本地操作结果，或稍后重新请求总结。'
            }, owner);
        this.publish({ type: 'phase', phase: 'error' }, owner);
      } else {
        this.emitFailure(error, owner);
      }
      throw error;
    } finally {
      if (this.activeController === controller) this.activeController = null;
      if (this.taskOwner === owner && this.pendingSession === null) {
        this.taskOwner = null;
        this.activeSession = null;
      }
    }
  }

  cancelAction(actionId: string): void {
    try {
      this.pending.cancel(actionId);
      this.pendingSession = null;
      const owner = this.taskOwner;
      this.publish({ type: 'phase', phase: 'cancelled' }, owner);
        if (this.taskOwner === owner && this.pendingSession === null) this.taskOwner = null;
    } catch (error) {
      this.emitFailure(error);
      throw error;
    }
  }

  clearPending(reason: PendingActionClearReason): void {
    this.fileTaskCoordinator.cancel();
    this.pending.clear(reason);
    this.pendingSession = null;
    this.activeSession = null;
  }

  /**
   * 先使旧任务事件失去所有权；可撤销阶段立即取消，不可逆执行则等待真实结果收敛。
   */
  async resetForNewConversation(): Promise<void> {
    this.taskOwner = null;
    const irreversible = this.irreversibleExecution?.promise ?? null;
    const controller = this.activeController;
    const session = this.activeSession;
    this.pendingSession = null;
    this.activeSession = null;
    const failures: unknown[] = [];
    for (const cleanup of [
      () => this.fileTaskCoordinator.cancel(),
      () => this.pending.clear('task_cancelled'),
      () => controller?.abort()
    ]) {
      try {
        cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (irreversible) await irreversible;
    if (session?.taskKind === 'powershell') await session.powershell.close();
    if (this.activeController === controller) this.activeController = null;
    if (failures.length > 0) throw failures[0];
  }

  /** 接收 Renderer 已由行为服务认证的播放开始反馈。 */
  onPlaybackStarted(playbackToken: string, actionId: string): boolean {
    return this.fileTaskCoordinator.onPlaybackStarted(playbackToken, actionId);
  }

  /** 接收 Renderer 已由行为服务认证的终止反馈。 */
  onPlaybackTerminal(
    playbackToken: string,
    actionId: string,
    terminal: FileTaskPlaybackTerminal
  ): boolean {
    return this.fileTaskCoordinator.onPlaybackTerminal(playbackToken, actionId, terminal);
  }

  /** 消费严格匹配当前授权的提交帧；返回值供 IPC 拒绝伪造或重复里程碑。 */
  onCommitFrame(playbackToken: string, actionId: string, frameId: string): boolean {
    return this.fileTaskCoordinator.onCommitFrame(playbackToken, actionId, frameId);
  }

  /** 由 Main 的短周期轮询推进开始与提交超时。 */
  advanceFileTaskTransaction(): boolean {
    return this.fileTaskCoordinator.advance();
  }

  /** 角色切换或用户交互使旧播放令牌失效时，同步撤销尚未提交的文件能力。 */
  invalidateFileTaskPlaybackGrant(): boolean {
    return this.fileTaskCoordinator.cancel('playback_interrupted');
  }

  /** 应用退出或桌宠窗口关闭时撤销尚未提交的文件能力。 */
  async close(): Promise<void> {
    this.taskOwner = null;
    const session = this.activeSession;
    const irreversible = this.irreversibleExecution?.promise ?? null;
    this.fileTaskCoordinator.close();
    this.pending.clear('application_exit');
    this.pendingSession = null;
    this.activeSession = null;
    this.activeController?.abort();
    if (irreversible) await irreversible;
    if (session?.taskKind === 'powershell') await session.powershell.close();
  }

  private assertIdle(): void {
    if (!this.activeController) return;
    const error = Object.assign(new Error('TASK_ALREADY_ACTIVE'), { code: 'TASK_ALREADY_ACTIVE' });
    this.emitFailure(error);
    throw error;
  }

  private async confirmDeleteFile(
    execution: CapabilityExecution & { verifiedAction: Readonly<{ category: 'file'; action: VerifiedWriteAction }> },
    session: AgentSession,
    controller: AbortController,
    owner: symbol
  ): Promise<void> {
    const taskCarry = this.taskCarry;
    if (!taskCarry) {
      this.loop.discard(execution.continuationToken);
      const error = Object.assign(new Error('FILE_TASK_PLAYBACK_UNAVAILABLE'), {
        code: 'FILE_TASK_PLAYBACK_UNAVAILABLE'
      });
      this.emitFailure(error, owner);
      if (this.activeController === controller) this.activeController = null;
      throw error;
    }

    let resolveResult!: (result: FileTaskResult) => void;
    const resultPromise = new Promise<FileTaskResult>(resolve => {
      resolveResult = resolve;
    });
    const activeTask: ActiveFileTask = {
      action: execution.verifiedAction.action,
      session,
      resolveResult
    };
    this.activeFileTask = activeTask;
    let writeCompleted = false;
    let carryStarted = false;
    let carryingPublished = true;
    try {
      this.publish({ type: 'phase', phase: 'acting' }, owner);
      this.assertTaskOwned(owner, controller.signal);
      this.publish({ type: 'character_carrying', carrying: true }, owner);
      this.assertTaskOwned(owner, controller.signal);
      this.assertFileDisclosureAllowed(session);
      this.assertTaskOwned(owner, controller.signal);
      const grant = taskCarry.beginTaskCarry();
      carryStarted = true;
      this.assertTaskOwned(owner, controller.signal);
      this.fileTaskCoordinator.begin(execution.verifiedAction.action, grant);
      const result = await resultPromise;
      if (result.status !== 'succeeded') {
        throw this.fileTaskResultError(result);
      }
      writeCompleted = true;
      taskCarry.endTaskCarry();
      carryStarted = false;
      this.publish({ type: 'character_carrying', carrying: false }, owner);
      carryingPublished = false;
      await this.forward(
        this.loop.resume(
          execution.continuationToken,
          writeResult(execution.verifiedAction.action),
          this.runContext(session, controller.signal)
        ),
        session,
        owner
      );
    } catch (error) {
      if (!writeCompleted && this.fileTaskCoordinator.snapshot().state === 'waiting-playback') {
        this.fileTaskCoordinator.cancel();
      }
      if (!writeCompleted && this.fileTaskCoordinator.snapshot().state === 'waiting-commit') {
        this.fileTaskCoordinator.cancel();
      }
      if (!writeCompleted && this.activeFileTask === activeTask) {
        // beginTaskCarry 或授权校验失败时协调器尚未接管续跑令牌。
        this.loop.discard(execution.continuationToken);
      }
      if (writeCompleted) {
        this.publish({
          type: 'error',
          code: 'PROVIDER_SUMMARY_FAILED_AFTER_WRITE',
          message: '本地文件操作已成功，但模型总结失败。',
          nextAction: '可以查看文件结果，或稍后重新请求总结。'
        }, owner);
        this.publish({ type: 'phase', phase: 'success' }, owner);
      } else {
        this.emitFailure(error, owner);
      }
      throw error;
    } finally {
      if (carryStarted) taskCarry.endTaskCarry();
      if (carryingPublished) {
        this.publish({ type: 'character_carrying', carrying: false }, owner);
      }
      if (this.activeFileTask === activeTask) this.activeFileTask = null;
      if (this.activeController === controller) this.activeController = null;
    }
  }

  private async executeFileTask(action: VerifiedWriteAction): Promise<void> {
    const activeTask = this.activeFileTask;
    if (!activeTask || activeTask.action !== action) {
      throw new Error('FILE_TASK_TRANSACTION_MISMATCH');
    }
    const irreversible = this.beginIrreversibleExecution();
    try {
      if (activeTask.session.taskKind !== 'file') throw new Error('FILE_TASK_TRANSACTION_MISMATCH');
      await activeTask.session.fileTools.executeWrite(action);
    } finally {
      this.finishIrreversibleExecution(irreversible);
    }
  }

  /** 普通文件写入与 PowerShell 共用确认续跑，删除仍由专属回收站事务协调。 */
  private async executeCapability(
    execution: CapabilityExecution,
    session: AgentSession,
    signal: AbortSignal,
    owner: symbol
  ): Promise<Record<string, unknown> | PowerShellRunResult> {
    const irreversible = this.beginIrreversibleExecution();
    try {
      if (execution.verifiedAction.category === 'powershell') {
        if (session.taskKind !== 'powershell') throw new Error('ACTION_EXPIRED');
        this.assertTaskOwned(owner, signal);
        return await session.powershell.execute(execution.verifiedAction.action, signal);
      }
      if (session.taskKind !== 'file') throw new Error('ACTION_EXPIRED');
      this.assertTaskOwned(owner, signal);
      this.assertFileDisclosureAllowed(session);
      this.publish({ type: 'character_carrying', carrying: true }, owner);
      try {
        this.assertTaskOwned(owner, signal);
        await session.fileTools.executeWrite(execution.verifiedAction.action);
      } finally {
        this.publish({ type: 'character_carrying', carrying: false }, owner);
      }
      return writeResult(execution.verifiedAction.action);
    } finally {
      this.finishIrreversibleExecution(irreversible);
    }
  }

  private fileTaskResultError(result: FileTaskResult): Error {
    if (result.status === 'succeeded') {
      return Object.assign(new Error('FILE_TASK_RESULT_INVALID'), {
        code: 'FILE_TASK_RESULT_INVALID'
      });
    }
    if (result.status === 'failed') {
      return Object.assign(new Error('FILE_TASK_EXECUTION_FAILED'), {
        code: 'FILE_TASK_EXECUTION_FAILED'
      });
    }
    const code = result.reason === 'user_cancelled'
      ? 'FILE_TASK_USER_CANCELLED'
      : result.reason === 'playback_start_timeout' || result.reason === 'commit_timeout'
        ? 'FILE_TASK_PLAYBACK_TIMEOUT'
        : 'FILE_TASK_PLAYBACK_CANCELLED';
    return Object.assign(new Error(code), { code });
  }

  private runContext(
    session: AgentSession,
    signal: AbortSignal,
    visibleHistory: readonly ModelMessage[] = []
  ): RunContext {
    return {
      // 文件系统提示始终在前；获准历史只作为本轮模型输入，不回写 Agent 私有轨迹。
      messages: [...session.messages, ...visibleHistory],
      provider: this.historyBoundSessions.has(session)
        ? providerWithOneRetry(session.provider)
        : providerWithFallback(session.provider, session.fallbackProviders ?? []),
      tools: session.tools,
      toolRuntime: session.toolRuntime,
      signal,
      // 能力任务显式启用首个真实工具结果前的受限规划协议；聊天默认不受影响。
      protocol: 'capability_planner'
    };
  }

  private async forward(
    stream: AsyncGenerator<AgentEvent>,
    session: AgentSession,
    owner: symbol
  ): Promise<void> {
    for await (const event of stream) {
      if (this.taskOwner !== owner) {
        if (event.type === 'write_request') this.loop.discard(event.continuationToken);
        return;
      }
      if (event.type === 'phase') {
        this.publish(event, owner);
        continue;
      }
      if (event.type === 'message') {
        this.publish({ type: 'message', role: 'assistant', text: event.text }, owner);
        continue;
      }
      if (event.type === 'emotion') {
        this.publish({ type: 'character_emotion', label: event.label }, owner);
        continue;
      }
      if (event.type === 'behavior_intent') {
        if (this.taskOwner === owner) this.emitBehaviorIntent?.(event.intent);
        continue;
      }
      try {
        const execution = await this.previewCapability(event.executionRequest, session);
        if (this.taskOwner !== owner) {
          this.loop.discard(event.continuationToken);
          return;
        }
        const publicAction = this.pending.issue(pendingActionDraft(
          execution.verifiedAction,
          this.createConversationId()
        ), {
          verifiedAction: execution.verifiedAction,
          continuationToken: event.continuationToken
        });
        this.pendingSession = session;
        this.publish({ type: 'pending_action', action: publicAction }, owner);
      } catch (error) {
        this.loop.discard(event.continuationToken);
        throw error;
      }
    }
  }

  private emitFailure(error: unknown, owner?: symbol): void {
    if (typeof error === 'object' && error !== null) {
      this.reportedFailures.add(error);
    }
    this.publish(publicErrorEvent(error), owner);
    this.publish({ type: 'phase', phase: 'error' }, owner);
  }

  private async previewCapability(
    request: ToolRequest,
    session: AgentSession
  ): Promise<Readonly<{ verifiedAction: import('./pending-action-store').VerifiedCapabilityAction }>> {
    if (request.toolName === 'powershell') {
      if (session.taskKind !== 'powershell') throw new Error('TOOL_UNKNOWN');
      const command = request.arguments['command'];
      if (typeof command !== 'string') throw new Error('TOOL_ARGUMENTS_INVALID');
      return {
        verifiedAction: {
          category: 'powershell',
          action: session.powershell.preview({
            command,
            workingDirectory: session.workingDirectory,
            workingDirectoryLabel: session.workingDirectoryLabel,
            generation: session.generation
          })
        }
      };
    }
    if (session.taskKind !== 'file') throw new Error('TOOL_UNKNOWN');
    this.assertFileDisclosureAllowed(session);
    return { verifiedAction: { category: 'file', action: await session.fileTools.preview(request) } };
  }

  private publish(event: TaskEvent, owner?: symbol | null): void {
    if (owner !== undefined && owner !== null && this.taskOwner !== owner) return;
    this.emit(event);
  }

  private beginIrreversibleExecution(): NonNullable<AgentService['irreversibleExecution']> {
    let resolve!: () => void;
    const promise = new Promise<void>(done => {
      resolve = done;
    });
    const execution = { promise, resolve };
    this.irreversibleExecution = execution;
    return execution;
  }

  private finishIrreversibleExecution(
    execution: NonNullable<AgentService['irreversibleExecution']>
  ): void {
    execution.resolve();
    if (this.irreversibleExecution === execution) this.irreversibleExecution = null;
  }

  private assertFileDisclosureAllowed(session: AgentSession): void {
    if (session.taskKind !== 'file') throw new Error('FILE_DISCLOSURE_DENIED');
    if (session.fileDisclosureAllowed) return;
    throw Object.assign(new Error('FILE_DISCLOSURE_DENIED'), {
      code: 'FILE_DISCLOSURE_DENIED'
    });
  }

  private assertTaskOwned(owner: symbol, signal: AbortSignal): void {
    if (this.taskOwner === owner && !signal.aborted) return;
    throw Object.assign(new Error('FILE_TASK_USER_CANCELLED'), {
      code: 'FILE_TASK_USER_CANCELLED'
    });
  }
}

function pendingActionDraft(
  action: import('./pending-action-store').VerifiedCapabilityAction,
  conversationId: string
): PendingActionDraft {
  if (action.category === 'powershell') {
    return {
      category: 'powershell',
      conversationId,
      risk: 'shell',
      operation: 'powershell',
      summary: '运行 PowerShell 命令',
      command: action.action.command,
      workingDirectoryLabel: action.action.workingDirectoryLabel,
      runMode: 'foreground'
    };
  }
  const fileAction = action.action;
  const common = { category: 'file' as const, conversationId, risk: 'write' as const, summary: actionSummary(fileAction), targetRelativePath: fileAction.targetRelativePath };
  switch (fileAction.operation) {
    case 'create_file': return { ...common, operation: 'create_file', contentCharacters: fileAction.contentCharacters, contentPreview: fileAction.contentPreview, previewTruncated: fileAction.previewTruncated };
    case 'apply_patch': return { ...common, operation: 'apply_patch', addedLines: fileAction.addedLines, removedLines: fileAction.removedLines, diffPreview: fileAction.diffPreview, previewTruncated: fileAction.previewTruncated };
    case 'delete_file': return { ...common, operation: 'delete_file', targetType: fileAction.targetType };
    default: return assertNever(fileAction);
  }
}
