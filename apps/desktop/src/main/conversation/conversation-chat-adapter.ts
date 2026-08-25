import type { ModelMessage, ModelProvider, ModelResponseContract } from '@myself/agent-core';
import type { CharacterEmotionLabel } from '@myself/shared-types';
import {
  characterBehaviorPlanSchema,
  characterBehaviorDescriptorSchema,
  characterChatResponseSchema,
  characterChatResponseJsonSchema,
  motionPlanSchema,
  type CharacterBehaviorPlan,
  type MotionPlan
} from '@myself/character-runtime';
import { ProviderError } from '../providers/openai-provider';
import type { ConversationBehaviorContext } from
  '../characters/character-behavior-director';

export const characterJsonOutputInstructions = [
  '请只返回 json 对象，不要添加对象外文字。',
  '每轮必须提供仅供 Main 使用的 activity 与 status，它们绝不显示给用户。',
  'behaviorPlan 每轮必填：有匹配候选时原样复制 candidates 中的 kind 与 name；没有匹配候选时返回 kind=none，绝不编造目录外名称。',
  'motionPlan 每轮必填且只控制表现：停止不动用 stop；只移动一次用 once；保持、一会儿或持续运动用 continuous；不移动用 none。',
  'durationSeconds 只在用户给出运动时长时填写 1–600；持续到明确停止或没有时长时为 null。',
  'target 只能是 current、random_work_area 或公开屏幕区域，绝不提供坐标；distance 按用户语义选择 none、near、medium、far。',
  '示例“停止不动”：motionPlan={"mode":"stop","durationSeconds":null,"target":"current","distance":"none"}。',
  '示例“跑远一点”：motionPlan={"mode":"once","durationSeconds":null,"target":"random_work_area","distance":"far"}。',
  '格式示例：{"text":"我会陪着你。","activity":"安静陪伴","status":"idle","motionPlan":{"mode":"none","durationSeconds":null,"target":"current","distance":"none"},"behaviorPlan":{"kind":"none","emotion":"calm"}}'
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
export const characterChatResponseContract: ModelResponseContract = {
  type: 'json_object' as const,
  name: 'character_chat' as const,
  jsonSchema: characterChatResponseJsonSchema,
  textField: 'text' as const,
  allowPlainTextFallback: true as const,
  validateStructuredOutput: value => characterChatResponseSchema.safeParse(value).success
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
  motionPlan?: MotionPlan;
  activity?: string;
  status?: string;
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
      motionPlan?: MotionPlan;
      activity?: string;
      status?: string;
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
    const motionPlan = motionPlanSchema.safeParse(response.structured_output?.motionPlan);
    if (motionPlan.success) reply.motionPlan = motionPlan.data;

    // Provider 只恢复正文；行为计划必须再次经过本地角色契约校验。
    const behaviorPlan = characterBehaviorPlanSchema.safeParse(
      response.structured_output?.behaviorPlan
    );
    if (behaviorPlan.success) {
      // JSON Output 把情绪收敛在行为计划内；继续投影既有情绪事件以兼容角色扩展状态。
      if (reply.emotion === undefined
        && (behaviorPlan.data.kind === 'none' || behaviorPlan.data.kind === 'play')
        && behaviorPlan.data.emotion !== undefined) {
        reply.emotion = behaviorPlan.data.emotion;
      }
      // Zod 可选字段类型包含显式 undefined；这里重建两类可选分支以保持公共契约不变量。
      if (behaviorPlan.data.kind === 'none') {
        reply.behaviorPlan = behaviorPlan.data.emotion === undefined
          ? { kind: 'none' }
          : { kind: 'none', emotion: behaviorPlan.data.emotion };
      } else if (behaviorPlan.data.kind === 'play') {
        reply.behaviorPlan = behaviorPlan.data.emotion === undefined
          ? { kind: 'play', target: behaviorPlan.data.target }
          : {
              kind: 'play',
              target: behaviorPlan.data.target,
              emotion: behaviorPlan.data.emotion
            };
      } else {
        reply.behaviorPlan = behaviorPlan.data;
      }
    }
    return reply;
  }
}

function 构建聊天系统消息(context: ConversationBehaviorContext): string {
  const candidates = context.character.candidates;
  if (!candidates?.length) return `${聊天系统消息前缀}${JSON.stringify(context)}`;
  const compactContext = {
    ...context,
    character: {
      characterName: context.character.characterName,
      semantics: context.character.semantics,
      candidates
    }
  };
  // candidates 已逐项携带 kind/name/semantic/tags；只省略可推导的聚合字段，候选对象原样保留。
  return `${聊天系统消息前缀}${JSON.stringify(compactContext)}`;
}

/** 仅校验响应边界，保留合法正文的原始空白与 Markdown。 */
function 是合法正文(text: string): boolean {
  return text.trim().length > 0 && Array.from(text).length <= 最大正文字符数;
}
