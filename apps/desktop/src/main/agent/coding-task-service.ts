import { createCodingSession, commandResource, type CodingSession, type CodingSessionOptions, type CodingSessionEvent } from '@myself/coding-task-core';
import type { ModelMessage } from '@myself/agent-core';
import { taskPermissionRequiredEventSchema, taskPermissionIdSchema, type TaskEvent, type TaskPermissionRequiredEvent } from '@myself/shared-types';

export interface CodingTaskSubmission {
  text: string;
  visibleHistory: readonly ModelMessage[];
  submissionOwner?: symbol;
}
export type CodingTaskOutcome = Readonly<{ kind: 'completed'; acted: boolean }>;
export type CodingTaskToolResult = Readonly<{
  toolName: string; ok: boolean; relativePaths: readonly string[]; submissionOwner?: symbol; exit?: number;
}>;
export interface CodingTaskServiceOptions {
  sessionOptions(): Promise<Omit<CodingSessionOptions, 'onEvent' | 'initialHistory'>>;
  createSession?: typeof createCodingSession;
  emit(event: TaskEvent): void;
  emitTrustedToolResult?(result: CodingTaskToolResult): void;
}

/** Main 只拥有当前任务的输入快照、许可投影及清理；执行与消息仍由原 Core 管理。 */
export class CodingTaskService {
  private active: { controller: AbortController; done: Promise<CodingTaskOutcome>; session?: CodingSession; permissions: Map<string, { action: TaskPermissionRequiredEvent['request']['action']; replying: boolean }>; invalidPermission: boolean } | null = null;
  private closed = false;
  private cleanupFailed = false;
  constructor(private readonly options: CodingTaskServiceOptions) {}

  async submitFileTask(input: CodingTaskSubmission): Promise<CodingTaskOutcome> {
    if (this.closed || this.cleanupFailed || this.active) throw taskError('TASK_ALREADY_ACTIVE');
    const initialHistory = disclosedTurns(input.visibleHistory);
    const owner: NonNullable<CodingTaskService['active']> = { controller: new AbortController(), done: Promise.resolve({ kind: 'completed' as const, acted: false }), permissions: new Map(), invalidPermission: false };
    this.active = owner;
    owner.done = this.runOwned(owner, { ...input, visibleHistory: [] }, initialHistory);
    return owner.done;
  }

  private async runOwned(owner: NonNullable<CodingTaskService['active']>, input: CodingTaskSubmission, initialHistory: NonNullable<CodingSessionOptions['initialHistory']>): Promise<CodingTaskOutcome> {
    let session: CodingSession | undefined;
    let acted = false;
    let phase: 'success' | 'error' | 'cancelled' = 'success';
    let lastCommandExit: number | undefined;
    const publish = (event: TaskEvent) => { if (this.active === owner && !this.closed) this.options.emit(event); };
    try {
      const configuration = await this.options.sessionOptions();
      if (owner.controller.signal.aborted) throw taskError('TASK_CANCELLED');
      session = await (this.options.createSession ?? createCodingSession)({
        ...configuration, initialHistory,
        onEvent: (event: CodingSessionEvent) => {
          if (this.active !== owner || owner.controller.signal.aborted || this.closed) return;
          if (event.type === 'permission') {
            try {
              if (owner.permissions.size >= 16 || owner.permissions.has(event.id)) throw taskError('PERMISSION_INVALID');
              const metadata = event.metadata as { command?: unknown; cwd?: unknown; repeatCount?: unknown } | undefined;
              if (event.action === 'doom_loop' && event.resources.length !== 1) throw taskError('PERMISSION_INVALID');
              const request = event.action === 'doom_loop'
                ? { action: event.action, tool: event.resources[0], repeatCount: metadata?.repeatCount }
                : event.action === 'bash'
                ? { action: event.action, resources: [...event.resources], command: metadata?.command, cwd: metadata?.cwd }
                : { action: event.action, resources: [...event.resources] };
              const dto = taskPermissionRequiredEventSchema.parse({ type: 'task_permission_required', actionId: event.id,
                summary: event.action === 'doom_loop' ? '重复操作保护' : event.action === 'bash' ? '运行未预先批准的命令' : event.action === 'delete' ? '移入回收站' : event.action === 'overwrite' ? '覆盖已有文件' : '访问授权目录之外的位置', request });
              if (dto.request.action === 'bash' && (!configuration.commandShell || dto.request.resources.length !== 1
                || dto.request.resources[0] !== commandResource(configuration.commandShell, dto.request.cwd, dto.request.command))) throw taskError('PERMISSION_INVALID');
              owner.permissions.set(event.id, { action: dto.request.action, replying: false });
              publish(dto);
            } catch { owner.invalidPermission = true; owner.controller.abort(); }
          }
          if (event.type === 'phase') {
            if (event.phase === 'failed') phase = 'error';
            else if (event.phase === 'cancelled') phase = 'cancelled';
            else if (event.phase === 'completed') phase = 'success';
            else publish({ type: 'phase', phase: event.phase === 'running' ? 'acting' : 'awaiting_confirmation' });
          }
          if (event.type === 'tool' && event.status !== 'running') {
            acted = true;
            if (event.name === 'bash') lastCommandExit = event.facts?.exit;
            this.options.emitTrustedToolResult?.({ toolName: event.name,
              ok: event.status === 'completed' && (event.facts?.exit === undefined || event.facts.exit === 0),
              relativePaths: [], ...(input.submissionOwner === undefined ? {} : { submissionOwner: input.submissionOwner }),
              ...(event.facts?.exit === undefined ? {} : { exit: event.facts.exit }) });
          }
        }
      });
      owner.session = session;
      const result = await session.run(input.text, owner.controller.signal);
      if (!owner.controller.signal.aborted) publish({ type: 'message', role: 'assistant', text: result.text || '任务已结束，模型未返回正文。' });
      if (lastCommandExit !== undefined && lastCommandExit !== 0) phase = 'error';
    } catch {
      phase = owner.controller.signal.aborted ? 'cancelled' : 'error';
    } finally {
      try { await session?.close(); } catch { this.cleanupFailed = true; phase = 'error'; }
      owner.permissions.clear();
      if (owner.controller.signal.aborted && !this.cleanupFailed) phase = owner.invalidPermission ? 'error' : 'cancelled';
      if (phase === 'error') publish({ type: 'error', code: 'CODING_TASK_FAILED', message: this.cleanupFailed ? '任务资源清理失败，当前任务入口已关闭，请重启应用。' : '任务执行失败，请根据实际操作结果检查后重试。' });
      if (phase === 'cancelled') publish({ type: 'message', role: 'assistant', text: '任务已取消；已完成的本地操作不会自动撤销。' });
      publish({ type: 'phase', phase });
      if (this.active === owner) this.active = null;
    }
    return { kind: 'completed', acted };
  }

