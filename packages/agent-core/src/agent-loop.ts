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
  ModelMessage,
  ModelToolRequest,
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
  mutationFailureToolName: string | null;
  lastToolSignature: string | null;
  repeatedToolCalls: number;
  correctionUsed: boolean;
  expectedOperation: ExpectedCapabilityOperation | undefined;
  expectedOperationSatisfied: boolean;
};

type ExpectedCapabilityOperation = NonNullable<
  NonNullable<RunContext['capabilityPlanning']>['expectedOperation']
>;

const MAX_AGENT_TURNS = 4;
const MAX_IDENTICAL_TOOL_EXECUTIONS = 3;

const MUTATION_TOOL_NAMES = new Set<string>([
  'create_file',
  'create_directory',
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

function rejectedToolRequestForHistory(raw: unknown): ModelToolRequest | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const requestId = record['requestId'];
  const toolName = record['toolName'];
  const arguments_ = record['arguments'];
  if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 128) {
    return null;
  }
  if (typeof toolName !== 'string'
    || toolName.length === 0
    || toolName.length > 64
    || !/^[A-Za-z0-9_.-]+$/u.test(toolName)) {
    return null;
  }
  if (typeof arguments_ !== 'object' || arguments_ === null || Array.isArray(arguments_)) {
    return null;
  }
  return {
    requestId,
    toolName,
    arguments: arguments_ as Record<string, unknown>
  };
}

/** 工具结果在各 Provider 中都必须紧跟对应的 assistant 工具调用。 */
function appendRejectedToolFeedback(
  messages: ModelMessage[],
  raw: unknown,
  code: 'INVALID_TOOL_REQUEST' | 'TOOL_ARGUMENTS_INVALID'
): boolean {
  const toolRequest = rejectedToolRequestForHistory(raw);
  if (toolRequest === null) return false;
  messages.push({ role: 'assistant', content: '', toolRequest });
  messages.push({
    role: 'tool',
    toolCallId: toolRequest.requestId,
    content: JSON.stringify({ ok: false, code })
  });
  return true;
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalize(child)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export class AgentLoop {
  private readonly continuations = new Map<string, ContinuationState>();

  async *run(userText: string, context: RunContext): AsyncGenerator<AgentEvent, AgentRunOutcome> {
    const messages = [
      ...context.messages,
      { role: 'user' as const, content: userText }
    ];
    const expectedOperation = context.capabilityPlanning?.expectedOperation;
    return yield* this.continueRun(
      messages,
      0,
      context,
      false,
      undefined,
      false,
      null,
      null,
      0,
      false,
      expectedOperation,
      expectedOperation === undefined
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
      continuation.mutationFailureToolName,
      continuation.toolName,
      toolResult
    );
    const latestTrustedResultOk = trustedState.latestOk;
    const expectedOperationSatisfied = continuation.expectedOperationSatisfied || (
      continuation.expectedOperation !== undefined
      && matchesExpectedOperation(continuation.expectedOperation, continuation.toolName)
      && trustedResultSatisfied(continuation.toolName, toolResult)
    );
    if (continuation.nextTurn >= MAX_AGENT_TURNS) {
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
      trustedState.mutationFailureToolName,
      continuation.lastToolSignature,
      continuation.repeatedToolCalls,
      continuation.correctionUsed,
      continuation.expectedOperation,
      expectedOperationSatisfied
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
    mutationFailureToolName: string | null,
    lastToolSignature: string | null,
    repeatedToolCalls: number,
    correctionUsed: boolean,
    expectedOperation: ExpectedCapabilityOperation | undefined,
    expectedOperationSatisfied: boolean
  ): AsyncGenerator<AgentEvent, AgentRunOutcome> {
    if (context.signal.aborted) {
      yield { type: 'phase', phase: 'cancelled' };
      return;
    }

    yield { type: 'phase', phase: 'thinking' };

    for (let turn = startTurn; turn < MAX_AGENT_TURNS; turn += 1) {
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
        if (
          context.protocol === 'capability_planner'
          && hasTrustedToolResult
          && latestTrustedResultOk !== false
          && expectedOperation !== undefined
          && !expectedOperationSatisfied
        ) throw capabilityPlanProtocolError();
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
          throw new Error('AGENT_INVALID_TOOL_REQUEST');
        }
        if (!appendRejectedToolFeedback(messages, response.request, 'INVALID_TOOL_REQUEST')) {
          throw new Error('AGENT_INVALID_TOOL_REQUEST');
        }
        correctionUsed = true;
        continue;
      }

      let prepared: PreparedToolRequest;
      try {
        prepared = context.toolRuntime.prepare(response.request);
      } catch {
        // 显式能力规划的第二次参数违约必须使用稳定协议错误，避免被泛化为未知工具失败。
        if (correctionUsed) {
          throw context.protocol === 'capability_planner'
            ? capabilityPlanProtocolError()
            : new Error('AGENT_INVALID_TOOL_REQUEST');
        }
        if (!appendRejectedToolFeedback(messages, response.request, 'TOOL_ARGUMENTS_INVALID')) {
          throw new Error('AGENT_INVALID_TOOL_REQUEST');
        }
        correctionUsed = true;
        continue;
      }

      const signature = `${prepared.request.toolName}:${canonicalize(prepared.request.arguments)}`;
      if (signature === lastToolSignature) repeatedToolCalls += 1;
      else {
        lastToolSignature = signature;
        repeatedToolCalls = 1;
      }
      if (repeatedToolCalls > MAX_IDENTICAL_TOOL_EXECUTIONS) {
        throw Object.assign(new Error('AGENT_REPEATED_TOOL_CALL'), {
          code: 'AGENT_REPEATED_TOOL_CALL'
        });
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
          toolName: prepared.executionRequest.toolName,
          previousTrustedResultOk: latestTrustedResultOk,
          mutationFailurePending,
          mutationFailureToolName,
          lastToolSignature,
          repeatedToolCalls,
          correctionUsed,
          expectedOperation,
          expectedOperationSatisfied
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
        mutationFailureToolName,
        prepared.executionRequest.toolName,
        result
      );
      latestTrustedResultOk = trustedState.latestOk;
      mutationFailurePending = trustedState.mutationFailurePending;
      mutationFailureToolName = trustedState.mutationFailureToolName;
      if (
        expectedOperation !== undefined
        && matchesExpectedOperation(expectedOperation, prepared.executionRequest.toolName)
        && trustedResultSatisfied(prepared.executionRequest.toolName, result)
      ) expectedOperationSatisfied = true;
    }

    throw new Error('AGENT_MAX_TURNS');
  }
}

