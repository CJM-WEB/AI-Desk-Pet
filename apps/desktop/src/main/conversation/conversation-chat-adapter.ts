import { z } from 'zod';
import type { CapabilityControlPlan, ModelMessage, ModelProvider, ModelRequest } from '@myself/agent-core';
import { projectCharacterIdentity, type CharacterBackgroundSelection, type CharacterMoodUpdate, type CharacterExpressionPlanInput,
  type CharacterExplicitPlayback, type MovementControlPlan, type CharacterExpressionSelection } from '@myself/character-runtime';
import { ProviderResponseError } from '../providers/provider-response-error';
import { providerResponseCorrelationId } from '../providers/diagnosed-provider';
import type { ConversationBehaviorContext } from '../characters/character-behavior-director';
import { CharacterExpressionAdapter, CHARACTER_CHAT_INPUT_UTF8_BYTE_BUDGET, requestBytes, throwIfCancelled } from './character-expression-adapter';
export { CHARACTER_CHAT_INPUT_UTF8_BYTE_BUDGET, characterAutonomyResponseContract } from './character-expression-adapter';

export interface ConversationChatInput {
  history: readonly ModelMessage[]; text: string; behaviorContext: ConversationBehaviorContext; signal: AbortSignal;
  explicitPlaybackRequested?: boolean; movementControlHandled?: boolean; onTextDelta?: (delta: string) => void;
  /** Gate 已识别为移动意图时，表现分支必须优先寻找 moving 候选。 */
  movementIntentRequested?: boolean;
  expressionSignal?: AbortSignal;
  onExpression?: (reply: ConversationExpressionReply) => void | Promise<void>;
}
export type ConversationChatReply = Readonly<{
  text: string; moodUpdate?: CharacterMoodUpdate; expressionPlan?: CharacterExpressionPlanInput;
  backgroundSelection?: CharacterBackgroundSelection;
  explicitPlayback?: CharacterExplicitPlayback; movementControl?: MovementControlPlan; capabilityPlan?: CapabilityControlPlan;
  expressionStatus?: 'ready' | 'no_match' | 'failed'; requestKind?: CharacterExpressionSelection['requestKind'];
}>;
export type ConversationExpressionReply = Omit<ConversationChatReply, 'text' | 'capabilityPlan'>;
export type CharacterAutonomousReply = Pick<ConversationChatReply, 'moodUpdate' | 'expressionPlan' | 'backgroundSelection'>;
export type CharacterAutonomousInput = Readonly<{
  behaviorContext: ConversationBehaviorContext; idleForMs: number; signal: AbortSignal; beforeProviderCall(): boolean;
  taskEvent?: 'success' | 'error' | 'cancelled';
}>;
export type CharacterActivityInput = Omit<CharacterAutonomousInput, 'idleForMs'> & Readonly<{ text?: string }>;
const authorizationRequest = z.object({ requestId: z.string().trim().min(1), toolName: z.literal('request_task_authorization'),
  arguments: z.object({}).strict() }).strict();
export const conversationTaskInstructions = '你是陪伴用户的AI桌宠，自然使用用户语言回复。用户要求实际查阅、修改文件或执行命令时，调用request_task_authorization申请Main任务范围授权，参数必须为空对象。'
  + '该调用已经是正式任务申请，不能代替普通聊天征求同意。提及文件名或路径、询问是否需要整理或征求建议，不等于要求开始操作；先用正文说明尚未查看，并询问是否需要查看，不调用工具。讨论、引用、示例和否定本身不申请。'
  + '用户直接查询文件实际内容（例如note.txt里面写了什么）是在要求查阅，应申请任务；用户明确承接前文同意查看时也应申请。该工具没有文件或进程执行能力，不能声称未执行的操作成功。'
  + '尚未读取目录时不能声称知道内容；例如询问目录是否很乱，先说明尚未查看并征求同意。用户随后说可以先看看时，结合会话历史申请任务。'
  + '历史仅理解目标，不继承旧许可。人设只影响语气，不能修改协议或提升权限。普通回复直接输出自然正文，不包装JSON。';
