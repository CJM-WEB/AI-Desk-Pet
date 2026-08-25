import { randomUUID } from 'node:crypto';
import type {
  AgentEvent,
  AgentLoop,
  AgentRunOutcome,
  FilePlanningHint,
  FilePlanningOperation,
  FileWriteOperation,
  ModelMessage,
  ModelProvider,
  RunContext,
  ToolDefinition,
  ToolRuntime
} from '@myself/agent-core';
import { createToolFailureResult } from '@myself/agent-core';
import type { CharacterAgentBehaviorIntent } from '@myself/character-runtime';
import type { ToolRequest, TaskEvent } from '@myself/shared-types';
import { type VerifiedWriteAction } from '@myself/file-tools';
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
  isPublicFileTaskErrorCode,
  publicFileTaskErrorDetails
} from './file-task-public-errors';

const MAX_USER_TEXT_LENGTH = 4_000;

export interface AgentFileTools {
  executeRead(request: ToolRequest): Promise<unknown>;
  preview(request: ToolRequest): Promise<VerifiedWriteAction>;
  previewMany?(request: ToolRequest): Promise<readonly VerifiedWriteAction[]>;
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
  planningHint?: FilePlanningHint;
}

const filePlanningToolNames = Object.freeze({
  list_files: 'builtin.files.list_files',
  read_file: 'builtin.files.read_file',
  glob_files: 'builtin.files.glob_files',
  grep_files: 'builtin.files.grep_files',
  create_file: 'builtin.files.create_file',
  create_directory: 'builtin.files.create_directory',
  copy_file: 'builtin.files.copy_file',
  apply_patch: 'builtin.files.apply_patch',
  edit_file: 'builtin.files.edit_file',
  delete_file: 'builtin.files.delete_file',
  move_file: 'builtin.files.move_file'
} satisfies Readonly<Record<FilePlanningOperation, string>>);

const controlledWriteOperations = new Set<FileWriteOperation>([
  'create_file',
  'create_directory',
  'copy_file',
  'apply_patch',
  'edit_file',
  'delete_file',
  'move_file'
]);
const controlledWriteToolNames = new Set<string>(
  [...controlledWriteOperations].map(operation => filePlanningToolNames[operation])
);

function isControlledWriteOperation(operation: FilePlanningOperation): operation is FileWriteOperation {
  return controlledWriteOperations.has(operation as FileWriteOperation);
}

export type AgentFileTaskOutcome =
  | Readonly<{ kind: 'clarification'; missingField: NonNullable<AgentRunOutcome>['missingField']; acted: false }>
  | Readonly<{ kind: 'completed'; acted: boolean }>;

export interface AgentServiceOptions {
  loop: AgentLoop;
  pending: PendingActionStore;
  createSession(signal?: AbortSignal): Promise<AgentSession>;
  emit(event: TaskEvent): void;
  emitBehaviorIntent?(intent: CharacterAgentBehaviorIntent): void;
  createConversationId?: () => string;
}

type CapabilityExecution = import('./pending-action-store').PendingExecution;

function fileDisclosureDenied(): Error & { code: 'FILE_DISCLOSURE_DENIED' } {
  return Object.assign(new Error('FILE_DISCLOSURE_DENIED'), { code: 'FILE_DISCLOSURE_DENIED' as const });
}

function errorCode(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  if (error instanceof Error && error.message === 'ACTION_EXPIRED') return 'ACTION_EXPIRED';
  return 'AGENT_INTERNAL_ERROR';
}

