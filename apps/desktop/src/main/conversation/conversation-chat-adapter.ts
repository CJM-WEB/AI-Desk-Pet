import {
  capabilityControlPlanSchema,
  type CapabilityControlPlan,
  type ModelMessage,
  type ModelProvider,
  type ModelResponseContract
} from '@myself/agent-core';
import type { CharacterEmotionLabel } from '@myself/shared-types';
import {
  characterChatBehaviorPlanSchema,
  characterBehaviorDescriptorSchema,
  characterChatResponseJsonSchema,
  boundPublicBehaviorCatalogForModel,
  movementControlPlanSchema,
  type CharacterBehaviorPlan,
  type MovementControlPlan
} from '@myself/character-runtime';
import { ProviderResponseError } from '../providers/provider-response-error';
import { providerResponseCorrelationId } from '../providers/diagnosed-provider';
import type { ConversationBehaviorContext } from
  '../characters/character-behavior-director';

export const characterJsonOutputInstructions = [
  '请只返回 json 对象，不要添加对象外文字。',
  '每轮必须提供仅供 Main 使用的 activity 与 status，它们绝不显示给用户。',
  'behaviorPlan 每轮必填：有匹配项时返回 play_state，state 使用公开状态名；用户明确动作时 action 使用该状态内公开动作名，只指定状态时省略 action；没有匹配项时返回 kind=none。',
  'movementControl 每轮必填且只允许 keep、set_mode、move_once：没有运动要求用 keep。',
  '停止、保持静止、不要再动用 set_mode=0；一直、持续、保持运动用 set_mode=1；时不时、偶尔、间歇、恢复自主活动用 set_mode=2。',
  'mode=2 表示每段移动结束后回到 idle，再由 Main 随机等待 10–30 秒；mode=2 时 behaviorPlan 不得描述正在移动，只有 move_once 才描述本轮移动。',
  '只动一下、跑远一点或去屏幕某区域用 move_once；target 只能是 random_work_area 或公开屏幕区域，绝不提供坐标；distance 按用户语义选择 near、medium、far。',
  'capabilityPlan 每轮必填：普通聊天返回 {"kind":"chat"}；用户明确要求真实文件、目录或 PowerShell 操作时返回 {"kind":"agent_task","preferredTool":工具名或null}。它只用于请求 Main 授权，绝不表示已经执行。',
  '示例“停止不动”：movementControl={"kind":"set_mode","mode":0}。',
  '示例“时不时动一下”：movementControl={"kind":"set_mode","mode":2}。',
  '示例“跑远一点”：movementControl={"kind":"move_once","target":"random_work_area","distance":"far"}。',
  '格式示例：{"text":"我会陪着你。","activity":"安静陪伴","status":"idle","movementControl":{"kind":"keep"},"behaviorPlan":{"kind":"none","emotion":"calm"},"capabilityPlan":{"kind":"chat"}}'
].join('');

const 聊天系统消息前缀 = [
  '你是一只 AI 桌宠，请自然、直接地回复用户。',
  '优先使用用户使用的语言，并结合可见上下文作答。',
  '不要声称已执行任何尚未执行的文件操作。',
  '直接给出正常文本回复，可按需要使用 Markdown。',
  characterJsonOutputInstructions,
  '以下是 Main 提供的当前公开行为上下文，只能从清单中建议动作：'
].join('');
const 最大正文字符数 = 8_000;
/** 与本地 6,400-token 输入预算共同为 4,000 字符当前用户正文保留空间。 */
export const PUBLIC_CHARACTER_CHAT_SYSTEM_UTF8_BYTE_BUDGET = 4_800;
export const characterChatResponseContract: ModelResponseContract = {
  type: 'json_object' as const,
  name: 'character_chat' as const,
  jsonSchema: {
    ...characterChatResponseJsonSchema,
    required: [...characterChatResponseJsonSchema.required, 'capabilityPlan'],
    properties: {
      ...characterChatResponseJsonSchema.properties,
      capabilityPlan: {
        oneOf: [
          {
            type: 'object', additionalProperties: false, required: ['kind'],
            properties: { kind: { const: 'chat' } }
          },
          {
            type: 'object', additionalProperties: false,
            required: ['kind', 'preferredTool'],
            properties: {
              kind: { const: 'agent_task' },
              preferredTool: {
                enum: [
                  null, 'list_files', 'read_file', 'glob_files', 'grep_files',
                  'create_file', 'create_directory', 'apply_patch', 'edit_file',
                  'delete_file', 'move_file', 'powershell'
                ]
              }
            }
          }
        ]
      }
    }
  },
  textField: 'text' as const,
  allowPlainTextFallback: true as const
};

export interface ConversationChatInput {
  history: readonly ModelMessage[];
  text: string;
  behaviorContext: ConversationBehaviorContext;
  signal: AbortSignal;
  onTextDelta?: (delta: string) => void;
}

export type ConversationChatReply = Readonly<{
  text: string;
  emotion?: CharacterEmotionLabel;
  behaviorPlan?: CharacterBehaviorPlan;
  movementControl?: MovementControlPlan;
  activity?: string;
  status?: string;
  capabilityPlan?: CapabilityControlPlan;
}>;

export class ConversationChatAdapter {
  constructor(
    private readonly provider: ModelProvider,
    private readonly reportResponseError: (
      error: ProviderResponseError,
      correlationId?: string
    ) => void = () => undefined
  ) {}

