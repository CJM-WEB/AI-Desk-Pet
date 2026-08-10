import { describe, expect, test, vi } from 'vitest';
import {
  createProviderResponseGate,
  startProviderServer
} from '../fixtures/provider-server';

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
