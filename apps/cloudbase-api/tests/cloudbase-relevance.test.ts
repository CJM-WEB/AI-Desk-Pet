import { describe, expect, it, vi } from 'vitest';

import { CloudBaseRelevanceClassifier } from '../src/adapters/cloudbase-relevance.js';

describe('CloudBase AI 相关性适配器', () => {
  it('使用固定模型参数和 JSON Schema 并只返回枚举结论', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '{"decision":"pass"}' } }]
    }), { status: 200 }));
    const classifier = new CloudBaseRelevanceClassifier(
      'https://ai.example.com/v1',
      'ai-secret',
      fetcher
    );

    await expect(classifier.classify({
      title: '桌宠建议',
      body: '希望增加动作'
    })).resolves.toBe('pass');

    const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'deepseek-v4-flash',
      temperature: 0,
      max_tokens: 300,
      response_format: {
        type: 'json_schema',
        json_schema: expect.objectContaining({ strict: true })
      }
    });
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer ai-secret'
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('非法 JSON 或未知结论视为依赖失败', async () => {
    const classifier = new CloudBaseRelevanceClassifier(
      'https://ai.example.com/v1',
      'ai-secret',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({
        choices: [{ message: { content: '{"decision":"allow"}' } }]
      }), { status: 200 }))
    );
    await expect(classifier.classify({ title: 'a', body: 'b' }))
      .rejects.toThrow('RELEVANCE_RESPONSE_INVALID');
  });

  it('接受 OpenAI 标准响应中的附加字段但仍只读取 content', async () => {
    const classifier = new CloudBaseRelevanceClassifier(
      'https://ai.example.com/v1',
      'ai-secret',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({
        id: 'chatcmpl-1',
        object: 'chat.completion',
        created: 1785456000,
        choices: [{
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            refusal: null,
            content: '{"decision":"review"}'
          }
        }]
      }), { status: 200 }))
    );

    await expect(classifier.classify({ title: '桌宠', body: '相关内容' }))
      .resolves.toBe('review');
  });
});
