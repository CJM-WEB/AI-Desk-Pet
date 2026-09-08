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
import { ProviderResponseError } from '../src/main/providers/provider-response-error';
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
import { characterExpressionSelectionJsonSchema, characterExpressionSelectionSchema } from '@myself/character-runtime';
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
  character: { idleStateId: 'protocol-state',
    identity: { formsOfAddress: [], dislikes: [], boundaries: [], exampleLines: [],
      name: '契约测试角色', description: '契约测试角色', background: '测试环境', traits: [],
      languageStyle: '简洁', likes: [], behavioralTendencies: []
    },
    states: [{ agentInferable: true,
      name: '移动', stateId: 'protocol-state', tags: [],
      actions: [{ name: '散步', actionId: 'protocol-action', tags: [] }]
    }]
  },
  runtime: {
    chatting: false, taskRunning: false, awaitingConfirmation: false, moving: false,
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
  name: 'character_expression',
  jsonSchema: characterExpressionSelectionJsonSchema,
  validateStructuredOutput: value => characterExpressionSelectionSchema.safeParse(value).success
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

describe('Provider 响应格式故障分类', () => {
  test('HTTP 200 正文不是 JSON 时返回 HTTP_BODY_NOT_JSON 且不携带原始响应', async () => {
    const apiKey = 'sk-private-contract-key';
    const privateBody = '私密文件正文 C:\\Users\\Alice\\Documents\\secret.txt';
    const provider = new OpenAICompatibleProvider(
      adapterProfile,
      async () => apiKey,
      vi.fn(async () => new Response(privateBody, { status: 200 }))
    );

    const error = await captureError(provider.respond(request, new AbortController().signal));

    expect(error).toMatchObject({ code: 'HTTP_BODY_NOT_JSON', stage: 'transport' });
    expectObservableErrorTextHidden(error, [apiKey, privateBody, 'C:\\Users\\Alice\\Documents\\secret.txt']);
  });

  test('完整 Anthropic 包络缺少 content 时返回 RESPONSE_SHAPE_INVALID', async () => {
    const provider = new AnthropicProvider(
      adapterProfile,
      async () => 'anthropic-private-key',
      vi.fn(async () => jsonResponse({ id: 'message-private', type: 'message', role: 'assistant' }))
    );

    await expect(provider.respond(request, new AbortController().signal)).rejects.toMatchObject({
      code: 'RESPONSE_SHAPE_INVALID',
      stage: 'transport'
    });
  });

  test('OpenAI 工具参数不是对象 JSON 时返回 TOOL_ARGUMENTS_INVALID 且不自动重放', async () => {
    const sensitiveArguments = '{"path":"C:\\\\Users\\\\Alice\\\\secret.txt","content":"私密正文"';
    const fetchClient = vi.fn<FetchLike>(async () => jsonResponse({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: 'call-private',
            type: 'function',
            function: { name: 'read_text_file', arguments: sensitiveArguments }
          }]
        }
      }]
    }));
    const provider = new OpenAICompatibleProvider(
      adapterProfile,
      async () => 'tool-private-key',
      fetchClient
    );

    const error = await captureError(provider.respond(request, new AbortController().signal));

    expect(error).toMatchObject({ code: 'TOOL_ARGUMENTS_INVALID', stage: 'tool_call' });
    expect(fetchClient).toHaveBeenCalledOnce();
    expectObservableErrorTextHidden(error, [sensitiveArguments, 'C:\\Users\\Alice\\secret.txt', '私密正文']);
  });

  test('响应契约对象缺少可见 text 时返回 RESPONSE_FORMAT_UNSUPPORTED', async () => {
    const provider = new GeminiProvider(
      adapterProfile,
      async () => 'gemini-private-key',
      vi.fn(async () => jsonResponse({
        candidates: [{ content: { parts: [{ text: '{"status":"idle"}' }] } }]
      }))
    );

    await expect(provider.respond(structuredChatRequest, new AbortController().signal))
      .rejects.toMatchObject({
        code: 'RESPONSE_FORMAT_UNSUPPORTED',
        stage: 'chat_control'
      });
  });
});

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

