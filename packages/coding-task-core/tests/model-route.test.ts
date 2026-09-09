import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { CodingModelConnection } from '../src/index';
import { fixture, type Step } from './fixture';

function requestBody(request: unknown): Record<string, unknown> {
  return request as Record<string, unknown>;
}

test('DeepSeek 协议发送禁用思考字段并保持工具结果调用关联', async () => {
  const f = await fixture([
    [{ name: 'read', args: { path: 'note.txt' }, id: 'call_deepseek_read' }],
    '读取完成'
  ], {
    model: {
      baseUrl: '',
      modelId: 'deepseek-v4-flash',
      contextWindow: 1_000_000,
      outputTokens: 8_192,
      protocol: 'deepseek',
      readCredential: async () => 'fixture'
    }
  });
  try {
    await writeFile(join(f.directory, 'note.txt'), randomUUID(), 'utf8');
    await f.session.run('读取 note.txt', new AbortController().signal);

    expect(f.requests).toHaveLength(2);
    expect(requestBody(f.requests[0]).thinking).toEqual({ type: 'disabled' });
    expect(requestBody(f.requests[1]).thinking).toEqual({ type: 'disabled' });
    expect(f.requests[1]?.messages).toContainEqual(expect.objectContaining({
      role: 'tool',
      tool_call_id: 'call_deepseek_read'
    }));
  } finally {
    await f.close();
  }
});

test('通用 OpenAI Chat 路由保留内置 Qwen 参数且不增加 DeepSeek 字段', async () => {
  const f = await fixture(['完成'], {
    model: {
      baseUrl: '',
      modelId: 'qwen-fixture',
      contextWindow: 8_192,
      outputTokens: 2_048,
      protocol: 'openai-chat',
      requestBody: {
        reasoning_effort: 'none',
        chat_template_kwargs: { enable_thinking: false },
        parallel_tool_calls: false,
        parse_tool_calls: true
      },
      readCredential: async () => 'fixture'
    }
  });
  try {
    await f.session.run('直接回答', new AbortController().signal);

    expect(requestBody(f.requests[0])).toMatchObject({
      reasoning_effort: 'none',
      chat_template_kwargs: { enable_thinking: false },
      parallel_tool_calls: false,
      parse_tool_calls: true
    });
    expect(requestBody(f.requests[0])).not.toHaveProperty('thinking');
  } finally {
    await f.close();
  }
});

test.each(['messages', 'tools', 'model', 'thinking'] as const)(
  'HTTP overlay 在网络请求前拒绝协议字段 %s',
  async field => {
    const f = await fixture(['不应收到请求'], {
      model: {
        baseUrl: '',
        modelId: 'fixture',
        contextWindow: 32_000,
        outputTokens: 1_024,
        requestBody: { [field]: field === 'thinking' ? { type: 'disabled' } : 'forbidden' },
        readCredential: async () => 'fixture'
      }
    });
    try {
      await expect(f.session.run('触发请求', new AbortController().signal)).rejects.toBeDefined();
      expect(f.requests).toEqual([]);
    } finally {
      await f.close();
    }
  }
);

test('Qwen 压缩预算以下不额外发出摘要请求', async () => {
  const f = await fixture(['完成'], {
    model: {
      baseUrl: '',
      modelId: 'qwen-fixture',
      contextWindow: 8_192,
      outputTokens: 2_048,
      compaction: { buffer: 2_048, keepTokens: 2_048 },
      readCredential: async () => 'fixture'
    }
  });
  try {
    await f.session.run('短请求', new AbortController().signal);
    expect(f.requests).toHaveLength(1);
    expect(JSON.stringify(f.requests[0])).not.toContain('Create a new anchored summary');
  } finally {
    await f.close();
  }
});

test('Qwen 输入增长后沿用原压缩并保持后续工具调用关联', async () => {
  const nonce = randomUUID();
  const serverSteps: Step[] = [
    '压缩后的摘要',
    [{ name: 'read', args: { path: 'note.txt' }, id: 'call_after_compaction' }],
    `最终正文 ${nonce}`
  ];
  const f = await fixture(serverSteps, {
    model: {
      baseUrl: '',
      modelId: 'qwen-fixture',
      contextWindow: 8_192,
      outputTokens: 2_048,
      compaction: { buffer: 2_048, keepTokens: 2_048 },
      readCredential: async () => 'fixture'
    }
  });
  try {
    await writeFile(join(f.directory, 'note.txt'), nonce, 'utf8');
    // 工具 Schema 也计入上下文；该输入超过可用预算，但摘要正文仍能装入同一模型窗口。
    const largeInput = `请读取 note.txt。${'背景资料'.repeat(3_500)}`;
    await expect(f.session.run(largeInput, new AbortController().signal)).resolves.toMatchObject({
      text: expect.stringContaining(nonce),
      toolCalls: 1
    });

    expect(f.requests).toHaveLength(3);
    expect(JSON.stringify(f.requests[0])).toContain('Create a new anchored summary');
    expect(f.requests[2]?.messages).toContainEqual(expect.objectContaining({
      role: 'tool',
      tool_call_id: 'call_after_compaction'
    }));
  } finally {
    await f.close();
  }
});

// 编译期类型断言：宿主连接仅增加协议与压缩提示，原字段保持不变。
const _connectionContract: CodingModelConnection = {
  baseUrl: 'http://127.0.0.1:1',
  modelId: 'fixture',
  contextWindow: 8_192,
  outputTokens: 2_048,
  protocol: 'openai-chat',
  compaction: { buffer: 2_048, keepTokens: 2_048 },
  readCredential: async () => 'fixture'
};
void _connectionContract;
