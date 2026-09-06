import type { ModelRequest, ToolDefinition } from '@myself/agent-core';
import { describe, expect, test, vi } from 'vitest';
import {
  LocalModelProvider,
  type LocalModelConnection,
  type LocalModelConnectionPort
} from '../src/main/providers/local-model-provider';
import { ProviderError } from '../src/main/providers/openai-provider';
import { ConversationChatAdapter } from '../src/main/conversation/conversation-chat-adapter';
import { characterChatProtocolCases } from '../../../tests/fixtures/natural-intent-matrix';

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

const characterResponseSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['text', 'activity', 'status'],
  properties: {
    text: { type: 'string' },
    activity: { type: 'string' },
    status: { type: 'string' }
  }
});

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
    name: 'character_chat',
    jsonSchema: characterResponseSchema,
    textField: 'text',
    allowPlainTextFallback: true,
    validateStructuredOutput: value => (
      typeof value === 'object'
      && value !== null
      && typeof Reflect.get(value, 'text') === 'string'
      && typeof Reflect.get(value, 'activity') === 'string'
      && typeof Reflect.get(value, 'status') === 'string'
    )
  }
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function sseResponse(contentChunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  const events = contentChunks.map(content => (
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
  )).concat('data: [DONE]\n\n');
  return new Response(new ReadableStream({
    start(controller) {
      // 故意把 UTF-8 与 SSE 边界拆散，证明传输层不依赖网络分片形状。
      const bytes = encoder.encode(events.join(''));
      for (let offset = 0; offset < bytes.length; offset += 3) {
        controller.enqueue(bytes.slice(offset, offset + 3));
      }
      controller.close();
    }
  }), { headers: { 'content-type': 'text/event-stream' } });
}

function rawSseResponse(events: readonly string[]): Response {
  return new Response(events.join(''), {
    headers: { 'content-type': 'text/event-stream' }
  });
}

function readyPort(getReadyConnection = () => connection): LocalModelConnectionPort {
  return { getReadyConnection };
}