  /**
   * 聊天层只负责受限请求与文本响应，不参与文件任务的决策或回退。
   */
  async respond(input: ConversationChatInput): Promise<ConversationChatReply> {
    const request = {
      messages: [
        { role: 'system', content: 构建聊天系统消息(input.behaviorContext) },
        ...input.history,
        { role: 'user', content: input.text }
      ],
      tools: [],
      toolChoice: 'none',
      reasoningMode: 'provider_default',
      responseContract: characterChatResponseContract,
      ...(input.onTextDelta === undefined ? {} : { onTextDelta: input.onTextDelta })
    } satisfies Parameters<ModelProvider['respond']>[0];
    const response = await this.provider.respond(request, input.signal);
    const correlationId = providerResponseCorrelationId(response);

    if (response.type !== 'text' || !是合法正文(response.text)) {
      const formatError = new ProviderResponseError(
        'RESPONSE_FORMAT_UNSUPPORTED',
        'chat_control'
      );
      this.reportResponseErrorSafely(formatError, correlationId);
      throw formatError;
    }
    const controls = 解析聊天控制字段(response);
    if (controls !== null) return { text: response.text, ...controls };

    const controlError = new ProviderResponseError('CONTROL_SCHEMA_INVALID', 'chat_control');
    this.reportResponseErrorSafely(controlError, correlationId);
    try {
      const repaired = await this.provider.respond(构建控制字段修复请求(request), input.signal);
      if (repaired.type === 'text' && repaired.structured_output !== undefined) {
        const repairedControls = 解析聊天控制字段(repaired);
        if (repairedControls !== null) return { text: response.text, ...repairedControls };
      }
    } catch (error) {
      if (input.signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
    }
    // 首次正文已通过可见边界；修复失败只丢弃控制副作用，不用错误替换正文。
    return { text: response.text };
  }

  private reportResponseErrorSafely(
    error: ProviderResponseError,
    correlationId?: string
  ): void {
    try {
      this.reportResponseError(error, correlationId);
    } catch {
      // 诊断上报仅尽力执行，不能替换正文回退或原始格式错误。
    }
  }
}

type ChatControls = Omit<ConversationChatReply, 'text'>;

/** 控制字段按一个原子计划校验；任一字段失败都不能提交其余副作用。 */
function 解析聊天控制字段(
  response: Extract<Awaited<ReturnType<ModelProvider['respond']>>, { type: 'text' }>
): ChatControls | null {
  if (response.structured_output === undefined) return null;
  const activity = characterBehaviorDescriptorSchema.safeParse(response.structured_output.activity);
  const status = characterBehaviorDescriptorSchema.safeParse(response.structured_output.status);
  const capabilityPlan = capabilityControlPlanSchema.safeParse(
    response.structured_output.capabilityPlan
  );
  const movementControl = movementControlPlanSchema.safeParse(
    response.structured_output.movementControl
  );
  const behaviorPlan = characterChatBehaviorPlanSchema.safeParse(
    response.structured_output.behaviorPlan
  );
  if (
    !activity.success
    || !status.success
    || !capabilityPlan.success
    || !movementControl.success
    || !behaviorPlan.success
  ) return null;

  const normalizedBehavior = behaviorPlan.data.kind === 'none'
    ? behaviorPlan.data.emotion === undefined
      ? { kind: 'none' as const }
      : { kind: 'none' as const, emotion: behaviorPlan.data.emotion }
    : {
        kind: 'play_state' as const,
        state: behaviorPlan.data.state,
        ...(behaviorPlan.data.action === undefined ? {} : { action: behaviorPlan.data.action }),
        ...(behaviorPlan.data.duration === undefined ? {} : { duration: behaviorPlan.data.duration }),
        ...(behaviorPlan.data.emotion === undefined ? {} : { emotion: behaviorPlan.data.emotion })
      };
  const emotion = response.emotion ?? behaviorPlan.data.emotion;
  return {
    activity: activity.data,
    status: status.data,
    capabilityPlan: capabilityPlan.data,
    movementControl: movementControl.data,
    behaviorPlan: normalizedBehavior,
    ...(emotion === undefined ? {} : { emotion })
  };
}

function 构建控制字段修复请求(
  request: Parameters<ModelProvider['respond']>[0]
): Parameters<ModelProvider['respond']>[0] {
  const { onTextDelta: _onTextDelta, ...bufferedRequest } = request;
  const [system, ...messages] = request.messages;
  const repairInstruction = '上次响应的控制字段不符合契约。请重新返回完整 JSON；此请求没有工具能力，不得声称执行了本地操作。';
  return {
    ...bufferedRequest,
    messages: system?.role === 'system'
      ? [{ ...system, content: `${system.content}${repairInstruction}` }, ...messages]
      : [{ role: 'system', content: repairInstruction }, ...request.messages],
    tools: [],
    toolChoice: 'none'
  };
}

function 构建聊天系统消息(context: ConversationBehaviorContext): string {
  const character = boundPublicBehaviorCatalogForModel(context.character);
  const recentActions = [...context.recentActions];
  let message = `${聊天系统消息前缀}${JSON.stringify({
    ...context,
    character,
    recentActions
  })}`;
  // 最近动作只是重复抑制提示；超出 system 总预算时优先移除最旧项，不碰当前正文。
  while (
    recentActions.length > 0
    && new TextEncoder().encode(message).byteLength > PUBLIC_CHARACTER_CHAT_SYSTEM_UTF8_BYTE_BUDGET
  ) {
    recentActions.shift();
    message = `${聊天系统消息前缀}${JSON.stringify({
      ...context,
      character,
      recentActions
    })}`;
  }
  return message;
}

/** 仅校验响应边界，保留合法正文的原始空白与 Markdown。 */
function 是合法正文(text: string): boolean {
  return text.trim().length > 0 && Array.from(text).length <= 最大正文字符数;
}
