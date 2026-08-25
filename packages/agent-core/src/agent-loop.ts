import { randomUUID } from 'node:crypto';
import { characterAgentBehaviorIntentSchema } from '@myself/character-runtime';
import { characterEmotionLabelSchema } from '@myself/shared-types';
import {
  CAPABILITY_CLARIFICATION_TOOL_NAME,
  capabilityClarificationToolDefinition,
  getCapabilityClarificationMessage,
  parseCapabilityClarificationRequest
} from './capability-clarification-tool';
import { createToolFailureResult } from './tool-result';
import type {
  AgentEvent,
  AgentRunOutcome,
  FileWriteOperation,
  ModelMessage,
  PreparedToolRequest,
  RunContext
} from './types';

type ContinuationState = {
  messages: ModelMessage[];
  nextTurn: number;
  requestId: string;
  toolName: string;
  previousTrustedResultOk: boolean | undefined;
  mutationFailurePending: boolean;
  expectedWriteOperation: FileWriteOperation | undefined;
};

const MUTATION_TOOL_NAMES = new Set<string>([
  'create_file',
  'create_directory',
  'copy_file',
  'apply_patch',
  'edit_file',
  'delete_file',
  'move_file',
  'powershell'
]);

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function capabilityPlanProtocolError(): Error {
  return Object.assign(new Error('CAPABILITY_PLAN_PROTOCOL_INVALID'), {
    code: 'CAPABILITY_PLAN_PROTOCOL_INVALID'
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

function requestedToolName(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const toolName = (raw as Record<string, unknown>)['toolName'];
  return typeof toolName === 'string' ? toolName : null;
}

function isExpectedWriteResult(result: unknown, expectedOperation: FileWriteOperation): boolean {
  return typeof result === 'object'
    && result !== null
    && !Array.isArray(result)
    && typeof (result as Record<string, unknown>)['ok'] === 'boolean'
    && (result as Record<string, unknown>)['toolName'] === expectedOperation;
}

export class AgentLoop {
  private readonly continuations = new Map<string, ContinuationState>();

  async *run(userText: string, context: RunContext): AsyncGenerator<AgentEvent, AgentRunOutcome> {
    const messages = [
      ...context.messages,
      { role: 'user' as const, content: userText }
    ];
    return yield* this.continueRun(
      messages,
      0,
      context,
      false,
      undefined,
      false,
      context.capabilityPlanning?.expectedWriteOperation
    );
  }

  async *resume(
    continuationToken: string,
    toolResult: unknown,
    context: RunContext
  ): AsyncGenerator<AgentEvent, AgentRunOutcome> {
    const continuation = this.continuations.get(continuationToken);
    if (!continuation) throw new Error('ACTION_EXPIRED');
    this.continuations.delete(continuationToken);

    continuation.messages.push({
      role: 'tool',
      toolCallId: continuation.requestId,
      content: JSON.stringify(toolResult)
    });
    const trustedState = nextTrustedResultState(
      continuation.previousTrustedResultOk,
      continuation.mutationFailurePending,
      continuation.toolName,
      toolResult
    );
    const latestTrustedResultOk = trustedState.latestOk;
    if (continuation.expectedWriteOperation !== undefined
      && !isExpectedWriteResult(toolResult, continuation.expectedWriteOperation)) {
      throw capabilityPlanProtocolError();
    }
    if (continuation.nextTurn >= 4) {
      yield { type: 'message', text: '本地能力操作已结束；已达到模型响应轮次上限。' };
      yield { type: 'phase', phase: latestTrustedResultOk === false ? 'error' : 'success' };
      return;
    }
    return yield* this.continueRun(
      continuation.messages,
      continuation.nextTurn,
      context,
      true,
      latestTrustedResultOk,
      trustedState.mutationFailurePending,
      undefined
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
    mutationFailurePending: boolean,
    expectedWriteOperation: FileWriteOperation | undefined
  ): AsyncGenerator<AgentEvent, AgentRunOutcome> {
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
      const allowClarification = context.capabilityPlanning?.allowClarification !== false;
      const planningTools = context.capabilityPlanning?.planningTools ?? context.tools;
      const tools = planning
        ? allowClarification
          ? [...planningTools, capabilityClarificationToolDefinition]
          : [...planningTools]
        : context.tools;
      let response;
      try {
        response = await context.provider.respond({
          messages,
          tools,
          toolChoice: planning ? 'required' : 'auto',
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
            content: 'CAPABILITY_PLAN_PROTOCOL_INVALID：能力规划必须调用当前提供的工具。缺少执行必需参数时，只能调用当前提供的无权限结构化澄清工具；确认由宿主在工具调用后处理。请仅修正一次。'
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
        // Main 的真实工具失败优先于模型总结；失败后绝不公开可能伪称成功的模型正文。
        yield {
          type: 'message',
          text: latestTrustedResultOk === false
            ? '本地能力操作失败，未完成请求。'
            : response.text
        };
        yield { type: 'phase', phase: latestTrustedResultOk === false ? 'error' : 'success' };
        return;
      }

      if (isCapabilityClarificationToolRequest(response.request)) {
        if (!planning || !allowClarification) throw new Error('AGENT_INVALID_TOOL_REQUEST');
        try {
          const clarification = parseCapabilityClarificationRequest(response.request.arguments);
          yield {
            type: 'message',
            text: getCapabilityClarificationMessage(clarification.missingField)
          };
          yield { type: 'phase', phase: latestTrustedResultOk === false ? 'error' : 'success' };
          return { kind: 'clarification', missingField: clarification.missingField };
        } catch {
          if (correctionUsed) throw capabilityPlanProtocolError();
          correctionUsed = true;
          messages.push({
            role: 'system',
            content: 'CAPABILITY_PLAN_PROTOCOL_INVALID：澄清工具参数必须是只含 missingField 的严格对象，并从当前 Schema 的固定枚举中选择一个缺失字段。确认和公开文案均由宿主处理。请仅修正一次。'
          });
          continue;
        }
      }

      // 运行时不得信任 ToolRuntime 的宽松实现；模型请求必须来自本轮实际公告的工具表。
      const requestedName = requestedToolName(response.request);
      if (requestedName === null || !tools.some(tool => tool.function.name === requestedName)) {
        if (correctionUsed) {
          if (expectedWriteOperation !== undefined) throw capabilityPlanProtocolError();
          throw new Error('AGENT_INVALID_TOOL_REQUEST');
        }
        correctionUsed = true;
        messages.push({
          role: 'system',
          content: 'INVALID_TOOL_REQUEST：只能调用当前已提供的工具。请修正一次。'
        });
        continue;
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
        if (expectedWriteOperation !== undefined
          && prepared.executionRequest.toolName !== expectedWriteOperation) {
          if (correctionUsed) throw capabilityPlanProtocolError();
          correctionUsed = true;
          messages.push({
            role: 'system',
            content: 'CAPABILITY_PLAN_PROTOCOL_INVALID：本轮写任务必须调用与请求一致的受控写工具。请修正一次。'
          });
          continue;
        }
        const continuationToken = `continue_${randomUUID()}`;
        this.continuations.set(continuationToken, {
          messages: [...messages],
          nextTurn: turn + 1,
          requestId: prepared.request.requestId,
          toolName: prepared.executionRequest.toolName,
          previousTrustedResultOk: latestTrustedResultOk,
          mutationFailurePending,
          expectedWriteOperation
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

      if (expectedWriteOperation !== undefined) {
        if (correctionUsed) throw capabilityPlanProtocolError();
        correctionUsed = true;
        messages.push({
          role: 'system',
          content: 'CAPABILITY_PLAN_PROTOCOL_INVALID：本轮写任务必须先调用与请求一致的受控写工具。请修正一次。'
        });
        continue;
      }

      yield { type: 'phase', phase: 'acting' };
      let result: unknown;
      try {
        result = await context.toolRuntime.executeRead(prepared.executionRequest);
      } catch (error) {
        result = createToolFailureResult(prepared.executionRequest.toolName, error);
      }
      messages.push({
        role: 'tool',
        toolCallId: prepared.request.requestId,
        content: JSON.stringify(result)
      });
      hasTrustedToolResult = true;
      const trustedState = nextTrustedResultState(
        latestTrustedResultOk,
        mutationFailurePending,
        prepared.executionRequest.toolName,
        result
      );
      latestTrustedResultOk = trustedState.latestOk;
      mutationFailurePending = trustedState.mutationFailurePending;
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

/** mutation 失败保持粘性；只读结果仍保留自身失败语义，但不能替 mutation 宣告恢复。 */
function nextTrustedResultState(
  previousOk: boolean | undefined,
  mutationFailurePending: boolean,
  toolName: string,
  result: unknown
): Readonly<{ latestOk: boolean | undefined; mutationFailurePending: boolean }> {
  const currentOk = trustedResultOk(result);
  if (MUTATION_TOOL_NAMES.has(toolName)) {
    if (currentOk === undefined) {
      return { latestOk: mutationFailurePending ? false : previousOk, mutationFailurePending };
    }
    return { latestOk: currentOk, mutationFailurePending: !currentOk };
  }
  if (mutationFailurePending) return { latestOk: false, mutationFailurePending: true };
  return { latestOk: currentOk ?? previousOk, mutationFailurePending: false };
}
