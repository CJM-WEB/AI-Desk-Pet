import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelResponseContract,
  ToolDefinition
} from '@myself/agent-core';
import { describe, expect, test, vi } from 'vitest';
import {
  OpenAICompatibleProvider,
  ProviderError
} from '../src/main/providers/openai-provider';
import {
  AnthropicProvider,
  toAnthropicResponseJsonSchema
} from '../src/main/providers/anthropic-provider';
import {
  GeminiProvider,
  toGeminiResponseJsonSchema
} from '../src/main/providers/gemini-provider';
import { ProviderRegistry } from '../src/main/providers/provider-registry';
import { BUILTIN_LOCAL_PROFILE_ID } from '../src/main/local-model/local-model-route';
import { ConversationChatAdapter } from '../src/main/conversation/conversation-chat-adapter';
import { characterChatResponseJsonSchema } from '@myself/character-runtime';
import {
  providerCatalog,
  toolRequestSchema,
  type ProviderProfileV2
} from '@myself/shared-types';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface ProviderContractCase {
  name: string;
  createProvider: (fetchClient: FetchLike) => ModelProvider;
  textResponse: unknown;
  toolResponse: unknown;
  behaviorIntentResponse: unknown;
  expectedBehaviorIntentResponse: ModelResponse;
  invalidBehaviorIntentResponse: unknown;
  toolResponseWithBehaviorIntent: unknown;
  mixedTextAndToolResponse: unknown;
  multipleToolsResponse: unknown;
  missingFieldsResponse: unknown;
}

const adapterProfile = {
  id: 'contract-profile',
  displayName: '契约测试服务',
  baseUrl: 'https://api.example.com/v1',
  model: 'contract-model',
  modelId: 'contract-model',
  hasStoredSecret: true,
  additionalParameters: {}
};

const tools: ToolDefinition[] = [{
  type: 'function',
  function: {
    name: 'read_text_file',
    description: '读取文本文件',
    parameters: {
      type: 'object',
      properties: {
        relativePath: { type: 'string' }
      },
      required: ['relativePath'],
      additionalProperties: false
    }
  }
}];

const providerBehaviorContext = {
  character: {
    identity: {
      name: '契约测试角色', description: '契约测试角色', background: '测试环境', traits: [],
      languageStyle: '简洁', likes: [], behavioralTendencies: []
    },
    states: [{
      name: '移动', semantic: 'move', tags: [],
      actions: [{ name: '散步', semantic: 'move', tags: [] }]
    }]
  },
  runtime: {
    moving: false,
    dragging: false,
    carrying: false,
    movementMode: 2 as const
  },
  proactivityMode: 'assistive' as const,
  recentActions: []
};

const request: ModelRequest = {
  messages: [
    { role: 'system', content: '只返回必要内容。' },
    { role: 'user', content: '读取 notes.txt' }
  ],
  tools,
  toolChoice: 'auto',
  reasoningMode: 'provider_default'
};

const chatResponseContract: ModelResponseContract = {
  type: 'json_object',
  name: 'character_chat',
  jsonSchema: characterChatResponseJsonSchema,
  textField: 'text',
  allowPlainTextFallback: true
};

const structuredChatRequest: ModelRequest = {
  messages: [{ role: 'user', content: '向左走一点' }],
  tools: [],
  toolChoice: 'none',
  reasoningMode: 'provider_default',
  responseContract: chatResponseContract
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function captureError(promise: Promise<ModelResponse>): Promise<unknown> {
  return promise.catch(error => error);
}

function expectObservableErrorTextHidden(
  error: unknown,
  sensitiveValues: string[]
): void {
  expect(error).toBeInstanceOf(Error);
  const observableError = error as Error & { cause?: unknown };

  for (const sensitiveValue of sensitiveValues) {
    expect(String(error)).not.toContain(sensitiveValue);
    expect(observableError.message).not.toContain(sensitiveValue);
    expect(observableError.stack ?? '').not.toContain(sensitiveValue);
    expect(String(observableError.cause ?? '')).not.toContain(sensitiveValue);
  }
}

function characterChatJson(
  text: string,
  capabilityPlan: { kind: 'chat' } | {
    kind: 'agent_task';
    preferredTool: 'create_file';
  } = { kind: 'chat' }
): string {
  return JSON.stringify({
    text,
    activity: '安静陪伴',
    status: 'idle',
    movementControl: { kind: 'keep' },
    behaviorPlan: { kind: 'none' },
    capabilityPlan
  });
}

function sseResponse(events: readonly string[], keepOpen = false): Response {
  const encoded = new TextEncoder().encode(events.map(event => `data: ${event}\n\n`).join(''));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // 小网络块确保 SSE 行、JSON escape 与多字节正文不会依赖单次 read 边界。
      for (let offset = 0; offset < encoded.length; offset += 7) {
        controller.enqueue(encoded.slice(offset, offset + 7));
      }
      if (!keepOpen) controller.close();
    }
  });
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream' }
  });
}

function characterChatSseResponse(providerName: string, content: string): Response {
  if (providerName === 'Anthropic') {
    return sseResponse([
      JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: content }
      }),
      JSON.stringify({ type: 'message_stop' })
    ]);
  }
  if (providerName === 'Gemini') {
    return sseResponse([JSON.stringify({
      candidates: [{ content: { parts: [{ text: content }] }, finishReason: 'STOP' }]
    })]);
  }
  return sseResponse([
    JSON.stringify({ choices: [{ delta: { content } }] }),
    '[DONE]'
  ]);
}

interface ChatProviderContractCase {
  name: string;
  createProvider(fetchClient: FetchLike): ModelProvider;
  textResponse(text: string): unknown;
  toolResponse: unknown;
  expectedToolResponseErrorCode?: string;
  requestTools(body: Record<string, unknown>): unknown;
}

const chatProviderContractCases: ChatProviderContractCase[] = [
  {
    name: 'OpenAI Compatible',
    createProvider: fetchClient => new OpenAICompatibleProvider(
      adapterProfile,
      async () => 'chat-contract-secret',
      fetchClient
    ),
    textResponse: text => ({ choices: [{ message: { content: text } }] }),
    toolResponse: {
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: 'chat-contract-tool-call',
            type: 'function',
            function: { name: 'read_text_file', arguments: '{}' }
          }]
        }
      }]
    },
    expectedToolResponseErrorCode: 'PROVIDER_UNKNOWN_TOOL_CALL',
    requestTools: body => body.tools
  },
  {
    name: 'Anthropic',
    createProvider: fetchClient => new AnthropicProvider(
      adapterProfile,
      async () => 'chat-contract-secret',
      fetchClient
    ),
    textResponse: text => ({ content: [{ type: 'text', text }] }),
    toolResponse: {
      content: [{
        type: 'tool_use',
        id: 'chat-contract-tool-call',
        name: 'read_text_file',
        input: {}
      }]
    },
    requestTools: body => body.tools
  },
  {
    name: 'Gemini',
    createProvider: fetchClient => new GeminiProvider(
      adapterProfile,
      async () => 'chat-contract-secret',
      fetchClient
    ),
    textResponse: text => ({
      candidates: [{ content: { parts: [{ text }] } }]
    }),
    toolResponse: {
      candidates: [{
        content: {
          parts: [{ functionCall: { name: 'read_text_file', args: {} } }]
        }
      }]
    },
    requestTools: body => body.tools
  }
];

interface StructuredProviderCase extends ChatProviderContractCase {
  assertRequestContract(body: Record<string, unknown>): void;
}

const structuredProviderCases: StructuredProviderCase[] = [
  {
    ...chatProviderContractCases[0]!,
    name: 'OpenAI Compatible',
    assertRequestContract(body) {
      expect(body.response_format).toEqual({ type: 'json_object' });
    }
  },
  {
    ...chatProviderContractCases[0]!,
    name: 'DeepSeek',
    createProvider: fetchClient => new OpenAICompatibleProvider(
      { ...adapterProfile, providerId: 'deepseek' },
      async () => 'chat-contract-secret',
      fetchClient
    ),
    assertRequestContract(body) {
      expect(body.response_format).toEqual({ type: 'json_object' });
    }
  },
  {
    ...chatProviderContractCases[1]!,
    name: 'Anthropic',
    assertRequestContract(body) {
      const outputConfig = body.output_config as {
        format: { type: string; schema: Record<string, unknown>; name?: string };
      };
      expect(outputConfig.format.type).toBe('json_schema');
      expect(outputConfig.format.name).toBeUndefined();
      const serializedSchema = JSON.stringify(outputConfig.format.schema);
      expect(serializedSchema).toContain('"anyOf"');
      expect(serializedSchema).toContain('"const"');
      expect(serializedSchema).not.toMatch(/"(?:oneOf|minLength|maxLength|pattern)"/u);
    }
  },
  {
    ...chatProviderContractCases[2]!,
    name: 'Gemini',
    assertRequestContract(body) {
      const generationConfig = body.generationConfig as {
        responseMimeType: string;
        responseJsonSchema: Record<string, unknown>;
      };
      expect(generationConfig.responseMimeType).toBe('application/json');
      const serializedSchema = JSON.stringify(generationConfig.responseJsonSchema);
      expect(serializedSchema).toContain('"anyOf"');
      expect(serializedSchema).toContain('"enum"');
      expect(serializedSchema).not.toMatch(
        /"(?:oneOf|const|minLength|maxLength|pattern)"/u
      );
    }
  }
];

const structuredStreamFragments = [
  '{"activity":"不可见-canary","text":"你\\uD83D',
  '\\uDC3E好\\n世',
  '界","status":"idle"}'
] as const;

