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
import type { ToolRequest, TaskEvent } from '@myself/shared-types';
import type { VerifiedWriteAction } from '@myself/file-tools';
import type {
  PendingActionClearReason,
  PendingActionStore
} from './pending-action-store';

const MAX_USER_TEXT_LENGTH = 4_000;

export interface AgentFileTools {
  executeRead(request: ToolRequest): Promise<unknown>;
  preview(request: ToolRequest): Promise<VerifiedWriteAction>;
  executeWrite(action: VerifiedWriteAction): Promise<void>;
}

export interface AgentSession {
  provider: ModelProvider;
  fallbackProviders?: ModelProvider[];
  fileTools: AgentFileTools;
  fileDisclosureAllowed: boolean;
  tools: ToolDefinition[];
  toolRuntime: ToolRuntime;
  messages: ModelMessage[];
}

export interface AgentServiceOptions {
  loop: AgentLoop;
  pending: PendingActionStore;
  createSession(signal?: AbortSignal): Promise<AgentSession>;
  emit(event: TaskEvent): void;
  createConversationId?: () => string;
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
    TOOL_PERMISSION_DENIED: '该工具操作未获本地权限策略允许。'
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

function writeResult(action: VerifiedWriteAction): Record<string, unknown> {
  if (action.toolName === 'rename_entry') {
    return {
      ok: true,
      toolName: action.toolName,
      sourceRelativePath: action.sourceRelativePath,
      targetRelativePath: action.targetRelativePath
    };
  }
  return {
    ok: true,
    toolName: action.toolName,
    targetRelativePath: action.targetRelativePath
  };
}

function actionSummary(action: VerifiedWriteAction): string {
  if (action.toolName === 'rename_entry') {
    return `将 ${action.sourceRelativePath} 重命名为 ${action.targetRelativePath}`;
  }
  if (action.toolName === 'create_file') return `创建文件 ${action.targetRelativePath}`;
  return `创建目录 ${action.targetRelativePath}`;
}

export class AgentService {
  private readonly loop: AgentLoop;
  private readonly pending: PendingActionStore;
  private readonly createSession: (signal?: AbortSignal) => Promise<AgentSession>;
  private readonly emit: (event: TaskEvent) => void;
  private readonly createConversationId: () => string;
  private activeController: AbortController | null = null;
  private pendingSession: AgentSession | null = null;
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
    this.createConversationId = options.createConversationId ?? randomUUID;
  }

  async submit(text: string): Promise<void> {
    const normalized = text.trim();
    if (normalized.length === 0 || normalized.length > MAX_USER_TEXT_LENGTH) {
      const error = Object.assign(new Error('INPUT_INVALID'), { code: 'INPUT_INVALID' });
      this.emitFailure(error);
      throw error;
    }
    this.assertIdle();
    this.clearPending('new_task');

    const controller = new AbortController();
    this.activeController = controller;
    this.emit({ type: 'message', role: 'user', text: normalized });
    try {
      const session = await this.createSession(controller.signal);
      await this.forward(
        this.loop.run(normalized, this.runContext(session, controller.signal)),
        session
      );
    } catch (error) {
      this.emitFailure(error);
      throw error;
    } finally {
      if (this.activeController === controller) this.activeController = null;
    }
  }

  cancelActive(): void {
    if (this.activeController) {
      this.activeController.abort();
      return;
    }
    if (this.pendingSession) {
      this.clearPending('task_cancelled');
      this.emit({ type: 'phase', phase: 'cancelled' });
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
    this.pendingSession = null;
    if (!session) {
      this.loop.discard(execution.continuationToken);
      const error = new Error('ACTION_EXPIRED');
      this.emitFailure(error);
      throw error;
    }

    const controller = new AbortController();
    this.activeController = controller;
    let writeCompleted = false;
    this.emit({ type: 'phase', phase: 'acting' });
    try {
      this.assertFileDisclosureAllowed(session);
      await session.fileTools.executeWrite(execution.verifiedAction);
      writeCompleted = true;
      await this.forward(
        this.loop.resume(
          execution.continuationToken,
          writeResult(execution.verifiedAction),
          this.runContext(session, controller.signal)
        ),
        session
      );
    } catch (error) {
      if (!writeCompleted) this.loop.discard(execution.continuationToken);
      if (writeCompleted) {
        this.emit({
          type: 'error',
          code: 'PROVIDER_SUMMARY_FAILED_AFTER_WRITE',
          message: '本地文件操作已成功，但模型总结失败。',
          nextAction: '可以查看文件结果，或稍后重新请求总结。'
        });
        this.emit({ type: 'phase', phase: 'error' });
      } else {
        this.emitFailure(error);
      }
      throw error;
    } finally {
      if (this.activeController === controller) this.activeController = null;
    }
  }

  cancelAction(actionId: string): void {
    try {
      this.pending.cancel(actionId);
      this.pendingSession = null;
      this.emit({ type: 'phase', phase: 'cancelled' });
    } catch (error) {
      this.emitFailure(error);
      throw error;
    }
  }

  clearPending(reason: PendingActionClearReason): void {
    this.pending.clear(reason);
    this.pendingSession = null;
  }

  private assertIdle(): void {
    if (!this.activeController) return;
    const error = Object.assign(new Error('TASK_ALREADY_ACTIVE'), { code: 'TASK_ALREADY_ACTIVE' });
    this.emitFailure(error);
    throw error;
  }

  private runContext(session: AgentSession, signal: AbortSignal): RunContext {
    return {
      messages: session.messages,
      provider: providerWithFallback(session.provider, session.fallbackProviders ?? []),
      tools: session.tools,
      toolRuntime: session.toolRuntime,
      signal
    };
  }

  private async forward(stream: AsyncGenerator<AgentEvent>, session: AgentSession): Promise<void> {
    for await (const event of stream) {
      if (event.type === 'phase') {
        this.emit(event);
        continue;
      }
      if (event.type === 'message') {
        this.emit({ type: 'message', role: 'assistant', text: event.text });
        continue;
      }
      try {
        this.assertFileDisclosureAllowed(session);
        const verifiedAction = await session.fileTools.preview(event.executionRequest);
        const publicAction = this.pending.issue({
          conversationId: this.createConversationId(),
          risk: 'write',
          summary: actionSummary(verifiedAction),
          ...(verifiedAction.toolName === 'rename_entry'
            ? { sourceRelativePath: verifiedAction.sourceRelativePath }
            : {}),
          targetRelativePath: verifiedAction.targetRelativePath
        }, {
          verifiedAction,
          continuationToken: event.continuationToken
        });
        this.pendingSession = session;
        this.emit({ type: 'pending_action', action: publicAction });
      } catch (error) {
        this.loop.discard(event.continuationToken);
        throw error;
      }
    }
  }

  private emitFailure(error: unknown): void {
    if (typeof error === 'object' && error !== null) {
      this.reportedFailures.add(error);
    }
    this.emit(publicErrorEvent(error));
    this.emit({ type: 'phase', phase: 'error' });
  }

  private assertFileDisclosureAllowed(session: AgentSession): void {
    if (session.fileDisclosureAllowed) return;
    throw Object.assign(new Error('FILE_DISCLOSURE_DENIED'), {
      code: 'FILE_DISCLOSURE_DENIED'
    });
  }
}
