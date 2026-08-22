import { randomUUID } from 'node:crypto';
import { characterAgentBehaviorIntentSchema } from '@myself/character-runtime';
import { characterEmotionLabelSchema } from '@myself/shared-types';
import {
  CAPABILITY_CLARIFICATION_TOOL_NAME,
  capabilityClarificationToolDefinition,
  isCapabilityClarificationExecutionConfirmation,
  parseCapabilityClarificationRequest
} from './capability-clarification-tool';
import type {
  AgentEvent,
  ModelMessage,
  PreparedToolRequest,
  RunContext
} from './types';

type ContinuationState = {
  messages: ModelMessage[];
  nextTurn: number;
  requestId: string;
  latestTrustedResultOk: boolean | undefined;
  finalizationOnly: true;
};

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function capabilityPlanProtocolError(): Error {
  return Object.assign(new Error('CAPABILITY_PLAN_PROTOCOL_INVALID'), {
    code: 'CAPABILITY_PLAN_PROTOCOL_INVALID'
  });
}

function finalizationOnlyToolError(): Error {
  return Object.assign(new Error('AGENT_FINALIZATION_TOOL_REQUEST'), {
    code: 'AGENT_FINALIZATION_TOOL_REQUEST'
  });
}

/** 澄清工具由 AgentLoop 消费，绝不进入具备本地能力的 ToolRuntime。 */
function isCapabilityClarificationToolRequest(raw: unknown): raw is Readonly<{
  toolName: typeof CAPABILITY_CLARIFICATION_TOOL_NAME;
  arguments: unknown;
}> {
  return typeof raw === 'object'
    && raw !== null
    && !Array.isArray(raw)
    && (raw as Record<string, unknown>).toolName === CAPABILITY_CLARIFICATION_TOOL_NAME;
}

export class AgentLoop {
  private readonly continuations = new Map<string, ContinuationState>();

  async *run(userText: string, context: RunContext): AsyncGenerator<AgentEvent> {
    const messages = [
      ...context.messages,
      { role: 'user' as const, content: userText }
    ];
    yield* this.continueRun(messages, 0, context, false, undefined, false);
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
    const latestTrustedResultOk = trustedResultOk(toolResult);
    if (continuation.nextTurn >= 4) {
      yield { type: 'message', text: '本地能力操作已结束；已达到模型响应轮次上限。' };
      yield { type: 'phase', phase: latestTrustedResultOk === false ? 'error' : 'success' };
      return;
    }
    yield* this.continueRun(
      continuation.messages,
      continuation.nextTurn,
      context,
      true,
      latestTrustedResultOk,
      continuation.finalizationOnly
    );
  }

  discard(continuationToken: string): void {
    this.continuations.delete(continuationToken);
  }

  private async *continueRun(
    messages: ModelMessage[],
    startTurn: number,
    context: RunContext,
    hasTrustedToolResult: boolean,
    latestTrustedResultOk: boolean | undefined,
    finalizationOnly: boolean
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

      const planning = context.protocol === 'capability_planner' && !hasTrustedToolResult;
      const tools = finalizationOnly
        ? []
        : planning
          ? [...context.tools, capabilityClarificationToolDefinition]
          : context.tools;
      let response;
      try {
        response = await context.provider.respond({
          messages,
          tools,
          toolChoice: finalizationOnly ? 'none' : planning ? 'required' : 'auto',
          reasoningMode: context.protocol === 'capability_planner'
            ? 'disabled'
            : 'provider_default'
        }, context.signal);
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
        if (context.protocol === 'capability_planner' && !hasTrustedToolResult) {
          if (correctionUsed) throw capabilityPlanProtocolError();
          correctionUsed = true;
          messages.push({
            role: 'system',
            content: 'CAPABILITY_PLAN_PROTOCOL_INVALID：能力规划必须调用当前提供的工具。缺少执行必需参数时，只能调用 builtin.capability.request_clarification；确认由宿主在工具调用后处理。请仅修正一次。'
          });
          continue;
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
        yield { type: 'phase', phase: latestTrustedResultOk === false ? 'error' : 'success' };
        return;
      }

      if (finalizationOnly) throw finalizationOnlyToolError();

      if (isCapabilityClarificationToolRequest(response.request)) {
        if (!planning) throw new Error('AGENT_INVALID_TOOL_REQUEST');
        try {
          const clarification = parseCapabilityClarificationRequest(response.request.arguments);
          if (isCapabilityClarificationExecutionConfirmation(clarification.question)) {
            throw new Error('CAPABILITY_CLARIFICATION_EXECUTION_CONFIRMATION');
          }
          yield { type: 'message', text: clarification.question };
          yield { type: 'phase', phase: latestTrustedResultOk === false ? 'error' : 'success' };
          return;
        } catch {
          if (correctionUsed) throw capabilityPlanProtocolError();
          correctionUsed = true;
          messages.push({
            role: 'system',
            content: 'CAPABILITY_PLAN_PROTOCOL_INVALID：澄清工具只能询问缺失的执行必需参数，参数必须是只含非空 question 的严格对象。确认由宿主在工具调用后处理。请仅修正一次。'
          });
          continue;
        }
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
          requestId: prepared.request.requestId,
          latestTrustedResultOk,
          finalizationOnly: true
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
      latestTrustedResultOk = trustedResultOk(result);
    }

    throw new Error('AGENT_MAX_TURNS');
  }
}

/** 本地执行结果是终态的唯一事实；没有 ok 字段时保持既有兼容语义。 */
function trustedResultOk(result: unknown): boolean | undefined {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return undefined;
  const ok = (result as Record<string, unknown>)['ok'];
  return typeof ok === 'boolean' ? ok : undefined;
}