const cloudStreamingCases = [
  {
    name: 'OpenAI Compatible',
    createProvider: chatProviderContractCases[0]!.createProvider,
    response: (keepOpen = false) => sseResponse([
      ...structuredStreamFragments.map(content => JSON.stringify({ choices: [{ delta: { content } }] })),
      '[DONE]'
    ], keepOpen),
    assertRequest(input: string | URL | Request, body: Record<string, unknown>) {
      expect(String(input)).toBe('https://api.example.com/v1/chat/completions');
      expect(body.stream).toBe(true);
    }
  },
  {
    name: 'Anthropic',
    createProvider: chatProviderContractCases[1]!.createProvider,
    response: (keepOpen = false) => sseResponse([
      ...structuredStreamFragments.map(text => JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text }
      })),
      JSON.stringify({ type: 'message_stop' })
    ], keepOpen),
    assertRequest(input: string | URL | Request, body: Record<string, unknown>) {
      expect(String(input)).toBe('https://api.example.com/v1/messages');
      expect(body.stream).toBe(true);
    }
  },
  {
    name: 'Gemini',
    createProvider: chatProviderContractCases[2]!.createProvider,
    response: (keepOpen = false) => sseResponse(structuredStreamFragments.map((text, index) => JSON.stringify({
      candidates: [{
        content: { parts: [{ text }] },
        ...(index === structuredStreamFragments.length - 1 ? { finishReason: 'STOP' } : {})
      }]
    })), keepOpen),
    assertRequest(input: string | URL | Request, body: Record<string, unknown>) {
      expect(String(input)).toBe(
        'https://api.example.com/v1/models/contract-model:streamGenerateContent?alt=sse'
      );
      expect(body).not.toHaveProperty('stream');
    }
  }
] as const;

describe('三协议云端普通聊天流式契约', () => {
  test.each(cloudStreamingCases)(
    '$name 只增量公开结构化顶层 text 并保留最终完整响应',
    async contract => {
      const fetchClient = vi.fn<FetchLike>(async () => contract.response());
      const deltas: string[] = [];
      const response = await contract.createProvider(fetchClient).respond({
        ...structuredChatRequest,
        onTextDelta: delta => deltas.push(delta)
      }, new AbortController().signal);

      expect(response).toMatchObject({
        type: 'text',
        text: '你🐾好\n世界',
        structured_output: { activity: '不可见-canary', status: 'idle' }
      });
      expect(deltas.join('')).toBe('你🐾好\n世界');
      expect(JSON.stringify(deltas)).not.toContain('不可见-canary');
      const [input, init] = fetchClient.mock.calls[0] ?? [];
      contract.assertRequest(input!, JSON.parse(String(init?.body)) as Record<string, unknown>);
    }
  );

  test.each(cloudStreamingCases)(
    '$name 流式纯文本不被结构化投影器提前拒绝',
    async contract => {
      const fetchClient = vi.fn<FetchLike>(async () => characterChatSseResponse(
        contract.name,
        '流式纯文本正文'
      ));
      const deltas: string[] = [];

      await expect(contract.createProvider(fetchClient).respond({
        ...structuredChatRequest,
        onTextDelta: delta => deltas.push(delta)
      }, new AbortController().signal)).resolves.toEqual({
        type: 'text',
        text: '流式纯文本正文'
      });
      expect(deltas.join('')).toBe('流式纯文本正文');
    }
  );

  test.each(cloudStreamingCases)(
    '$name 收到协议终态后主动结束，不等待服务端关闭长连接',
    async contract => {
      const fetchClient = vi.fn<FetchLike>(async () => contract.response(true));
      const response = contract.createProvider(fetchClient).respond({
        ...structuredChatRequest,
        onTextDelta: vi.fn()
      }, new AbortController().signal);

      await expect(Promise.race([
        response,
        new Promise((_, reject) => setTimeout(
          () => reject(new Error('SSE_TERMINAL_WAITED_FOR_EOF')),
          500
        ))
      ])).resolves.toMatchObject({ type: 'text', text: '你🐾好\n世界' });
    }
  );

  test.each(chatProviderContractCases)(
    '$name 工具回合即使携带 callback 也保持缓冲 JSON',
    async contract => {
      const fetchClient = vi.fn<FetchLike>(async () => jsonResponse(contract.textResponse('完成')));
      const onTextDelta = vi.fn();

      await contract.createProvider(fetchClient).respond({ ...request, onTextDelta }, new AbortController().signal);

      expect(onTextDelta).not.toHaveBeenCalled();
      const [input, init] = fetchClient.mock.calls[0] ?? [];
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (contract.name === 'OpenAI Compatible') expect(body.stream).not.toBe(true);
      if (contract.name === 'Anthropic') expect(body.stream).not.toBe(true);
      if (contract.name === 'Gemini') expect(String(input)).toContain(':generateContent');
    }
  );

  test('OpenAI Compatible 缺少协议终态时失败关闭且不返回最终响应', async () => {
    const fetchClient = vi.fn<FetchLike>(async () => sseResponse([
      JSON.stringify({ choices: [{ delta: { content: '{"text":"未完成"}' } }] })
    ]));
    const deltas: string[] = [];

    await expect(chatProviderContractCases[0]!.createProvider(fetchClient).respond({
      ...structuredChatRequest,
      onTextDelta: delta => deltas.push(delta)
    }, new AbortController().signal)).rejects.toMatchObject({
      code: 'PROVIDER_MALFORMED_RESPONSE'
    });

    expect(deltas.join('')).toBe('未完成');
  });

  test.each(['SAFETY', 'MAX_TOKENS', 'UNKNOWN_REASON'])(
    'Gemini 将非 STOP 终态 %s 作为失败关闭',
    async finishReason => {
      const fetchClient = vi.fn<FetchLike>(async () => sseResponse(
        structuredStreamFragments.map((text, index) => JSON.stringify({
          candidates: [{
            content: { parts: [{ text }] },
            ...(index === structuredStreamFragments.length - 1 ? { finishReason } : {})
          }]
        }))
      ));

      await expect(chatProviderContractCases[2]!.createProvider(fetchClient).respond({
        ...structuredChatRequest,
        onTextDelta: vi.fn()
      }, new AbortController().signal)).rejects.toMatchObject({
        code: 'PROVIDER_MALFORMED_RESPONSE',
        retryable: false
      });
    }
  );

  test('Anthropic 终态后的正文数据使整轮失败', async () => {
    const fetchClient = vi.fn<FetchLike>(async () => sseResponse([
      JSON.stringify({ type: 'message_stop' }),
      JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: '{"text":"迟到"}' }
      })
    ]));

    await expect(chatProviderContractCases[1]!.createProvider(fetchClient).respond({
      ...structuredChatRequest,
      onTextDelta: vi.fn()
    }, new AbortController().signal)).rejects.toMatchObject({
      code: 'PROVIDER_MALFORMED_RESPONSE'
    });
  });

  test('OpenAI Compatible 拒绝重复顶层 text 且不公开第二段', async () => {
    const fetchClient = vi.fn<FetchLike>(async () => sseResponse([
      JSON.stringify({ choices: [{ delta: { content: '{"text":"第一段"' } }] }),
      JSON.stringify({ choices: [{ delta: { content: ',"text":"第二段"}' } }] }),
      '[DONE]'
    ]));
    const deltas: string[] = [];

    await expect(chatProviderContractCases[0]!.createProvider(fetchClient).respond({
      ...structuredChatRequest,
      onTextDelta: delta => deltas.push(delta)
    }, new AbortController().signal)).rejects.toMatchObject({
      code: 'PROVIDER_MALFORMED_RESPONSE',
      retryable: false
    });

    expect(deltas.join('')).toBe('第一段');
  });

  test('Anthropic 忽略私有 thinking 和 signature 增量并继续公开后续正文', async () => {
    const fetchClient = vi.fn<FetchLike>(async () => sseResponse([
      JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: '不可见思考' }
      }),
      JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'signature_delta', signature: '不可见签名' }
      }),
      JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: '{"text":"正常","status":"idle"}' }
      }),
      JSON.stringify({ type: 'message_stop' })
    ]));
    const deltas: string[] = [];

    await expect(chatProviderContractCases[1]!.createProvider(fetchClient).respond({
      ...structuredChatRequest,
      onTextDelta: delta => deltas.push(delta)
    }, new AbortController().signal)).resolves.toMatchObject({
      type: 'text',
      text: '正常'
    });

    expect(deltas.join('')).toBe('正常');
    expect(JSON.stringify(deltas)).not.toContain('不可见');
  });

  test('Anthropic 拒绝未知 content_block_delta 类型且不公开后续正文', async () => {
    const fetchClient = vi.fn<FetchLike>(async () => sseResponse([
      JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: '{"unexpected":true}' }
      }),
      JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: '{"text":"不得公开"}' }
      }),
      JSON.stringify({ type: 'message_stop' })
    ]));
    const onTextDelta = vi.fn();

    await expect(chatProviderContractCases[1]!.createProvider(fetchClient).respond({
      ...structuredChatRequest,
      onTextDelta
    }, new AbortController().signal)).rejects.toMatchObject({
      code: 'PROVIDER_MALFORMED_RESPONSE',
      retryable: false
    });

    expect(onTextDelta).not.toHaveBeenCalled();
  });

  test('Anthropic 私有 thinking 和 signature 增量累计超预算时失败且不公开正文', async () => {
    const privateDelta = '思'.repeat(80_000);
    const events = [
      { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: privateDelta } },
      { type: 'content_block_delta', delta: { type: 'signature_delta', signature: privateDelta } },
      { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: privateDelta } },
      {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: '{"text":"不得到达"}' }
      },
      { type: 'message_stop' }
    ].map(event => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
    const fetchClient = vi.fn<FetchLike>(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) controller.enqueue(event);
        controller.close();
      }
    }), {
      headers: { 'content-type': 'text/event-stream' }
    }));
    const onTextDelta = vi.fn();

    await expect(chatProviderContractCases[1]!.createProvider(fetchClient).respond({
      ...structuredChatRequest,
      onTextDelta
    }, new AbortController().signal)).rejects.toMatchObject({
      code: 'PROVIDER_MALFORMED_RESPONSE',
      retryable: false
    });

    expect(onTextDelta).not.toHaveBeenCalled();
  }, 20_000);

  test.each(cloudStreamingCases)(
    '$name 在请求前已 Abort 时不公开任何增量',
    async contract => {
      const fetchClient = vi.fn<FetchLike>(async () => contract.response());
      const onTextDelta = vi.fn();
      const controller = new AbortController();
      controller.abort(new DOMException('测试取消', 'AbortError'));

      await expect(contract.createProvider(fetchClient).respond({
        ...structuredChatRequest,
        onTextDelta
      }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
      expect(onTextDelta).not.toHaveBeenCalled();
    }
  );

  test('OpenAI Compatible 在事件可读后取消时不公开迟到增量', async () => {
    const abortReason = new DOMException('测试取消', 'AbortError');
    let releaseFirstAbortCheck: (() => void) | undefined;
    const firstAbortCheck = new Promise<void>(resolve => { releaseFirstAbortCheck = resolve; });
    let firstCheckPending = true;
    let cancelled = false;
    const signal = {
      get aborted() {
        if (firstCheckPending) {
          firstCheckPending = false;
          releaseFirstAbortCheck?.();
          return false;
        }
        return cancelled;
      },
      reason: abortReason
    } as AbortSignal;
    const encoded = new TextEncoder().encode(
      `data: ${JSON.stringify({ choices: [{ delta: { content: '{"text":"迟到"}' } }] })}\n\n`
    );
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await firstAbortCheck;
        controller.enqueue(encoded);
        // 模拟 reader.read 返回与同步事件投影之间抵达的取消。
        cancelled = true;
        controller.close();
      }
    });
    const fetchClient = vi.fn<FetchLike>(async () => new Response(body, {
      headers: { 'content-type': 'text/event-stream' }
    }));
    const onTextDelta = vi.fn();

    await expect(chatProviderContractCases[0]!.createProvider(fetchClient).respond({
      ...structuredChatRequest,
      onTextDelta
    }, signal)).rejects.toBe(abortReason);

    expect(onTextDelta).not.toHaveBeenCalled();
  });

  test('Gemini 只公开非 thought 的 text Part，忽略不可见 Part', async () => {
    const fetchClient = vi.fn<FetchLike>(async () => sseResponse([
      JSON.stringify({
        candidates: [{
          content: {
            parts: [
              { thought: true, text: '不可见推理' },
              { functionCall: { name: 'unused', args: {} } },
              { text: '{"text":"公开","status":"idle"}' }
            ]
          },
          finishReason: 'STOP'
        }]
      })
    ]));
    const deltas: string[] = [];

    await expect(chatProviderContractCases[2]!.createProvider(fetchClient).respond({
      ...structuredChatRequest,
      onTextDelta: delta => deltas.push(delta)
    }, new AbortController().signal)).resolves.toMatchObject({
      type: 'text',
      text: '公开'
    });

    expect(deltas.join('')).toBe('公开');
    expect(JSON.stringify(deltas)).not.toContain('不可见推理');
  });

  test('Gemini 拒绝同一流式 Part 混合正文和函数调用', async () => {
    const fetchClient = vi.fn<FetchLike>(async () => sseResponse([
      JSON.stringify({
        candidates: [{
          content: {
            parts: [{
              text: '{"text":"不得公开","status":"idle"}',
              functionCall: { name: 'unused', args: {} }
            }]
          },
          finishReason: 'STOP'
        }]
      })
    ]));

    await expect(chatProviderContractCases[2]!.createProvider(fetchClient).respond({
      ...structuredChatRequest,
      onTextDelta: vi.fn()
    }, new AbortController().signal)).rejects.toMatchObject({
      code: 'PROVIDER_MALFORMED_RESPONSE'
    });
  });

  test('OpenAI Compatible 对 application/json;charset 回退为缓冲 JSON', async () => {
    const fetchClient = vi.fn<FetchLike>(async () => new Response(JSON.stringify(
      chatProviderContractCases[0]!.textResponse('{"text":"兼容回退","status":"idle"}')
    ), {
      headers: { 'content-type': 'application/json; charset=utf-8' }
    }));
    const onTextDelta = vi.fn();

    await expect(chatProviderContractCases[0]!.createProvider(fetchClient).respond({
      ...structuredChatRequest,
      onTextDelta
    }, new AbortController().signal)).resolves.toMatchObject({
      type: 'text',
      text: '兼容回退'
    });

    expect(onTextDelta).not.toHaveBeenCalled();
  });

  test('OpenAI Compatible 终态前已经公开的 text 在最终 JSON 无效时不冒充成功', async () => {
    const fetchClient = vi.fn<FetchLike>(async () => sseResponse([
      JSON.stringify({ choices: [{ delta: { content: '{"text":"可见但未提交"' } }] }),
      JSON.stringify({ choices: [{ delta: { content: ',"text":123}' } }] }),
      '[DONE]'
    ]));
    const deltas: string[] = [];

    await expect(chatProviderContractCases[0]!.createProvider(fetchClient).respond({
      ...structuredChatRequest,
      onTextDelta: delta => deltas.push(delta)
    }, new AbortController().signal)).rejects.toMatchObject({
      code: 'PROVIDER_MALFORMED_RESPONSE'
    });

    expect(deltas.join('')).toBe('可见但未提交');
  });

  test('OpenAI Compatible 把 SSE 读取异常归一为可重试网络错误', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('sensitive-stream-failure'));
      }
    });
    const fetchClient = vi.fn<FetchLike>(async () => new Response(body, {
      headers: { 'content-type': 'text/event-stream' }
    }));

    await expect(chatProviderContractCases[0]!.createProvider(fetchClient).respond({
      ...structuredChatRequest,
      onTextDelta: vi.fn()
    }, new AbortController().signal)).rejects.toMatchObject({
      code: 'PROVIDER_NETWORK_ERROR',
      retryable: true
    });
  });

  test('OpenAI Compatible 按 UTF-8 字节拒绝超预算的云端 reasoning 帧', async () => {
    const fetchClient = vi.fn<FetchLike>(async () => sseResponse([
      JSON.stringify({ choices: [{ delta: { reasoning_content: '思'.repeat(90_000) } }] }),
      JSON.stringify({ choices: [{ delta: { content: '{"text":"正常","status":"idle"}' } }] }),
      '[DONE]'
    ]));

    await expect(chatProviderContractCases[0]!.createProvider(fetchClient).respond({
      ...structuredChatRequest,
      onTextDelta: vi.fn()
    }, new AbortController().signal)).rejects.toMatchObject({
      code: 'PROVIDER_MALFORMED_RESPONSE'
    });
  }, 20_000);
});

