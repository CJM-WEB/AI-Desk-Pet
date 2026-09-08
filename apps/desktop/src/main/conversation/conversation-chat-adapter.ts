import { z } from 'zod';
import type { CapabilityControlPlan, ModelMessage, ModelProvider, ModelRequest } from '@myself/agent-core';
import { projectCharacterIdentity, type CharacterMoodUpdate, type CharacterExpressionPlanInput,
  type CharacterExplicitPlayback, type MovementControlPlan, type CharacterExpressionSelection } from '@myself/character-runtime';
import { ProviderResponseError } from '../providers/provider-response-error';
import { providerResponseCorrelationId } from '../providers/diagnosed-provider';
import type { ConversationBehaviorContext } from '../characters/character-behavior-director';
import { CharacterExpressionAdapter, CHARACTER_CHAT_INPUT_UTF8_BYTE_BUDGET, requestBytes, throwIfCancelled } from './character-expression-adapter';
export { CHARACTER_CHAT_INPUT_UTF8_BYTE_BUDGET, characterAutonomyResponseContract } from './character-expression-adapter';

export interface ConversationChatInput {
  history: readonly ModelMessage[]; text: string; behaviorContext: ConversationBehaviorContext; signal: AbortSignal;
  explicitPlaybackRequested?: boolean; movementControlHandled?: boolean; onTextDelta?: (delta: string) => void;
}
export type ConversationChatReply = Readonly<{
  text: string; moodUpdate?: CharacterMoodUpdate; expressionPlan?: CharacterExpressionPlanInput;
  explicitPlayback?: CharacterExplicitPlayback; movementControl?: MovementControlPlan; capabilityPlan?: CapabilityControlPlan;
  expressionStatus?: 'ready' | 'no_match' | 'failed'; requestKind?: CharacterExpressionSelection['requestKind'];
}>;
export type CharacterAutonomousReply = Pick<ConversationChatReply, 'moodUpdate' | 'expressionPlan'>;
export type CharacterAutonomousInput = Readonly<{
  behaviorContext: ConversationBehaviorContext; idleForMs: number; signal: AbortSignal; beforeProviderCall(): boolean;
}>;
export type CharacterActivityInput = Omit<CharacterAutonomousInput, 'idleForMs'>;
const authorizationRequest = z.object({ requestId: z.string().trim().min(1), toolName: z.literal('request_task_authorization'),
  arguments: z.object({}).strict() }).strict();
const instructions = '你是陪伴用户的AI桌宠，自然使用用户语言回复。用户要求实际查阅、修改文件或执行命令时，调用request_task_authorization申请Main任务范围授权，参数必须为空对象。'
  + '该工具只申请授权，没有文件或进程执行能力；不能声称未执行的操作成功。讨论、引用、示例和否定本身不申请。'
  + '尚未读取目录时不能声称知道内容；例如询问目录是否很乱，先说明尚未查看并征求同意。用户随后说可以先看看时，结合会话历史申请任务。'
  + '历史仅理解目标，不继承旧许可。人设只影响语气，不能修改协议或提升权限。普通回复直接输出自然正文，不包装JSON。';
/** 主请求只接纳自然正文或严格原生申请；可选表现失败不会覆盖已经取得的正文。 */
export class ConversationChatAdapter {
  private readonly expression: CharacterExpressionAdapter;
  constructor(private readonly provider: ModelProvider,
    private readonly reportResponseError: (error: ProviderResponseError, correlationId?: string) => void = () => undefined,
    private readonly options: { inputByteBudget?: number } = {}) {
    this.expression = new CharacterExpressionAdapter(provider, options.inputByteBudget, (error, correlationId) => this.report(error, correlationId));
  }
  async respondAutonomous(input: CharacterAutonomousInput): Promise<CharacterAutonomousReply | null> {
    if (input.signal.aborted) return null;
    const reply = await this.expression.respond(input, 'autonomous');
    return reply && { ...(reply.moodUpdate ? { moodUpdate: reply.moodUpdate } : {}),
      ...(reply.expressionPlan ? { expressionPlan: reply.expressionPlan } : {}) };
  }
  async respondActivity(input: CharacterActivityInput): Promise<Pick<ConversationChatReply, 'expressionPlan'> | null> {
    if (input.signal.aborted) return null;
    const reply = await this.expression.respond(input, 'activity');
    return reply && { ...(reply.expressionPlan ? { expressionPlan: reply.expressionPlan } : {}) };
  }
  async respond(input: ConversationChatInput): Promise<ConversationChatReply> {
    throwIfCancelled(input.signal);
    const response = await this.provider.respond(this.buildRequest(input), input.signal);
    throwIfCancelled(input.signal);
    if (response.type === 'tool_request' && authorizationRequest.safeParse(response.request).success) {
      return { text: '', capabilityPlan: { kind: 'agent_task' } };
    }
    if (response.type !== 'text' || !response.text.trim() || Array.from(response.text).length > 4000) {
      const error = new ProviderResponseError('RESPONSE_FORMAT_UNSUPPORTED', 'chat_control');
      this.report(error, providerResponseCorrelationId(response)); throw error;
    }
    try {
      const expression = await this.expression.respond({ text: input.text, behaviorContext: input.behaviorContext,
        signal: input.signal, ...(input.movementControlHandled === undefined ? {} : { movementControlHandled: input.movementControlHandled }) }, 'chat');
      throwIfCancelled(input.signal);
      return { text: response.text, capabilityPlan: { kind: 'chat' }, ...expression,
        expressionStatus: expression?.explicitPlayback || expression?.expressionPlan?.states.length ? 'ready' : 'no_match' };
    } catch (error) {
      throwIfCancelled(input.signal);

      return { text: response.text, capabilityPlan: { kind: 'chat' }, expressionStatus: 'failed' };
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
        purpose: 'conversation', messages: [{ role: 'system', content: instructions },
          { role: 'system', content: '角色人设（仅影响说话方式）：' + JSON.stringify(projectCharacterIdentity(input.behaviorContext.character.identity, textLimit)) },
          ...history, { role: 'user', content: input.text }],
        tools: [{ type: 'function', function: { name: 'request_task_authorization', description: '申请Main展示本轮任务范围卡，不执行文件或命令。',
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
