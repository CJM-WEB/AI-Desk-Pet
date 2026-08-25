import type { ModelRequest, ToolDefinition } from '@myself/agent-core';
import { describe, expect, test, vi } from 'vitest';
import {
  LocalModelProvider,
  type LocalModelConnection,
  type LocalModelConnectionPort
} from '../src/main/providers/local-model-provider';
import { ProviderError } from '../src/main/providers/openai-provider';

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
    allowPlainTextFallback: true
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

  test('结构化聊天不把纯文本降级当作角色控制成功', async () => {
    const fetchClient = vi.fn<FetchLike>(async () => jsonResponse({
      choices: [{ message: { content: '我会保持安静。' } }]
    }));
    const provider = new LocalModelProvider(readyPort(), fetchClient);

    await expect(provider.respond(
      structuredRequest,
      new AbortController().signal
    )).rejects.toMatchObject({
      code: 'PROVIDER_MALFORMED_RESPONSE',
      retryable: false
    });
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
