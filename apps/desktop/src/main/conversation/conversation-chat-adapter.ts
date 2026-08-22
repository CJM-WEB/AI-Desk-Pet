import type { ModelMessage, ModelProvider } from '@myself/agent-core';
import type { CharacterEmotionLabel } from '@myself/shared-types';
import {
  characterBehaviorPlanSchema,
  characterChatResponseJsonSchema,
  type CharacterBehaviorPlan
} from '@myself/character-runtime';
import { ProviderError } from '../providers/openai-provider';
import type { ConversationBehaviorContext } from
  '../characters/character-behavior-director';

export const characterJsonOutputInstructions = [
  '请只返回 json 对象，不要添加对象外文字。',
  '格式示例：{"text":"我会陪着你。","behaviorPlan":{"kind":"none","emotion":"calm"}}'
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
export const characterChatResponseContract = {
  type: 'json_object' as const,
  name: 'character_chat' as const,
  jsonSchema: characterChatResponseJsonSchema,
  textField: 'text' as const,
  allowPlainTextFallback: true as const
};

export interface ConversationChatInput {
  history: readonly ModelMessage[];
  text: string;
  behaviorContext: ConversationBehaviorContext;
  signal: AbortSignal;
}

export type ConversationChatReply = Readonly<{
  text: string;
  emotion?: CharacterEmotionLabel;
  behaviorPlan?: CharacterBehaviorPlan;
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
      responseContract: characterChatResponseContract
    }, input.signal);

    if (response.type !== 'text' || !是合法正文(response.text)) {
      throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
    }

    const reply: {
      text: string;
      emotion?: CharacterEmotionLabel;
      behaviorPlan?: CharacterBehaviorPlan;
    } = { text: response.text };
    if (response.emotion !== undefined) reply.emotion = response.emotion;

    // Provider 只恢复正文；行为计划必须再次经过本地角色契约校验。
    const behaviorPlan = characterBehaviorPlanSchema.safeParse(
      response.structured_output?.behaviorPlan
    );
    if (behaviorPlan.success) {
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
  return `${聊天系统消息前缀}${JSON.stringify(context)}`;
}

/** 仅校验响应边界，保留合法正文的原始空白与 Markdown。 */
function 是合法正文(text: string): boolean {
  return text.trim().length > 0 && Array.from(text).length <= 最大正文字符数;
}
