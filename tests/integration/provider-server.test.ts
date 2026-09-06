import { request as httpRequest } from 'node:http';
import { describe, expect, test, vi } from 'vitest';
import {
  createProviderResponseGate,
  startProviderServer
} from '../fixtures/provider-server';

/** 保持正文流未结束，证明边界响应不依赖正文读取完成。 */
function requestStatusBeforeBodyEnds(
  url: string,
  options: { method: string; authorization: string }
): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, {
      method: options.method,
      headers: {
        authorization: options.authorization,
        'content-type': 'application/json'
      }
    }, response => {
      const status = response.statusCode ?? 0;
      response.resume();
      request.end();
      response.once('end', () => resolve(status));
    });
    request.once('error', reject);
    request.setTimeout(1_000, () => {
      request.destroy(new Error('Provider 未在正文结束前响应'));
    });
    request.write('{"model":"未结束正文"');
  });
}

describe('脚本化 Provider 生命周期', () => {
  test('Core SSE 保留参数分片、多调用标识与工具结果关联', async () => {
    const frames = [
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'read-a', type: 'function', function: { name: 'read', arguments: '{"path":' } }, { index: 1, id: 'read-b', type: 'function', function: { name: 'read', arguments: '{"path":' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }, { index: 1, function: { arguments: '"b.txt"}' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
    ];
    let history: unknown;
    const provider = await startProviderServer([
      { response: { type: 'sse', chunks: frames } },
      { response: { type: 'sse', chunks: [] }, inspectRaw: request => { history = request.messages; } }
    ]);
    const post = (messages: unknown[]) => fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST', headers: { authorization: `Bearer ${provider.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'core', stream: true, messages, tools: [] })
    });
    try {
      const first = await post([{ role: 'user', content: '读取两个文件' }]);
      expect(first.headers.get('content-type')).toBe('text/event-stream');
      expect(await first.text()).toBe(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n');
      const messages = [
        { role: 'assistant', content: null, tool_calls: ['a', 'b'].map(name => ({ id: `read-${name}`, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: `${name}.txt` }) } })) },
        { role: 'tool', tool_call_id: 'read-b', content: '乙文件真实结果' },
        { role: 'tool', tool_call_id: 'read-a', content: '甲文件真实结果' }
      ];
      expect((await post(messages)).status).toBe(200);
      expect(history).toEqual(messages);
      expect(provider.inspectionErrors).toEqual([]);
      provider.assertComplete();
    } finally { await provider.close(); }
  });

  test('客户端中止释放未放行的 SSE gate，关闭不遗留请求', async () => {
    const gate = createProviderResponseGate();
    const provider = await startProviderServer([{ response: { type: 'sse', chunks: [] }, gate }]);
    const controller = new AbortController();
    const pending = fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST', headers: { authorization: `Bearer ${provider.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [], tools: [], stream: true }), signal: controller.signal
    }).catch(() => undefined);
    try {
      await vi.waitFor(() => expect(gate.isWaiting()).toBe(true));
      controller.abort();
      await pending;
      await vi.waitFor(() => expect(gate.isWaiting()).toBe(false));
      provider.assertComplete();
    } finally { gate.release(); await provider.close(); }
  });

  test('inspect 可读取 tool_choice 且请求摘要不持久该字段', async () => {
    let inspectedToolChoice: unknown;
    let inspectedToolChoiceWasExplicit = false;
    let inspectedResponseFormat = false;
    const provider = await startProviderServer([{
      response: { type: 'text', text: '已收到' },
      inspect: request => {
        inspectedToolChoice = request.toolChoice;
        inspectedToolChoiceWasExplicit = request.toolChoiceWasExplicit;
        inspectedResponseFormat = request.responseFormatWasJsonObject;
      }
    }]);

    try {
      const response = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${provider.apiKey}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'reflection-model',
          messages: [{ role: 'user', content: '反思私密正文' }],
          tools: [],
          tool_choice: 'none',
          response_format: { type: 'json_object' }
        })
      });

      expect(response.status).toBe(200);
      expect(inspectedToolChoice).toBe('none');
      expect(inspectedToolChoiceWasExplicit).toBe(true);
      expect(inspectedResponseFormat).toBe(true);
      expect(provider.requests).toEqual([{
        method: 'POST',
        model: 'reflection-model',
        messageRoleCounts: { system: 0, user: 1, assistant: 0, tool: 0 },
        toolCount: 0
      }]);
      expect(JSON.stringify(provider.requests)).not.toMatch(/tool_choice|response_format|私密/iu);
    } finally {
      await provider.close();
    }
  });

  test('结构化响应按真实 JSON Output 线格式返回且请求仍为零工具', async () => {
    const provider = await startProviderServer([{
      response: {
        type: 'text',
        text: '向左移动',
        structured_output: {
          text: '向左移动',
          behaviorPlan: { kind: 'move', direction: 'left', distance: 'near' }
        }
      },
      inspect: request => {
        expect(request.tools).toEqual([]);
      }
    }]);

    try {
      const response = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${provider.apiKey}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'structured-model',
          messages: [{ role: 'user', content: '向左一点' }],
          tools: []
        })
      });
      const payload = await response.json() as {
        choices: Array<{ message: { content: string; metadata?: unknown } }>;
      };
      expect(JSON.parse(payload.choices[0]!.message.content)).toEqual({
        text: '向左移动',
        behaviorPlan: { kind: 'move', direction: 'left', distance: 'near' }
      });
      expect(payload.choices[0]!.message).not.toHaveProperty('metadata');
      provider.assertComplete();
      expect(provider.inspectionErrors).toEqual([]);
    } finally {
      await provider.close();
    }
  });

  test('请求摘要只保留方法、模型、角色计数与工具计数', async () => {
    const provider = await startProviderServer([
      { response: { type: 'text', text: '已收到' } }
    ]);

    try {
      const response = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${provider.apiKey}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'summary-model',
          messages: [
            { role: 'system', content: '私密系统正文' },
            { role: 'user', content: '私密用户正文' },
            { role: 'assistant', content: '私密助手正文' },
            { role: 'tool', tool_call_id: 'private-call', content: '私密工具正文' }
          ],
          tools: [{
            type: 'function',
            function: {
              name: 'builtin.files.list_directory',
              description: '私密工具描述',
              parameters: { type: 'object' }
            }
          }]
        })
      });

      expect(response.status).toBe(200);
      expect(provider.requests).toEqual([{
        method: 'POST',
        model: 'summary-model',
        messageRoleCounts: { system: 1, user: 1, assistant: 1, tool: 1 },
        toolCount: 1
      }]);
      expect(JSON.stringify(provider.requests)).not.toMatch(
        /私密|authorization|pathname|toolNames|messageRoles|private-call/iu
      );
    } finally {
      await provider.close();
    }
  });

  test('方法、端点或授权在正文结束前被即时拒绝且不写入请求摘要', async () => {
    const provider = await startProviderServer([
      { response: { type: 'text', text: '不应消费' } }
    ]);
    try {
      const wrongMethod = await requestStatusBeforeBodyEnds(
        `${provider.baseUrl}/chat/completions`,
        { method: 'PUT', authorization: `Bearer ${provider.apiKey}` }
      );
      const wrongEndpoint = await requestStatusBeforeBodyEnds(
        `${provider.baseUrl}/wrong-endpoint`,
        { method: 'POST', authorization: `Bearer ${provider.apiKey}` }
      );
      const wrongAuthorization = await requestStatusBeforeBodyEnds(
        `${provider.baseUrl}/chat/completions`,
        { method: 'POST', authorization: 'Bearer wrong-key' }
      );

      expect(wrongMethod).toBe(405);
      expect(wrongEndpoint).toBe(404);
      expect(wrongAuthorization).toBe(401);
      expect(provider.requests).toEqual([]);
      expect(provider.remainingSteps()).toBe(1);
    } finally {
      await provider.close();
    }
  });

  test('inspect 失败只记录稳定错误而不持久化正文', async () => {
    const privateText = '私密检查正文';
    const provider = await startProviderServer([{
      response: { type: 'text', text: '已收到' },
      inspect: () => {
        throw new Error(privateText);
      }
    }]);

    try {
      const response = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${provider.apiKey}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'inspection-model',
          messages: [{ role: 'user', content: privateText }],
          tools: []
        })
      });

      expect(response.status).toBe(200);
      expect(provider.inspectionErrors).toEqual(['脚本化 Provider 请求检查失败']);
      expect(JSON.stringify(provider.inspectionErrors)).not.toContain(privateText);
    } finally {
      await provider.close();
    }
  });

  test('每个服务实例在运行时生成不同 API Key', async () => {
    const first = await startProviderServer([]);
    const second = await startProviderServer([]);
    try {
      expect(first.apiKey).not.toBe(second.apiKey);
      expect(first.apiKey).toMatch(/^myself-e2e-[a-f0-9]+$/u);
      expect(second.apiKey).toMatch(/^myself-e2e-[a-f0-9]+$/u);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  test('close 只关闭资源，脚本完整性由显式 assertComplete 检查', async () => {
    const provider = await startProviderServer([
      { response: { type: 'text', text: '尚未消费' } }
    ]) as Awaited<ReturnType<typeof startProviderServer>> & {
      assertComplete?: () => void;
    };

    await expect(provider.close()).resolves.toBeUndefined();
    expect(typeof provider.assertComplete).toBe('function');
    expect(() => provider.assertComplete?.()).toThrow('脚本化 Provider 仍有 1 个响应未消费');
  });

  test('assertComplete 拒绝脚本耗尽后的额外请求', async () => {
    const provider = await startProviderServer([
      { response: { type: 'text', text: '唯一响应' } }
    ]);
    const request = () => fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${provider.apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: '验证精确消费' }],
        tools: []
      })
    });

    try {
      expect((await request()).status).toBe(200);
      expect((await request()).status).toBe(500);
      expect(() => provider.assertComplete()).toThrow('脚本化 Provider 收到 1 个额外请求');
    } finally {
      await provider.close();
    }
  });

  test('脚本 factory 只接收当前实例运行时生成的 API Key', async () => {
    let receivedKey = '';
    const startWithFactory = startProviderServer as unknown as (
      factory: (apiKey: string) => []
    ) => ReturnType<typeof startProviderServer>;
    const provider = await startWithFactory(apiKey => {
      receivedKey = apiKey;
      return [];
    });
    try {
      expect(receivedKey).toBe(provider.apiKey);
      expect(receivedKey).toMatch(/^myself-e2e-[a-f0-9]+$/u);
    } finally {
      await provider.close();
    }
  });

  test('Provider gate 在请求到达后阻塞响应直到显式释放', async () => {
    const gate = createProviderResponseGate();
    const provider = await startProviderServer([{
      response: { type: 'text', text: '显式释放后返回' },
      gate
    }]);
    let settled = false;
    const pendingResponse = fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${provider.apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: '验证门闩' }],
        tools: []
      })
    }).then(response => {
      settled = true;
      return response;
    });

    try {
      await vi.waitFor(() => expect(gate.isWaiting()).toBe(true));
      expect(settled).toBe(false);
      gate.release();
      expect((await pendingResponse).status).toBe(200);
    } finally {
      gate.release();
      await pendingResponse.catch(() => undefined);
      await provider.close();
    }
  });

  test('响应完成屏障只在指定数量的 Provider 步骤执行 response.end 后释放', async () => {
    const gate = createProviderResponseGate();
    const provider = await startProviderServer([{
      response: { type: 'text', text: '屏障完成后返回' },
      gate
    }]) as Awaited<ReturnType<typeof startProviderServer>> & {
      waitForCompletedResponses?: (count: number) => Promise<void>;
    };
    const pendingResponse = fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${provider.apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: '验证完成屏障' }],
        tools: []
      })
    });

    try {
      await vi.waitFor(() => expect(gate.isWaiting()).toBe(true));
      expect(typeof provider.waitForCompletedResponses).toBe('function');
      let completed = false;
      const barrier = provider.waitForCompletedResponses?.(1).then(() => {
        completed = true;
      });
      expect(completed).toBe(false);
      gate.release();
      await barrier;
      expect(completed).toBe(true);
      expect((await pendingResponse).status).toBe(200);
    } finally {
      gate.release();
      await pendingResponse.catch(() => undefined);
      await provider.close();
    }
  });
});
