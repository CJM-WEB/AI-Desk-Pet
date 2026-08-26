import { describe, expect, test, vi } from 'vitest';
import type { ModelProvider, ModelResponse } from '@myself/agent-core';
import { createSettingsActions } from '../src/main/settings/settings-actions';

function configuredSettings() {
  return {
    version: 1 as const,
    provider: {
      id: 'default',
      displayName: '示例服务',
      baseUrl: 'https://api.example.com/v1',
      model: 'example-model',
      hasStoredSecret: true
    },
    authorizedRoot: null,
    fileDisclosureAccepted: false
  };
}

describe('设置主进程动作', () => {
  test('连接测试只发送最小纯文本请求且不提供文件工具', async () => {
    const provider: ModelProvider = {
      respond: vi.fn(async (): Promise<ModelResponse> => ({ type: 'text', text: 'ok' }))
    };
    const settings = {
      getPublic: vi.fn(async () => configuredSettings()),
      saveAuthorizedRoot: vi.fn(async () => undefined)
    };
    const actions = createSettingsActions({
      settings,
      readSecret: vi.fn(async () => 'secret'),
      createProvider: () => provider,
      selectDirectory: vi.fn(async () => null),
      createRootId: () => 'root-1'
    });

    await expect(actions.testProvider()).resolves.toEqual({ ok: true, message: '连接成功。' });
    expect(provider.respond).toHaveBeenCalledWith({
      messages: [
        { role: 'system', content: '这是一次连接测试，只需返回简短文本。' },
        { role: 'user', content: '请回复“连接成功”。' }
      ],
      tools: [],
      toolChoice: 'none',
      reasoningMode: 'provider_default'
    }, expect.any(AbortSignal));
  });

  test('缺少 Provider 或密钥时返回可理解提示', async () => {
    const settings = {
      getPublic: vi.fn(async () => ({ ...configuredSettings(), provider: null })),
      saveAuthorizedRoot: vi.fn(async () => undefined)
    };
    const actions = createSettingsActions({
      settings,
      readSecret: vi.fn(async () => 'secret'),
      createProvider: vi.fn(),
      selectDirectory: vi.fn(async () => null),
      createRootId: () => 'root-1'
    });

    await expect(actions.testProvider()).resolves.toEqual({
      ok: false,
      message: '请先保存模型配置和 API Key。'
    });
  });

  test('系统选择的目录以完整路径私存并只公开隐私摘要', async () => {
    const settings = {
      getPublic: vi.fn(async () => configuredSettings()),
      saveAuthorizedRoot: vi.fn(async () => undefined)
    };
    const actions = createSettingsActions({
      settings,
      readSecret: vi.fn(async () => 'secret'),
      createProvider: vi.fn(),
      selectDirectory: vi.fn(async () => 'D:\\Private\\CompanionProject'),
      validateAuthorizedRoot: vi.fn(async () => undefined),
      createRootId: () => 'root-1'
    });

    await actions.chooseAuthorizedRoot();

    expect(settings.saveAuthorizedRoot).toHaveBeenCalledWith({
      id: 'root-1',
      displayName: 'CompanionProject',
      pathHint: 'D:\\…\\CompanionProject',
      absolutePath: 'D:\\Private\\CompanionProject'
    });
  });

  test('受保护目录校验失败时不保存授权根', async () => {
    const settings = {
      getPublic: vi.fn(async () => configuredSettings()),
      saveAuthorizedRoot: vi.fn(async () => undefined)
    };
    const actions = createSettingsActions({
      settings,
      readSecret: vi.fn(async () => 'secret'),
      createProvider: vi.fn(),
      selectDirectory: vi.fn(async () => 'C:\\Windows'),
      validateAuthorizedRoot: vi.fn(async () => {
        throw Object.assign(new Error('受保护区域不能作为文件授权范围'), {
          code: 'PERMISSION_DENIED'
        });
      }),
      createRootId: () => 'root-1'
    });

    await expect(actions.chooseAuthorizedRoot()).rejects.toMatchObject({
      code: 'PERMISSION_DENIED'
    });
    expect(settings.saveAuthorizedRoot).not.toHaveBeenCalled();
  });

  test('用户取消目录选择时不改变授权', async () => {
    const settings = {
      getPublic: vi.fn(async () => configuredSettings()),
      saveAuthorizedRoot: vi.fn(async () => undefined)
    };
    const actions = createSettingsActions({
      settings,
      readSecret: vi.fn(async () => 'secret'),
      createProvider: vi.fn(),
      selectDirectory: vi.fn(async () => null),
      createRootId: () => 'root-1'
    });

    await actions.chooseAuthorizedRoot();

    expect(settings.saveAuthorizedRoot).not.toHaveBeenCalled();
  });
});
