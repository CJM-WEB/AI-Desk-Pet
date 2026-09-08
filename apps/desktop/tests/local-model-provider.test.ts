import type { ModelRequest, ToolDefinition } from '@myself/agent-core';
import { describe, expect, test, vi } from 'vitest';
import {
  LocalModelProvider,
  type LocalModelConnection,
  type LocalModelConnectionPort
} from '../src/main/providers/local-model-provider';
import { ProviderError } from '../src/main/providers/openai-provider';
import { characterExpressionSelectionSchema, characterExpressionSelectionJsonSchema } from '@myself/character-runtime';
import { ConversationChatAdapter } from '../src/main/conversation/conversation-chat-adapter';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const connection: LocalModelConnection = {
  generation: 'generation-1',
  baseUrl: 'http://127.0.0.1:43123/v1',
  token: 'local-session-token',
  modelId: 'ai-pet-local'
};

const tools: ToolDefinition[] = [{
  type: 'function',
  function: {
    name: 'builtin.files.read_text',
    description: '读取文本文件',
    parameters: {
      type: 'object',
      properties: { relativePath: { type: 'string' } },
      required: ['relativePath'],
      additionalProperties: false
    }
  }
}];

const request: ModelRequest = {
  messages: [{ role: 'user', content: '读取 notes.txt' }],
  tools,
  toolChoice: 'auto',
  reasoningMode: 'provider_default'
};

const localBehaviorContext = {
  character: { idleStateId: 'protocol-state',
    identity: { formsOfAddress: [], dislikes: [], boundaries: [], exampleLines: [],
      name: '本地测试角色', description: '本地测试角色', background: '测试环境',
      traits: [], languageStyle: '简洁', likes: [], behavioralTendencies: []
    },
    states: [{ agentInferable: true,
      name: '开心', stateId: 'protocol-state', tags: [],
      actions: [{ name: '挥手', actionId: 'protocol-action', tags: [] }]
    }]
  },
  runtime: { chatting: false, taskRunning: false, awaitingConfirmation: false, moving: false, dragging: false, carrying: false, movementMode: 2 as const },
  proactivityMode: 'assistive' as const,
  recentActions: []
};

