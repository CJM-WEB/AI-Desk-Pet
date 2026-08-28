import { randomUUID } from 'node:crypto';
import type {
  AgentEvent,
  AgentLoop,
  AgentRunOutcome,
  FilePlanningHint,
  ModelMessage,
  ModelProvider,
  RunContext,
  ToolDefinition,
  ToolRuntime
} from '@myself/agent-core';
import { createToolFailureResult } from '@myself/agent-core';
import type { CharacterAgentBehaviorIntent } from '@myself/character-runtime';
import type { ToolRequest, TaskEvent } from '@myself/shared-types';
import { isRootRelativePathInput, type VerifiedWriteAction } from '@myself/file-tools';
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
import { ProviderResponseError } from '../providers/provider-response-error';

const MAX_USER_TEXT_LENGTH = 4_000;
const MAX_PRIVATE_PLANNING_CONTEXT_LENGTH = 1_200;
const NAMED_READ_GLOB_MAX_RESULTS = 100;
const NAMED_READ_LINE_COUNT = 200;

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
  fileTools: AgentFileTools;
  powershell: PowerShellTool;
  workingDirectory: string;
  workingDirectoryLabel: string;
  generation: string;
}

/** 单一 Agent 会话持有完整执行端口；initialCapability 只收窄首轮规划面。 */
export type AgentSession = AgentSessionBase & Readonly<{
  taskKind: 'agent';
  initialCapability: 'file' | 'powershell';
}>;

export interface AgentFileTaskSubmission {
  text: string;
  visibleHistory: readonly ModelMessage[];
  planningHint?: FilePlanningHint;
  privatePlanningContext?: string;
  submissionOwner?: symbol;
}

export type AgentFileTaskOutcome =
  | Readonly<{ kind: 'clarification'; missingField: NonNullable<AgentRunOutcome>['missingField']; acted: false }>
  | Readonly<{ kind: 'completed'; acted: boolean }>;

/** 仅供 Main 会话事务消费；不得进入公开 TaskEvent 或 Renderer。 */
export type AgentTrustedToolResult = Readonly<{
  toolName: string;
  ok: boolean;
  relativePaths: readonly string[];
  submissionOwner?: symbol;
}>;

export interface AgentServiceOptions {
  loop: AgentLoop;
  pending: PendingActionStore;
  createSession(signal?: AbortSignal): Promise<AgentSession>;
  emit(event: TaskEvent): void;
  emitTrustedToolResult?: (result: AgentTrustedToolResult) => void;
  emitBehaviorIntent?(intent: CharacterAgentBehaviorIntent): void;
  createConversationId?: () => string;
}

type CapabilityExecution = import('./pending-action-store').PendingExecution;

type NamedReadResolution =
  | { kind: 'resolved'; relativePath: string; content: string; truncated: boolean }
  | {
      kind: 'clarification';
      candidates: readonly string[];
      reason: 'not_found' | 'ambiguous' | 'search_truncated';
    };

function errorCode(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  if (error instanceof Error && error.message === 'ACTION_EXPIRED') return 'ACTION_EXPIRED';
  return 'AGENT_INTERNAL_ERROR';
}

function publicErrorEvent(error: unknown): Extract<TaskEvent, { type: 'error' }> {
  // Provider 内部子码只用于 Main 诊断，公开事件继续使用既有通用契约。
  const code = error instanceof ProviderResponseError
    ? 'PROVIDER_MALFORMED_RESPONSE'
    : errorCode(error);
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
    CAPABILITY_PLAN_PROTOCOL_INVALID: '能力任务需要先调用真实工具，或提出格式正确的澄清问题。',
    AGENT_REPEATED_TOOL_CALL: '模型重复请求了相同工具参数，任务已安全停止。'
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

function trustedReadRelativePaths(result: unknown): readonly string[] {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return [];
  const record = result as Record<string, unknown>;
  const candidates: unknown[] = [record['relativePath']];
  if (Array.isArray(record['paths'])) candidates.push(...record['paths']);
  for (const collectionName of ['entries', 'matches'] as const) {
    const collection = record[collectionName];
    if (!Array.isArray(collection)) continue;
    for (const item of collection) {
      if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
        candidates.push((item as Record<string, unknown>)['relativePath']);
      }
    }
  }
  return Object.freeze(Array.from(new Set(candidates.filter(
    (candidate): candidate is string => typeof candidate === 'string'
      && isRootRelativePathInput(candidate)
  ))));
}