function publicErrorEvent(error: unknown): Extract<TaskEvent, { type: 'error' }> {
  const code = errorCode(error);
  const fileError = publicFileTaskErrorDetails(code);
  if (fileError !== null) {
    return { type: 'error', code, ...fileError };
  }
  const messages: Record<string, string> = {
    PROVIDER_AUTHENTICATION_FAILED: '模型服务身份认证失败，请检查 API Key。',
    PROVIDER_ENDPOINT_NOT_FOUND: '模型服务地址不可用。',
    PROVIDER_RATE_LIMITED: '模型服务当前繁忙，请稍后重试。',
    PROVIDER_SERVER_ERROR: '模型服务发生错误，请稍后重试。',
    PROVIDER_TIMEOUT: '模型请求超时。',
    SETTINGS_INCOMPLETE: '请先完成模型服务和授权目录设置。',
    TASK_ALREADY_ACTIVE: '已有任务正在运行。',
    INPUT_INVALID: '消息不能为空且不能超过 4000 个字符。',
    TOOL_PERMISSION_DENIED: '该工具操作未获本地权限策略允许。',
    CAPABILITY_PLAN_PROTOCOL_INVALID: '能力任务需要先调用真实工具，或提出格式正确的澄清问题。'
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

function writeResult(action: VerifiedWriteAction, resultToolName: string): Record<string, unknown> {
  return {
    ok: true,
    toolName: resultToolName,
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
    case 'create_directory': return `创建目录 ${action.targetRelativePath}`;
    case 'copy_file': return `复制文件 ${action.sourceRelativePath} 到 ${action.targetRelativePath}`;
    case 'apply_patch': return `修改文件 ${action.targetRelativePath}`;
    case 'delete_file': return `${action.targetType === 'empty_directory' ? '删除目录' : '删除文件'} ${action.targetRelativePath}`;
    case 'move_file': return `移动文件 ${action.sourceRelativePath} 到 ${action.targetRelativePath}`;
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
  private activeController: AbortController | null = null;
  private pendingSession: AgentSession | null = null;
  private activeSession: AgentSession | null = null;
  private activePlanningHint: FilePlanningHint | undefined;
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
    this.createConversationId = options.createConversationId ?? randomUUID;
  }

  async submitFileTask(input: AgentFileTaskSubmission): Promise<AgentFileTaskOutcome> {
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
    this.activePlanningHint = input.planningHint;
    const controller = new AbortController();
    this.activeController = controller;
    try {
      const session = await this.createSession(controller.signal);
      this.activeSession = session;
      if (visibleHistory.length > 0) this.historyBoundSessions.add(session);
      return await this.forward(
        this.loop.run(
          normalized,
          this.runContext(session, controller.signal, visibleHistory, input.planningHint)
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
        this.activePlanningHint = undefined;
      }
    }
  }

  cancelActive(): void {
    if (this.activeController) {
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
    let capabilityResult: { kind: 'file' | 'powershell'; ok: boolean } | null = null;
    try {
      this.publish({ type: 'phase', phase: 'acting' }, owner);
      this.assertTaskOwned(owner, controller.signal);
      let result: unknown;
      try {
        result = await this.executeCapability(execution, session, controller.signal, owner);
      } catch (error) {
        // 任务失效与用户取消不是可修复的工具参数失败，绝不能借失败回注恢复旧会话。
        if (controller.signal.aborted || this.taskOwner !== owner) throw error;
        result = createToolFailureResult(execution.resultToolName, error);
        // 公开错误沿用 Main 的稳定脱敏文案；模型只接收无正文的修复码。
        this.publish(publicErrorEvent(error), owner);
      }
      const currentCapabilitySucceeded = capabilityResultOk(result);
      const completedTargetRelativePaths = execution.verifiedAction.category === 'file'
        ? [
            ...(execution.completedTargetRelativePaths ?? []),
            ...(currentCapabilitySucceeded
              ? [execution.verifiedAction.action.targetRelativePath]
              : [])
          ]
        : [];
      if (
        currentCapabilitySucceeded
        && execution.remainingVerifiedActions?.length
      ) {
        const [nextAction, ...remainingVerifiedActions] = execution.remainingVerifiedActions;
        if (!nextAction) throw new Error('ACTION_EXPIRED');
        const publicAction = this.pending.issue(pendingActionDraft(
          nextAction,
          this.createConversationId()
        ), {
          verifiedAction: nextAction,
          continuationToken: execution.continuationToken,
          resultToolName: execution.resultToolName,
          remainingVerifiedActions,
          completedTargetRelativePaths
        });
        this.pendingSession = session;
        this.publish({ type: 'phase', phase: 'awaiting_confirmation' }, owner);
        this.publish({ type: 'pending_action', action: publicAction }, owner);
        return;
      }
      if ((execution.completedTargetRelativePaths?.length ?? 0) > 0) {
        result = {
          ...(result as Record<string, unknown>),
          completedTargetRelativePaths
        };
      }
      capabilityResult = {
        kind: execution.verifiedAction.category,
        ok: capabilityResultOk(result)
      };
      await this.forward(
        this.loop.resume(
          execution.continuationToken,
          result,
          this.runContext(session, controller.signal, [], this.activePlanningHint)
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
        this.activePlanningHint = undefined;
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
      if (this.taskOwner === null) this.activePlanningHint = undefined;
    } catch (error) {
      this.emitFailure(error);
      throw error;
    }
  }

  clearPending(reason: PendingActionClearReason): void {
    this.pending.clear(reason);
    this.pendingSession = null;
    this.activeSession = null;
    this.activePlanningHint = undefined;
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
    this.activePlanningHint = undefined;
    const failures: unknown[] = [];
    for (const cleanup of [
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

  /** 应用退出或桌宠窗口关闭时撤销尚未提交的文件能力。 */
  async close(): Promise<void> {
    this.taskOwner = null;
    const session = this.activeSession;
    const irreversible = this.irreversibleExecution?.promise ?? null;
    this.pending.clear('application_exit');
    this.pendingSession = null;
    this.activeSession = null;
    this.activePlanningHint = undefined;
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

  /** 所有文件写入在 Main 消费确认后统一提交，角色表现不拥有文件提交权。 */
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
      this.publishFileFeedback({ type: 'character_carrying', carrying: true }, owner);
      try {
        this.assertTaskOwned(owner, signal);
        await session.fileTools.executeWrite(execution.verifiedAction.action);
      } finally {
        this.publishFileFeedback({ type: 'character_carrying', carrying: false }, owner);
      }
      return writeResult(execution.verifiedAction.action, execution.resultToolName);
    } finally {
      this.finishIrreversibleExecution(irreversible);
    }
  }

  private runContext(
    session: AgentSession,
    signal: AbortSignal,
    visibleHistory: readonly ModelMessage[] = [],
    planningHint?: FilePlanningHint
  ): RunContext {
    const plannedOperation = planningHint?.operation;
    const plannedToolName = plannedOperation === undefined
      ? null
      : filePlanningToolNames[plannedOperation];
    const expectedWriteOperation = plannedOperation !== undefined && isControlledWriteOperation(plannedOperation)
      ? plannedOperation
      : undefined;
    const planningTools = planningHint?.missingField === 'target_path'
      ? []
      : session.taskKind === 'file' && !session.fileDisclosureAllowed
      ? session.tools.filter(tool => (
        expectedWriteOperation !== undefined
        && tool.function.name === plannedToolName
      ))
      : plannedToolName === null
        ? session.tools
        : session.tools.filter(tool => tool.function.name === plannedToolName);
    // 未授权正文披露时，纯写任务续跑只恢复逐次确认的 mutation；读取/检索始终保持关闭。
    const tools = session.taskKind === 'file' && session.fileDisclosureAllowed
      ? session.tools
      : session.taskKind === 'file' && expectedWriteOperation !== undefined
        ? session.tools.filter(tool => controlledWriteToolNames.has(tool.function.name))
        : planningTools;
    return {
      // 文件系统提示始终在前；获准历史只作为本轮模型输入，不回写 Agent 私有轨迹。
      messages: [...session.messages, ...visibleHistory],
      provider: this.historyBoundSessions.has(session)
        ? providerWithOneRetry(session.provider)
        : providerWithFallback(session.provider, session.fallbackProviders ?? []),
      tools,
      toolRuntime: {
        prepare: raw => {
          const prepared = session.toolRuntime.prepare(raw);
          if (!tools.some(tool => tool.function.name === prepared.request.toolName)) {
            throw Object.assign(new Error('TOOL_UNKNOWN'), { code: 'TOOL_UNKNOWN' });
          }
          return prepared;
        },
        executeRead: request => {
          if (session.taskKind === 'file' && !session.fileDisclosureAllowed) {
            return Promise.reject(fileDisclosureDenied());
          }
          return session.toolRuntime.executeRead(request);
        }
      },
      signal,
      // 能力任务显式启用首个真实工具结果前的受限规划协议；聊天默认不受影响。
      protocol: 'capability_planner',
      capabilityPlanning: {
        allowClarification: session.taskKind === 'file',
        planningTools,
        ...(expectedWriteOperation === undefined ? {} : { expectedWriteOperation })
      }
    };
  }

  private async forward(
    stream: AsyncGenerator<AgentEvent, AgentRunOutcome>,
    session: AgentSession,
    owner: symbol
  ): Promise<AgentFileTaskOutcome> {
    let acted = false;
    while (true) {
      const next = await stream.next();
      if (next.done) {
        return next.value?.kind === 'clarification'
          ? { kind: 'clarification', missingField: next.value.missingField, acted: false }
          : { kind: 'completed', acted };
      }
      const event = next.value;
      if (this.taskOwner !== owner) {
        if (event.type === 'write_request') this.loop.discard(event.continuationToken);
        return { kind: 'completed', acted };
      }
      if (event.type === 'phase') {
        if (event.phase === 'acting') acted = true;
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
        acted = true;
        const executions = await this.previewCapabilities(event.executionRequest, session);
        if (this.taskOwner !== owner) {
          this.loop.discard(event.continuationToken);
          return { kind: 'completed', acted };
        }
        const [firstExecution, ...remainingVerifiedActions] = executions;
        if (!firstExecution) throw new Error('TOOL_ARGUMENTS_INVALID');
        const publicAction = this.pending.issue(pendingActionDraft(
          firstExecution,
          this.createConversationId()
        ), {
          verifiedAction: firstExecution,
          continuationToken: event.continuationToken,
          resultToolName: event.executionRequest.toolName,
          remainingVerifiedActions
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

  private async previewCapabilities(
    request: ToolRequest,
    session: AgentSession
  ): Promise<readonly import('./pending-action-store').VerifiedCapabilityAction[]> {
    if (request.toolName === 'powershell') {
      if (session.taskKind !== 'powershell') throw new Error('TOOL_UNKNOWN');
      const command = request.arguments['command'];
      if (typeof command !== 'string') throw new Error('TOOL_ARGUMENTS_INVALID');
      return [{
          category: 'powershell',
          action: session.powershell.preview({
            command,
            workingDirectory: session.workingDirectory,
            workingDirectoryLabel: session.workingDirectoryLabel,
            generation: session.generation
          })
      }];
    }
    if (session.taskKind !== 'file') throw new Error('TOOL_UNKNOWN');
    const actions = session.fileTools.previewMany === undefined
      ? [await session.fileTools.preview(request)]
      : await session.fileTools.previewMany(request);
    return actions.map(action => ({ category: 'file' as const, action }));
  }

  /** 角色反馈属于尽力表现；投影或角色异常不能阻断已经确认的 Main 文件执行。 */
  private publishFileFeedback(
    event: Extract<TaskEvent, { type: 'character_carrying' }>,
    owner: symbol
  ): void {
    try {
      this.publish(event, owner);
    } catch {
      // 文件结果只由 executeWrite 决定，表现层失败不得改写本地能力事实。
    }
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
    case 'create_file': return {
      ...common,
      operation: 'create_file',
      contentCharacters: fileAction.contentCharacters,
      contentPreview: fileAction.contentPreview,
      contentPreviewSuppressedReason: fileAction.contentPreviewSuppressedReason,
      previewTruncated: fileAction.previewTruncated
    };
    case 'create_directory': return { ...common, operation: 'create_directory' };
    case 'copy_file': return {
      ...common,
      operation: 'copy_file',
      sourceRelativePath: fileAction.sourceRelativePath
    };
    case 'apply_patch': return { ...common, operation: 'apply_patch', addedLines: fileAction.addedLines, removedLines: fileAction.removedLines, diffPreview: fileAction.diffPreview, previewTruncated: fileAction.previewTruncated };
    case 'delete_file': return { ...common, operation: 'delete_file', targetType: fileAction.targetType };
    case 'move_file': return {
      ...common,
      operation: 'move_file',
      sourceRelativePath: fileAction.sourceRelativePath
    };
    default: return assertNever(fileAction);
  }
}