  async cancelActive(): Promise<void> {
    if (this.cleanupFailed) throw taskError('CODING_TASK_CLEANUP_FAILED');
    const owner = this.active;
    if (!owner) return;
    owner.controller.abort();
    await owner.done;
    if (this.cleanupFailed) throw taskError('CODING_TASK_CLEANUP_FAILED');
  }
  async resetForNewConversation(): Promise<void> { await this.cancelActive(); }
  async close(): Promise<void> { this.closed = true; await this.cancelActive(); }
  async confirm(actionId: string): Promise<void> { await this.reply(actionId, 'once'); }
  async cancelAction(actionId: string): Promise<void> { await this.reply(actionId, 'reject'); }

  private async reply(actionId: string, decision: 'once' | 'reject'): Promise<void> {
    const owner = this.active;
    const pending = owner?.permissions.get(actionId);
    if (!taskPermissionIdSchema.safeParse(actionId).success || !owner?.session || owner.controller.signal.aborted || !pending || pending.replying) throw taskError('ACTION_EXPIRED');
    pending.replying = true;
    // 循环卡的结束先同步失效整个 owner，再等待原 run/close；不能先 reject 放跑原循环。
    if (decision === 'reject' && pending.action === 'doom_loop') {
      await this.cancelActive();
      return;
    }
    try {
      await owner.session.replyPermission(actionId, decision);
      owner.permissions.delete(actionId);
    } catch (error) {
      if (this.active === owner && !owner.controller.signal.aborted) pending.replying = false;
      throw taskError('ACTION_EXPIRED');
    }
  }
}

/** 披露端口只允许完整 user/assistant 正文，不承接旧工具转录或 system 消息。 */
function disclosedTurns(messages: readonly ModelMessage[]): NonNullable<CodingSessionOptions['initialHistory']> {
  if (messages.length % 2 !== 0 || messages.length > 40) throw taskError('HISTORY_INVALID');
  const turns: { userText: string; assistantText: string }[] = [];
  for (let index = 0; index < messages.length; index += 2) {
    const user = messages[index]!;
    const assistant = messages[index + 1]!;
    if (user.role !== 'user' || assistant.role !== 'assistant' || typeof user.content !== 'string' || typeof assistant.content !== 'string'
      || Object.keys(user).some(key => key !== 'role' && key !== 'content') || Object.keys(assistant).some(key => key !== 'role' && key !== 'content')) throw taskError('HISTORY_INVALID');
    turns.push({ userText: user.content, assistantText: assistant.content });
  }
  return turns;
}

function taskError(code: string): Error & { code: string } { return Object.assign(new Error(code), { code }); }
