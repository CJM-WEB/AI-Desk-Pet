import type { ModelProvider, ModelRequest, ModelResponse } from '@myself/agent-core';
import { characterChatResponseJsonSchema } from '@myself/character-runtime';
import { describe, expect, test, vi } from 'vitest';
import { ProviderError } from '../src/main/providers/openai-provider';
import { ConversationChatAdapter } from '../src/main/conversation/conversation-chat-adapter';

const behaviorContext = {
  character: {
    characterName: '小橘',
    semantics: ['idle', 'move', 'celebrate'] as const,
    stateNames: ['开心'],
    actionNames: ['挥手'],
    tags: ['friendly']
  },
  runtime: {
    moving: false,
    dragging: false,
    carrying: false,
    movementStopped: false
  },
  proactivityMode: 'assistive' as const,
  recentActions: ['挥手']
};

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
      behaviorContext,
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
        allowPlainTextFallback: true,
        validateStructuredOutput: expect.any(Function)
      }
    });
    expect(取得请求(provider).messages[0]?.content).toContain('用户使用的语言');
    expect(取得请求(provider).messages[0]?.content).toContain('可见上下文');
    expect(取得请求(provider).messages[0]?.content).toContain('尚未执行的文件操作');
    expect(取得请求(provider).messages[0]?.content).toContain('"characterName":"小橘"');
    expect(取得请求(provider).messages[0]?.content).toContain('"movementStopped":false');
    expect(取得请求(provider).messages[0]?.content).toContain('"proactivityMode":"assistive"');
    expect(取得请求(provider).messages[0]?.content).toContain('"recentActions":["挥手"]');
    expect(取得请求(provider).messages[0]?.content).toContain('json');
    expect(取得请求(provider).messages[0]?.content).toContain(
      '{"text":"我会陪着你。","activity":"安静陪伴","status":"idle","motionPlan":{"mode":"none","durationSeconds":null,"target":"current","distance":"none"},"behaviorPlan":{"kind":"none","emotion":"calm"}}'
    );
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
      behaviorContext,
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
      behaviorContext,
      signal: new AbortController().signal
    })).resolves.toEqual({
      text: '我向左走一点。',
      behaviorPlan: { kind: 'move', direction: 'left', distance: 'near' }
    });
  });

  test('只把本地严格校验通过的隐藏 motionPlan 交给 Main', async () => {
    const provider = 响应为({
      type: 'text',
      text: '我会继续走。',
      structured_output: {
        text: '我会继续走。',
        motionPlan: {
          mode: 'continuous', durationSeconds: 20, target: 'random_work_area', distance: 'far'
        },
        behaviorPlan: { kind: 'none' }
      }
    });

    await expect(new ConversationChatAdapter(provider).respond({
      history: [], text: '继续活动', behaviorContext, signal: new AbortController().signal
    })).resolves.toEqual({
      text: '我会继续走。',
      motionPlan: {
        mode: 'continuous', durationSeconds: 20, target: 'random_work_area', distance: 'far'
      },
      behaviorPlan: { kind: 'none' }
    });
  });

  test('忽略非法隐藏 motionPlan 但保留可见正文', async () => {
    const provider = 响应为({
      type: 'text',
      text: '正文仍然可见。',
      structured_output: {
        text: '正文仍然可见。',
        motionPlan: {
          mode: 'continuous', durationSeconds: 601, target: { x: 1, y: 2 }, distance: 'far'
        }
      }
    });

    await expect(new ConversationChatAdapter(provider).respond({
      history: [], text: '测试', behaviorContext, signal: new AbortController().signal
    })).resolves.toEqual({ text: '正文仍然可见。' });
  });

  test('隐藏 activity/status 仅随回复交给 Main，不出现在可见正文', async () => {
    const provider = 响应为({
      type: 'text',
      text: '我来活动一下。',
      structured_output: {
        text: '我来活动一下。',
        activity: '轻快移动',
        status: 'move'
      }
    });

    await expect(new ConversationChatAdapter(provider).respond({
      history: [], text: '请你移动', behaviorContext, signal: new AbortController().signal
    })).resolves.toEqual({
      text: '我来活动一下。', activity: '轻快移动', status: 'move'
    });
  });

  test('隐藏 activity/status 在本地裁剪空白并丢弃空值或超长值', async () => {
    const provider = 响应为({
      type: 'text',
      text: '正文保持可用。',
      structured_output: {
        activity: '  轻快移动  ',
        status: '跑'.repeat(121)
      }
    });

    await expect(new ConversationChatAdapter(provider).respond({
      history: [], text: '请你移动', behaviorContext, signal: new AbortController().signal
    })).resolves.toEqual({ text: '正文保持可用。', activity: '轻快移动' });
  });

  test('JSON 契约要求隐藏 activity/status，且不把它们作为可见文本字段', () => {
    expect(characterChatResponseJsonSchema.required).toEqual(
      expect.arrayContaining(['text', 'activity', 'status'])
    );
    expect(characterChatResponseJsonSchema.properties).toHaveProperty('activity');
    expect(characterChatResponseJsonSchema.properties).toHaveProperty('status');
  });

  test('行为 candidates 存在时序列化上下文不重复发送可推导的名称与标签聚合', async () => {
    const provider = 响应为({ type: 'text', text: '好的' });
    const adapter = new ConversationChatAdapter(provider);
    const candidate = {
      kind: 'action_name' as const,
      name: '自定义巡游',
      semantic: 'move',
      tags: ['locomotion', 'friendly']
    };

    await adapter.respond({
      history: [],
      text: '走一走',
      behaviorContext: {
        ...behaviorContext,
        character: {
          ...behaviorContext.character,
          stateNames: ['自定义待机'],
          actionNames: ['自定义巡游'],
          tags: ['locomotion', 'friendly'],
          candidates: [candidate]
        }
      },
      signal: new AbortController().signal
    });

    const system = 取得请求(provider).messages[0]?.content ?? '';
    const contextStart = system.lastIndexOf('{"character":');
    expect(contextStart).toBeGreaterThanOrEqual(0);
    const serializedContext = JSON.parse(system.slice(contextStart)) as {
      character: Record<string, unknown>;
    };
    expect(serializedContext.character.candidates).toEqual([candidate]);
    expect(serializedContext.character).not.toHaveProperty('stateNames');
    expect(serializedContext.character).not.toHaveProperty('actionNames');
    expect(serializedContext.character).not.toHaveProperty('tags');
  });

  test('把 JSON Output 行为计划中的合法情绪投影为聊天情绪', async () => {
    const provider = 响应为({
      type: 'text',
      text: '今天真开心。',
      structured_output: {
        text: '今天真开心。',
        behaviorPlan: { kind: 'none', emotion: 'happy' }
      }
    });
    const adapter = new ConversationChatAdapter(provider);

    await expect(adapter.respond({
      history: [],
      text: '我今天很开心',
      behaviorContext,
      signal: new AbortController().signal
    })).resolves.toEqual({
      text: '今天真开心。',
      emotion: 'happy',
      behaviorPlan: { kind: 'none', emotion: 'happy' }
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
      behaviorContext,
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
      behaviorContext,
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
      behaviorContext,
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
      behaviorContext,
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
      behaviorContext,
      signal: new AbortController().signal
    })).rejects.toBe(abortError);
    await expect(new ConversationChatAdapter(timeoutProvider).respond({
      history: [],
      text: '超时',
      behaviorContext,
      signal: new AbortController().signal
    })).rejects.toBe(timeoutError);
  });
});
