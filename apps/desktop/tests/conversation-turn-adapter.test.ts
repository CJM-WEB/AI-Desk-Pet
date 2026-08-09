import type { ModelProvider, ModelRequest, ModelResponse } from '@myself/agent-core';
import { describe, expect, test } from 'vitest';
import { ConversationTurnAdapter } from '../src/main/conversation/conversation-turn-adapter';

const 固定澄清问题 = '我还不确定你是想聊天，还是希望我处理本地文件。可以再具体说明一下吗？';
const 系统协议 = '只输出单个 JSON 对象；聊天结果含 kind/text，澄清结果含 kind/question，文件任务仅含 kind；不得输出 Markdown、工具请求或其他字段。';

function input(text = '你好') {
  return {
    history: [
      { role: 'user' as const, content: '上一轮用户消息' },
      { role: 'assistant' as const, content: '上一轮助手回复' }
    ],
    text,
    signal: new AbortController().signal
  };
}

function scriptedProvider(response: ModelResponse) {
  const requests: ModelRequest[] = [];
  const model: ModelProvider = {
    async respond(request) {
      requests.push(request);
      return response;
    }
  };
  return { model, requests };
}

describe('ConversationTurnAdapter', () => {
  test.each([
    ['聊天', '{"kind":"chat_reply","text":"当然可以陪你聊聊。","emotion":"calm"}', {
      kind: 'chat_reply', text: '当然可以陪你聊聊。', emotion: 'calm'
    }],
    ['澄清', '{"kind":"clarify","question":"你希望整理哪个文件夹？"}', {
      kind: 'clarify', question: '你希望整理哪个文件夹？'
    }]
  ])('严格解析合法%s规划结果', async (_名称, text, expected) => {
    const provider = scriptedProvider({ type: 'text', text });
    const adapter = new ConversationTurnAdapter(provider.model);

    await expect(adapter.plan(input())).resolves.toEqual(expected);
  });

  test('规划请求恒为空工具并严格解析文件任务', async () => {
    const provider = scriptedProvider({
      type: 'text',
      text: '{"kind":"file_task"}'
    });
    const adapter = new ConversationTurnAdapter(provider.model);

    await expect(adapter.plan(input('列出桌面文件'))).resolves.toEqual({
      kind: 'file_task'
    });
    expect(provider.requests).toEqual([{
      messages: [
        { role: 'system', content: 系统协议 },
        { role: 'user', content: '上一轮用户消息' },
        { role: 'assistant', content: '上一轮助手回复' },
        { role: 'user', content: '列出桌面文件' }
      ],
      tools: []
    }]);
  });

  test.each([
    ['Markdown 包裹 JSON', { type: 'text' as const, text: '```json\n{"kind":"file_task"}\n```' }],
    ['未知字段', { type: 'text' as const, text: '{"kind":"file_task","extra":true}' }],
    ['混合结果字段', { type: 'text' as const, text: '{"kind":"chat_reply","text":"你好","question":"要处理文件吗？"}' }],
    ['非法情绪', { type: 'text' as const, text: '{"kind":"chat_reply","text":"你好","emotion":"excited"}' }],
    ['空文本', { type: 'text' as const, text: '{"kind":"chat_reply","text":""}' }],
    ['工具调用', { type: 'tool_request' as const, request: { name: 'read_file' } }]
  ])('将%s保守降级为固定澄清', async (_名称, response) => {
    const adapter = new ConversationTurnAdapter(scriptedProvider(response).model);

    await expect(adapter.plan(input())).resolves.toEqual({
      kind: 'clarify',
      question: 固定澄清问题
    });
  });

  test.each([
    ['聊天回复', 'chat_reply', 'text'],
    ['澄清问题', 'clarify', 'question']
  ])('按 Unicode 字符限制%s正文', async (_名称, kind, field) => {
    const 正好上限 = '🐾'.repeat(8_000);
    const 超过上限 = '🐾'.repeat(8_001);
    const adapter = new ConversationTurnAdapter(scriptedProvider({
      type: 'text',
      text: JSON.stringify({ kind, [field]: 正好上限 })
    }).model);
    const 超长适配器 = new ConversationTurnAdapter(scriptedProvider({
      type: 'text',
      text: JSON.stringify({ kind, [field]: 超过上限 })
    }).model);

    await expect(adapter.plan(input())).resolves.toMatchObject({ kind, [field]: 正好上限 });
    await expect(超长适配器.plan(input())).resolves.toEqual({
      kind: 'clarify',
      question: 固定澄清问题
    });
  });

  test('继续抛出 Provider 失败', async () => {
    const expected = new DOMException('已取消', 'AbortError');
    const adapter = new ConversationTurnAdapter({
      async respond() {
        throw expected;
      }
    });

    await expect(adapter.plan(input())).rejects.toBe(expected);
  });
});