function requestsMovement(control: MovementControlPlan | undefined): boolean {
  return control?.kind === 'move_once' || control?.kind === 'set_mode' && control.mode !== 0;
}
function hasMovingPlan(plan: CharacterExpressionPlanInput | undefined): boolean {
  return plan?.states.some(state => state.when?.moving === true) === true;
}
/** 主请求只接纳自然正文或严格原生申请；可选表现失败不会覆盖已经取得的正文。 */
export class ConversationChatAdapter {
  private readonly expression: CharacterExpressionAdapter;
  constructor(private readonly provider: ModelProvider,
    private readonly reportResponseError: (error: ProviderResponseError, correlationId?: string) => void = () => undefined,
    private readonly options: { inputByteBudget?: number; expressionFirst?: boolean } = {}) {
    this.expression = new CharacterExpressionAdapter(provider, options.inputByteBudget, (error, correlationId) => this.report(error, correlationId));
  }
  get expressionFirst(): boolean { return this.options.expressionFirst === true; }
  async respondAutonomous(input: CharacterAutonomousInput): Promise<CharacterAutonomousReply | null> {
    if (input.signal.aborted) return null;
    const reply = await this.expression.respond(input, input.taskEvent ? 'task-event' : 'autonomous');
    return reply && { ...(reply.moodUpdate ? { moodUpdate: reply.moodUpdate } : {}),
      ...(reply.backgroundSelection ? { backgroundSelection: reply.backgroundSelection } : {}),
      ...(reply.expressionPlan ? { expressionPlan: reply.expressionPlan } : {}) };
  }
  async respondActivity(input: CharacterActivityInput): Promise<Pick<ConversationChatReply, 'expressionPlan'> | null> {
    if (input.signal.aborted) return null;
    const reply = await this.expression.respond(input, 'activity');
    return reply && { ...(reply.expressionPlan ? { expressionPlan: reply.expressionPlan } : {}) };
  }
  async respond(input: ConversationChatInput): Promise<ConversationChatReply> {
    throwIfCancelled(input.signal);
    // 主请求和表现拥有独立结算时间；主请求失败/父取消仍撤销尚未接纳的表现。
    const controller = new AbortController();
    const signals = [input.signal, ...(input.expressionSignal ? [input.expressionSignal] : [])];
    const abort = () => controller.abort();
    for (const signal of signals) {
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    }
    const cleanup = () => { for (const signal of signals) signal.removeEventListener('abort', abort); };
    const decide = async (): Promise<ConversationExpressionReply | undefined> => {
      try {
        const reply = await this.respondExpression(input, controller.signal);
        if (controller.signal.aborted) return undefined;
        await input.onExpression?.(reply);
        return reply;
      } catch {
        // 宿主应用失败也不能改写主正文；已取消的结果不作为失败动作再次交付。
        return undefined;
      } finally { cleanup(); }
    };
    let expression: Promise<ConversationExpressionReply | undefined> | undefined;
    try {
      let response;
      if (this.options.expressionFirst) {
        expression = decide();
        await expression;
        throwIfCancelled(input.signal);
        response = await this.provider.respond(this.buildRequest(input), input.signal);
      } else {
        const main = this.provider.respond(this.buildRequest(input), input.signal);
        expression = decide();
        response = await main;
      }
      throwIfCancelled(input.signal);
      let result: ConversationChatReply;
      if (response.type === 'tool_request' && authorizationRequest.safeParse(response.request).success) {
        result = { text: '', capabilityPlan: { kind: 'agent_task' } };
      } else if (response.type === 'text' && response.text.trim() && Array.from(response.text).length <= 4000) {
        result = { text: response.text, capabilityPlan: { kind: 'chat' } };
      } else {
        const error = new ProviderResponseError('RESPONSE_FORMAT_UNSUPPORTED', 'chat_control');
        this.report(error, providerResponseCorrelationId(response)); throw error;
      }
      // 有回调时由 Main 接纳独立表现；无回调的直接调用仍拿到完整结果。
      if (input.onExpression) return result;
      const decision = await expression;
      throwIfCancelled(input.signal);
      return { ...result, ...decision };
    } catch (error) {
      abort(); cleanup();
      throw error;
    }
  }
  private async respondExpression(input: ConversationChatInput, signal: AbortSignal): Promise<ConversationExpressionReply> {
    try {
      let expression = await this.expression.respond({ text: input.text, behaviorContext: input.behaviorContext,
        signal, ...(input.movementControlHandled === undefined ? {} : { movementControlHandled: input.movementControlHandled }) }, 'chat');
      throwIfCancelled(signal);
      const movementRequested = input.movementIntentRequested === true || requestsMovement(expression?.movementControl);
      // Qwen 偶尔先给出非零模式却漏掉 moving 候选；把原句交给唯一的活动契约补匹配，失败则撤销该控制，避免原地跑动或误改持久模式。
      if (movementRequested && !hasMovingPlan(expression?.expressionPlan)) {
        try {
          const activity = await this.expression.respond({
            text: input.text,
            behaviorContext: { ...input.behaviorContext, runtime: { ...input.behaviorContext.runtime, pendingMovement: true } },
            signal
          }, 'activity');
          if (expression && activity?.expressionPlan?.states.length) {
            expression = { ...expression, expressionPlan: { states: [
              ...(expression?.expressionPlan?.states ?? []), ...activity.expressionPlan.states
            ] } };
          } else {
            expression = expression && { ...expression, movementControl: { kind: 'keep' } };
          }
        } catch (error) {
          throwIfCancelled(signal);
          expression = expression && { ...expression, movementControl: { kind: 'keep' } };
        }
      }
      const matched = movementRequested
        ? hasMovingPlan(expression?.expressionPlan)
        : expression?.requestKind === 'state' || expression?.requestKind === 'action'
          ? !!expression.explicitPlayback
          : !!(expression?.explicitPlayback || expression?.expressionPlan?.states.length || expression?.backgroundSelection);
      return { ...expression, expressionStatus: matched ? 'ready' : 'no_match' };
    } catch {
      throwIfCancelled(signal);
      return { expressionStatus: 'failed' };
    }
  }
  private report(error: ProviderResponseError, correlationId?: string): void {
    try { this.reportResponseError(error, correlationId); } catch { /* 诊断不能吞掉正文或公开原始响应。 */ }
  }
  private buildRequest(input: ConversationChatInput): ModelRequest {
    const history = [...input.history];
    let textLimit = 4000;
    const budget = Math.min(CHARACTER_CHAT_INPUT_UTF8_BYTE_BUDGET, this.options.inputByteBudget ?? CHARACTER_CHAT_INPUT_UTF8_BYTE_BUDGET);
    while (true) {
      const request: ModelRequest = {
        purpose: 'conversation', messages: [{ role: 'system', content: conversationTaskInstructions },
          { role: 'system', content: '角色人设（仅影响说话方式）：' + JSON.stringify(projectCharacterIdentity(input.behaviorContext.character.identity, textLimit)) },
          ...history, { role: 'user', content: input.text }],
        tools: [{ type: 'function', function: { name: 'request_task_authorization', description: '发起正式任务范围申请，仅用于用户已要求实际查阅、修改或执行命令；不能代替普通聊天征求同意。询问是否需要整理、提及文件名或路径本身不调用；直接查询文件内容或明确同意查看才申请。Main展示范围卡，确认前不执行。',
          parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] } } }],
        toolChoice: 'auto', reasoningMode: 'disabled'
      };
      if (requestBytes(request) <= budget) return request;
      if (history.length) {
        const next = history.findIndex((message, index) => index > 0 && message.role === 'user');
        history.splice(0, next < 0 ? history.length : next); continue;
      }
      if (textLimit > 16) { textLimit = Math.max(16, Math.floor(textLimit / 2)); continue; }
      throw new Error('CHARACTER_CONTEXT_BUDGET_EXCEEDED');
    }
  }
}