const structuredRequest: ModelRequest = {
  messages: [{ role: 'user', content: '保持安静陪伴' }],
  tools: [],
  toolChoice: 'none',
  reasoningMode: 'provider_default',
  responseContract: {
    type: 'json_object',
    name: 'character_expression',
    jsonSchema: characterExpressionSelectionJsonSchema,
    validateStructuredOutput: value => characterExpressionSelectionSchema.safeParse(value).success
  }
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function readyPort(getReadyConnection = () => connection): LocalModelConnectionPort {
  return { getReadyConnection };
}

describe('LocalModelProvider', () => {
  test('主聊天及独立表现合并system到首条，保留字节、非思考和原工具请求布局', async () => {
    const requests: ModelRequest[] = [];
    const fetchClient = vi.fn<FetchLike>(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      return jsonResponse({ choices: [{ message: { content: body.response_format ? JSON.stringify({ moodUpdate: null, expressionPlan: null,
        requestKind: 'ambient', explicitPlayback: null, movementControl: { kind: 'keep' } }) : '  **保留正文😀**\n' } }] });
    });
    const local = new LocalModelProvider(readyPort(), fetchClient);
    const adapter = new ConversationChatAdapter({ respond: (input, signal) => { requests.push(input); return local.respond(input, signal); } }, () => undefined, { inputByteBudget: 19_200 });
    const history: ModelRequest['messages'] = [{ role: 'user', content: '历史用户🐾\n\n保留段落' }, { role: 'assistant', content: '  历史答复  \r\n缩进' }];
    const reply = await adapter.respond({ history, text: '  今天获奖了😀\n聊聊吧。  ', behaviorContext: localBehaviorContext, signal: new AbortController().signal });
    expect(reply.text).toBe('  **保留正文😀**\n');
    expect(fetchClient).toHaveBeenCalledTimes(2);
    for (const [index, original] of requests.entries()) {
      const body = JSON.parse(String(fetchClient.mock.calls[index]?.[1]?.body));
      const systems = original.messages.filter(message => message.role === 'system');
      expect(body.messages).toEqual([{ role: 'system', content: systems.map(message => message.content).join('\n\n') }, ...original.messages.filter(message => message.role !== 'system')]);
      expect(body).toMatchObject({ stream: false, reasoning_effort: 'none', chat_template_kwargs: { enable_thinking: false }, parallel_tool_calls: false });
      if (index === 0) {
        expect(body.tools.map((tool: ToolDefinition) => tool.function.name)).toEqual(['request_task_authorization']);
        expect(body.tool_choice).toBe('auto'); expect(body).not.toHaveProperty('response_format');
      } else {
        expect(body.tools).toEqual([]); expect(body.tool_choice).toBe('none');
        expect(body.response_format.schema).toEqual(original.responseContract?.jsonSchema);
        expect(body.response_format.schema.properties).not.toHaveProperty('text');
        expect(body.response_format.schema.properties).not.toHaveProperty('capabilityPlan');
      }
      expect(Buffer.byteLength(JSON.stringify({ messages: body.messages, tools: body.tools, responseSchema: body.response_format?.schema ?? null }))).toBeLessThanOrEqual(19_200);
    }
    await local.respond({ ...request, messages: requests[0]!.messages }, new AbortController().signal);
    expect(JSON.parse(String(fetchClient.mock.calls[2]?.[1]?.body)).messages).toEqual(requests[0]!.messages);
  });
  test('本地模型工具参数损坏时返回稳定子码且绝不重放已开始的工具协议回合', async () => {
    const fetchClient = vi.fn<FetchLike>(async () => jsonResponse({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: 'local-invalid-call',
            type: 'function',
            function: {
              name: 'builtin_files_read_text',
              arguments: '{"relativePath":"C:\\\\private.txt","content":"私密正文"'
            }
          }]
        }
      }]
    }));
    const provider = new LocalModelProvider(readyPort(), fetchClient);

    await expect(provider.respond(request, new AbortController().signal)).rejects.toMatchObject({
      code: 'TOOL_ARGUMENTS_INVALID',
      stage: 'tool_call'
    });
    expect(fetchClient).toHaveBeenCalledOnce();
  });

  test('本地原生单申请可附正文，且不额外请求表现', async () => {
    const fetchClient = vi.fn<FetchLike>(async () => jsonResponse({ choices: [{ message: { content: '准备查看', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'request_task_authorization', arguments: '{}' } }] } }] }));
    const adapter = new ConversationChatAdapter(new LocalModelProvider(readyPort(), fetchClient));
    expect(await adapter.respond({ history: [], text: '请查看目录', behaviorContext: localBehaviorContext, signal: new AbortController().signal })).toEqual({ text: '', capabilityPlan: { kind: 'agent_task' } });
    expect(fetchClient).toHaveBeenCalledOnce();
  });
  test('过大公开角色目录不会挤占本地当前用户正文的固定输入预算', async () => {
    const fetchClient = vi.fn<FetchLike>(async () => jsonResponse({
      choices: [{ message: { content: JSON.stringify({ text: '收到。' }) } }]
    }));
    const adapter = new ConversationChatAdapter(new LocalModelProvider(readyPort(), fetchClient), () => undefined, { inputByteBudget: 19_200 });
    const text = '甲'.repeat(4_000);
    const actions = Array.from({ length: 100 }, (_, index) => ({
      name: `共享动作${index}`, actionId: 'action-7391', description: '动'.repeat(2_000), tags: []
    }));

    await adapter.respond({
      history: [],
      text,
      behaviorContext: {
        ...localBehaviorContext,
        character: {
          ...localBehaviorContext.character,
          identity: {
            ...localBehaviorContext.character.identity,
            description: '角'.repeat(2_000),
            background: '景'.repeat(4_000)
          },
          states: Array.from({ length: 100 }, (_, index) => ({
            agentInferable: true,
            name: `共享状态${index}`, stateId: 'action-7933', description: '态'.repeat(2_000),
            tags: [], actions
          }))
        }
      },
      signal: new AbortController().signal
    });

    const body = JSON.parse(String(fetchClient.mock.calls[0]?.[1]?.body));
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: text });
    expect(Math.ceil(Buffer.byteLength(JSON.stringify({
      messages: body.messages,
      tools: [],
      responseSchema: body.response_format?.schema ?? null
    }), 'utf8') / 3)).toBeLessThanOrEqual(6_400);
  });

  test('固定关闭思考、流式和并行工具调用并使用当前私有连接', async () => {
    const fetchClient = vi.fn<FetchLike>(async () => jsonResponse({
      choices: [{ message: { content: '完成' } }]
    }));
    const provider = new LocalModelProvider(readyPort(), fetchClient);

    await expect(provider.respond(request, new AbortController().signal)).resolves.toEqual({
      type: 'text',
      text: '完成'
    });

    const [url, init] = fetchClient.mock.calls[0] ?? [];
    expect(String(url)).toBe('http://127.0.0.1:43123/v1/chat/completions');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer local-session-token');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'ai-pet-local',
      stream: false,
      reasoning_effort: 'none',
      chat_template_kwargs: { enable_thinking: false },
      parallel_tool_calls: false,
      parse_tool_calls: true
    });
  });

  test('通过既有 OpenAI 工具名 codec 解码内部工具名', async () => {
    const fetchClient = vi.fn<FetchLike>(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      return jsonResponse({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: 'call-local-1',
              type: 'function',
              function: {
                name: body.tools[0].function.name,
                arguments: '{"relativePath":"notes.txt"}'
              }
            }]
          }
        }]
      });
    });
    const provider = new LocalModelProvider(readyPort(), fetchClient);

    await expect(provider.respond(request, new AbortController().signal)).resolves.toEqual({
      type: 'tool_request',
      request: {
        requestId: 'call-local-1',
        toolName: 'builtin.files.read_text',
        arguments: { relativePath: 'notes.txt' }
      }
    });
  });

  test('仅 required 工具规划固定 temperature 0，auto 与 none 保持现有采样策略', async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const fetchClient = vi.fn<FetchLike>(async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return jsonResponse({ choices: [{ message: { content: '完成' } }] });
    });
    const provider = new LocalModelProvider(readyPort(), fetchClient);

    await provider.respond({ ...request, toolChoice: 'required' }, new AbortController().signal);
    await provider.respond(request, new AbortController().signal);
    await provider.respond({
      ...request,
      tools: [],
      toolChoice: 'none'
    }, new AbortController().signal);

    expect(requestBodies[0]).toMatchObject({ tool_choice: 'required', temperature: 0 });
    expect(requestBodies[1]).toMatchObject({ tool_choice: 'auto' });
    expect(requestBodies[1]).not.toHaveProperty('temperature');
    expect(requestBodies[2]).toMatchObject({ tool_choice: 'none' });
    expect(requestBodies[2]).not.toHaveProperty('temperature');
  });

  test('独立表现把响应契约作为 llama.cpp JSON Schema 约束发送', async () => {
    const fetchClient = vi.fn<FetchLike>(async () => jsonResponse({
      choices: [{
        message: {
          content: JSON.stringify({"moodUpdate":null,"expressionPlan":null,"requestKind":"ambient","explicitPlayback":null,"movementControl":{"kind":"keep"}})
        }
      }]
    }));
    const provider = new LocalModelProvider(readyPort(), fetchClient);

    await expect(provider.respond(
      structuredRequest,
      new AbortController().signal
    )).resolves.toMatchObject({
      type: 'structured', structured_output: {"moodUpdate":null,"expressionPlan":null,"requestKind":"ambient","explicitPlayback":null,"movementControl":{"kind":"keep"}}
    });

    const body = JSON.parse(String(fetchClient.mock.calls[0]?.[1]?.body));
    expect(body.response_format).toEqual({
      type: 'json_object',
      schema: characterExpressionSelectionJsonSchema
    });
  });

  test('带工具请求即使提供增量接收器也保持非流式', async () => {
    const onTextDelta = vi.fn();
    const fetchClient = vi.fn<FetchLike>(async () => jsonResponse({
      choices: [{ message: { content: '完成' } }]
    }));
    const provider = new LocalModelProvider(readyPort(), fetchClient);

    await provider.respond({ ...request, onTextDelta }, new AbortController().signal);

    expect(JSON.parse(String(fetchClient.mock.calls[0]?.[1]?.body))).toMatchObject({
      stream: false
    });
    expect(onTextDelta).not.toHaveBeenCalled();
  });

  test('本地输入超预算时只删除最旧完整回合并保留最近回合与当前用户', async () => {
    const fetchClient = vi.fn<FetchLike>(async () => jsonResponse({
      choices: [{ message: { content: '完成' } }]
    }));
    const provider = new LocalModelProvider(readyPort(), fetchClient);
    const messages: ModelRequest['messages'] = [
      { role: 'system', content: '固定系统消息' },
      { role: 'user', content: `最旧用户-${'旧'.repeat(7_000)}` },
      { role: 'assistant', content: `最旧回复-${'答'.repeat(7_000)}` },
      { role: 'user', content: '最近用户' },
      { role: 'assistant', content: '最近回复' },
      { role: 'user', content: '当前用户输入' }
    ];

    await provider.respond({ ...request, messages }, new AbortController().signal);

    const body = JSON.parse(String(fetchClient.mock.calls[0]?.[1]?.body));
    expect(body.messages).toEqual([
      { role: 'system', content: '固定系统消息' },
      { role: 'user', content: '最近用户' },
      { role: 'assistant', content: '最近回复' },
      { role: 'user', content: '当前用户输入' }
    ]);
  });

  test('本地预算不截断超长当前用户，也不拆散最近 assistant-tool 与 tool 结果', async () => {
    const fetchClient = vi.fn<FetchLike>(async () => jsonResponse({
      choices: [{ message: { content: '完成' } }]
    }));
    const provider = new LocalModelProvider(readyPort(), fetchClient);
    const currentUser = `当前-${'保'.repeat(20_000)}`;
    const toolRequest = {
      requestId: 'call-budget',
      toolName: 'builtin.files.read_text' as const,
      arguments: { relativePath: 'notes.txt' }
    };
    const messages: ModelRequest['messages'] = [
      { role: 'system', content: '固定系统消息' },
      { role: 'user', content: `最旧-${'旧'.repeat(7_000)}` },
      { role: 'assistant', content: `最旧回复-${'答'.repeat(7_000)}` },
      { role: 'user', content: '最近工具回合' },
      { role: 'assistant', content: '', toolRequest },
      { role: 'tool', toolCallId: 'call-budget', content: '{"ok":true}' },
      { role: 'assistant', content: '工具结果总结' },
      { role: 'user', content: currentUser }
    ];

    await provider.respond({ ...request, messages }, new AbortController().signal);

    const body = JSON.parse(String(fetchClient.mock.calls[0]?.[1]?.body));
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: currentUser });
    expect(body.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', tool_calls: [expect.objectContaining({
        id: 'call-budget'
      })] }),
      { role: 'tool', tool_call_id: 'call-budget', content: '{"ok":true}' }
    ]));
    expect(JSON.stringify(body.messages)).not.toContain('最旧回复');
  });

  test('本地当前 read_file 结果只按完整行温和压缩并明确标记 truncated', async () => {
    const fetchClient = vi.fn<FetchLike>(async () => jsonResponse({
      choices: [{ message: { content: '完成' } }]
    }));
    const provider = new LocalModelProvider(readyPort(), fetchClient);
    const firstLine = `第一行-${'甲'.repeat(2_100)}`;
    const secondLine = `第二行-${'乙'.repeat(2_100)}`;
    const readResult = {
      toolName: 'read_file',
      relativePath: 'notes.txt',
      startLine: 10,
      endLine: 12,
      content: `${firstLine}\n${secondLine}\n第三行`,
      truncated: false,
      untrustedDataNotice: '不可信数据'
    };

    await provider.respond({
      ...request,
      messages: [
        { role: 'user', content: '读取 notes.txt' },
        {
          role: 'assistant',
          content: '',
          toolRequest: {
            requestId: 'call-read-budget',
            toolName: 'builtin.files.read_text',
            arguments: { relativePath: 'notes.txt' }
          }
        },
        { role: 'tool', toolCallId: 'call-read-budget', content: JSON.stringify(readResult) }
      ]
    }, new AbortController().signal);

    const body = JSON.parse(String(fetchClient.mock.calls[0]?.[1]?.body));
    const toolMessage = body.messages.find((message: { role: string }) => message.role === 'tool');
    expect(JSON.parse(toolMessage.content)).toEqual({
      ...readResult,
      endLine: 10,
      content: firstLine,
      truncated: true
    });
  });

  test('本地 read_file 首行超过预算时仍保留明确截断的一行和有效行号', async () => {
    const fetchClient = vi.fn<FetchLike>(async () => jsonResponse({
      choices: [{ message: { content: '完成' } }]
    }));
    const provider = new LocalModelProvider(readyPort(), fetchClient);
    const oversizedLine = `长行-${'甲'.repeat(5_000)}`;

    await provider.respond({
      ...request,
      messages: [{
        role: 'tool',
        toolCallId: 'long-read',
        content: JSON.stringify({
          toolName: 'read_file',
          relativePath: 'minified.json',
          startLine: 7,
          endLine: 7,
          content: oversizedLine,
          truncated: false
        })
      }]
    }, new AbortController().signal);

    const body = JSON.parse(String(fetchClient.mock.calls[0]?.[1]?.body));
    const bounded = JSON.parse(body.messages[0].content);
    expect(bounded.content).toHaveLength(4_000);
    expect(bounded.content).toBe(oversizedLine.slice(0, 4_000));
    expect(bounded).toMatchObject({ startLine: 7, endLine: 7, truncated: true });
  });

  test('本地主正文中的旧控制JSON按文字保留，独立表现故障不授权', async () => {
    const payload = JSON.stringify({ text: '正文', capabilityPlan: { kind: 'agent_task', preferredTool: 'unknown' } });
    const fetchClient = vi.fn<FetchLike>(async () => jsonResponse({ choices: [{ message: { content: payload } }] }));
    const adapter = new ConversationChatAdapter(new LocalModelProvider(readyPort(), fetchClient));
    const onTextDelta = vi.fn();
    expect(await adapter.respond({ history: [], text: '普通聊天', behaviorContext: localBehaviorContext, signal: new AbortController().signal, onTextDelta })).toEqual({ text: payload, capabilityPlan: { kind: 'chat' }, expressionStatus: 'failed' });
    expect(onTextDelta).not.toHaveBeenCalled();
  });
  test.each([
    ['字符串', 'reasoning-canary-string'],
    ['空字符串', ''],
    ['null', null],
    ['数字', 0],
    ['对象', { detail: 'reasoning-canary-object' }]
  ])('reasoning_content 字段存在且值为%s时稳定拒绝', async (_name, reasoningContent) => {
    const contentCanary = `content-canary-${_name}`;
    const rawResponse = {
      choices: [{
        message: {
          content: contentCanary,
          reasoning_content: reasoningContent
        }
      }]
    };
    const fetchClient = vi.fn<FetchLike>(async () => jsonResponse(rawResponse));
    const provider = new LocalModelProvider(readyPort(), fetchClient);

    const error = await provider.respond(request, new AbortController().signal)
      .catch(reason => reason as unknown);
    expect(error).toMatchObject({
      code: 'LOCAL_MODEL_REASONING_LEAK',
      retryable: false
    });
    const observableError = error as Error;
    expect(String(error)).not.toContain(contentCanary);
    expect(observableError.message).not.toContain(contentCanary);
    expect(observableError.stack ?? '').not.toContain(contentCanary);
    expect(JSON.stringify(error)).not.toContain('reasoning-canary');
  });

  test('reasoning_content 字段不存在时接受普通文本', async () => {
    const fetchClient = vi.fn<FetchLike>(async () => jsonResponse({
      choices: [{ message: { content: '普通正文' } }]
    }));
    const provider = new LocalModelProvider(readyPort(), fetchClient);

    await expect(provider.respond(request, new AbortController().signal)).resolves.toEqual({
      type: 'text',
      text: '普通正文'
    });
  });

  test('稳定拒绝 think 标签且错误不泄露正文', async () => {
    const contentCanary = '<think>reasoning-canary-think</think>最终答案';
    const fetchClient = vi.fn<FetchLike>(async () => jsonResponse({
      choices: [{ message: { content: contentCanary } }]
    }));
    const provider = new LocalModelProvider(readyPort(), fetchClient);

    const error = await provider.respond(request, new AbortController().signal)
      .catch(reason => reason as unknown);
    expect(error).toMatchObject({
      code: 'LOCAL_MODEL_REASONING_LEAK',
      retryable: false
    });
    expect(String(error)).not.toContain(contentCanary);
    expect(JSON.stringify(error)).not.toContain('reasoning-canary-think');
  });

  test('Runtime 未 ready 时不发送请求', async () => {
    const fetchClient = vi.fn<FetchLike>();
    const port = readyPort(() => {
      throw new ProviderError('LOCAL_MODEL_NOT_READY', true);
    });
    const provider = new LocalModelProvider(port, fetchClient);

    await expect(provider.respond(request, new AbortController().signal)).rejects.toMatchObject({
      code: 'LOCAL_MODEL_NOT_READY'
    });
    expect(fetchClient).not.toHaveBeenCalled();
  });

  test('发送前 generation 已变化时不发送请求', async () => {
    const fetchClient = vi.fn<FetchLike>();
    const port = readyPort(vi.fn()
      .mockReturnValueOnce(connection)
      .mockReturnValueOnce({ ...connection, generation: 'generation-2' }));
    const provider = new LocalModelProvider(port, fetchClient);

    await expect(provider.respond(request, new AbortController().signal)).rejects.toMatchObject({
      code: 'LOCAL_MODEL_CONNECTION_STALE',
      retryable: false
    });
    expect(fetchClient).not.toHaveBeenCalled();
  });

  test('取得连接后 Runtime 转为未 ready 时按失效连接拒绝且不发送请求', async () => {
    let ready = true;
    const fetchClient = vi.fn<FetchLike>();
    const port = readyPort(() => {
      if (ready) {
        ready = false;
        return connection;
      }
      throw new ProviderError('LOCAL_MODEL_NOT_READY', true);
    });
    const provider = new LocalModelProvider(port, fetchClient);

    await expect(provider.respond(request, new AbortController().signal)).rejects.toMatchObject({
      code: 'LOCAL_MODEL_CONNECTION_STALE',
      retryable: false
    });
    expect(fetchClient).not.toHaveBeenCalled();
  });

  test('请求期间 generation 变化时拒绝迟到结果', async () => {
    const fetchClient = vi.fn<FetchLike>(async () => jsonResponse({
      choices: [{ message: { content: '迟到结果' } }]
    }));
    const port = readyPort(vi.fn()
      .mockReturnValueOnce(connection)
      .mockReturnValueOnce(connection)
      .mockReturnValueOnce({ ...connection, generation: 'generation-2' }));
    const provider = new LocalModelProvider(port, fetchClient);

    await expect(provider.respond(request, new AbortController().signal)).rejects.toMatchObject({
      code: 'LOCAL_MODEL_CONNECTION_STALE',
      retryable: false
    });
    expect(fetchClient).toHaveBeenCalledOnce();
  });

  test.each([
    ['网络异常', () => Promise.reject(new Error('connection reset'))],
    ['HTTP 503', () => Promise.resolve(jsonResponse({ error: 'unavailable' }, 503))]
  ] as const)('请求期间 generation 变化时以失效连接覆盖%s', async (_name, response) => {
    let currentConnection = connection;
    const fetchClient = vi.fn<FetchLike>(async () => {
      currentConnection = { ...connection, generation: 'generation-2' };
      return response();
    });
    const provider = new LocalModelProvider(
      readyPort(() => currentConnection),
      fetchClient
    );

    await expect(provider.respond(request, new AbortController().signal)).rejects.toMatchObject({
      code: 'LOCAL_MODEL_CONNECTION_STALE',
      retryable: false
    });
    expect(fetchClient).toHaveBeenCalledOnce();
  });
});