describe('ConversationChatAdapter 三类 Provider 自然文本契约', () => {
  test.each(chatProviderContractCases)(
    '$name 的合法普通聊天与能力任务结构在流式传输后均保留控制计划',
    async contract => {
      const plans = [
        { kind: 'chat' } as const,
        { kind: 'agent_task', preferredTool: 'create_file' } as const
      ];

      for (const capabilityPlan of plans) {
        const visibleText = capabilityPlan.kind === 'chat' ? '普通回复。' : '需要进入本地任务。';
        const deltas: string[] = [];
        const fetchClient = vi.fn<FetchLike>(async () => (
          characterChatSseResponse(
            contract.name,
            characterChatJson(visibleText, capabilityPlan)
          )
        ));
        const adapter = new ConversationChatAdapter(contract.createProvider(fetchClient));

        await expect(adapter.respond({
          history: [],
          text: capabilityPlan.kind === 'chat' ? '你好' : '创建文件',
          behaviorContext: providerBehaviorContext,
          signal: new AbortController().signal,
          onTextDelta: delta => deltas.push(delta)
        })).resolves.toMatchObject({ text: visibleText, capabilityPlan });
        expect(deltas.join('')).toBe(visibleText);
      }
    }
  );

  test.each(chatProviderContractCases)(
    '$name 普通聊天返回完整结构且请求工具数组为空',
    async contract => {
      const visibleText = '  可以使用 Markdown。\n\n```ts\nconst 回复 = "原样保留";\n```\n';
      const fetchClient = vi.fn<FetchLike>(async () => jsonResponse(
        contract.textResponse(characterChatJson(visibleText))
      ));
      const adapter = new ConversationChatAdapter(contract.createProvider(fetchClient));

      await expect(adapter.respond({
        history: [],
        text: '请给出示例',
        behaviorContext: providerBehaviorContext,
        signal: new AbortController().signal
      })).resolves.toEqual({
        text: visibleText,
        activity: '安静陪伴',
        status: 'idle',
        movementControl: { kind: 'keep' },
        behaviorPlan: { kind: 'none' },
        capabilityPlan: { kind: 'chat' }
      });

      const body = JSON.parse(String(fetchClient.mock.calls[0]?.[1]?.body)) as Record<
        string,
        unknown
      >;
      expect(contract.requestTools(body)).toEqual([]);
    }
  );

  test.each(chatProviderContractCases)(
    '$name 对合法 JSON 同时保留正文与严格行为计划',
    async contract => {
      const raw = JSON.stringify({
        text: '我向左走一点。',
        activity: '向左移动',
        status: 'moving',
        movementControl: { kind: 'move_once', target: 'left', distance: 'near' },
        behaviorPlan: { kind: 'none', emotion: 'calm' },
        capabilityPlan: { kind: 'chat' }
      });
      const adapter = new ConversationChatAdapter(contract.createProvider(
        vi.fn(async () => jsonResponse(contract.textResponse(raw)))
      ));

      await expect(adapter.respond({
        history: [],
        text: '向左走一点',
        behaviorContext: providerBehaviorContext,
        signal: new AbortController().signal
      })).resolves.toEqual({
        text: '我向左走一点。',
        activity: '向左移动',
        status: 'moving',
        movementControl: { kind: 'move_once', target: 'left', distance: 'near' },
        emotion: 'calm',
        behaviorPlan: { kind: 'none', emotion: 'calm' },
        capabilityPlan: { kind: 'chat' }
      });
    }
  );

  test.each(chatProviderContractCases.flatMap(contract => ([
    ['纯文本', '普通纯文本', '普通纯文本'],
    ['只有 text 的 JSON', '{"text":"只有正文"}', '只有正文'],
    [
      '合法 text 加非法 movementControl',
      '{"text":"正文仍然有效。","movementControl":{"kind":"move_once","target":{"x":1,"y":2},"distance":"far"}}',
      '正文仍然有效。'
    ],
    ['截断于控制字段的 JSON', '{"text":"截断前的正文","movementControl":', '截断前的正文']
  ] as const).map(([shape, raw, text]) => ({ contract, shape, raw, text }))))(
    '$contract.name 对$shape只要求合法正文',
    async ({ contract, raw, text }) => {
      const adapter = new ConversationChatAdapter(contract.createProvider(
        vi.fn(async () => jsonResponse(contract.textResponse(raw)))
      ));

      await expect(adapter.respond({
        history: [],
        text: '普通聊天',
        behaviorContext: providerBehaviorContext,
        signal: new AbortController().signal
      })).resolves.toEqual({ text });
    }
  );

  test.each(chatProviderContractCases)(
    '$name 拒绝无法恢复正文的空对象且不泄露响应',
    async contract => {
      const sensitiveRaw = '{"private":"不得泄露"}';
      const adapter = new ConversationChatAdapter(contract.createProvider(
        vi.fn(async () => jsonResponse(contract.textResponse(sensitiveRaw)))
      ));

      const error = await adapter.respond({
        history: [],
        text: '测试空对象',
        behaviorContext: providerBehaviorContext,
        signal: new AbortController().signal
      }).catch(reason => reason);

      expect(error).toMatchObject({
        code: 'PROVIDER_MALFORMED_RESPONSE',
        retryable: false
      });
      expectObservableErrorTextHidden(error, ['private', '不得泄露']);
    }
  );

  test.each(chatProviderContractCases)(
    '$name 的工具响应会被聊天适配器拒绝',
    async contract => {
      const adapter = new ConversationChatAdapter(contract.createProvider(
        vi.fn(async () => jsonResponse(contract.toolResponse))
      ));

      await expect(adapter.respond({
        history: [],
        text: '调用工具',
        behaviorContext: providerBehaviorContext,
        signal: new AbortController().signal
      })).rejects.toMatchObject({
        code: contract.expectedToolResponseErrorCode ?? 'PROVIDER_MALFORMED_RESPONSE',
        retryable: false
      });
    }
  );

  test.each(chatProviderContractCases)(
    '$name 保留取消与超时错误分类',
    async contract => {
      const abortError = new DOMException('测试取消', 'AbortError');
      const timeoutError = new DOMException('测试超时', 'TimeoutError');
      const abortAdapter = new ConversationChatAdapter(contract.createProvider(
        vi.fn(async () => { throw abortError; })
      ));
      const timeoutAdapter = new ConversationChatAdapter(contract.createProvider(
        vi.fn(async () => { throw timeoutError; })
      ));

      await expect(abortAdapter.respond({
        history: [],
        text: '取消',
        behaviorContext: providerBehaviorContext,
        signal: new AbortController().signal
      })).rejects.toBe(abortError);
      await expect(timeoutAdapter.respond({
        history: [],
        text: '超时',
        behaviorContext: providerBehaviorContext,
        signal: new AbortController().signal
      })).rejects.toMatchObject({
        code: 'PROVIDER_TIMEOUT',
        retryable: true
      });
    }
  );
});

