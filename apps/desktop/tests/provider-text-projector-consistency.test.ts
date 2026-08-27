import type { ModelProvider, ModelRequest } from '@myself/agent-core';
import { describe, expect, test, vi } from 'vitest';
import { LocalModelProvider } from '../src/main/providers/local-model-provider';
import {
  OpenAICompatibleProvider,
  type FetchLike
} from '../src/main/providers/openai-provider';

const structuredRequest: ModelRequest = {
  messages: [{ role: 'user', content: '普通聊天' }],
  tools: [],
  toolChoice: 'none',
  reasoningMode: 'disabled',
  responseContract: {
    type: 'json_object',
    name: 'character_chat',
    jsonSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text']
    },
    textField: 'text',
    allowPlainTextFallback: true
  }
};

function sseResponse(contentChunks: readonly string[]): Response {
  const events = contentChunks.map(content => (
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
  )).concat('data: [DONE]\n\n');
  return new Response(events.join(''), {
    headers: { 'content-type': 'text/event-stream' }
  });
}

function createCloudProvider(fetchClient: FetchLike): ModelProvider {
  return new OpenAICompatibleProvider({
    baseUrl: 'https://api.example.com/v1',
    modelId: 'example-model'
  }, async () => 'cloud-secret', fetchClient);
}

function createLocalProvider(fetchClient: FetchLike): ModelProvider {
  return new LocalModelProvider({
    getReadyConnection: () => ({
      generation: 'generation-1',
      baseUrl: 'http://127.0.0.1:43123/v1',
      token: 'local-session-token',
      modelId: 'ai-pet-local'
    })
  }, fetchClient);
}

const providerCases = [
  ['云端', createCloudProvider],
  ['本地', createLocalProvider]
] as const;

const projectionCases = [
  {
    name: '纯文本降级',
    contentChunks: ['你好', '，世界'],
    expectedText: '你好，世界'
  },
  {
    name: '跳过嵌套隐藏字段并解码跨分片 Unicode',
    contentChunks: ['{"metadata":{"text":"不可见"},"text":"你\\u', '597d"}'],
    expectedText: '你好'
  }
] as const;

describe('云端与本地 Provider 的顶层正文投影一致性', () => {
  test.each(projectionCases)('$name 在两条路径上得到同一正文', async ({ contentChunks, expectedText }) => {
    for (const [, createProvider] of providerCases) {
      const deltas: string[] = [];
      const fetchClient = vi.fn<FetchLike>(async () => sseResponse(contentChunks));
      const provider = createProvider(fetchClient);

      await expect(provider.respond({
        ...structuredRequest,
        onTextDelta: delta => deltas.push(delta)
      }, new AbortController().signal)).resolves.toMatchObject({
        type: 'text',
        text: expectedText
      });
      expect(deltas.join('')).toBe(expectedText);
    }
  });

  test.each(providerCases)('%s路径拒绝重复的顶层 text 键', async (_name, createProvider) => {
    const contentChunks = ['{"text":"第一段",', '"text":"第二段"}'];
    const deltas: string[] = [];
    const fetchClient = vi.fn<FetchLike>(async () => sseResponse(contentChunks));
    const provider = createProvider(fetchClient);

    await expect(provider.respond({
      ...structuredRequest,
      onTextDelta: delta => deltas.push(delta)
    }, new AbortController().signal)).rejects.toMatchObject({
      code: 'PROVIDER_MALFORMED_RESPONSE',
      retryable: false
    });
    expect(deltas).toEqual(['第一段']);
  });
});
