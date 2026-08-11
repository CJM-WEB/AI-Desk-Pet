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
