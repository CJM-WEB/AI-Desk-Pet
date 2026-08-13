import type { ModelMessage, ModelProvider } from '@myself/agent-core';
import type { CharacterEmotionLabel } from '@myself/shared-types';
import { ProviderError } from '../providers/openai-provider';

const 聊天系统消息 = [
  '你是一只 AI 桌宠，请自然、直接地回复用户。',
  '优先使用用户使用的语言，并结合可见上下文作答。',
  '不要声称已执行任何尚未执行的文件操作。',
  '直接给出正常文本回复，可按需要使用 Markdown。'
].join('');
const 最大正文字符数 = 8_000;

export interface ConversationChatInput {
  history: readonly ModelMessage[];
  text: string;
  signal: AbortSignal;
}

export type ConversationChatReply = Readonly<{
  text: string;
  emotion?: CharacterEmotionLabel;
}>;

export class ConversationChatAdapter {
  constructor(private readonly provider: ModelProvider) {}

  /**
   * 聊天层只负责受限请求与文本响应，不参与文件任务的决策或回退。
   */
  async respond(input: ConversationChatInput): Promise<ConversationChatReply> {
    const response = await this.provider.respond({
      messages: [
        { role: 'system', content: 聊天系统消息 },
        ...input.history,
        { role: 'user', content: input.text }
      ],
      tools: []
    }, input.signal);

    if (response.type !== 'text' || !是合法正文(response.text)) {
      throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
    }

    return response.emotion === undefined
      ? { text: response.text }
      : { text: response.text, emotion: response.emotion };
  }
}

/** 仅校验响应边界，保留合法正文的原始空白与 Markdown。 */
function 是合法正文(text: string): boolean {
  return text.trim().length > 0 && Array.from(text).length <= 最大正文字符数;
}
