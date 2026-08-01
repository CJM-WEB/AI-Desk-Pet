import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelRouteConfig, ProviderProfileV2 } from '@myself/shared-types';
import { afterEach, describe, expect, test } from 'vitest';
import { SettingsStore } from '../src/main/storage/settings-store';

const temporaryDirectories: string[] = [];

async function createStore(secretProfiles: string[] = []) {
  const directory = await mkdtemp(join(tmpdir(), 'myself-multi-provider-settings-'));
  temporaryDirectories.push(directory);
  return new SettingsStore(
    join(directory, 'settings.json'),
    async profileId => secretProfiles.includes(profileId ?? 'default')
  );
}

function presetProfile(
  id: string,
  providerId: string,
  modelId: string
): ProviderProfileV2 {
  return {
    id,
    displayName: id,
    mode: 'preset',
    providerId,
    modelId,
    hasStoredSecret: false
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('多 Provider 设置持久化', () => {
  test('公开快照逐档案查询密钥状态且不返回密钥正文', async () => {
    const store = await createStore(['openai-main']);
    await store.saveProviderProfile(presetProfile('openai-main', 'openai', 'gpt-5-mini'));
    await store.saveProviderProfile(presetProfile('deepseek-chat', 'deepseek', 'deepseek-v4-flash'));

    const snapshot = await store.getProviderSettings();

    expect(snapshot.profiles).toEqual([
      expect.objectContaining({ id: 'openai-main', hasStoredSecret: true }),
      expect.objectContaining({ id: 'deepseek-chat', hasStoredSecret: false })
    ]);
    for (const profile of snapshot.profiles) {
      expect(profile).not.toHaveProperty('secret');
      expect(profile).not.toHaveProperty('apiKey');
    }
  });

  test('目录外预置模型可按显式能力保存并用于 Agent 路由', async () => {
    const store = await createStore();
    await store.saveProviderProfile({
      id: 'openai-new-agent',
      displayName: 'OpenAI 新 Agent',
      mode: 'preset',
      providerId: 'openai',
      modelId: 'provider-new-agent',
      capabilities: ['chat', 'tools'],
      hasStoredSecret: false
    });

    await expect(store.saveModelRoute({
      primaryProfileId: 'openai-new-agent',
      chatProfileId: null,
      agentProfileId: 'openai-new-agent',
      visionProfileId: null,
      fallbackProfileIds: [],
      allowCrossProviderFallback: false
    })).resolves.toBeUndefined();
  });

  test('目录外预置模型未声明能力时不从名称推断工具或视觉', async () => {
    const store = await createStore();
    await store.saveProviderProfile({
      id: 'openai-vision-tools',
      displayName: 'OpenAI Vision Tools',
      mode: 'preset',
      providerId: 'openai',
      modelId: 'provider-vision-tools-model',
      hasStoredSecret: false
    });
    const baseRoute: ModelRouteConfig = {
      primaryProfileId: null,
      chatProfileId: null,
      agentProfileId: null,
      visionProfileId: null,
      fallbackProfileIds: [],
      allowCrossProviderFallback: false
    };

    await expect(store.saveModelRoute({
      ...baseRoute,
      agentProfileId: 'openai-vision-tools'
    })).rejects.toMatchObject({ code: 'AGENT_MODEL_REQUIRES_TOOLS' });
    await expect(store.saveModelRoute({
      ...baseRoute,
      visionProfileId: 'openai-vision-tools'
    })).rejects.toMatchObject({ code: 'VISION_MODEL_REQUIRES_VISION' });
  });

  test('Agent 路由拒绝不支持工具的自定义档案', async () => {
    const store = await createStore();
    await store.saveProviderProfile({
      id: 'chat-only',
      displayName: '仅聊天模型',
      mode: 'custom',
      protocol: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      modelId: 'chat-only-model',
      additionalParameters: {},
      capabilities: ['chat'],
      hasStoredSecret: false
    });

    await expect(store.saveModelRoute({
      primaryProfileId: 'chat-only',
      chatProfileId: null,
      agentProfileId: 'chat-only',
      visionProfileId: null,
      fallbackProfileIds: [],
      allowCrossProviderFallback: false
    })).rejects.toMatchObject({ code: 'AGENT_MODEL_REQUIRES_TOOLS' });
  });

  test('视觉路由拒绝无 vision 能力的预置档案', async () => {
    const store = await createStore();
    await store.saveProviderProfile(
      presetProfile('deepseek-main', 'deepseek', 'deepseek-v4-flash')
    );

    await expect(store.saveModelRoute({
      primaryProfileId: 'deepseek-main',
      chatProfileId: null,
      agentProfileId: null,
      visionProfileId: 'deepseek-main',
      fallbackProfileIds: [],
      allowCrossProviderFallback: false
    })).rejects.toMatchObject({ code: 'VISION_MODEL_REQUIRES_VISION' });
  });

  test('未明确授权时拒绝跨提供商备用档案', async () => {
    const store = await createStore();
    await store.saveProviderProfile(presetProfile('openai-main', 'openai', 'gpt-5-mini'));
    await store.saveProviderProfile(
      presetProfile('deepseek-fallback', 'deepseek', 'deepseek-v4-flash')
    );

    await expect(store.saveModelRoute({
      primaryProfileId: 'openai-main',
      chatProfileId: null,
      agentProfileId: null,
      visionProfileId: null,
      fallbackProfileIds: ['deepseek-fallback'],
      allowCrossProviderFallback: false
    })).rejects.toMatchObject({ code: 'CROSS_PROVIDER_FALLBACK_NOT_AUTHORIZED' });
  });

  test('拒绝引用不存在档案且失败时保留原路由', async () => {
    const store = await createStore();
    await store.saveProviderProfile(presetProfile('openai-main', 'openai', 'gpt-5-mini'));
    const validRoute: ModelRouteConfig = {
      primaryProfileId: 'openai-main',
      chatProfileId: null,
      agentProfileId: 'openai-main',
      visionProfileId: null,
      fallbackProfileIds: [],
      allowCrossProviderFallback: false
    };
    await store.saveModelRoute(validRoute);

    await expect(store.saveModelRoute({
      ...validRoute,
      chatProfileId: 'missing'
    })).rejects.toMatchObject({ code: 'PROVIDER_PROFILE_NOT_FOUND' });
    await expect(store.getProviderSettings()).resolves.toMatchObject({
      route: validRoute
    });
  });

  test('删除档案会原子清理所有路由引用', async () => {
    const store = await createStore();
    await store.saveProviderProfile(presetProfile('openai-main', 'openai', 'gpt-5-mini'));
    await store.saveProviderProfile(presetProfile('openai-fallback', 'openai', 'gpt-5-mini'));
    await store.saveModelRoute({
      primaryProfileId: 'openai-main',
      chatProfileId: 'openai-main',
      agentProfileId: 'openai-main',
      visionProfileId: 'openai-main',
      fallbackProfileIds: ['openai-fallback'],
      allowCrossProviderFallback: false
    });

    await store.deleteProviderProfile('openai-main');

    await expect(store.getProviderSettings()).resolves.toMatchObject({
      profiles: [expect.objectContaining({ id: 'openai-fallback' })],
      route: {
        primaryProfileId: null,
        chatProfileId: null,
        agentProfileId: null,
        visionProfileId: null,
        fallbackProfileIds: ['openai-fallback'],
        allowCrossProviderFallback: false
      }
    });
  });

  test('隐私策略默认辅助模式且各数据类别可独立保存', async () => {
    const store = await createStore();

    await expect(store.getPrivacySettings()).resolves.toEqual({
      dataCategories: {
        file: false,
        screenshot: false,
        clipboard: false,
        memory: false
      },
      longTermMemory: false,
      proactivityMode: 'assistive'
    });

    await store.savePrivacySettings({
      dataCategories: {
        file: true,
        screenshot: false,
        clipboard: true,
        memory: false
      },
      longTermMemory: true,
      proactivityMode: 'passive'
    });

    await expect(store.getPrivacySettings()).resolves.toEqual({
      dataCategories: {
        file: true,
        screenshot: false,
        clipboard: true,
        memory: false
      },
      longTermMemory: true,
      proactivityMode: 'passive'
    });
  });

  test('MCP 配置持久化只保存认证字段名而不保存认证值', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'myself-mcp-settings-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'settings.json');
    const store = new SettingsStore(file, async () => false);

    await store.saveMcpServerSettings({
      id: 'remote-tools',
      enabled: true,
      transport: {
        type: 'http',
        url: 'https://mcp.example.com',
        secretNames: ['Authorization']
      },
      tools: {
        search: { enabled: true, readOnly: true, description: '搜索' }
      }
    });

    await expect(store.getMcpServerSettings()).resolves.toEqual([{
      id: 'remote-tools',
      enabled: true,
      transport: {
        type: 'http',
        url: 'https://mcp.example.com',
        secretNames: ['Authorization']
      },
      tools: {
        search: { enabled: true, readOnly: true, description: '搜索' }
      }
    }]);
    const raw = await readFile(file, 'utf8');
    expect(raw).toContain('"Authorization"');
    expect(raw).not.toContain('Bearer private-header');
  });
});