describe('LocalModelProvider', () => {
  test('角色首次及修复请求合并全部 system 到首条，内容字节和非 system 顺序保真，普通工具请求保持原样', async () => {
    const requests: ModelRequest[] = [];
    let responseNumber = 0;
    const fetchClient = vi.fn<FetchLike>(async () => jsonResponse({ choices: [{ message: { content: JSON.stringify({
      text: '  **保留正文😀**\n', moodUpdate: null, movementControl: { kind: 'keep' }, capabilityPlan: { kind: 'chat' },
      expressionPlan: ++responseNumber === 1 ? { states: 'bad' } : { states: [] }
    }) } }] }));
    const local = new LocalModelProvider(readyPort(), fetchClient);
    const adapter = new ConversationChatAdapter({ respond: (input, signal) => {
      requests.push(input);
      return local.respond(input, signal);
    } }, () => undefined, { inputByteBudget: 19_200 });
    const history: ModelRequest['messages'] = [
      { role: 'user', content: '历史用户🐾\n\n保留段落' },
      { role: 'assistant', content: '  历史答复  \r\n```text\n  原始缩进\n```' }
    ];
    const reply = await adapter.respond({ history, text: '  今天获奖了😀\n聊聊吧。  ',
      behaviorContext: localBehaviorContext, signal: new AbortController().signal, movementControlHandled: true });
    expect(reply.text).toBe('  **保留正文😀**\n');
    expect(fetchClient).toHaveBeenCalledTimes(2);
    for (const [index, original] of requests.entries()) {
      const body = JSON.parse(String(fetchClient.mock.calls[index]?.[1]?.body));
      const systems = original.messages.filter(message => message.role === 'system');
      expect(systems).toHaveLength(index === 0 ? 3 : 4);
      expect(body.messages).toEqual([
        { role: 'system', content: systems.map(message => message.content).join('\n\n') },
        ...original.messages.filter(message => message.role !== 'system')
      ]);
      expect(body.tools).toEqual([]);
      expect(body.tool_choice).toBe('none');
      expect(body.response_format.schema).toEqual(original.responseContract?.jsonSchema);
      expect(body.response_format.schema.required).toEqual(expect.arrayContaining(['moodUpdate', 'expressionPlan']));
      for (const field of ['moodUpdate', 'expressionPlan']) expect(body.response_format.schema.properties[field].anyOf).toContainEqual({ type: 'null' });
      expect(body.response_format.schema.properties.movementControl.oneOf).toHaveLength(1);
      expect(body.response_format.schema.properties).not.toHaveProperty('explicitPlayback');
      const bytes = Buffer.byteLength(JSON.stringify({ messages: body.messages, tools: body.tools, responseSchema: body.response_format.schema }));
      const originalBytes = Buffer.byteLength(JSON.stringify({ messages: original.messages, tools: original.tools, responseSchema: original.responseContract?.jsonSchema }));
      expect(bytes).toBeLessThanOrEqual(originalBytes);
      expect(bytes).toBeLessThanOrEqual(19_200);
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

  test.each(characterChatProtocolCases)(
    '解码“$name”线协议且保留与云 Provider 相同的控制字段',
    async ({ wireJson, decoded }) => {
      const fetchClient = vi.fn<FetchLike>(async () => sseResponse([wireJson]));
      const adapter = new ConversationChatAdapter(new LocalModelProvider(readyPort(), fetchClient));

      await expect(adapter.respond({
        history: [],
        text: '协议解码测试',
        behaviorContext: localBehaviorContext,
        signal: new AbortController().signal,
        onTextDelta: vi.fn()
      })).resolves.toEqual(decoded);

      const requestBody = JSON.parse(String(fetchClient.mock.calls[0]?.[1]?.body));
      expect(requestBody).toMatchObject({
        stream: true,
        response_format: { type: 'json_object' }
      });
      expect(requestBody.response_format.schema.required).toEqual(expect.arrayContaining([
        'text', 'movementControl', 'capabilityPlan'
      ]));
    }
  );

  test('真实本地 Provider 接受包含 capabilityPlan 的完整桌宠组合契约', async () => {
    const payload = JSON.stringify({
      text: '需要进入本地任务。',
      movementControl: { kind: 'keep' },
      capabilityPlan: { kind: 'agent_task' }
    });
    const fetchClient = vi.fn<FetchLike>(async () => sseResponse([payload]));
    const adapter = new ConversationChatAdapter(new LocalModelProvider(readyPort(), fetchClient));

    await expect(adapter.respond({
      history: [],
      text: '请整理当前目录并生成摘要',
      behaviorContext: {
        character: { idleStateId: 'idle',
          identity: { formsOfAddress: [], dislikes: [], boundaries: [], exampleLines: [],
            name: '小橘', description: '测试角色', background: '测试环境', traits: [],
            languageStyle: '简洁', likes: [], behavioralTendencies: []
          },
          states: []
        },
        runtime: { chatting: false, taskRunning: false, awaitingConfirmation: false, moving: false, dragging: false, carrying: false, movementMode: 2 },
        proactivityMode: 'assistive',
        recentActions: []
      },
      signal: new AbortController().signal,
      onTextDelta: vi.fn()
    })).resolves.toMatchObject({
      text: '需要进入本地任务。',
      capabilityPlan: { kind: 'agent_task' }
    });
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
      responseSchema: body.response_format.schema
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

  test('结构化聊天把响应契约作为 llama.cpp JSON Schema 约束发送', async () => {
    const fetchClient = vi.fn<FetchLike>(async () => jsonResponse({
      choices: [{
        message: {
          content: JSON.stringify({ text: '好的。', activity: '安静陪伴', status: 'idle' })
        }
      }]
    }));
    const provider = new LocalModelProvider(readyPort(), fetchClient);

    await expect(provider.respond(
      structuredRequest,
      new AbortController().signal
    )).resolves.toMatchObject({
      type: 'text',
      text: '好的。',
      structured_output: { activity: '安静陪伴', status: 'idle' }
    });

    const body = JSON.parse(String(fetchClient.mock.calls[0]?.[1]?.body));
    expect(body.response_format).toEqual({
      type: 'json_object',
      schema: characterResponseSchema
    });
  });

  test('本地无工具结构化聊天使用 SSE 且只增量公开顶层 text 的完整解码字符', async () => {
    const fetchClient = vi.fn<FetchLike>(async () => sseResponse([
      '{"activity":"不可见-canary","text":"你\\uD83D',
      '\\uDC3E好\\n世',
      '界","status":"idle"}'
    ]));
    const deltas: string[] = [];
    const provider = new LocalModelProvider(readyPort(), fetchClient);

    await expect(provider.respond({
      ...structuredRequest,
      onTextDelta: delta => deltas.push(delta)
    }, new AbortController().signal)).resolves.toMatchObject({
      type: 'text',
      text: '你🐾好\n世界',
      structured_output: { activity: '不可见-canary', status: 'idle' }
    });

    expect(deltas.join('')).toBe('你🐾好\n世界');
    expect(JSON.stringify(deltas)).not.toContain('不可见-canary');
    expect(JSON.parse(String(fetchClient.mock.calls[0]?.[1]?.body))).toMatchObject({
      stream: true
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

  test('SSE 期间 generation 变化后拒绝迟到增量与最终响应', async () => {
    let currentConnection = connection;
    const deltas: string[] = [];
    const fetchClient = vi.fn<FetchLike>(async () => sseResponse([
      '{"text":"第一段',
      '第二段","activity":"陪伴","status":"idle"}'
    ]));
    const provider = new LocalModelProvider(
      readyPort(() => currentConnection),
      fetchClient
    );

    await expect(provider.respond({
      ...structuredRequest,
      onTextDelta: delta => {
        deltas.push(delta);
        currentConnection = { ...connection, generation: 'generation-2' };
      }
    }, new AbortController().signal)).rejects.toMatchObject({
      code: 'LOCAL_MODEL_CONNECTION_STALE',
      retryable: false
    });

    expect(deltas).toEqual(['第一段']);
  });

  test('SSE 被 Abort 后不再发布后续增量', async () => {
    const controller = new AbortController();
    const deltas: string[] = [];
    const fetchClient = vi.fn<FetchLike>(async () => sseResponse([
      '{"text":"第一段',
      '第二段","activity":"陪伴","status":"idle"}'
    ]));
    const provider = new LocalModelProvider(readyPort(), fetchClient);

    await expect(provider.respond({
      ...structuredRequest,
      onTextDelta: delta => {
        deltas.push(delta);
        controller.abort();
      }
    }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });

    expect(deltas).toEqual(['第一段']);
  });

  test('SSE 大量事件会让出事件循环并在最终响应前响应 Abort', async () => {
    const controller = new AbortController();
    const deltas: string[] = [];
    const fragments = [
      '{"text":"',
      ...Array.from({ length: 600 }, () => '字'),
      '","activity":"陪伴","status":"idle"}'
    ];
    const events = fragments.map(content => (
      `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
    )).concat('data: [DONE]\n\n');
    const fetchClient = vi.fn<FetchLike>(async () => rawSseResponse(events));
    const provider = new LocalModelProvider(readyPort(), fetchClient);
    let abortTimer: ReturnType<typeof setTimeout> | undefined;

    try {
      await expect(provider.respond({
        ...structuredRequest,
        onTextDelta: delta => {
          deltas.push(delta);
          if (deltas.length === 10) {
            abortTimer = setTimeout(() => {
              controller.abort(new DOMException('主动取消', 'AbortError'));
            }, 0);
          }
        }
      }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      if (abortTimer !== undefined) clearTimeout(abortTimer);
    }

    expect(deltas.length).toBeGreaterThanOrEqual(10);
    expect(deltas.length).toBeLessThan(600);
  });

  test('跨 SSE chunk 的 think 标签在任何前缀公开前稳定拒绝', async () => {
    const deltas: string[] = [];
    const fetchClient = vi.fn<FetchLike>(async () => sseResponse([
      '{"text":"<thi',
      'nk>内部推理</think>","activity":"陪伴","status":"idle"}'
    ]));
    const provider = new LocalModelProvider(readyPort(), fetchClient);

    await expect(provider.respond({
      ...structuredRequest,
      onTextDelta: delta => deltas.push(delta)
    }, new AbortController().signal)).rejects.toMatchObject({
      code: 'LOCAL_MODEL_REASONING_LEAK',
      retryable: false
    });

    expect(deltas).toEqual([]);
  });

  test('SSE 缺少 DONE 终态时即使正文完整也 fail-close', async () => {
    const content = JSON.stringify({ text: '未终止', activity: '陪伴', status: 'idle' });
    const fetchClient = vi.fn<FetchLike>(async () => rawSseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
    ]));
    const provider = new LocalModelProvider(readyPort(), fetchClient);

    await expect(provider.respond({
      ...structuredRequest,
      onTextDelta: vi.fn()
    }, new AbortController().signal)).rejects.toMatchObject({
      code: 'STREAM_TERMINAL_MISSING', retryable: false
    });
  });

  test.each([
    ['DONE 后普通数据', [
      `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ text: '保留', activity: '陪伴', status: 'idle' }) } }] })}\n\n`,
      'data: [DONE]\n\n',
      'data: {not-json-tail}\n\n'
    ]],
    ['重复 DONE', [
      `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ text: '保留', activity: '陪伴', status: 'idle' }) } }] })}\n\n`,
      'data: [DONE]\n\n',
      'data: [DONE]\n\n'
    ]]
  ] as const)('%s 不污染首个终态结果', async (_name, events) => {
    const deltas: string[] = [];
    const provider = new LocalModelProvider(
      readyPort(),
      vi.fn<FetchLike>(async () => rawSseResponse(events))
    );

    await expect(provider.respond({
      ...structuredRequest,
      onTextDelta: delta => deltas.push(delta)
    }, new AbortController().signal)).resolves.toMatchObject({
      type: 'text', text: '保留'
    });
    expect(deltas.join('')).toBe('保留');
  });

  test('SSE 在最终校验前拒绝超过正文预算的累计投影', async () => {
    const deltas: string[] = [];
    const provider = new LocalModelProvider(
      readyPort(),
      vi.fn<FetchLike>(async () => sseResponse([
        JSON.stringify({ text: 'x'.repeat(4_001), activity: '陪伴', status: 'idle' })
      ]))
    );

    await expect(provider.respond({
      ...structuredRequest,
      onTextDelta: delta => deltas.push(delta)
    }, new AbortController().signal)).rejects.toMatchObject({
      code: 'RESPONSE_SHAPE_INVALID', retryable: false
    });
    expect(deltas).toEqual([]);
  });

  test('SSE 单事件与累计结构化内容具有固定上限', async () => {
    const content = `${JSON.stringify({ text: '保留', activity: '陪伴', status: 'idle' })}${' '.repeat(300_000)}`;
    const provider = new LocalModelProvider(
      readyPort(),
      vi.fn<FetchLike>(async () => rawSseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
        'data: [DONE]\n\n'
      ]))
    );

    await expect(provider.respond({
      ...structuredRequest,
      onTextDelta: vi.fn()
    }, new AbortController().signal)).rejects.toMatchObject({
      code: 'RESPONSE_SHAPE_INVALID', retryable: false
    });
  });

  test('SSE 多事件累计内容超过结构化 JSON 预算时 fail-close', async () => {
    const first = JSON.stringify({ text: '保留', activity: '陪伴', status: 'idle' });
    const provider = new LocalModelProvider(
      readyPort(),
      vi.fn<FetchLike>(async () => sseResponse([first, ' '.repeat(40_000), ' '.repeat(30_000)]))
    );

    await expect(provider.respond({
      ...structuredRequest,
      onTextDelta: vi.fn()
    }, new AbortController().signal)).rejects.toMatchObject({
      code: 'RESPONSE_SHAPE_INVALID', retryable: false
    });
  });

  test('SSE 单事件 data 行数量具有固定上限', async () => {
    const content = JSON.stringify({ text: '保留', activity: '陪伴', status: 'idle' });
    const data = JSON.stringify({ choices: [{ delta: { content } }] });
    const provider = new LocalModelProvider(
      readyPort(),
      vi.fn<FetchLike>(async () => rawSseResponse([
        `data: ${data}\n`,
        ...Array.from({ length: 1_024 }, () => 'data:  \n'),
        '\n',
        'data: [DONE]\n\n'
      ]))
    );

    await expect(provider.respond({
      ...structuredRequest,
      onTextDelta: vi.fn()
    }, new AbortController().signal)).rejects.toMatchObject({
      code: 'RESPONSE_SHAPE_INVALID', retryable: false
    });
  });

  test('SSE 忽略行也计入固定传输预算', async () => {
    const content = JSON.stringify({ text: '保留', activity: '陪伴', status: 'idle' });
    const ignored = `: ${'x'.repeat(1_000)}\n`;
    const provider = new LocalModelProvider(
      readyPort(),
      vi.fn<FetchLike>(async () => rawSseResponse([
        ...Array.from({ length: 530 }, () => ignored),
        `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
        'data: [DONE]\n\n'
      ]))
    );

    await expect(provider.respond({
      ...structuredRequest,
      onTextDelta: vi.fn()
    }, new AbortController().signal)).rejects.toMatchObject({
      code: 'RESPONSE_SHAPE_INVALID', retryable: false
    });
  });

  test.each([
    {
      name: '纯文本',
      content: '我会保持安静。',
      expected: { type: 'text', text: '我会保持安静。' }
    },
    {
      name: '只有 text 的 JSON',
      content: '{"text":"只保留正文。"}',
      expected: {
        type: 'text', text: '只保留正文。', structured_output: { text: '只保留正文。' }
      }
    },
    {
      name: '带非法隐藏字段的 JSON',
      content: '{"text":"正文仍然有效。","activity":42,"status":null}',
      expected: {
        type: 'text',
        text: '正文仍然有效。',
        structured_output: { text: '正文仍然有效。', activity: 42, status: null }
      }
    }
  ] as const)('结构化聊天的$name只以合法正文作为成功前置条件', async ({ content, expected }) => {
    const textDeltas: string[] = [];
    const provider = new LocalModelProvider(
      readyPort(),
      vi.fn<FetchLike>(async () => sseResponse([content]))
    );

    await expect(provider.respond(
      { ...structuredRequest, onTextDelta: delta => textDeltas.push(delta) },
      new AbortController().signal
    )).resolves.toEqual(expected);
    expect(textDeltas.join('')).toBe(expected.text);
  });

  test('完全没有合法正文时仍返回格式错误', async () => {
    const onTextDelta = vi.fn();
    const provider = new LocalModelProvider(
      readyPort(),
      vi.fn<FetchLike>(async () => sseResponse(['{}']))
    );

    await expect(provider.respond(
      { ...structuredRequest, onTextDelta },
      new AbortController().signal
    )).rejects.toMatchObject({
      code: 'RESPONSE_FORMAT_UNSUPPORTED',
      retryable: false
    });
    expect(onTextDelta).not.toHaveBeenCalled();
  });

  test('本地模型非法隐藏字段由聊天 Adapter 逐项丢弃且保留正文', async () => {
    const payload = JSON.stringify({
      text: '正文仍然有效。',
      movementControl: { kind: 'move_once', target: { x: 1, y: 2 } },
      capabilityPlan: { kind: 'agent_task', preferredTool: 'unknown' }
    });
    const adapter = new ConversationChatAdapter(new LocalModelProvider(
      readyPort(),
      vi.fn<FetchLike>(async () => sseResponse([payload]))
    ));
    const textDeltas: string[] = [];

    await expect(adapter.respond({
      history: [],
      text: '普通聊天',
      behaviorContext: {
        character: { idleStateId: 'idle',
          identity: { formsOfAddress: [], dislikes: [], boundaries: [], exampleLines: [],
            name: '小橘', description: '测试角色', background: '测试环境', traits: [],
            languageStyle: '简洁', likes: [], behavioralTendencies: []
          },
          states: []
        },
        runtime: { chatting: false, taskRunning: false, awaitingConfirmation: false, moving: false, dragging: false, carrying: false, movementMode: 2 },
        proactivityMode: 'assistive',
        recentActions: []
      },
      onTextDelta: delta => textDeltas.push(delta),
      signal: new AbortController().signal
    })).resolves.toEqual({ text: '正文仍然有效。' });
    expect(textDeltas.join('')).toBe('正文仍然有效。');
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
