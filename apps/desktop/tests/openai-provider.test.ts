import { describe, expect, test, vi } from 'vitest';
import type { ModelRequest, ToolDefinition } from '@myself/agent-core';
import {
  OpenAICompatibleProvider,
  ProviderError
} from '../src/main/providers/openai-provider';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const profile = {
  id: 'default',
  displayName: '示例服务',
  baseUrl: 'https://api.example.com/v1',
  model: 'example-model',
  hasStoredSecret: true
};

const toolNames = [
  'list_directory',
  'read_text_file',
  'create_file',
  'create_directory',
  'rename_entry'
] as const;

const tools: ToolDefinition[] = toolNames.map(name => ({
  type: 'function' as const,
  function: {
    name,
    description: `${name} 工具`,
    parameters: { type: 'object', additionalProperties: false }
  }
}));

const request: ModelRequest = {
  messages: [{ role: 'user', content: '读取 notes.txt' }],
  tools,
  toolChoice: 'auto',
  reasoningMode: 'provider_default'
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

describe('OpenAICompatibleProvider', () => {
  test('发送规范化请求并返回纯文本', async () => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse({
      choices: [{ message: { role: 'assistant', content: '文件内容是……' } }]
    }));
    const getSecret = vi.fn(async () => 'sk-provider-fixture');
    const provider = new OpenAICompatibleProvider(profile, getSecret, fetchMock);

    await expect(provider.respond(request, new AbortController().signal)).resolves.toEqual({
      type: 'text',
      text: '文件内容是……'
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://api.example.com/v1/chat/completions');
    expect(init?.method).toBe('POST');
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer sk-provider-fixture');
    expect(headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'example-model',
      messages: [{ role: 'user', content: '读取 notes.txt' }],
      tools,
      tool_choice: 'auto'
    });
  });

  test('把单个工具调用规范化为 ToolRequest', async () => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse({
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: {
              name: 'read_text_file',
              arguments: '{"relativePath":"notes.txt"}'
            }
          }]
        }
      }]
    }));
    const provider = new OpenAICompatibleProvider(profile, async () => 'secret', fetchMock);

    await expect(provider.respond(request, new AbortController().signal)).resolves.toEqual({
      type: 'tool_request',
      request: {
        requestId: 'call-1',
        toolName: 'read_text_file',
        arguments: { relativePath: 'notes.txt' }
      }
    });
  });

  test('规范化合法的行为意图元数据', async () => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse({
      choices: [{
        message: {
          content: '处理完成',
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
    }));
    const provider = new OpenAICompatibleProvider(profile, async () => 'secret', fetchMock);

    await expect(provider.respond(request, new AbortController().signal)).resolves.toEqual({
      type: 'text',
      text: '处理完成',
      behaviorIntent: {
        stateIntent: { semantic: 'think' },
        actionSemantic: 'think',
        urgency: 50,
        explanation: '正在整理回应。'
      }
    });
  });

  test.each([
    ['非空工具表的 auto', tools, 'auto'],
    ['非空工具表的 required', tools, 'required'],
    ['空工具表的 none', [] as ToolDefinition[], 'none']
  ] as const)('原样序列化合法的 tool_choice：%s', async (_name, requestTools, toolChoice) => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse({
      choices: [{ message: { content: '完成' } }]
    }));
    const provider = new OpenAICompatibleProvider(profile, async () => 'secret', fetchMock);

    await provider.respond({
      ...request,
      tools: requestTools,
      toolChoice
    }, new AbortController().signal);

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      tools: requestTools,
      tool_choice: toolChoice
    });
  });

  test.each([
    ['空工具表 required', [] as ToolDefinition[], 'required'],
    ['非空工具表 none', tools, 'none']
  ] as const)('在 fetch 前拒绝非法的 tool_choice：%s', async (_name, requestTools, toolChoice) => {
    const fetchMock = vi.fn<FetchLike>();
    const provider = new OpenAICompatibleProvider(profile, async () => 'secret', fetchMock);

    await expect(provider.respond({
      ...request,
      tools: requestTools,
      toolChoice
    }, new AbortController().signal)).rejects.toMatchObject({
      code: 'PROVIDER_TOOL_CHOICE_INVALID',
      retryable: false
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('空工具表续传前一轮工具调用时复用工具别名并生成总结', async () => {
    const deleteTool: ToolDefinition = {
      type: 'function',
      function: {
        name: 'builtin.files.delete_file',
        description: '删除文件',
        parameters: { type: 'object' }
      }
    };
    const fetchMock = vi.fn<FetchLike>()
      .mockImplementationOnce(async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        return jsonResponse({
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: 'delete-history-1',
                type: 'function',
                function: {
                  name: body.tools[0].function.name,
                  arguments: '{"relativePath":"old.txt"}'
                }
              }]
            }
          }]
        });
      })
      .mockImplementationOnce(async () => jsonResponse({
        choices: [{ message: { content: '删除完成' } }]
      }));
    const provider = new OpenAICompatibleProvider(profile, async () => 'secret', fetchMock);

    const toolResponse = await provider.respond({
      ...request,
      tools: [deleteTool],
      toolChoice: 'required'
    }, new AbortController().signal);
    if (toolResponse.type !== 'tool_request') throw new Error('预期工具调用');

    await expect(provider.respond({
      ...request,
      tools: [],
      toolChoice: 'none',
      messages: [{
        role: 'assistant',
        content: '',
        toolRequest: toolResponse.request as {
          requestId: string;
          toolName: 'builtin.files.delete_file';
          arguments: { relativePath: string };
        }
      }, {
        role: 'tool',
        toolCallId: 'delete-history-1',
        content: '{"deleted":"old.txt"}'
      }]
    }, new AbortController().signal)).resolves.toEqual({
      type: 'text',
      text: '删除完成'
    });

    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(secondBody).toMatchObject({ tools: [], tool_choice: 'none' });
    expect(secondBody.messages).toEqual([{
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'delete-history-1',
        type: 'function',
        function: {
          name: firstBody.tools[0].function.name,
          arguments: '{"relativePath":"old.txt"}'
        }
      }]
    }, {
      role: 'tool',
      tool_call_id: 'delete-history-1',
      content: '{"deleted":"old.txt"}'
    }]);
  });

  test('丢弃非法行为意图元数据并保留文本响应', async () => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse({
      choices: [{
        message: {
          content: '处理完成',
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
    }));
    const provider = new OpenAICompatibleProvider(profile, async () => 'secret', fetchMock);

    await expect(provider.respond(request, new AbortController().signal)).resolves.toEqual({
      type: 'text',
      text: '处理完成'
    });
  });

  test('工具请求不夹带行为意图', async () => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse({
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
            id: 'call-1',
            type: 'function',
            function: {
              name: 'read_text_file',
              arguments: '{"relativePath":"notes.txt"}'
            }
          }]
        }
      }]
    }));
    const provider = new OpenAICompatibleProvider(profile, async () => 'secret', fetchMock);

    await expect(provider.respond(request, new AbortController().signal)).resolves.toEqual({
      type: 'tool_request',
      request: {
        requestId: 'call-1',
        toolName: 'read_text_file',
        arguments: { relativePath: 'notes.txt' }
      }
    });
  });

  test('正确序列化工具调用历史和工具结果', async () => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse({
      choices: [{ message: { role: 'assistant', content: '完成' } }]
    }));
    const provider = new OpenAICompatibleProvider(profile, async () => 'secret', fetchMock);
    const historyRequest: ModelRequest = {
      tools,
      toolChoice: 'auto',
      reasoningMode: 'provider_default',
      messages: [
        { role: 'user', content: '读取文件' },
        {
          role: 'assistant',
          content: '',
          toolRequest: {
            requestId: 'call-1',
            toolName: 'read_text_file',
            arguments: { relativePath: 'notes.txt' }
          }
        },
        { role: 'tool', toolCallId: 'call-1', content: '{"content":"示例"}' }
      ]
    };

    await provider.respond(historyRequest, new AbortController().signal);

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.messages).toEqual([
      { role: 'user', content: '读取文件' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call-1',
          type: 'function',
          function: {
            name: 'read_text_file',
            arguments: '{"relativePath":"notes.txt"}'
          }
        }]
      },
      { role: 'tool', tool_call_id: 'call-1', content: '{"content":"示例"}' }
    ]);
  });

  test.each([
    [401, 'PROVIDER_AUTHENTICATION_FAILED', false],
    [404, 'PROVIDER_ENDPOINT_NOT_FOUND', false],
    [429, 'PROVIDER_RATE_LIMITED', true],
    [503, 'PROVIDER_SERVER_ERROR', true]
  ])('映射 HTTP %i 错误', async (status, code, retryable) => {
    const fetchMock = vi.fn<FetchLike>(async () => (
      jsonResponse({ error: 'details must not leak' }, status)
    ));
    const provider = new OpenAICompatibleProvider(profile, async () => 'secret', fetchMock);

    const error = await provider.respond(request, new AbortController().signal).catch(value => value);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code, status, retryable });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test('映射超时且不在适配器内部重试', async () => {
    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';
    const fetchMock = vi.fn<FetchLike>(async () => { throw timeout; });
    const provider = new OpenAICompatibleProvider(profile, async () => 'secret', fetchMock);

    await expect(provider.respond(request, new AbortController().signal)).rejects.toMatchObject({
      code: 'PROVIDER_TIMEOUT',
      retryable: true
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test.each([
    ['not-json', 'PROVIDER_MALFORMED_RESPONSE'],
    [JSON.stringify({ choices: [] }), 'PROVIDER_MALFORMED_RESPONSE']
  ])('拒绝畸形响应', async (body, code) => {
    const fetchMock = vi.fn<FetchLike>(async () => new Response(body, { status: 200 }));
    const provider = new OpenAICompatibleProvider(profile, async () => 'secret', fetchMock);

    await expect(provider.respond(request, new AbortController().signal)).rejects.toMatchObject({
      code,
      retryable: false
    });
  });
});
