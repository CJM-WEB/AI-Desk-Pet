import type { ModelMessage, ModelRequest, ModelProvider } from '@myself/agent-core';
import { describe, expect, test, vi } from 'vitest';
import { AnthropicProvider } from '../src/main/providers/anthropic-provider';
import { GeminiProvider } from '../src/main/providers/gemini-provider';
import { OpenAICompatibleProvider } from '../src/main/providers/openai-provider';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const profile = {
  baseUrl: 'https://api.example.com/v1',
  modelId: 'test-model'
};

const errorHistory: ModelMessage[] = [{
  role: 'assistant',
  content: '',
  toolRequest: {
    requestId: 'invalid-call-1',
    toolName: 'delete_everything',
    arguments: { target: 'notes.txt' }
  }
}, {
  role: 'tool',
  toolCallId: 'invalid-call-1',
  content: '{"ok":false,"code":"INVALID_TOOL_REQUEST"}'
}];

const request: ModelRequest = {
  messages: errorHistory,
  tools: [{
    type: 'function',
    function: {
      name: 'builtin.files.read_text',
      description: '读取文件',
      parameters: { type: 'object' }
    }
  }],
  toolChoice: 'auto',
  reasoningMode: 'disabled'
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

async function captureBody(
  createProvider: (fetchClient: FetchLike) => ModelProvider,
  response: unknown
): Promise<Record<string, unknown>> {
  const fetchClient = vi.fn<FetchLike>(async () => jsonResponse(response));
  await createProvider(fetchClient).respond(request, new AbortController().signal);
  return JSON.parse(String(fetchClient.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
}

describe('Provider 工具错误回灌历史', () => {
  test('OpenAI 序列化 assistant tool_calls 后再序列化 tool 结果', async () => {
    const body = await captureBody(
      fetchClient => new OpenAICompatibleProvider(profile, async () => 'secret', fetchClient),
      { choices: [{ message: { role: 'assistant', content: '已修正' } }] }
    );

    expect(body.messages).toEqual([{
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'invalid-call-1',
        type: 'function',
        function: {
          name: 'delete_everything',
          arguments: '{"target":"notes.txt"}'
        }
      }]
    }, {
      role: 'tool',
      tool_call_id: 'invalid-call-1',
      content: '{"ok":false,"code":"INVALID_TOOL_REQUEST"}'
    }]);
  });

  test('Anthropic 序列化 tool_use 后再序列化 tool_result', async () => {
    const body = await captureBody(
      fetchClient => new AnthropicProvider(profile, async () => 'secret', fetchClient),
      { content: [{ type: 'text', text: '已修正' }] }
    );

    expect(body.messages).toEqual([{
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'invalid-call-1',
        name: 'delete_everything',
        input: { target: 'notes.txt' }
      }]
    }, {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'invalid-call-1',
        content: '{"ok":false,"code":"INVALID_TOOL_REQUEST"}'
      }]
    }]);
  });

  test('Gemini 从前置 functionCall 恢复名称并序列化 functionResponse', async () => {
    const body = await captureBody(
      fetchClient => new GeminiProvider(profile, async () => 'secret', fetchClient),
      { candidates: [{ content: { parts: [{ text: '已修正' }] } }] }
    );

    expect(body.contents).toEqual([{
      role: 'model',
      parts: [{
        functionCall: {
          id: 'invalid-call-1',
          name: 'delete_everything',
          args: { target: 'notes.txt' }
        }
      }]
    }, {
      role: 'user',
      parts: [{
        functionResponse: {
          id: 'invalid-call-1',
          name: 'delete_everything',
          response: { ok: false, code: 'INVALID_TOOL_REQUEST' }
        }
      }]
    }]);
  });
});