function normalizeOperationName(toolName: string): string {
  const leaf = toolName.split('.').at(-1) ?? toolName;
  if (leaf === 'read_text' || leaf === 'read_text_file') return 'read_file';
  if (leaf === 'list_directory') return 'list_files';
  return leaf;
}

function matchesExpectedOperation(
  expectedOperation: ExpectedCapabilityOperation,
  toolName: string
): boolean {
  return normalizeOperationName(toolName) === expectedOperation;
}

function trustedResultSatisfied(toolName: string, result: unknown): boolean {
  const normalizedOperation = normalizeOperationName(toolName);
  if (MUTATION_TOOL_NAMES.has(normalizedOperation)) return trustedResultOk(result) === true;
  return trustedResultOk(result) !== false;
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
  mutationFailureToolName: string | null,
  toolName: string,
  result: unknown
): Readonly<{
  latestOk: boolean | undefined;
  mutationFailurePending: boolean;
  mutationFailureToolName: string | null;
}> {
  const currentOk = trustedResultOk(result);
  if (MUTATION_TOOL_NAMES.has(toolName)) {
    if (mutationFailurePending) {
      // 不同 mutation 已形成第二个独立事实，单一同工具重试不再足以证明本轮全部恢复。
      if (mutationFailureToolName !== null && mutationFailureToolName !== toolName) {
        return { latestOk: false, mutationFailurePending: true, mutationFailureToolName: null };
      }
      if (currentOk === true && mutationFailureToolName === toolName) {
        return { latestOk: true, mutationFailurePending: false, mutationFailureToolName: null };
      }
      return { latestOk: false, mutationFailurePending: true, mutationFailureToolName };
    }
    if (currentOk === undefined) {
      return { latestOk: previousOk, mutationFailurePending: false, mutationFailureToolName: null };
    }
    return {
      latestOk: currentOk,
      mutationFailurePending: !currentOk,
      mutationFailureToolName: currentOk ? null : toolName
    };
  }
  if (mutationFailurePending) {
    return { latestOk: false, mutationFailurePending: true, mutationFailureToolName };
  }
  // 生产只读工具以成功返回值表示完成，不强制携带 ok；异常已在调用边界转换为 ok=false。
  return { latestOk: currentOk ?? true, mutationFailurePending: false, mutationFailureToolName: null };
}