function isGlobFilesResult(value: unknown): value is Readonly<{
  toolName: 'glob_files';
  paths: readonly string[];
  truncated: boolean;
}> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record['toolName'] === 'glob_files'
    && Array.isArray(record['paths'])
    && record['paths'].every(isRootRelativePathInput)
    && typeof record['truncated'] === 'boolean';
}

function isReadFileResult(value: unknown): value is Readonly<{
  toolName: 'read_file';
  relativePath: string;
  content: string;
  truncated: boolean;
}> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record['toolName'] === 'read_file'
    && typeof record['relativePath'] === 'string'
    && isRootRelativePathInput(record['relativePath'])
    && typeof record['content'] === 'string'
    && typeof record['truncated'] === 'boolean';
}

function namedReadCandidates(paths: readonly string[], targetNameQuery: string): readonly string[] {
  const queryHasExtension = targetNameQuery.lastIndexOf('.') > 0;
  return Object.freeze(paths.filter(relativePath => {
    const fileName = relativePath.split('/').at(-1);
    if (fileName === undefined) return false;
    if (fileName === targetNameQuery) return true;
    const extensionOffset = fileName.lastIndexOf('.');
    return !queryHasExtension
      && extensionOffset > 0
      && fileName.slice(0, extensionOffset) === targetNameQuery;
  }).sort());
}

function trustedWriteRelativePaths(action: VerifiedWriteAction): readonly string[] {
  const candidates = action.operation === 'move_file'
    ? [action.sourceRelativePath, action.targetRelativePath]
    : [action.targetRelativePath];
  return Object.freeze(candidates.filter(isRootRelativePathInput));
}

/** 执行端口的 ok 字段是确认续跑后的本地能力事实。 */
function capabilityResultOk(result: unknown): boolean {
  return typeof result === 'object'
    && result !== null
    && (result as Record<string, unknown>)['ok'] === true;
}

/** 多文件任务不是事务；宿主必须明确公开已落盘的相对路径，不能让取消或失败掩盖部分成功。 */
function partialFileCompletionMessage(
  completedTargetRelativePaths: readonly string[],
  outcome: 'cancelled' | 'failed'
): string {
  const completed = completedTargetRelativePaths.join('、');
  return outcome === 'cancelled'
    ? `已完成以下文件操作：${completed}。其余文件操作已取消，未执行。`
    : `已完成以下文件操作：${completed}。当前文件操作失败，其余文件操作未执行。`;
}

function assertNever(value: never): never {
  throw new Error(`未处理的能力操作：${String(value)}`);
}

