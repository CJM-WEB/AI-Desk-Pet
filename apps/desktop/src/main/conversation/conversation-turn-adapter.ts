import type { ModelMessage, ModelProvider } from '@myself/agent-core';
import {
  characterEmotionLabelSchema,
  type CharacterEmotionLabel
} from '@myself/shared-types';
import { z } from 'zod';

const 固定澄清问题 = '我还不确定你是想聊天，还是希望我处理本地文件。可以再具体说明一下吗？';
const 最大正文字符数 = 8_000;
const 规划系统协议 = '只输出单个 JSON 对象；聊天结果含 kind/text，澄清结果含 kind/question，文件任务仅含 kind；不得输出 Markdown、工具请求或其他字段。';

const 有界文本 = z.string().min(1).refine(
  text => Array.from(text).length <= 最大正文字符数
);

const 规划结果模式 = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('chat_reply'),
    text: 有界文本,
    emotion: characterEmotionLabelSchema.optional()
  }).strict(),
  z.object({
    kind: z.literal('clarify'),
    question: 有界文本
  }).strict(),
  z.object({
    kind: z.literal('file_task')
  }).strict()
]);

export type TurnPlan =
  | { kind: 'chat_reply'; text: string; emotion?: CharacterEmotionLabel }
  | { kind: 'clarify'; question: string }
  | { kind: 'file_task' };

export interface ConversationTurnInput {
  history: readonly ModelMessage[];
  text: string;
  signal: AbortSignal;
}

export class ConversationTurnAdapter {
  constructor(private readonly provider: ModelProvider) {}

  /** 以无工具的受限协议把模型文本收敛为安全的单轮计划。 */
  async plan(input: ConversationTurnInput): Promise<TurnPlan> {
    const response = await this.provider.respond({
      messages: [
        { role: 'system', content: 规划系统协议 },
        ...input.history,
        { role: 'user', content: input.text }
      ],
      tools: []
    }, input.signal);

    if (response.type !== 'text') return 固定澄清计划();

    try {
      const parsed = 规划结果模式.safeParse(JSON.parse(response.text));
      if (!parsed.success) return 固定澄清计划();
      if (parsed.data.kind !== 'chat_reply') return parsed.data;
      return parsed.data.emotion === undefined
        ? { kind: 'chat_reply', text: parsed.data.text }
        : {
            kind: 'chat_reply',
            text: parsed.data.text,
            emotion: parsed.data.emotion
          };
    } catch {
      return 固定澄清计划();
    }
  }
}

/** 任何不可信规划输出都只返回固定澄清，不暴露解析细节。 */
function 固定澄清计划(): TurnPlan {
  return { kind: 'clarify', question: 固定澄清问题 };
}
