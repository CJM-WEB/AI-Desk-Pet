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
import { ProviderError } from '../providers/openai-provider';
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
  constructor(private readonly provider: ModelProvider) {}

  /**
   * 聊天层只负责受限请求与文本响应，不参与文件任务的决策或回退。
   */
  async respond(input: ConversationChatInput): Promise<ConversationChatReply> {
    const response = await this.provider.respond({
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
    }, input.signal);

    if (response.type !== 'text' || !是合法正文(response.text)) {
      throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
    }

    const reply: {
      text: string;
      emotion?: CharacterEmotionLabel;
      behaviorPlan?: CharacterBehaviorPlan;
      movementControl?: MovementControlPlan;
      activity?: string;
      status?: string;
      capabilityPlan?: CapabilityControlPlan;
    } = { text: response.text };
    if (response.emotion !== undefined) reply.emotion = response.emotion;
    const activity = characterBehaviorDescriptorSchema.safeParse(
      response.structured_output?.activity
    );
    const status = characterBehaviorDescriptorSchema.safeParse(
      response.structured_output?.status
    );
    if (activity.success) reply.activity = activity.data;
    if (status.success) reply.status = status.data;
    const capabilityPlan = capabilityControlPlanSchema.safeParse(
      response.structured_output?.capabilityPlan
    );
    if (capabilityPlan.success) reply.capabilityPlan = capabilityPlan.data;
    const movementControl = movementControlPlanSchema.safeParse(
      response.structured_output?.movementControl
    );
    if (movementControl.success) reply.movementControl = movementControl.data;

    // Provider 只恢复正文；行为计划必须再次经过本地角色契约校验。
    const behaviorPlan = characterChatBehaviorPlanSchema.safeParse(
      response.structured_output?.behaviorPlan
    );
    if (behaviorPlan.success) {
      // JSON Output 把情绪收敛在行为计划内；继续投影既有情绪事件以兼容角色扩展状态。
      if (reply.emotion === undefined
        && (behaviorPlan.data.kind === 'none' || behaviorPlan.data.kind === 'play_state')
        && behaviorPlan.data.emotion !== undefined) {
        reply.emotion = behaviorPlan.data.emotion;
      }
      // Zod 可选字段类型包含显式 undefined；这里重建两类可选分支以保持公共契约不变量。
      if (behaviorPlan.data.kind === 'none') {
        reply.behaviorPlan = behaviorPlan.data.emotion === undefined
          ? { kind: 'none' }
          : { kind: 'none', emotion: behaviorPlan.data.emotion };
      } else if (behaviorPlan.data.kind === 'play_state') {
        reply.behaviorPlan = {
          kind: 'play_state',
          state: behaviorPlan.data.state,
          ...(behaviorPlan.data.action === undefined ? {} : { action: behaviorPlan.data.action }),
          ...(behaviorPlan.data.duration === undefined ? {} : { duration: behaviorPlan.data.duration }),
          ...(behaviorPlan.data.emotion === undefined ? {} : { emotion: behaviorPlan.data.emotion })
        };
      }
    }
    return reply;
  }
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
