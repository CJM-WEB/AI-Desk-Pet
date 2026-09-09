import { describe, expect, test, vi } from 'vitest';
import { providerCatalog, type ProviderProfileV2 } from '@myself/shared-types';
import type { LocalModelConnection, LocalModelConnectionPort } from '../src/main/providers/local-model-provider';
import { createLocalModelRoutingSnapshot } from '../src/main/local-model/local-model-route';
import { createCodingModelConnection } from '../src/main/providers/coding-model-connection';

function presetProfile(providerId: string, modelId: string): ProviderProfileV2 {
  return {
    id: `${providerId}-main`,
    displayName: providerId,
    mode: 'preset',
    providerId,
    modelId,
    capabilities: ['chat', 'tools'],
    hasStoredSecret: true
  };
}

function builtinLocalProfile(): ProviderProfileV2 {
  const snapshot = createLocalModelRoutingSnapshot({
    profiles: [],
    route: {
      primaryProfileId: null,
      chatProfileId: null,
      agentProfileId: null,
      visionProfileId: null,
      fallbackProfileIds: [],
      allowCrossProviderFallback: false
    }
  }, true);
  const profile = snapshot.profiles.find(item => item.id === 'builtin-local');
  if (!profile) throw new Error('测试夹具缺少内置模型档案');
  return profile;
}

class MutableLocalConnectionPort implements LocalModelConnectionPort {
  constructor(public current: LocalModelConnection) {}
  getReadyConnection(): LocalModelConnection {
    return this.current;
  }
}

describe('CodingModelConnection', () => {
  test('DeepSeek V4 使用现有目录配置、私有凭据回调与专用协议预算', async () => {
    const readSecret = vi.fn(async () => 'private-deepseek-key');
    const connection = createCodingModelConnection(
      presetProfile('deepseek', 'deepseek-v4-flash'),
      { catalog: providerCatalog, readSecret }
    );

    expect(connection).toMatchObject({
      baseUrl: 'https://api.deepseek.com',
      modelId: 'deepseek-v4-flash',
      contextWindow: 1_000_000,
      outputTokens: 8_192,
      protocol: 'deepseek'
    });
    expect(readSecret).not.toHaveBeenCalled();
    await expect(connection.readCredential()).resolves.toBe('private-deepseek-key');
    expect(readSecret).toHaveBeenCalledOnce();
    expect(JSON.stringify(connection)).not.toContain('private-deepseek-key');
  });

  test('其他 DeepSeek 模型保守使用宿主预算且不改写 modelId', () => {
    const connection = createCodingModelConnection(
      presetProfile('deepseek', 'deepseek-future-model'),
      { catalog: providerCatalog, readSecret: async () => 'secret' }
    );

    expect(connection).toMatchObject({
      modelId: 'deepseek-future-model',
      contextWindow: 8_192,
      outputTokens: 2_048,
      protocol: 'deepseek',
      compaction: { buffer: 2_048, keepTokens: 2_048 }
    });
  });

  test('通用 OpenAI compatible 档案沿用额外参数和通用协议', () => {
    const profile: ProviderProfileV2 = {
      id: 'custom-main',
      displayName: '自定义',
      mode: 'custom',
      protocol: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:4567/v1',
      modelId: 'custom-model',
      additionalParameters: { seed: 7 },
      capabilities: ['chat', 'tools'],
      hasStoredSecret: true
    };

    expect(createCodingModelConnection(profile, {
      catalog: providerCatalog,
      readSecret: async () => 'secret'
    })).toMatchObject({
      baseUrl: 'http://127.0.0.1:4567/v1',
      modelId: 'custom-model',
      contextWindow: 8_192,
      outputTokens: 2_048,
      protocol: 'openai-chat',
      compaction: { buffer: 2_048, keepTokens: 2_048 },
      requestBody: { seed: 7 }
    });
  });

  test.each(['anthropic', 'gemini'] as const)('任务连接明确拒绝尚未适配的 %s 协议', protocol => {
    const profile: ProviderProfileV2 = {
      id: `${protocol}-custom`,
      displayName: protocol,
      mode: 'custom',
      protocol,
      baseUrl: 'https://example.com/v1',
      modelId: 'fixture',
      additionalParameters: {},
      capabilities: ['chat', 'tools'],
      hasStoredSecret: true
    };

    expect(() => createCodingModelConnection(profile, {
      catalog: providerCatalog,
      readSecret: async () => 'secret'
    })).toThrow('CODING_MODEL_PROTOCOL_UNSUPPORTED');
  });

  test('内置 Qwen 固定完整连接并在每次读取令牌时复核 runtime generation', async () => {
    const initial = {
      generation: 'local-model-1',
      baseUrl: 'http://127.0.0.1:43123/v1',
      token: 'private-local-token',
      modelId: 'ai-pet-local'
    };
    const port = new MutableLocalConnectionPort(initial);
    const readSecret = vi.fn(async () => '不应读取云密钥');
    const connection = createCodingModelConnection(builtinLocalProfile(), {
      catalog: providerCatalog,
      readSecret,
      localModel: port
    });

    expect(connection).toMatchObject({
      baseUrl: initial.baseUrl,
      modelId: initial.modelId,
      contextWindow: 8_192,
      outputTokens: 2_048,
      protocol: 'openai-chat',
      compaction: { buffer: 2_048, keepTokens: 2_048 },
      requestBody: {
        reasoning_effort: 'none',
        chat_template_kwargs: { enable_thinking: false },
        parallel_tool_calls: false,
        parse_tool_calls: true
      }
    });
    await expect(connection.readCredential()).resolves.toBe(initial.token);
    expect(readSecret).not.toHaveBeenCalled();

    port.current = { ...initial, generation: 'local-model-2', token: 'new-private-token' };
    let failure: unknown;
    try {
      await connection.readCredential();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('LOCAL_MODEL_CONNECTION_STALE');
    expect(String(failure)).not.toContain(initial.token);
    expect(String(failure)).not.toContain(port.current.token);
  });

  test('伪造内置 profile 不能取得本地私有连接', () => {
    const port = new MutableLocalConnectionPort({
      generation: 'local-model-1',
      baseUrl: 'http://127.0.0.1:43123/v1',
      token: 'private-local-token',
      modelId: 'ai-pet-local'
    });
    const forged = { ...builtinLocalProfile(), displayName: '伪造内置模型' };

    expect(() => createCodingModelConnection(forged, {
      catalog: providerCatalog,
      readSecret: async () => 'secret',
      localModel: port
    })).toThrow('PROVIDER_CATALOG_ENTRY_NOT_FOUND');
  });
});