describe('结构化聊天响应协议映射', () => {
  const constrainedSchemaFixture = {
    type: 'object',
    minProperties: 1,
    additionalProperties: false,
    required: ['text', 'plan'],
    properties: {
      text: {
        type: 'string',
        minLength: 1,
        maxLength: 40,
        pattern: '^.+$'
      },
      plan: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['kind'],
            properties: { kind: { const: 'none' } }
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'name'],
            properties: {
              kind: { const: 'play' },
              name: { type: 'string', pattern: '^[a-z]+$' }
            }
          }
        ]
      }
    }
  };

  test('Anthropic Provider Schema 转换器递归删除约束并规范联合类型', () => {
    const before = structuredClone(constrainedSchemaFixture);
    const transformed = toAnthropicResponseJsonSchema(constrainedSchemaFixture);

    expect(transformed).not.toBe(constrainedSchemaFixture);
    expect(constrainedSchemaFixture).toEqual(before);
    expect(transformed).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['text', 'plan'],
      properties: {
        text: { type: 'string' },
        plan: {
          anyOf: [
            {
              type: 'object',
              additionalProperties: false,
              required: ['kind'],
              properties: { kind: { type: 'string', const: 'none' } }
            },
            {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'name'],
              properties: {
                kind: { type: 'string', const: 'play' },
                name: { type: 'string' }
              }
            }
          ]
        }
      }
    });
  });

  test('Gemini Provider Schema 转换器递归删除约束并把字符串 const 转为 enum', () => {
    const before = structuredClone(constrainedSchemaFixture);
    const transformed = toGeminiResponseJsonSchema(constrainedSchemaFixture);

    expect(transformed).not.toBe(constrainedSchemaFixture);
    expect(constrainedSchemaFixture).toEqual(before);
    expect(transformed).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['text', 'plan'],
      properties: {
        text: { type: 'string' },
        plan: {
          anyOf: [
            {
              type: 'object',
              additionalProperties: false,
              required: ['kind'],
              properties: { kind: { type: 'string', enum: ['none'] } }
            },
            {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'name'],
              properties: {
                kind: { type: 'string', enum: ['play'] },
                name: { type: 'string' }
              }
            }
          ]
        }
      }
    });
  });

  test('Anthropic Provider Schema 转换器保留 $defs 与非空 $ref 节点', () => {
    const schema = {
      $defs: {
        entry: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 1, pattern: '^.+$' }
          }
        }
      },
      type: 'object',
      additionalProperties: false,
      required: ['entry'],
      properties: {
        entry: { $ref: '#/$defs/entry', pattern: '不得保留' }
      }
    };
    const before = structuredClone(schema);

    expect(toAnthropicResponseJsonSchema(schema)).toEqual({
      $defs: {
        entry: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: { name: { type: 'string' } }
        }
      },
      type: 'object',
      additionalProperties: false,
      required: ['entry'],
      properties: { entry: { $ref: '#/$defs/entry' } }
    });
    expect(schema).toEqual(before);
  });

  test('Gemini Provider Schema 转换器递归保留引用标识并清理定义约束', () => {
    const schema = {
      $id: 'https://example.com/pet.schema.json',
      $anchor: 'pet',
      $defs: {
        entry: {
          $anchor: 'entry',
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'name'],
          properties: {
            kind: { const: 'none' },
            name: { type: 'string', maxLength: 40, pattern: '^.+$' }
          }
        }
      },
      type: 'object',
      additionalProperties: false,
      required: ['entry'],
      properties: {
        entry: { $ref: '#/$defs/entry', minLength: 1 }
      }
    };
    const before = structuredClone(schema);

    expect(toGeminiResponseJsonSchema(schema)).toEqual({
      $id: 'https://example.com/pet.schema.json',
      $anchor: 'pet',
      $defs: {
        entry: {
          $anchor: 'entry',
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'name'],
          properties: {
            kind: { type: 'string', enum: ['none'] },
            name: { type: 'string' }
          }
        }
      },
      type: 'object',
      additionalProperties: false,
      required: ['entry'],
      properties: { entry: { $ref: '#/$defs/entry' } }
    });
    expect(schema).toEqual(before);
  });

  test.each(structuredProviderCases)(
    '$name 映射无工具响应契约并解码正文',
    async contract => {
      const fetchClient = vi.fn<FetchLike>(async () => jsonResponse(
        contract.textResponse('{"text":"结构正文"}')
      ));
      const provider = contract.createProvider(fetchClient);

      await expect(provider.respond(
        structuredChatRequest,
        new AbortController().signal
      )).resolves.toEqual({
        type: 'text',
        text: '结构正文',
        structured_output: { text: '结构正文' }
      });

      const body = JSON.parse(String(fetchClient.mock.calls[0]?.[1]?.body)) as Record<
        string,
        unknown
      >;
      expect(contract.requestTools(body)).toEqual([]);
      contract.assertRequestContract(body);
    }
  );

  test.each(structuredProviderCases)(
    '$name 在响应契约与工具请求冲突时不发起 fetch',
    async contract => {
      const fetchClient = vi.fn<FetchLike>();
      const provider = contract.createProvider(fetchClient);

      await expect(provider.respond({
        ...structuredChatRequest,
        tools,
        toolChoice: 'auto'
      }, new AbortController().signal)).rejects.toMatchObject({
        code: 'PROVIDER_RESPONSE_CONTRACT_CONFLICT',
        retryable: false
      });
      expect(fetchClient).not.toHaveBeenCalled();
    }
  );

  test.each(structuredProviderCases)(
    '$name 在响应契约与非 none toolChoice 冲突时不发起 fetch',
    async contract => {
      const fetchClient = vi.fn<FetchLike>();
      const provider = contract.createProvider(fetchClient);

      await expect(provider.respond({
        ...structuredChatRequest,
        toolChoice: 'auto'
      }, new AbortController().signal)).rejects.toMatchObject({
        code: 'PROVIDER_RESPONSE_CONTRACT_CONFLICT',
        retryable: false
      });
      expect(fetchClient).not.toHaveBeenCalled();
    }
  );
});

