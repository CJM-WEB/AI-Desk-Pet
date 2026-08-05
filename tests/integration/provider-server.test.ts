import { describe, expect, test, vi } from 'vitest';
import {
  createProviderResponseGate,
  startProviderServer
} from '../fixtures/provider-server';

describe('脚本化 Provider 生命周期', () => {
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
});