describe('ConversationChatAdapter 三类 Provider 协议契约', () => {
  test.each(chatProviderContractCases)('$name先自然正文再独立表现，正文逐字保留且不增量公开', async contract => {
    const text = '  **自然正文**\n'; let calls = 0;
    const selection = { moodUpdate: { summary: '开心', strength: .8 }, expressionPlan: null,
      requestKind: 'ambient', explicitPlayback: null, movementControl: { kind: 'keep' } };
    const fetchClient = vi.fn<FetchLike>(async () => jsonResponse(contract.textResponse(++calls === 1 ? text : JSON.stringify(selection))));
    const onTextDelta = vi.fn();
    const reply = await new ConversationChatAdapter(contract.createProvider(fetchClient)).respond({ history: [], text: '你好', behaviorContext: providerBehaviorContext, signal: new AbortController().signal, onTextDelta });
    expect(reply).toMatchObject({ text, capabilityPlan: { kind: 'chat' }, moodUpdate: { summary: '开心', strength: .8, fadeInMs: 0 }, expressionStatus: 'no_match', expressionPlan: { states: [] } });
    expect(onTextDelta).not.toHaveBeenCalled();
    const bodies = fetchClient.mock.calls.map(call => JSON.parse(String(call[1]?.body)));
    expect(contract.requestTools(bodies[0])).toHaveLength(1);
    expect(JSON.stringify(contract.requestTools(bodies[0]))).toContain('request_task_authorization');
    expect(contract.requestTools(bodies[1])).toEqual([]);
    expect(bodies[0]).not.toHaveProperty('response_format');
    expect(bodies[0]).not.toHaveProperty('output_config');
  });
  test.each(chatProviderContractCases)('$name旧JSON只作为正文，独立表现格式失败保留正文', async contract => {
    const text = '{"text":"旧信封","capabilityPlan":{"kind":"agent_task"}}';
    const fetchClient = vi.fn<FetchLike>(async () => jsonResponse(contract.textResponse(text)));
    expect(await new ConversationChatAdapter(contract.createProvider(fetchClient)).respond({ history: [], text: '普通聊天', behaviorContext: providerBehaviorContext, signal: new AbortController().signal })).toEqual({ text, capabilityPlan: { kind: 'chat' }, expressionStatus: 'failed' });
    expect(fetchClient).toHaveBeenCalledTimes(2);
  });
  test.each(chatProviderContractCases)('$name非法响应实际携带隐私标记且错误不泄露', async contract => {
    const canary = 'private-不得泄露';
    const raw = { ...contract.textResponse(' ' ) as object, invalidPrivateField: canary };
    const adapter = new ConversationChatAdapter(contract.createProvider(vi.fn(async () => jsonResponse(raw))));
    const error = await adapter.respond({ history: [], text: '测试', behaviorContext: providerBehaviorContext, signal: new AbortController().signal }).catch(reason => reason);
    expect(error).toMatchObject({ code: 'RESPONSE_FORMAT_UNSUPPORTED', retryable: false });
    expectObservableErrorTextHidden(error, [canary]);
  });
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
        code: contract.name === 'Gemini' ? 'RESPONSE_SHAPE_INVALID' : contract.expectedToolResponseErrorCode ?? 'RESPONSE_FORMAT_UNSUPPORTED',
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
        contract.textResponse(JSON.stringify({"moodUpdate":null,"expressionPlan":null,"requestKind":"ambient","explicitPlayback":null,"movementControl":{"kind":"keep"}}))
      ));
      const provider = contract.createProvider(fetchClient);

      await expect(provider.respond(
        structuredChatRequest,
        new AbortController().signal
      )).resolves.toEqual({
        type: 'structured', structured_output: {"moodUpdate":null,"expressionPlan":null,"requestKind":"ambient","explicitPlayback":null,"movementControl":{"kind":"keep"}}
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
        code: 'RESPONSE_SHAPE_INVALID',
        retryable: false
      });
    });

    test.each([
      ['非 JSON 响应', () => new Response('not-json', { status: 200 }), 'HTTP_BODY_NOT_JSON'],
      ['缺少必要字段', (contractCase: ProviderContractCase) => (
        jsonResponse(contractCase.missingFieldsResponse)
      ), 'RESPONSE_SHAPE_INVALID'],
      ['包含多个工具调用', (contractCase: ProviderContractCase) => (
        jsonResponse(contractCase.multipleToolsResponse)
      ), 'RESPONSE_SHAPE_INVALID']
    ])('拒绝%s并隐藏原始响应', async (_caseName, createResponse, expectedCode) => {
      const provider = contract.createProvider(vi.fn(async () => createResponse(contract)));

      const error = await captureError(provider.respond(request, new AbortController().signal));

      expect(error).toMatchObject({
        code: expectedCode,
        retryable: false
      });
      expect(error).toBeInstanceOf(ProviderResponseError);
      expect(Object.keys(error as object)).toEqual(['code', 'stage', 'name', 'retryable']);
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
      code: 'CONTROL_SCHEMA_INVALID'
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
      code: 'RESPONSE_SHAPE_INVALID',
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
  test.each([
    ['HTTP_BODY_NOT_JSON', 'transport'],
    ['RESPONSE_SHAPE_INVALID', 'transport'],
    ['CONTROL_SCHEMA_INVALID', 'chat_control'],
    ['TOOL_ARGUMENTS_INVALID', 'tool_call'],
    ['STREAM_TERMINAL_MISSING', 'stream'],
    ['RESPONSE_FORMAT_UNSUPPORTED', 'chat_control']
  ] as const)('诊断包装器对 %s 只上报一次四字段私有诊断', async (code, stage) => {
    const error = Object.assign(new ProviderResponseError(code, stage), {
      apiKey: 'sk-private-diagnostic-key',
      fullPath: 'C:\\Users\\Alice\\Documents\\private.txt',
      fileBody: '绝密文件正文',
      rawResponse: '{"raw":"provider response"}'
    });
    const sink = vi.fn();
    const registry = new ProviderRegistry(
      providerCatalog,
      () => ({ respond: vi.fn(async () => { throw error; }) }),
      { sink, createCorrelationId: () => 'diagnostic-correlation-id' }
    );
    const provider = registry.create(builtinLocalProfile, async () => '不得读取');

    await expect(provider.respond(request, new AbortController().signal)).rejects.toBe(error);

    expect(sink).toHaveBeenCalledOnce();
    expect(sink).toHaveBeenCalledWith({
      providerType: BUILTIN_LOCAL_PROFILE_ID,
      stage,
      code,
      correlationId: 'diagnostic-correlation-id'
    });
    const serialized = JSON.stringify(sink.mock.calls);
    expect(serialized).not.toContain('sk-private-diagnostic-key');
    expect(serialized).not.toContain('C:\\Users\\Alice\\Documents\\private.txt');
    expect(serialized).not.toContain('绝密文件正文');
    expect(serialized).not.toContain('{"raw":"provider response"}');
  });

  test('诊断包装器的 sink 抛错时仍原样抛出 ProviderResponseError', async () => {
    const error = new ProviderResponseError('HTTP_BODY_NOT_JSON', 'transport');
    const sink = vi.fn(() => {
      throw new Error('sink failed');
    });
    const registry = new ProviderRegistry(
      providerCatalog,
      () => ({ respond: vi.fn(async () => { throw error; }) }),
      { sink, createCorrelationId: () => 'diagnostic-sink-throw' }
    );
    const provider = registry.create(builtinLocalProfile, async () => '不得读取');

    await expect(provider.respond(request, new AbortController().signal)).rejects.toBe(error);
    expect(sink).toHaveBeenCalledOnce();
  });

  test('独立表现校验使用同一私有reporter并关联表现调用', async () => {
    const rawProvider: ModelProvider = {
      respond: vi.fn()
        .mockResolvedValueOnce({
          type: 'text',
          text: '首次正文。',
          structured_output: {
            expressionPlan: { states: 'bad' },
            rawResponse: [
              'sk-private-control-key',
              'C:\\Users\\Alice\\Documents\\control.txt',
              '控制字段中的绝密正文',
              '{"raw":"control response"}'
            ].join('|')
          }
        })
        .mockResolvedValueOnce({
          type: 'text',
          text: '修复正文不得替换首次正文。',
          structured_output: {movementControl: { kind: 'keep' },
capabilityPlan: { kind: 'chat' }}
        })
    };
    const sink = vi.fn();
    const createCorrelationId = vi.fn()
      .mockReturnValueOnce('provider-call-1')
      .mockReturnValueOnce('repair-call-2');
    const registry = new ProviderRegistry(
      providerCatalog,
      () => rawProvider,
      { sink, createCorrelationId }
    );
    const provider = registry.create(builtinLocalProfile, async () => '不得读取');
    const adapter = new ConversationChatAdapter(
      provider,
      (error, correlationId) => registry.reportResponseError(
        builtinLocalProfile,
        error,
        correlationId
      )
    );

    await expect(adapter.respond({
      history: [], text: '普通聊天', behaviorContext: providerBehaviorContext,
      signal: new AbortController().signal
    })).resolves.toMatchObject({ text: '首次正文。' });

    expect(createCorrelationId).toHaveBeenCalledTimes(2);
    expect(sink).toHaveBeenCalledOnce();
    expect(sink).toHaveBeenCalledWith({
      providerType: BUILTIN_LOCAL_PROFILE_ID,
      stage: 'chat_control',
      code: 'CONTROL_SCHEMA_INVALID',
      correlationId: 'repair-call-2'
    });
    expect(JSON.stringify(sink.mock.calls)).not.toContain('control response');
  });

  test.each([
    ['preset', {
      id: 'account-alias',
      displayName: 'OpenAI',
      mode: 'preset',
      providerId: 'openai',
      modelId: 'gpt-4.1-mini',
      hasStoredSecret: true
    }, 'openai'],
    ['custom', {
      id: 'custom-account-alias',
      displayName: '自定义服务',
      mode: 'custom',
      protocol: 'openai-compatible',
      baseUrl: 'https://custom.example.com/v1',
      modelId: 'custom-model',
      additionalParameters: {},
      hasStoredSecret: true
    }, 'openai-compatible']
  ] satisfies Array<[string, ProviderProfileV2, string]>)(
    '%s 档案诊断只使用公开 Provider 类型而不使用档案标识',
    async (_mode, profile, expectedProviderType) => {
      const sink = vi.fn();
      const registry = new ProviderRegistry(
        providerCatalog,
        vi.fn<() => ModelProvider>(),
        { sink, createCorrelationId: () => 'public-provider-type-id' }
      );
      const provider = registry.create(
        profile,
        async () => 'sk-private-provider-type-key',
        vi.fn(async () => new Response('private raw response', {
          status: 200,
          headers: { 'content-type': 'application/json' }
        }))
      );

      await expect(provider.respond(request, new AbortController().signal)).rejects.toMatchObject({
        code: 'HTTP_BODY_NOT_JSON'
      });

      expect(sink).toHaveBeenCalledWith({
        providerType: expectedProviderType,
        stage: 'transport',
        code: 'HTTP_BODY_NOT_JSON',
        correlationId: 'public-provider-type-id'
      });
      expect(JSON.stringify(sink.mock.calls)).not.toContain('account-alias');
      expect(JSON.stringify(sink.mock.calls)).not.toContain('private raw response');
      expect(JSON.stringify(sink.mock.calls)).not.toContain('sk-private-provider-type-key');
    }
  );

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

  test('DeepSeek自然主请求无角色契约，独立表现沿用同一Provider且不思考', async () => {
    const profile: ProviderProfileV2 = { id: 'deepseek-chat-profile', displayName: 'DeepSeek', mode: 'preset', providerId: 'deepseek', modelId: 'deepseek-v4-flash', hasStoredSecret: true };
    const text = '  **自然回复**\n'; let calls = 0;
    const fetchClient = vi.fn<FetchLike>(async () => jsonResponse({ choices: [{ message: { content: ++calls === 1 ? text : JSON.stringify({ moodUpdate: null, expressionPlan: null, requestKind: 'ambient', explicitPlayback: null, movementControl: { kind: 'keep' } }) } }] }));
    const provider = new ProviderRegistry(providerCatalog).create(profile, async () => 'deepseek-secret', fetchClient);
    expect(await new ConversationChatAdapter(provider).respond({ history: [], text: '你好', behaviorContext: providerBehaviorContext, signal: new AbortController().signal })).toMatchObject({ text, capabilityPlan: { kind: 'chat' }, expressionStatus: 'no_match' });
    const first = JSON.parse(String(fetchClient.mock.calls[0]?.[1]?.body));
    const second = JSON.parse(String(fetchClient.mock.calls[1]?.[1]?.body));
    expect(first).toMatchObject({ model: 'deepseek-v4-flash', thinking: { type: 'disabled' }, max_tokens: 4096, tool_choice: 'auto' });
    expect(first).not.toHaveProperty('response_format');
    expect(first.tools[0].function.description).toContain('不能代替普通聊天征求同意');
    expect(first.messages[0].content).toContain('是否需要整理');
    expect(second).toMatchObject({ model: 'deepseek-v4-flash', thinking: { type: 'disabled' }, tools: [], response_format: { type: 'json_object' } });
    // JSON 模式仅保证 JSON；服务端实际收到的消息必须包含完整嵌套输出约定。
    expect(second.messages).toContainEqual({ role: 'system', content: '完整输出JSON Schema：' + JSON.stringify(characterExpressionSelectionJsonSchema) });
  });
  test.each([['空 content', null, 'RESPONSE_SHAPE_INVALID'], ['全空白 content', ' \n\t'.repeat(18), 'RESPONSE_FORMAT_UNSUPPORTED']] as const)('DeepSeek自然聊天%s只失败一次且不请求表现', async (_name, content, code) => {
    const profile: ProviderProfileV2 = { id: 'deepseek-empty-chat-profile', displayName: 'DeepSeek', mode: 'preset', providerId: 'deepseek', modelId: 'deepseek-v4-flash', hasStoredSecret: true };
    const fetchClient = vi.fn<FetchLike>(async () => jsonResponse({ choices: [{ message: { content, tool_calls: [] } }] }));
    const adapter = new ConversationChatAdapter(new ProviderRegistry(providerCatalog).create(profile, async () => 'deepseek-secret', fetchClient));
    await expect(adapter.respond({ history: [], text: '你好', behaviorContext: providerBehaviorContext, signal: new AbortController().signal })).rejects.toMatchObject({ code, retryable: false });
    expect(fetchClient).toHaveBeenCalledOnce();
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

test.each(['Anthropic', 'Gemini'])('%s自然conversation接受正文加单申请并拒绝缺ID', async name => {
  const make = (id: string | undefined) => name === 'Anthropic'
    ? { content: [{ type: 'text', text: '请确认' }, { type: 'tool_use', id, name: 'request_task_authorization', input: {} }] }
    : { candidates: [{ content: { parts: [{ text: '请确认' }, { functionCall: { id, name: 'request_task_authorization', args: {} } }] } }] };
  const fetchClient = vi.fn<FetchLike>(async () => jsonResponse(make('call-1')));
  const provider = name === 'Anthropic' ? new AnthropicProvider(adapterProfile, async () => 'fixture', fetchClient) : new GeminiProvider(adapterProfile, async () => 'fixture', fetchClient);
  const natural: ModelRequest = { ...request, purpose: 'conversation', tools: [{ type: 'function', function: { name: 'request_task_authorization', description: '申请', parameters: { type: 'object', properties: {}, additionalProperties: false } } }] };
  expect(await provider.respond(natural, new AbortController().signal)).toMatchObject({ type: 'tool_request', request: { requestId: 'call-1', toolName: 'request_task_authorization', arguments: {} } });
  fetchClient.mockImplementation(async () => jsonResponse(make(undefined)));
  await expect(provider.respond(natural, new AbortController().signal)).rejects.toMatchObject({ code: 'RESPONSE_SHAPE_INVALID' });
});