// 共享契约只验证 Agent Core 可观察到的统一行为，各协议请求形状另行验证。
function verifyProviderContract(contract: ProviderContractCase): void {
  describe(`${contract.name} 共享契约`, () => {
    test('把纯文本响应归一化为统一文本事件', async () => {
      const provider = contract.createProvider(vi.fn(async () => jsonResponse(contract.textResponse)));

      await expect(provider.respond(request, new AbortController().signal)).resolves.toEqual({
        type: 'text',
        text: '契约文本'
      });
    });

    test('把单个工具调用归一化为统一工具事件', async () => {
      const provider = contract.createProvider(vi.fn(async () => jsonResponse(contract.toolResponse)));

      await expect(provider.respond(request, new AbortController().signal)).resolves.toEqual({
        type: 'tool_request',
        request: {
          requestId: 'call-contract',
          toolName: 'read_text_file',
          arguments: { relativePath: 'notes.txt' }
        }
      });
    });

    test('只规范化协议允许的合法行为意图元数据', async () => {
      const provider = contract.createProvider(vi.fn(async () => (
        jsonResponse(contract.behaviorIntentResponse)
      )));

      await expect(provider.respond(request, new AbortController().signal)).resolves.toEqual(
        contract.expectedBehaviorIntentResponse
      );
    });

    test('忽略非法行为意图元数据并保留文本响应', async () => {
      const provider = contract.createProvider(vi.fn(async () => (
        jsonResponse(contract.invalidBehaviorIntentResponse)
      )));

      await expect(provider.respond(request, new AbortController().signal)).resolves.toEqual({
        type: 'text',
        text: '契约文本'
      });
    });

    test('工具请求不会夹带行为意图', async () => {
      const provider = contract.createProvider(vi.fn(async () => (
        jsonResponse(contract.toolResponseWithBehaviorIntent)
      )));

      await expect(provider.respond(request, new AbortController().signal)).resolves.toEqual({
        type: 'tool_request',
        request: {
          requestId: 'call-contract',
          toolName: 'read_text_file',
          arguments: { relativePath: 'notes.txt' }
        }
      });
    });

    test('保留已取消请求的原始 AbortError', async () => {
      const abortError = new DOMException('请求已取消', 'AbortError');
      const fetchClient = vi.fn<FetchLike>(async () => {
        throw abortError;
      });
      const provider = contract.createProvider(fetchClient);
      const controller = new AbortController();
      controller.abort();

      const error = await captureError(provider.respond(request, controller.signal));

      expect(error).toBe(abortError);
    });

    test('已取消 signal 也不会透传非 AbortError 的敏感详情', async () => {
      const fetchClient = vi.fn<FetchLike>(async () => {
        throw new TypeError('contract-secret 与私密响应正文不得泄漏', {
          cause: new Error('底层 cause 含 contract-secret')
        });
      });
      const provider = contract.createProvider(fetchClient);
      const controller = new AbortController();
      controller.abort();

      const error = await captureError(provider.respond(request, controller.signal));

      expect(error).toMatchObject({
        code: 'PROVIDER_NETWORK_ERROR',
        retryable: true
      });
      expectObservableErrorTextHidden(error, ['contract-secret', '私密响应正文']);
    });

    test.each([
      [401, 'PROVIDER_AUTHENTICATION_FAILED', false],
      [429, 'PROVIDER_RATE_LIMITED', true],
      [503, 'PROVIDER_SERVER_ERROR', true]
    ])('把 HTTP %i 映射为统一错误', async (status, code, retryable) => {
      const provider = contract.createProvider(vi.fn(async () => (
        jsonResponse({
          error: 'contract-secret 与供应商私密响应正文不得泄漏'
        }, status)
      )));

      const error = await captureError(provider.respond(request, new AbortController().signal));

      expect(error).toBeInstanceOf(ProviderError);
      expect(error).toMatchObject({ code, retryable, status });
      expectObservableErrorTextHidden(error, ['contract-secret', '供应商私密响应正文']);
    });

    test('把普通 fetch 异常映射为可重试网络错误', async () => {
      const fetchClient = vi.fn<FetchLike>(async () => {
        throw new TypeError('socket 含 contract-secret 与私密响应正文', {
          cause: new Error('cause 含 contract-secret 与私密响应正文')
        });
      });
      const provider = contract.createProvider(fetchClient);

      const error = await captureError(provider.respond(request, new AbortController().signal));

      expect(error).toMatchObject({
        code: 'PROVIDER_NETWORK_ERROR',
        retryable: true
      });
      expectObservableErrorTextHidden(error, ['contract-secret', '私密响应正文']);
    });

    test('拒绝文本与单个工具调用混合响应', async () => {
      const provider = contract.createProvider(vi.fn(async () => (
        jsonResponse(contract.mixedTextAndToolResponse)
      )));

      await expect(
        provider.respond(request, new AbortController().signal)
      ).rejects.toMatchObject({
        code: 'PROVIDER_MALFORMED_RESPONSE',
        retryable: false
      });
    });

    test.each([
      ['非 JSON 响应', () => new Response('not-json', { status: 200 })],
      ['缺少必要字段', (contractCase: ProviderContractCase) => (
        jsonResponse(contractCase.missingFieldsResponse)
      )],
      ['包含多个工具调用', (contractCase: ProviderContractCase) => (
        jsonResponse(contractCase.multipleToolsResponse)
      )]
    ])('拒绝%s并隐藏原始响应', async (_caseName, createResponse) => {
      const provider = contract.createProvider(vi.fn(async () => createResponse(contract)));

      const error = await captureError(provider.respond(request, new AbortController().signal));

      expect(error).toMatchObject({
        code: 'PROVIDER_MALFORMED_RESPONSE',
        retryable: false
      });
      expect(error).toBeInstanceOf(ProviderError);
      expect(Object.keys(error as object)).toEqual(['code', 'retryable', 'status', 'name']);
    });
  });
}

verifyProviderContract({
  name: 'OpenAI Compatible',
  createProvider: fetchClient => new OpenAICompatibleProvider(
    adapterProfile,
    async () => 'contract-secret',
    fetchClient
  ),
  textResponse: {
    choices: [{ message: { content: '契约文本' } }]
  },
  toolResponse: {
    choices: [{
      message: {
        content: null,
        tool_calls: [{
          id: 'call-contract',
          type: 'function',
          function: {
            name: 'read_text_file',
            arguments: '{"relativePath":"notes.txt"}'
          }
        }]
      }
    }]
  },
  behaviorIntentResponse: {
    choices: [{
      message: {
        content: '契约文本',
        metadata: {
          behaviorIntent: {
            stateIntent: { semantic: 'think' },
            actionSemantic: 'think',
            urgency: 50,
            explanation: '正在整理回应。'
          }
        }
      }
    }]
  },
  expectedBehaviorIntentResponse: {
    type: 'text',
    text: '契约文本',
    behaviorIntent: {
      stateIntent: { semantic: 'think' },
      actionSemantic: 'think',
      urgency: 50,
      explanation: '正在整理回应。'
    }
  },
  invalidBehaviorIntentResponse: {
    choices: [{
      message: {
        content: '契约文本',
        metadata: {
          behaviorIntent: {
            stateIntent: null,
            actionSemantic: 'dance',
            urgency: 50,
            explanation: '不应采用。'
          }
        }
      }
    }]
  },
  toolResponseWithBehaviorIntent: {
    choices: [{
      message: {
        content: null,
        metadata: {
          behaviorIntent: {
            stateIntent: { semantic: 'think' },
            actionSemantic: 'think',
            urgency: 50,
            explanation: '不应采用。'
          }
        },
        tool_calls: [{
          id: 'call-contract',
          type: 'function',
          function: {
            name: 'read_text_file',
            arguments: '{"relativePath":"notes.txt"}'
          }
        }]
      }
    }]
  },
  mixedTextAndToolResponse: {
    choices: [{
      message: {
        content: '不得静默丢弃',
        tool_calls: [{
          id: 'call-contract',
          type: 'function',
          function: {
            name: 'read_text_file',
            arguments: '{"relativePath":"notes.txt"}'
          }
        }]
      }
    }]
  },
  multipleToolsResponse: {
    choices: [{
      message: {
        content: null,
        tool_calls: [
          {
            id: 'call-contract',
            type: 'function',
            function: { name: 'read_text_file', arguments: '{}' }
          },
          {
            id: 'call-second',
            type: 'function',
            function: { name: 'read_text_file', arguments: '{}' }
          }
        ]
      }
    }]
  },
  missingFieldsResponse: { choices: [{}] }
});

describe('OpenAI Compatible 结构化情绪元数据', () => {
  test('白名单标签进入 ModelResponse，未知标签被拒绝', async () => {
    const valid = new OpenAICompatibleProvider(
      adapterProfile,
      async () => 'contract-secret',
      vi.fn(async () => jsonResponse({
        choices: [{
          message: {
            content: '完成',
            metadata: { emotion: 'happy' }
          }
        }]
      }))
    );
    await expect(valid.respond(request, new AbortController().signal)).resolves.toEqual({
      type: 'text',
      text: '完成',
      emotion: 'happy'
    });

    const invalid = new OpenAICompatibleProvider(
      adapterProfile,
      async () => 'contract-secret',
      vi.fn(async () => jsonResponse({
        choices: [{
          message: {
            content: '完成',
            metadata: { emotion: 'arbitrary-state' }
          }
        }]
      }))
    );
    await expect(invalid.respond(request, new AbortController().signal)).rejects.toMatchObject({
      code: 'PROVIDER_MALFORMED_RESPONSE'
    });
  });
});

verifyProviderContract({
  name: 'Anthropic',
  createProvider: fetchClient => new AnthropicProvider(
    adapterProfile,
    async () => 'contract-secret',
    fetchClient
  ),
  textResponse: {
    content: [
      { type: 'text', text: '契约' },
      { type: 'text', text: '文本' }
    ]
  },
  toolResponse: {
    content: [{
      type: 'tool_use',
      id: 'call-contract',
      name: 'read_text_file',
      input: { relativePath: 'notes.txt' }
    }]
  },
  behaviorIntentResponse: {
    metadata: {
      behaviorIntent: {
        stateIntent: { semantic: 'think' },
        actionSemantic: 'think',
        urgency: 50,
        explanation: '协议未定义此扩展槽。'
      }
    },
    content: [{ type: 'text', text: '契约文本' }]
  },
  expectedBehaviorIntentResponse: { type: 'text', text: '契约文本' },
  invalidBehaviorIntentResponse: {
    metadata: {
      behaviorIntent: {
        stateIntent: null,
        actionSemantic: 'dance',
        urgency: 50,
        explanation: '协议未定义此扩展槽。'
      }
    },
    content: [{ type: 'text', text: '契约文本' }]
  },
  toolResponseWithBehaviorIntent: {
    metadata: {
      behaviorIntent: {
        stateIntent: { semantic: 'think' },
        actionSemantic: 'think',
        urgency: 50,
        explanation: '协议未定义此扩展槽。'
      }
    },
    content: [{
      type: 'tool_use',
      id: 'call-contract',
      name: 'read_text_file',
      input: { relativePath: 'notes.txt' }
    }]
  },
  mixedTextAndToolResponse: {
    content: [
      { type: 'text', text: '不得静默丢弃' },
      {
        type: 'tool_use',
        id: 'call-contract',
        name: 'read_text_file',
        input: { relativePath: 'notes.txt' }
      }
    ]
  },
  multipleToolsResponse: {
    content: [
      {
        type: 'tool_use',
        id: 'call-contract',
        name: 'read_text_file',
        input: {}
      },
      {
        type: 'tool_use',
        id: 'call-second',
        name: 'read_text_file',
        input: {}
      }
    ]
  },
  missingFieldsResponse: {
    content: [{ type: 'text' }]
  }
});

