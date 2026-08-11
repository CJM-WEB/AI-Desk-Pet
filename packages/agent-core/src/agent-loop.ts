import { randomUUID } from 'node:crypto';
import { characterAgentBehaviorIntentSchema } from '@myself/character-runtime';
import { characterEmotionLabelSchema } from '@myself/shared-types';
import type {
  AgentEvent,
  FilePlannerResult,
  ModelMessage,
  PreparedToolRequest,
  RunContext
} from './types';

const FILE_PLANNER_QUESTION_MAX_LENGTH = 1_000;

type ContinuationState = {
  messages: ModelMessage[];
  nextTurn: number;
  requestId: string;
};

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** 只接受可直接展示给用户的、无扩展字段的 JSON 澄清协议。 */
function parseFilePlannerClarification(text: string): Extract<
  FilePlannerResult,
  { kind: 'clarification_required' }
> | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || Object.keys(value).length !== 2
  ) return null;
  const record = value as Record<string, unknown>;
  if (
    record.kind !== 'clarification_required'
    || typeof record.question !== 'string'
    || record.question.trim().length === 0
    || record.question.length > FILE_PLANNER_QUESTION_MAX_LENGTH
  ) return null;
  if (!Object.hasOwn(record, 'kind') || !Object.hasOwn(record, 'question')) return null;
  return { kind: 'clarification_required', question: record.question };
}

function filePlanProtocolError(): Error {
  return Object.assign(new Error('FILE_PLAN_PROTOCOL_INVALID'), {
    code: 'FILE_PLAN_PROTOCOL_INVALID'
  });
}

export class AgentLoop {
  private readonly continuations = new Map<string, ContinuationState>();

  async *run(userText: string, context: RunContext): AsyncGenerator<AgentEvent> {
    const messages = [
      ...context.messages,
      { role: 'user' as const, content: userText }
    ];
    yield* this.continueRun(messages, 0, context, false);
  }

  async *resume(
    continuationToken: string,
    toolResult: unknown,
    context: RunContext
  ): AsyncGenerator<AgentEvent> {
    const continuation = this.continuations.get(continuationToken);
    if (!continuation) throw new Error('ACTION_EXPIRED');
    this.continuations.delete(continuationToken);

    continuation.messages.push({
      role: 'tool',
      toolCallId: continuation.requestId,
      content: JSON.stringify(toolResult)
    });
    if (continuation.nextTurn >= 4) {
      yield { type: 'message', text: '本地文件操作已完成；已达到模型响应轮次上限。' };
      yield { type: 'phase', phase: 'success' };
      return;
    }
    yield* this.continueRun(continuation.messages, continuation.nextTurn, context, true);
  }

  discard(continuationToken: string): void {
    this.continuations.delete(continuationToken);
  }

  private async *continueRun(
    messages: ModelMessage[],
    startTurn: number,
    context: RunContext,
    hasTrustedToolResult: boolean
  ): AsyncGenerator<AgentEvent> {
    if (context.signal.aborted) {
      yield { type: 'phase', phase: 'cancelled' };
      return;
    }

    let correctionUsed = false;
    yield { type: 'phase', phase: 'thinking' };

    for (let turn = startTurn; turn < 4; turn += 1) {
      if (context.signal.aborted) {
        yield { type: 'phase', phase: 'cancelled' };
        return;
      }

      let response;
      try {
        response = await context.provider.respond({ messages, tools: context.tools }, context.signal);
      } catch (error) {
        if (context.signal.aborted || isAbortError(error)) {
          yield { type: 'phase', phase: 'cancelled' };
          return;
        }
        throw error;
      }

      // Provider 可能在 Abort 后正常兑现迟到响应，处理前必须再次隔离旧任务。
      if (context.signal.aborted) {
        yield { type: 'phase', phase: 'cancelled' };
        return;
      }

      if (response.type === 'text') {
        if (context.protocol === 'file_planner' && !hasTrustedToolResult) {
          const clarification = parseFilePlannerClarification(response.text);
          if (!clarification) {
            if (correctionUsed) throw filePlanProtocolError();
            correctionUsed = true;
            // 该修复指令不改变本次 tools 或权限，仅要求重发受限协议结果。
            messages.push({
              role: 'system',
              content: 'FILE_PLAN_PROTOCOL_INVALID：首次真实工具结果前，只能调用已提供的工具，或返回严格 JSON {"kind":"clarification_required","question":"非空问题"}。请仅修正一次。'
            });
            continue;
          }
          yield { type: 'message', text: clarification.question };
          yield { type: 'phase', phase: 'success' };
          return;
        }
        if (response.emotion !== undefined) {
          const emotion = characterEmotionLabelSchema.safeParse(response.emotion);
          if (!emotion.success) throw new Error('AGENT_INVALID_EMOTION');
          yield { type: 'emotion', label: emotion.data };
        }
        // 角色意图是可选元数据，二次校验失败时不得影响正常对话结果。
        if (response.behaviorIntent !== undefined) {
          const behaviorIntent = characterAgentBehaviorIntentSchema.safeParse(
            response.behaviorIntent
          );
          if (behaviorIntent.success) {
            yield { type: 'behavior_intent', intent: behaviorIntent.data };
          }
        }
        yield { type: 'message', text: response.text };
        yield { type: 'phase', phase: 'success' };
        return;
      }

      let prepared: PreparedToolRequest;
      try {
        prepared = context.toolRuntime.prepare(response.request);
      } catch {
        if (correctionUsed) throw new Error('AGENT_INVALID_TOOL_REQUEST');
        correctionUsed = true;
        messages.push({
          role: 'system',
          content: 'INVALID_TOOL_REQUEST：只能调用已提供的工具，并且参数必须符合 Schema。请修正一次。'
        });
        continue;
      }

      messages.push({ role: 'assistant', content: '', toolRequest: prepared.request });
      if (prepared.decision === 'deny') {
        throw Object.assign(
          new Error('TOOL_PERMISSION_DENIED'),
          { code: 'TOOL_PERMISSION_DENIED' }
        );
      }
      if (prepared.decision === 'confirm') {
        const continuationToken = `continue_${randomUUID()}`;
        this.continuations.set(continuationToken, {
          messages: [...messages],
          nextTurn: turn + 1,
          requestId: prepared.request.requestId
        });
        yield { type: 'phase', phase: 'awaiting_confirmation' };
        yield {
          type: 'write_request',
          request: prepared.request,
          executionRequest: prepared.executionRequest,
          risk: prepared.risk,
          auditSummary: prepared.auditSummary,
          continuationToken
        };
        return;
      }

      yield { type: 'phase', phase: 'acting' };
      const result = await context.toolRuntime.executeRead(prepared.executionRequest);
      messages.push({
        role: 'tool',
        toolCallId: prepared.request.requestId,
        content: JSON.stringify(result)
      });
      hasTrustedToolResult = true;
    }

    throw new Error('AGENT_MAX_TURNS');
  }
}