function actionSummary(action: VerifiedWriteAction): string {
  switch (action.operation) {
    case 'create_file': return `创建文件 ${action.targetRelativePath}`;
    case 'create_directory': return `创建目录 ${action.targetRelativePath}`;
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
  private readonly emitTrustedToolResult: ((result: AgentTrustedToolResult) => void) | undefined;
  private readonly emitBehaviorIntent:
    | ((intent: CharacterAgentBehaviorIntent) => void)
    | undefined;
  private readonly createConversationId: () => string;
  private activeController: AbortController | null = null;
  private pendingSession: AgentSession | null = null;
  private activeSession: AgentSession | null = null;
  private transactionSession: AgentSession | null = null;
  private activePlanningHint: FilePlanningHint | undefined;
  private activePrivatePlanningContext: string | undefined;
  private activeSubmissionOwner: symbol | undefined;
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
    this.emitTrustedToolResult = options.emitTrustedToolResult;
    this.emitBehaviorIntent = options.emitBehaviorIntent;
    this.createConversationId = options.createConversationId ?? randomUUID;
  }

  async submitFileTask(input: AgentFileTaskSubmission): Promise<AgentFileTaskOutcome> {
    const normalized = typeof input?.text === 'string' ? input.text.trim() : '';
    const visibleHistory = snapshotVisibleHistory(input?.visibleHistory);
    const privatePlanningContext = input?.privatePlanningContext === undefined
      ? undefined
      : typeof input.privatePlanningContext === 'string'
        && input.privatePlanningContext.length > 0
        && input.privatePlanningContext.length <= MAX_PRIVATE_PLANNING_CONTEXT_LENGTH
        ? input.privatePlanningContext
        : null;
    const submissionOwner = input?.submissionOwner;
    if (
      normalized.length === 0
      || normalized.length > MAX_USER_TEXT_LENGTH
      || visibleHistory === null
      || privatePlanningContext === null
      || (submissionOwner !== undefined && typeof submissionOwner !== 'symbol')
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
    this.activePrivatePlanningContext = privatePlanningContext;
    this.activeSubmissionOwner = submissionOwner;
    const controller = new AbortController();
    this.activeController = controller;
    try {
      const session = this.transactionSession ?? await this.createSession(controller.signal);
      this.transactionSession = session;
      this.activeSession = session;
      if (visibleHistory.length > 0) this.historyBoundSessions.add(session);
      const namedReadResolution = await this.resolveNamedRead(
        session,
        input.planningHint,
        controller.signal,
        owner
      );
      if (namedReadResolution !== null) {
        return this.completeNamedRead(namedReadResolution, owner);
      }
      return await this.forward(
        this.loop.run(
          normalized,
          this.runContext(
            session,
            controller.signal,
            visibleHistory,
            input.planningHint,
            privatePlanningContext,
            owner
          )
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
        this.activePrivatePlanningContext = undefined;
        this.activeSubmissionOwner = undefined;
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
        if (!currentCapabilitySucceeded) {
          this.publish({
            type: 'message',
            role: 'assistant',
            text: partialFileCompletionMessage(execution.completedTargetRelativePaths ?? [], 'failed')
          }, owner);
        }
      }
      capabilityResult = {
        kind: execution.verifiedAction.category,
        ok: capabilityResultOk(result)
      };
      await this.forward(
        this.loop.resume(
          execution.continuationToken,
          result,
          this.runContext(
            session,
            controller.signal,
            [],
            this.activePlanningHint,
            this.activePrivatePlanningContext,
            owner
          )
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
        this.activePrivatePlanningContext = undefined;
        this.activeSubmissionOwner = undefined;
      }
    }
  }

  cancelAction(actionId: string): void {
    try {
      const execution = this.pending.cancel(actionId);
      this.pendingSession = null;
      const owner = this.taskOwner;
      if ((execution.completedTargetRelativePaths?.length ?? 0) > 0) {
        this.publish({
          type: 'message',
          role: 'assistant',
          text: partialFileCompletionMessage(execution.completedTargetRelativePaths ?? [], 'cancelled')
        }, owner);
      }
      this.publish({ type: 'phase', phase: 'cancelled' }, owner);
      if (this.taskOwner === owner && this.pendingSession === null) this.taskOwner = null;
      if (this.taskOwner === null) this.activePlanningHint = undefined;
      if (this.taskOwner === null) this.activePrivatePlanningContext = undefined;
      if (this.taskOwner === null) this.activeSubmissionOwner = undefined;
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
    this.activePrivatePlanningContext = undefined;
    this.activeSubmissionOwner = undefined;
  }

  /**
   * 先使旧任务事件失去所有权；可撤销阶段立即取消，不可逆执行则等待真实结果收敛。
   */
  async resetForNewConversation(): Promise<void> {
    this.taskOwner = null;
    const irreversible = this.irreversibleExecution?.promise ?? null;
    const controller = this.activeController;
    const session = this.transactionSession ?? this.activeSession;
    this.pendingSession = null;
    this.activeSession = null;
    this.transactionSession = null;
    this.activePlanningHint = undefined;
    this.activePrivatePlanningContext = undefined;
    this.activeSubmissionOwner = undefined;
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
    if (session?.powershell) await session.powershell.close();
    if (this.activeController === controller) this.activeController = null;
    if (failures.length > 0) throw failures[0];
  }

  /** 应用退出或桌宠窗口关闭时撤销尚未提交的文件能力。 */
  async close(): Promise<void> {
    this.taskOwner = null;
    const session = this.transactionSession ?? this.activeSession;
    const irreversible = this.irreversibleExecution?.promise ?? null;
    this.pending.clear('application_exit');
    this.pendingSession = null;
    this.activeSession = null;
    this.transactionSession = null;
    this.activePlanningHint = undefined;
    this.activePrivatePlanningContext = undefined;
    this.activeSubmissionOwner = undefined;
    this.activeController?.abort();
    if (irreversible) await irreversible;
    if (session?.powershell) await session.powershell.close();
  }

  private assertIdle(): void {
    if (!this.activeController) return;
    const error = Object.assign(new Error('TASK_ALREADY_ACTIVE'), { code: 'TASK_ALREADY_ACTIVE' });
    this.emitFailure(error);
    throw error;
  }

  /**
   * 按文件名读取始终在同一 Agent 会话内先执行受控只读工具；Provider 不参与路径猜测。
   * 搜索截断时宁可澄清，也不能把局部结果误认作唯一命中。
   */
  private async resolveNamedRead(
    session: AgentSession,
    planningHint: FilePlanningHint | undefined,
    signal: AbortSignal,
    owner: symbol
  ): Promise<NamedReadResolution | null> {
    const targetNameQuery = planningHint?.operation === 'read_file'
      ? planningHint.targetNameQuery
      : undefined;
    if (targetNameQuery === undefined) return null;

    this.publish({ type: 'phase', phase: 'thinking' }, owner);
    this.assertTaskOwned(owner, signal);
    let rawGlobResult: unknown;
    try {
      rawGlobResult = await session.fileTools.executeRead({
        requestId: 'named-read-glob',
        toolName: 'glob_files',
        arguments: {
          relativePath: '.',
          pattern: '**/*',
          maxResults: NAMED_READ_GLOB_MAX_RESULTS
        }
      });
    } catch (error) {
      this.publishTrustedToolResult({
        toolName: 'glob_files',
        ok: false,
        relativePaths: []
      }, owner);
      throw error;
    }
    this.assertTaskOwned(owner, signal);
    if (!isGlobFilesResult(rawGlobResult)) {
      this.publishTrustedToolResult({
        toolName: 'glob_files',
        ok: false,
        relativePaths: []
      }, owner);
      throw Object.assign(new Error('TOOL_RESULT_INVALID'), { code: 'TOOL_RESULT_INVALID' });
    }
    this.publishTrustedToolResult({
      toolName: 'glob_files',
      ok: true,
      relativePaths: rawGlobResult.paths
    }, owner);
    this.publish({ type: 'phase', phase: 'acting' }, owner);
    if (rawGlobResult.truncated) {
      return { kind: 'clarification', candidates: [], reason: 'search_truncated' };
    }

    const candidates = namedReadCandidates(rawGlobResult.paths, targetNameQuery);
    if (candidates.length === 0) {
      return { kind: 'clarification', candidates: [], reason: 'not_found' };
    }
    if (candidates.length > 1) {
      return {
        kind: 'clarification',
        candidates: Object.freeze(candidates.slice(0, 10)),
        reason: 'ambiguous'
      };
    }

    const relativePath = candidates[0]!;
    this.assertTaskOwned(owner, signal);
    let rawReadResult: unknown;
    try {
      rawReadResult = await session.fileTools.executeRead({
        requestId: 'named-read-file',
        toolName: 'read_file',
        arguments: {
          relativePath,
          startLine: 1,
          lineCount: NAMED_READ_LINE_COUNT
        }
      });
    } catch (error) {
      this.publishTrustedToolResult({
        toolName: 'read_file',
        ok: false,
        relativePaths: []
      }, owner);
      throw error;
    }
    this.assertTaskOwned(owner, signal);
    if (!isReadFileResult(rawReadResult) || rawReadResult.relativePath !== relativePath) {
      this.publishTrustedToolResult({
        toolName: 'read_file',
        ok: false,
        relativePaths: []
      }, owner);
      throw Object.assign(new Error('TOOL_RESULT_INVALID'), { code: 'TOOL_RESULT_INVALID' });
    }
    this.publishTrustedToolResult({
      toolName: 'read_file',
      ok: true,
      relativePaths: [rawReadResult.relativePath]
    }, owner);
    return {
      kind: 'resolved',
      relativePath: rawReadResult.relativePath,
      content: rawReadResult.content,
      truncated: rawReadResult.truncated
    };
  }

  private completeNamedRead(
    resolution: NamedReadResolution,
    owner: symbol
  ): AgentFileTaskOutcome {
    if (resolution.kind === 'resolved') {
      this.publish({
        type: 'message',
        role: 'assistant',
        text: '已读取 ' + resolution.relativePath + '：\n' + resolution.content + (
          resolution.truncated ? '\n（文件内容已截断。）' : ''
        )
      }, owner);
      this.publish({ type: 'phase', phase: 'success' }, owner);
      return { kind: 'completed', acted: true };
    }
    const text = resolution.reason === 'not_found'
      ? '授权目录内未找到该文件，请提供目标相对路径。'
      : resolution.reason === 'search_truncated'
        ? '文件搜索结果过多，请提供更具体的目标相对路径。'
        : '找到多个同名文件，请提供目标相对路径：' + resolution.candidates.join('、') + '。';
    this.publish({ type: 'message', role: 'assistant', text }, owner);
    this.publish({ type: 'phase', phase: 'success' }, owner);
    return { kind: 'clarification', missingField: 'target_path', acted: false };
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
        this.assertTaskOwned(owner, signal);
        try {
          const result = await session.powershell.execute(execution.verifiedAction.action, signal);
          this.publishTrustedToolResult({
            toolName: execution.resultToolName,
            ok: result.ok,
            relativePaths: []
          }, owner);
          return result;
        } catch (error) {
          this.publishTrustedToolResult({
            toolName: execution.resultToolName,
            ok: false,
            relativePaths: []
          }, owner);
          throw error;
        }
      }
      this.assertTaskOwned(owner, signal);
      this.publishFileFeedback({ type: 'character_carrying', carrying: true }, owner);
      try {
        this.assertTaskOwned(owner, signal);
        try {
          await session.fileTools.executeWrite(execution.verifiedAction.action);
        } catch (error) {
          this.publishTrustedToolResult({
            toolName: execution.resultToolName,
            ok: false,
            relativePaths: []
          }, owner);
          throw error;
        }
        this.publishTrustedToolResult({
          toolName: execution.resultToolName,
          ok: true,
          relativePaths: trustedWriteRelativePaths(execution.verifiedAction.action)
        }, owner);
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
    planningHint?: FilePlanningHint,
    privatePlanningContext?: string,
    owner?: symbol
  ): RunContext {
    const fileTools = session.tools.filter(tool => tool.function.name.startsWith('builtin.files.'));
    const planningTools = planningHint?.missingField === 'target_path'
      ? []
      : session.initialCapability === 'powershell'
        ? session.tools.filter(tool => tool.function.name === 'builtin.powershell.run')
        : fileTools;
    // 普通文件任务始终排除 PowerShell；显式 PowerShell 只有真实命令结果后才恢复受控组合工具面。
    const tools = session.initialCapability === 'file' ? fileTools : session.tools;
    const expectedOperation = planningHint?.operation ?? (
      session.initialCapability === 'powershell' ? 'powershell' : undefined
    );
    return {
      // 文件系统提示始终在前；获准历史只作为本轮模型输入，不回写 Agent 私有轨迹。
      messages: [
        ...session.messages,
        ...(privatePlanningContext === undefined
          ? []
          : [{
              role: 'system' as const,
              content: `任务内私有规划上下文：${privatePlanningContext}`
            }]),
        ...visibleHistory
      ],
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
        executeRead: async request => {
          try {
            const result = await session.toolRuntime.executeRead(request);
            this.publishTrustedToolResult({
              toolName: request.toolName,
              ok: true,
              relativePaths: trustedReadRelativePaths(result)
            }, owner);
            return result;
          } catch (error) {
            this.publishTrustedToolResult({
              toolName: request.toolName,
              ok: false,
              relativePaths: []
            }, owner);
            throw error;
          }
        }
      },
      signal,
      // 能力任务显式启用首个真实工具结果前的受限规划协议；聊天默认不受影响。
      protocol: 'capability_planner',
      capabilityPlanning: {
        allowClarification: session.initialCapability === 'file',
        planningTools,
        ...(expectedOperation === undefined ? {} : { expectedOperation })
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
      if (!session.powershell || !session.workingDirectory
        || !session.workingDirectoryLabel || !session.generation) {
        throw new Error('TOOL_UNKNOWN');
      }
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
    if (!session.fileTools) throw new Error('TOOL_UNKNOWN');
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

  private publishTrustedToolResult(result: AgentTrustedToolResult, owner?: symbol): void {
    if (owner !== undefined && this.taskOwner !== owner) return;
    const submissionOwner = this.activeSubmissionOwner;
    try {
      this.emitTrustedToolResult?.(Object.freeze({
        toolName: result.toolName,
        ok: result.ok,
        relativePaths: Object.freeze([...result.relativePaths]),
        ...(submissionOwner === undefined ? {} : { submissionOwner })
      }));
    } catch {
      // 事务记录失败不得改写已经发生的本地工具事实。
    }
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