verifyProviderContract({
  name: 'Gemini',
  createProvider: fetchClient => new GeminiProvider(
    adapterProfile,
    async () => 'contract-secret',
    fetchClient
  ),
  textResponse: {
    candidates: [{
      content: {
        parts: [
          { text: '契约' },
          { text: '文本' }
        ]
      }
    }]
  },
  toolResponse: {
    candidates: [{
      content: {
        parts: [{
          functionCall: {
            id: 'call-contract',
            name: 'read_text_file',
            args: { relativePath: 'notes.txt' }
          }
        }]
      }
    }]
  },
  behaviorIntentResponse: {
    candidates: [{
      metadata: {
        behaviorIntent: {
          stateIntent: { semantic: 'think' },
          actionSemantic: 'think',
          urgency: 50,
          explanation: '协议未定义此扩展槽。'
        }
      },
      content: { parts: [{ text: '契约文本' }] }
    }]
  },
  expectedBehaviorIntentResponse: { type: 'text', text: '契约文本' },
  invalidBehaviorIntentResponse: {
    candidates: [{
      metadata: {
        behaviorIntent: {
          stateIntent: null,
          actionSemantic: 'dance',
          urgency: 50,
          explanation: '协议未定义此扩展槽。'
        }
      },
      content: { parts: [{ text: '契约文本' }] }
    }]
  },
  toolResponseWithBehaviorIntent: {
    candidates: [{
      metadata: {
        behaviorIntent: {
          stateIntent: { semantic: 'think' },
          actionSemantic: 'think',
          urgency: 50,
          explanation: '协议未定义此扩展槽。'
        }
      },
      content: {
        parts: [{
          functionCall: {
            id: 'call-contract',
            name: 'read_text_file',
            args: { relativePath: 'notes.txt' }
          }
        }]
      }
    }]
  },
  mixedTextAndToolResponse: {
    candidates: [{
      content: {
        parts: [
          { text: '不得静默丢弃' },
          {
            functionCall: {
              id: 'call-contract',
              name: 'read_text_file',
              args: { relativePath: 'notes.txt' }
            }
          }
        ]
      }
    }]
  },
  multipleToolsResponse: {
    candidates: [{
      content: {
        parts: [
          { functionCall: { name: 'read_text_file', args: {} } },
          { functionCall: { name: 'read_text_file', args: {} } }
        ]
      }
    }]
  },
  missingFieldsResponse: {
    candidates: [{ content: {} }]
  }
});

describe('协议请求映射', () => {
  test('OpenAI Compatible 编码工具别名、传递 required 并还原响应内部名', async () => {
    let body: Record<string, unknown> | undefined;
    const fetchClient = vi.fn<FetchLike>(async (_input, init) => {
      const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      body = requestBody;
      const providerName = ((requestBody.tools as Array<{
        function: { name: string };
      }>)[0]?.function.name);
      return jsonResponse({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: 'delete-file-1',
              type: 'function',
              function: {
                name: providerName,
                arguments: '{"relativePath":"old.txt"}'
              }
            }]
          }
        }]
      });
    });
    const provider = new OpenAICompatibleProvider(
      adapterProfile,
      async () => 'secret',
      fetchClient
    );
    const deleteTool: ToolDefinition = {
      type: 'function',
      function: {
        name: 'builtin.files.delete_file',
        description: '删除文件',
        parameters: { type: 'object' }
      }
    };

    await expect(provider.respond({
      ...request,
      tools: [deleteTool],
      toolChoice: 'required'
    }, new AbortController().signal)).resolves.toEqual({
      type: 'tool_request',
      request: {
        requestId: 'delete-file-1',
        toolName: 'builtin.files.delete_file',
        arguments: { relativePath: 'old.txt' }
      }
    });

    expect(body?.tools).toEqual([expect.objectContaining({
      function: expect.objectContaining({
        name: expect.stringMatching(/^[A-Za-z0-9_-]{1,64}$/u)
      })
    })]);
    expect((body?.tools as Array<{ function: { name: string } }>)[0]?.function.name)
      .not.toContain('.');
    expect(body?.tool_choice).toBe('required');
  });

  test('OpenAI Compatible 拒绝未知 Provider 工具别名', async () => {
    const provider = new OpenAICompatibleProvider(
      adapterProfile,
      async () => 'secret',
      vi.fn(async () => jsonResponse({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: 'unknown-tool-1',
              type: 'function',
              function: { name: 'unknown_provider_tool', arguments: '{}' }
            }]
          }
        }]
      }))
    );

    await expect(provider.respond({
      ...request,
      tools: [{
        type: 'function',
        function: {
          name: 'builtin.files.delete_file',
          description: '删除文件',
          parameters: { type: 'object' }
        }
      }],
      toolChoice: 'required'
    }, new AbortController().signal)).rejects.toMatchObject({
      code: 'PROVIDER_UNKNOWN_TOOL_CALL',
      retryable: false
    });
  });

  test('DeepSeek 禁用推理覆盖附加 thinking 参数且预设路径保留 providerId', async () => {
    const additionalParameters = {
      thinking: { type: 'enabled' }
    } as unknown as Record<string, string | number | boolean>;
    const directFetchClient = vi.fn<FetchLike>(async () => jsonResponse({
      choices: [{ message: { content: '完成' } }]
    }));
    const directProvider = new OpenAICompatibleProvider({
      ...adapterProfile,
      providerId: 'deepseek',
      additionalParameters
    }, async () => 'secret', directFetchClient);
    const presetFetchClient = vi.fn<FetchLike>(async () => jsonResponse({
      choices: [{ message: { content: '完成' } }]
    }));
    const presetProfile: ProviderProfileV2 = {
      id: 'deepseek-reasoning-profile',
      displayName: 'DeepSeek',
      mode: 'preset',
      providerId: 'deepseek',
      modelId: 'deepseek-v4-flash',
      hasStoredSecret: true
    };
    const presetProvider = new ProviderRegistry(providerCatalog).create(
      presetProfile,
      async () => 'secret',
      presetFetchClient
    );

    await directProvider.respond({
      ...request,
      reasoningMode: 'disabled'
    }, new AbortController().signal);
    await presetProvider.respond({
      ...request,
      reasoningMode: 'disabled'
    }, new AbortController().signal);

    expect(JSON.parse(String(directFetchClient.mock.calls[0]?.[1]?.body))).toMatchObject({
      thinking: { type: 'disabled' }
    });
    expect(JSON.parse(String(presetFetchClient.mock.calls[0]?.[1]?.body))).toMatchObject({
      thinking: { type: 'disabled' }
    });
  });

  test('仅 DeepSeek 的 disabled 推理模式注入 thinking', async () => {
    const openAIFetchClient = vi.fn<FetchLike>(async () => jsonResponse({
      choices: [{ message: { content: '完成' } }]
    }));
    const deepSeekDefaultFetchClient = vi.fn<FetchLike>(async () => jsonResponse({
      choices: [{ message: { content: '完成' } }]
    }));
    const openAIProvider = new OpenAICompatibleProvider({
      ...adapterProfile,
      providerId: 'openai'
    }, async () => 'secret', openAIFetchClient);
    const deepSeekProvider = new OpenAICompatibleProvider({
      ...adapterProfile,
      providerId: 'deepseek'
    }, async () => 'secret', deepSeekDefaultFetchClient);

    await openAIProvider.respond({ ...request, reasoningMode: 'disabled' }, new AbortController().signal);
    await deepSeekProvider.respond({
      ...request,
      reasoningMode: 'provider_default'
    }, new AbortController().signal);

    expect(JSON.parse(String(openAIFetchClient.mock.calls[0]?.[1]?.body))).not
      .toHaveProperty('thinking');
    expect(JSON.parse(String(deepSeekDefaultFetchClient.mock.calls[0]?.[1]?.body))).not
      .toHaveProperty('thinking');
  });

  test('OpenAI Compatible 续传时保留同一工具别名、调用 ID 与工具结果正文', async () => {
    const fetchClient = vi.fn<FetchLike>(async () => jsonResponse({
      choices: [{ message: { content: '完成' } }]
    }));
    const provider = new OpenAICompatibleProvider(
      adapterProfile,
      async () => 'secret',
      fetchClient
    );

    await provider.respond({
      ...request,
      tools: [{
        type: 'function',
        function: {
          name: 'builtin.files.delete_file',
          description: '删除文件',
          parameters: { type: 'object' }
        }
      }],
      toolChoice: 'auto',
      messages: [{
        role: 'assistant',
        content: '',
        toolRequest: {
          requestId: 'delete-file-history-1',
          toolName: 'builtin.files.delete_file',
          arguments: { relativePath: 'old.txt' }
        }
      }, {
        role: 'tool',
        toolCallId: 'delete-file-history-1',
        content: '{"deleted":"old.txt"}'
      }]
    }, new AbortController().signal);

    const body = JSON.parse(String(fetchClient.mock.calls[0]?.[1]?.body));
    const providerName = body.tools[0].function.name;
    expect(body.messages).toEqual([{
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'delete-file-history-1',
        type: 'function',
        function: {
          name: providerName,
          arguments: '{"relativePath":"old.txt"}'
        }
      }]
    }, {
      role: 'tool',
      tool_call_id: 'delete-file-history-1',
      content: '{"deleted":"old.txt"}'
    }]);
    expect(providerName).not.toContain('.');
  });

  test('Anthropic 使用专用认证头并映射 system、消息和工具 Schema', async () => {
    const fetchClient = vi.fn<FetchLike>(async () => jsonResponse({
      content: [{ type: 'text', text: '完成' }]
    }));
    const provider = new AnthropicProvider(
      adapterProfile,
      async () => 'anthropic-secret',
      fetchClient
    );

    await provider.respond(request, new AbortController().signal);

    const [url, init] = fetchClient.mock.calls[0] ?? [];
    const headers = new Headers(init?.headers);
    expect(String(url)).toBe('https://api.example.com/v1/messages');
    expect(headers.get('x-api-key')).toBe('anthropic-secret');
    expect(headers.get('anthropic-version')).toBe('2023-06-01');
    expect(String(url)).not.toContain('anthropic-secret');
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'contract-model',
      max_tokens: 4096,
      system: '只返回必要内容。',
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: '读取 notes.txt' }]
      }],
      tools: [{
        name: 'read_text_file',
        description: '读取文本文件',
        input_schema: tools[0]?.function.parameters
      }]
    });
  });

  test('Anthropic 映射助手工具请求和工具结果历史', async () => {
    const fetchClient = vi.fn<FetchLike>(async () => jsonResponse({
      content: [{ type: 'text', text: '完成' }]
    }));
    const provider = new AnthropicProvider(
      adapterProfile,
      async () => 'secret',
      fetchClient
    );

    await provider.respond({
      tools,
      toolChoice: 'none',
      reasoningMode: 'provider_default',
      messages: [
        {
          role: 'assistant',
          content: '',
          toolRequest: {
            requestId: 'call-history',
            toolName: 'read_text_file',
            arguments: { relativePath: 'notes.txt' }
          }
        },
        {
          role: 'tool',
          toolCallId: 'call-history',
          content: '{"content":"示例"}'
        }
      ]
    }, new AbortController().signal);

    expect(JSON.parse(String(fetchClient.mock.calls[0]?.[1]?.body)).messages).toEqual([
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'call-history',
          name: 'read_text_file',
          input: { relativePath: 'notes.txt' }
        }]
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'call-history',
          content: '{"content":"示例"}'
        }]
      }
    ]);
  });

  test('Gemini 使用 Header 传密钥并映射 system、消息和工具 Schema', async () => {
    const fetchClient = vi.fn<FetchLike>(async () => jsonResponse({
      candidates: [{ content: { parts: [{ text: '完成' }] } }]
    }));
    const provider = new GeminiProvider(
      adapterProfile,
      async () => 'gemini-secret',
      fetchClient
    );

    await provider.respond(request, new AbortController().signal);

    const [url, init] = fetchClient.mock.calls[0] ?? [];
    const headers = new Headers(init?.headers);
    expect(String(url)).toBe(
      'https://api.example.com/v1/models/contract-model:generateContent'
    );
    expect(headers.get('x-goog-api-key')).toBe('gemini-secret');
    expect(String(url)).not.toContain('gemini-secret');
    expect(JSON.parse(String(init?.body))).toEqual({
      systemInstruction: {
        parts: [{ text: '只返回必要内容。' }]
      },
      contents: [{
        role: 'user',
        parts: [{ text: '读取 notes.txt' }]
      }],
      tools: [{
        functionDeclarations: [{
          name: 'read_text_file',
          description: '读取文本文件',
          parameters: tools[0]?.function.parameters
        }]
      }]
    });
  });

  test('Gemini 在真实两轮历史中回传 thoughtSignature 和调用 ID', async () => {
    const fetchClient = vi.fn<FetchLike>()
      .mockResolvedValueOnce(jsonResponse({
        candidates: [{
          content: {
            parts: [{
              functionCall: {
                id: 'call-history',
                name: 'builtin.files.read_text',
                args: { relativePath: 'notes.txt' }
              },
              thoughtSignature: 'private-thought-signature'
            }]
          }
        }]
      }))
      .mockResolvedValueOnce(jsonResponse({
        candidates: [{ content: { parts: [{ text: '完成' }] } }]
      }));
    const provider = new GeminiProvider(
      adapterProfile,
      async () => 'secret',
      fetchClient
    );

    const firstResponse = await provider.respond(request, new AbortController().signal);
    expect(firstResponse).toEqual({
      type: 'tool_request',
      request: {
        requestId: 'call-history',
        toolName: 'builtin.files.read_text',
        arguments: { relativePath: 'notes.txt' }
      }
    });
    expect(String(firstResponse)).not.toContain('private-thought-signature');
    const toolRequest = toolRequestSchema.parse(
      firstResponse.type === 'tool_request' ? firstResponse.request : undefined
    );

    await provider.respond({
      tools,
      toolChoice: 'none',
      reasoningMode: 'provider_default',
      messages: [
        ...request.messages,
        {
          role: 'assistant',
          content: '',
          toolRequest
        },
        {
          role: 'tool',
          toolCallId: 'call-history',
          content: '{"content":"示例"}'
        }
      ]
    }, new AbortController().signal);

    const secondBody = JSON.parse(String(fetchClient.mock.calls[1]?.[1]?.body));
    expect(secondBody.contents.slice(-2)).toEqual([
      {
        role: 'model',
        parts: [{
          functionCall: {
            id: 'call-history',
            name: 'builtin.files.read_text',
            args: { relativePath: 'notes.txt' }
          },
          thoughtSignature: 'private-thought-signature'
        }]
      },
      {
        role: 'user',
        parts: [{
          functionResponse: {
            id: 'call-history',
            name: 'builtin.files.read_text',
            response: { content: '示例' }
          }
        }]
      }
    ]);
  });

  test('Gemini 为连续同名无 ID 调用分配唯一回退 ID 并恢复各自签名', async () => {
    const functionCallResponse = (
      relativePath: string,
      thoughtSignature: string
    ): Response => jsonResponse({
      candidates: [{
        content: {
          parts: [{
            functionCall: {
              name: 'builtin.files.read_text',
              args: { relativePath }
            },
            thoughtSignature
          }]
        }
      }]
    });
    const fetchClient = vi.fn<FetchLike>()
      .mockResolvedValueOnce(functionCallResponse('notes-1.txt', 'signature-1'))
      .mockResolvedValueOnce(functionCallResponse('notes-2.txt', 'signature-2'))
      .mockResolvedValueOnce(jsonResponse({
        candidates: [{ content: { parts: [{ text: '完成' }] } }]
      }));
    const provider = new GeminiProvider(
      adapterProfile,
      async () => 'secret',
      fetchClient
    );

    const firstResponse = await provider.respond(request, new AbortController().signal);
    const firstToolRequest = toolRequestSchema.parse(
      firstResponse.type === 'tool_request' ? firstResponse.request : undefined
    );
    const secondResponse = await provider.respond(request, new AbortController().signal);
    const secondToolRequest = toolRequestSchema.parse(
      secondResponse.type === 'tool_request' ? secondResponse.request : undefined
    );

    await provider.respond({
      tools,
      toolChoice: 'none',
      reasoningMode: 'provider_default',
      messages: [
        ...request.messages,
        { role: 'assistant', content: '', toolRequest: firstToolRequest },
        {
          role: 'tool',
          toolCallId: firstToolRequest.requestId,
          content: '{"content":"第一份"}'
        },
        { role: 'assistant', content: '', toolRequest: secondToolRequest },
        {
          role: 'tool',
          toolCallId: secondToolRequest.requestId,
          content: '{"content":"第二份"}'
        }
      ]
    }, new AbortController().signal);

    expect(firstToolRequest.requestId).toMatch(
      /^gemini-call-builtin\.files\.read_text-[1-9]\d*$/
    );
    expect(secondToolRequest.requestId).toMatch(
      /^gemini-call-builtin\.files\.read_text-[1-9]\d*$/
    );
    expect(secondToolRequest.requestId).not.toBe(firstToolRequest.requestId);
    const thirdBody = JSON.parse(String(fetchClient.mock.calls[2]?.[1]?.body));
    expect(thirdBody.contents.slice(-4)).toEqual([
      {
        role: 'model',
        parts: [{
          functionCall: {
            id: firstToolRequest.requestId,
            name: 'builtin.files.read_text',
            args: { relativePath: 'notes-1.txt' }
          },
          thoughtSignature: 'signature-1'
        }]
      },
      {
        role: 'user',
        parts: [{
          functionResponse: {
            id: firstToolRequest.requestId,
            name: 'builtin.files.read_text',
            response: { content: '第一份' }
          }
        }]
      },
      {
        role: 'model',
        parts: [{
          functionCall: {
            id: secondToolRequest.requestId,
            name: 'builtin.files.read_text',
            args: { relativePath: 'notes-2.txt' }
          },
          thoughtSignature: 'signature-2'
        }]
      },
      {
        role: 'user',
        parts: [{
          functionResponse: {
            id: secondToolRequest.requestId,
            name: 'builtin.files.read_text',
            response: { content: '第二份' }
          }
        }]
      }
    ]);
  });

  test('Gemini 拒绝同一 part 混合文本与函数调用', async () => {
    const fetchClient = vi.fn<FetchLike>(async () => jsonResponse({
      candidates: [{
        content: {
          parts: [{
            text: '不得接受',
            functionCall: {
              name: 'read_text_file',
              args: { relativePath: 'notes.txt' }
            }
          }]
        }
      }]
    }));
    const provider = new GeminiProvider(
      adapterProfile,
      async () => 'secret',
      fetchClient
    );

    await expect(
      provider.respond(request, new AbortController().signal)
    ).rejects.toMatchObject({
      code: 'PROVIDER_MALFORMED_RESPONSE',
      retryable: false
    });
  });
});

