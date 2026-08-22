import type { ModelProvider, ModelRequest, ModelResponse } from '@myself/agent-core';
import { characterChatResponseJsonSchema } from '@myself/character-runtime';
import { describe, expect, test, vi } from 'vitest';
import { ProviderError } from '../src/main/providers/openai-provider';
import { ConversationChatAdapter } from '../src/main/conversation/conversation-chat-adapter';

function 响应为(response: ModelResponse): ModelProvider {
  return {
    respond: vi.fn(async () => response)
  };
}

function 取得请求(provider: ModelProvider): ModelRequest {
  const 调用 = vi.mocked(provider.respond).mock.calls[0];
  if (!调用) throw new Error('未收到模型请求');
  return 调用[0];
}

describe('ConversationChatAdapter', () => {
  test('用固定系统消息、历史和当前用户文本发起无工具聊天请求', async () => {
    const provider = 响应为({ type: 'text', text: '你好！' });
    const adapter = new ConversationChatAdapter(provider);
    const history = [{ role: 'assistant' as const, content: '上一轮回复' }];

    await expect(adapter.respond({
      history,
      text: '这一轮问题',
      signal: new AbortController().signal
    })).resolves.toEqual({ text: '你好！' });

    expect(取得请求(provider)).toEqual({
      messages: [
        {
          role: 'system',
          content: expect.stringContaining('AI 桌宠')
        },
        ...history,
        { role: 'user', content: '这一轮问题' }
      ],
      tools: [],
      toolChoice: 'none',
      reasoningMode: 'provider_default',
      responseContract: {
        type: 'json_object',
        name: 'character_chat',
        jsonSchema: characterChatResponseJsonSchema,
        textField: 'text',
        allowPlainTextFallback: true
      }
    });
    expect(取得请求(provider).messages[0]?.content).toContain('用户使用的语言');
    expect(取得请求(provider).messages[0]?.content).toContain('可见上下文');
    expect(取得请求(provider).messages[0]?.content).toContain('尚未执行的文件操作');
    expect(取得请求(provider).messages[0]?.content).not.toContain('JSON');
    expect(取得请求(provider).messages[0]?.content).not.toContain('路由字段');
    expect(取得请求(provider).messages[0]?.content).not.toContain('禁止 Markdown');
  });

  test('原样返回中文、Markdown、代码块和已归一化情绪', async () => {
    const provider = 响应为({
      type: 'text',
      text: '  当然可以。\n\n```ts\nconst 宠物 = "你好";\n```\n',
      emotion: 'happy'
    });
    const adapter = new ConversationChatAdapter(provider);

    await expect(adapter.respond({
      history: [],
      text: '给我一个例子',
      signal: new AbortController().signal
    })).resolves.toEqual({
      text: '  当然可以。\n\n```ts\nconst 宠物 = "你好";\n```\n',
      emotion: 'happy'
    });
  });

  test('只返回本地严格校验通过的行为计划', async () => {
    const provider = 响应为({
      type: 'text',
      text: '我向左走一点。',
      structured_output: {
        text: '我向左走一点。',
        behaviorPlan: { kind: 'move', direction: 'left', distance: 'near' }
      }
    });
    const adapter = new ConversationChatAdapter(provider);

    await expect(adapter.respond({
      history: [],
      text: '向左走一点',
      signal: new AbortController().signal
    })).resolves.toEqual({
      text: '我向左走一点。',
      behaviorPlan: { kind: 'move', direction: 'left', distance: 'near' }
    });
  });

  test('丢弃非法行为计划并保留正文与既有合法情绪', async () => {
    const provider = 响应为({
      type: 'text',
      text: '正文仍然可见。',
      emotion: 'calm',
      structured_output: {
        text: '正文仍然可见。',
        behaviorPlan: { kind: 'move', direction: 'outside', distance: 'near' }
      }
    });
    const adapter = new ConversationChatAdapter(provider);

    await expect(adapter.respond({
      history: [],
      text: '测试非法计划',
      signal: new AbortController().signal
    })).resolves.toEqual({ text: '正文仍然可见。', emotion: 'calm' });
  });

  test('普通聊天忽略旧 behaviorIntent 元数据', async () => {
    const provider = 响应为({
      type: 'text',
      text: '只保留正文。',
      behaviorIntent: {
        stateIntent: { semantic: 'move' },
        actionSemantic: 'move',
        urgency: 100,
        explanation: '普通聊天不得消费旧意图。'
      }
    });
    const adapter = new ConversationChatAdapter(provider);

    await expect(adapter.respond({
      history: [],
      text: '普通聊天',
      signal: new AbortController().signal
    })).resolves.toEqual({ text: '只保留正文。' });
  });

  test.each([
    ['空白正文', ' \n\t '],
    ['超过 Unicode 字符上限的正文', `${'😀'.repeat(8_000)}好`]
  ])('拒绝%s且错误不暴露原始正文', async (_名称, text) => {
    const provider = 响应为({ type: 'text', text });
    const adapter = new ConversationChatAdapter(provider);

    const error = await adapter.respond({
      history: [],
      text: '测试输入',
      signal: new AbortController().signal
    }).catch(reason => reason);

    expect(error).toMatchObject({
      code: 'PROVIDER_MALFORMED_RESPONSE',
      retryable: false
    });
    expect(String(error)).not.toContain(text);
  });

  test('拒绝工具调用且错误不暴露工具内容', async () => {
    const provider = 响应为({
      type: 'tool_request',
      request: {
        requestId: 'private-request',
        toolName: 'read_file',
        arguments: { path: 'private-content' }
      }
    });
    const adapter = new ConversationChatAdapter(provider);

    const error = await adapter.respond({
      history: [],
      text: '测试输入',
      signal: new AbortController().signal
    }).catch(reason => reason);

    expect(error).toMatchObject({
      code: 'PROVIDER_MALFORMED_RESPONSE',
      retryable: false
    });
    expect(String(error)).not.toContain('private-content');
  });

  test('保留取消和超时错误的既有分类', async () => {
    const abortError = new DOMException('取消', 'AbortError');
    const timeoutError = new ProviderError('PROVIDER_TIMEOUT', true);
    const abortProvider: ModelProvider = {
      respond: vi.fn(async () => { throw abortError; })
    };
    const timeoutProvider: ModelProvider = {
      respond: vi.fn(async () => { throw timeoutError; })
    };

    await expect(new ConversationChatAdapter(abortProvider).respond({
      history: [],
      text: '取消',
      signal: new AbortController().signal
    })).rejects.toBe(abortError);
    await expect(new ConversationChatAdapter(timeoutProvider).respond({
      history: [],
      text: '超时',
      signal: new AbortController().signal
    })).rejects.toBe(timeoutError);
  });
});
