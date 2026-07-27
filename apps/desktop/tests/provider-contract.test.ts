import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ToolDefinition
} from '@myself/agent-core';
import { describe, expect, test, vi } from 'vitest';
import {
  OpenAICompatibleProvider,
  ProviderError
} from '../src/main/providers/openai-provider';
import { AnthropicProvider } from '../src/main/providers/anthropic-provider';
import { GeminiProvider } from '../src/main/providers/gemini-provider';
import { ProviderRegistry } from '../src/main/providers/provider-registry';
import {
  providerCatalog,
  type ProviderProfileV2
} from '@myself/shared-types';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface ProviderContractCase {
  name: string;
  createProvider: (fetchClient: FetchLike) => ModelProvider;
  textResponse: unknown;
  toolResponse: unknown;
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

const request: ModelRequest = {
  messages: [
    { role: 'system', content: '只返回必要内容。' },
    { role: 'user', content: '读取 notes.txt' }
  ],
  tools
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
        throw new TypeError('contract-secret 不得泄漏');
      });
      const provider = contract.createProvider(fetchClient);
      const controller = new AbortController();
      controller.abort();

      const error = await captureError(provider.respond(request, controller.signal));

      expect(error).toMatchObject({
        code: 'PROVIDER_NETWORK_ERROR',
        retryable: true
      });
      expect(JSON.stringify(error)).not.toContain('contract-secret');
    });

    test.each([
      [401, 'PROVIDER_AUTHENTICATION_FAILED', false],
      [429, 'PROVIDER_RATE_LIMITED', true],
      [503, 'PROVIDER_SERVER_ERROR', true]
    ])('把 HTTP %i 映射为统一错误', async (status, code, retryable) => {
      const provider = contract.createProvider(vi.fn(async () => (
        jsonResponse({ error: '供应商响应正文不得泄漏' }, status)
      )));

      const error = await captureError(provider.respond(request, new AbortController().signal));

      expect(error).toBeInstanceOf(ProviderError);
      expect(error).toMatchObject({ code, retryable, status });
      expect(JSON.stringify(error)).not.toContain('供应商响应正文不得泄漏');
    });

    test('把普通 fetch 异常映射为可重试网络错误', async () => {
      const fetchClient = vi.fn<FetchLike>(async () => {
        throw new TypeError('socket details must not leak');
      });
      const provider = contract.createProvider(fetchClient);

      const error = await captureError(provider.respond(request, new AbortController().signal));

      expect(error).toMatchObject({
        code: 'PROVIDER_NETWORK_ERROR',
        retryable: true
      });
      expect(JSON.stringify(error)).not.toContain('socket details must not leak');
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

  test('Gemini 映射助手工具请求和工具结果历史', async () => {
    const fetchClient = vi.fn<FetchLike>(async () => jsonResponse({
      candidates: [{ content: { parts: [{ text: '完成' }] } }]
    }));
    const provider = new GeminiProvider(
      adapterProfile,
      async () => 'secret',
      fetchClient
    );

    await provider.respond({
      tools,
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

    expect(JSON.parse(String(fetchClient.mock.calls[0]?.[1]?.body)).contents).toEqual([
      {
        role: 'model',
        parts: [{
          functionCall: {
            id: 'call-history',
            name: 'read_text_file',
            args: { relativePath: 'notes.txt' }
          }
        }]
      },
      {
        role: 'user',
        parts: [{
          functionResponse: {
            name: 'read_text_file',
            response: { content: '示例' }
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

  test.each(['deepseek', 'kimi', 'qwen'] as const)(
    '%s 复用 OpenAI Compatible 类及目录 URL/模型',
    async providerId => {
      const entry = providerCatalog.find(item => item.providerId === providerId);
      if (!entry) throw new Error(`测试目录缺少 ${providerId}`);
      const modelId = entry.models[0]?.modelId ?? '';
      const profile: ProviderProfileV2 = {
        id: `${providerId}-profile`,
        displayName: entry.displayName,
        mode: 'preset',
        providerId,
        modelId,
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
      expect(String(url)).toBe(`${entry.baseUrl.replace(/\/$/, '')}/chat/completions`);
      expect(JSON.parse(String(init?.body)).model).toBe(modelId);
    }
  );

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

  test('拒绝不在预置目录中的模型', () => {
    const profile: ProviderProfileV2 = {
      id: 'openai-profile',
      displayName: 'OpenAI',
      mode: 'preset',
      providerId: 'openai',
      modelId: 'not-in-catalog',
      hasStoredSecret: true
    };
    const registry = new ProviderRegistry(providerCatalog);

    expect(() => registry.create(profile, async () => 'secret')).toThrowError(
      expect.objectContaining({
        code: 'PROVIDER_MODEL_NOT_FOUND',
        retryable: false
      })
    );
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