describe('ProviderRegistry', () => {
  const builtinLocalProfile: ProviderProfileV2 = {
    id: BUILTIN_LOCAL_PROFILE_ID,
    displayName: '内置本地模型',
    mode: 'preset',
    providerId: BUILTIN_LOCAL_PROFILE_ID,
    modelId: BUILTIN_LOCAL_PROFILE_ID,
    capabilities: ['chat', 'tools'],
    hasStoredSecret: false
  };

  test('仅固定 builtin-local 档案使用 Main 注入 factory', () => {
    const localProvider = {
      respond: vi.fn<ModelProvider['respond']>()
    } satisfies ModelProvider;
    const localFactory = vi.fn(() => localProvider);
    const registry = new ProviderRegistry(providerCatalog, localFactory);
    expect(registry.create(builtinLocalProfile, async () => '不得读取')).toBe(localProvider);
    expect(localFactory).toHaveBeenCalledOnce();
  });

  test.each([
    ['id', { ...builtinLocalProfile, id: '伪造档案' }],
    ['providerId', { ...builtinLocalProfile, providerId: 'openai' }],
    ['mode', {
      id: BUILTIN_LOCAL_PROFILE_ID,
      displayName: '内置本地模型',
      mode: 'custom',
      protocol: 'openai-compatible',
      baseUrl: 'https://custom.example.com/v1',
      modelId: BUILTIN_LOCAL_PROFILE_ID,
      additionalParameters: {},
      capabilities: ['chat', 'tools'],
      hasStoredSecret: false
    }],
    ['modelId', { ...builtinLocalProfile, modelId: '伪造模型' }],
    ['capabilities', { ...builtinLocalProfile, capabilities: ['chat', 'vision'] }],
    ['hasStoredSecret', { ...builtinLocalProfile, hasStoredSecret: true }]
  ] satisfies Array<[string, ProviderProfileV2]>)('伪造 builtin-local 的 %s 时不调用 factory', (
    _field,
    profile
  ) => {
    const localFactory = vi.fn<() => ModelProvider>();
    const registry = new ProviderRegistry(providerCatalog, localFactory);

    try {
      registry.create(profile, async () => 'secret');
    } catch {
      // 非公开预置档案可由既有目录校验拒绝；本测试只验证不能越过固定身份边界。
    }

    expect(localFactory).not.toHaveBeenCalled();
  });

  test('注入本地 factory 后现有 Provider 仍按目录协议创建', () => {
    const localFactory = vi.fn<() => ModelProvider>();
    const registry = new ProviderRegistry(providerCatalog, localFactory);
    const profile: ProviderProfileV2 = {
      id: 'openai-profile',
      displayName: 'OpenAI',
      mode: 'preset',
      providerId: 'openai',
      modelId: 'gpt-4.1-mini',
      hasStoredSecret: true
    };

    expect(registry.create(profile, async () => 'secret'))
      .toBeInstanceOf(OpenAICompatibleProvider);
    expect(localFactory).not.toHaveBeenCalled();
  });

  test.each([
    ['anthropic', AnthropicProvider],
    ['gemini', GeminiProvider],
    ['openai', OpenAICompatibleProvider]
  ] as const)('按目录协议为 %s 创建正确适配器', (providerId, ProviderClass) => {
    const entry = providerCatalog.find(item => item.providerId === providerId);
    if (!entry) throw new Error(`测试目录缺少 ${providerId}`);
    const profile: ProviderProfileV2 = {
      id: `${providerId}-profile`,
      displayName: entry.displayName,
      mode: 'preset',
      providerId,
      modelId: entry.models[0]?.modelId ?? '',
      hasStoredSecret: true
    };
    const registry = new ProviderRegistry(providerCatalog);

    const provider = registry.create(
      profile,
      async () => 'secret',
      vi.fn<FetchLike>()
    );

    expect(provider).toBeInstanceOf(ProviderClass);
  });

  test.each([
    [
      'deepseek',
      'https://api.deepseek.com/chat/completions',
      'deepseek-v4-flash'
    ],
    [
      'kimi',
      'https://api.moonshot.cn/v1/chat/completions',
      'kimi-k2.5'
    ],
    [
      'qwen',
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      'qwen-plus'
    ]
  ] as const)(
    '%s 复用 OpenAI Compatible 类及目录 URL/模型',
    async (providerId, expectedUrl, expectedModelId) => {
      const entry = providerCatalog.find(item => item.providerId === providerId);
      if (!entry) throw new Error(`测试目录缺少 ${providerId}`);
      const profile: ProviderProfileV2 = {
        id: `${providerId}-profile`,
        displayName: entry.displayName,
        mode: 'preset',
        providerId,
        modelId: expectedModelId,
        hasStoredSecret: true
      };
      const fetchClient = vi.fn<FetchLike>(async () => jsonResponse({
        choices: [{ message: { content: '完成' } }]
      }));
      const registry = new ProviderRegistry(providerCatalog);

      const provider = registry.create(profile, async () => 'cn-secret', fetchClient);
      await provider.respond(request, new AbortController().signal);

      expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
      const [url, init] = fetchClient.mock.calls[0] ?? [];
      expect(String(url)).toBe(expectedUrl);
      expect(JSON.parse(String(init?.body)).model).toBe(expectedModelId);
    }
  );

  test('DeepSeek 预设通过既有 OpenAI Compatible 边界返回完整桌宠结构', async () => {
    const profile: ProviderProfileV2 = {
      id: 'deepseek-chat-profile',
      displayName: 'DeepSeek',
      mode: 'preset',
      providerId: 'deepseek',
      modelId: 'deepseek-v4-flash',
      hasStoredSecret: true
    };
    const visibleText = '  **自然回复**\n\n```ts\n你好();\n```\n';
    const fetchClient = vi.fn<FetchLike>(async () => jsonResponse({
      choices: [{ message: { content: characterChatJson(visibleText) } }]
    }));
    const provider = new ProviderRegistry(providerCatalog).create(
      profile,
      async () => 'deepseek-secret',
      fetchClient
    );
    const adapter = new ConversationChatAdapter(provider);

    await expect(adapter.respond({
      history: [],
      text: '给出 Markdown 示例',
      behaviorContext: providerBehaviorContext,
      signal: new AbortController().signal
    })).resolves.toEqual({
      text: visibleText,
      activity: '安静陪伴',
      status: 'idle',
      movementControl: { kind: 'keep' },
      behaviorPlan: { kind: 'none' },
      capabilityPlan: { kind: 'chat' }
    });

    const body = JSON.parse(String(fetchClient.mock.calls[0]?.[1]?.body));
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(body).toMatchObject({
      model: 'deepseek-v4-flash',
      thinking: { type: 'disabled' },
      max_tokens: 4096,
      tools: [],
      messages: [
        { role: 'system', content: expect.any(String) },
        { role: 'user', content: '给出 Markdown 示例' }
      ]
    });
  });

  test('DeepSeek 桌宠聊天空 content 仅在 Provider 内重试一次并复用同一配置', async () => {
    const profile: ProviderProfileV2 = {
      id: 'deepseek-empty-chat-profile',
      displayName: 'DeepSeek',
      mode: 'preset',
      providerId: 'deepseek',
      modelId: 'deepseek-v4-flash',
      hasStoredSecret: true
    };
    const fetchClient = vi.fn<FetchLike>()
      .mockResolvedValueOnce(sseResponse([
        JSON.stringify({ choices: [{ delta: { content: null, tool_calls: [] } }] }),
        '[DONE]'
      ]))
      .mockResolvedValueOnce(characterChatSseResponse(
        'OpenAI Compatible',
        '{"text":"重试后正文"}'
      ));
    const adapter = new ConversationChatAdapter(new ProviderRegistry(providerCatalog).create(
      profile,
      async () => 'deepseek-secret',
      fetchClient
    ));

    await expect(adapter.respond({
      history: [],
      text: '你好',
      behaviorContext: providerBehaviorContext,
      signal: new AbortController().signal,
      onTextDelta: vi.fn()
    })).resolves.toEqual({ text: '重试后正文' });

    expect(fetchClient).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String(fetchClient.mock.calls[0]?.[1]?.body));
    const secondBody = JSON.parse(String(fetchClient.mock.calls[1]?.[1]?.body));
    expect(secondBody).toEqual(firstBody);
    expect(firstBody).toMatchObject({
      thinking: { type: 'disabled' },
      max_tokens: 4096,
      response_format: { type: 'json_object' },
      stream: true,
      tools: [],
      tool_choice: 'none'
    });
  });

  test('DeepSeek 桌宠聊天空 content 重试耗尽后返回格式错误', async () => {
    const profile: ProviderProfileV2 = {
      id: 'deepseek-empty-chat-failure-profile',
      displayName: 'DeepSeek',
      mode: 'preset',
      providerId: 'deepseek',
      modelId: 'deepseek-v4-flash',
      hasStoredSecret: true
    };
    const fetchClient = vi.fn<FetchLike>(async () => jsonResponse({
      choices: [{ message: { content: null, tool_calls: [] } }]
    }));
    const adapter = new ConversationChatAdapter(new ProviderRegistry(providerCatalog).create(
      profile,
      async () => 'deepseek-secret',
      fetchClient
    ));

    await expect(adapter.respond({
      history: [],
      text: '你好',
      behaviorContext: providerBehaviorContext,
      signal: new AbortController().signal
    })).rejects.toMatchObject({
      code: 'PROVIDER_MALFORMED_RESPONSE',
      retryable: false
    });
    expect(fetchClient).toHaveBeenCalledTimes(2);
  });

  test('拒绝未知预置提供商', () => {
    const profile: ProviderProfileV2 = {
      id: 'unknown-profile',
      displayName: '未知服务',
      mode: 'preset',
      providerId: 'unknown',
      modelId: 'unknown-model',
      hasStoredSecret: false
    };
    const registry = new ProviderRegistry(providerCatalog);

    expect(() => registry.create(profile, async () => 'secret')).toThrowError(
      expect.objectContaining({
        code: 'PROVIDER_CATALOG_ENTRY_NOT_FOUND',
        retryable: false
      })
    );
  });

  test('已知预置提供商可创建目录外模型适配器', () => {
    const profile: ProviderProfileV2 = {
      id: 'openai-profile',
      displayName: 'OpenAI',
      mode: 'preset',
      providerId: 'openai',
      modelId: 'not-in-catalog',
      capabilities: ['chat'],
      hasStoredSecret: true
    };
    const registry = new ProviderRegistry(providerCatalog);

    expect(registry.create(profile, async () => 'secret'))
      .toBeInstanceOf(OpenAICompatibleProvider);
  });

  test('把自定义档案的白名单标量参数合并到请求顶层', async () => {
    const profile: ProviderProfileV2 = {
      id: 'custom-profile',
      displayName: '自定义服务',
      mode: 'custom',
      protocol: 'openai-compatible',
      baseUrl: 'https://custom.example.com/v1',
      modelId: 'custom-model',
      hasStoredSecret: true,
      additionalParameters: {
        temperature: 0.2,
        seed: 7,
        safety_mode: true
      }
    };
    const fetchClient = vi.fn<FetchLike>(async () => jsonResponse({
      choices: [{ message: { content: '完成' } }]
    }));
    const registry = new ProviderRegistry(providerCatalog);

    const provider = registry.create(profile, async () => 'custom-secret', fetchClient);
    await provider.respond(request, new AbortController().signal);

    expect(JSON.parse(String(fetchClient.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: 'custom-model',
      temperature: 0.2,
      seed: 7,
      safety_mode: true
    });
  });

  test.each([
    'model',
    'messages',
    'tools',
    'tool_choice',
    'stream',
    'max_tokens',
    'response_format',
    'output_config',
    'authorization',
    'x-api-key',
    'x-goog-api-key',
    'timeout'
  ])('拒绝额外参数覆盖保留字段 %s', reservedKey => {
    const profile: ProviderProfileV2 = {
      id: 'custom-profile',
      displayName: '自定义服务',
      mode: 'custom',
      protocol: 'openai-compatible',
      baseUrl: 'https://custom.example.com/v1',
      modelId: 'custom-model',
      hasStoredSecret: true,
      additionalParameters: { [reservedKey]: '覆盖值' }
    };
    const registry = new ProviderRegistry(providerCatalog);

    expect(() => registry.create(profile, async () => 'secret')).toThrow(ProviderError);
  });
});
