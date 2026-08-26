import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelRouteConfig, ProviderProfileV2 } from '@myself/shared-types';
import { afterEach, describe, expect, test, vi } from 'vitest';
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

  test('新建与清空设置默认自主模式且未停止', async () => {
    const store = await createStore();

    await expect(store.getCharacterBehaviorSettings()).resolves.toEqual({
      movementMode: 2,
      proactivityMode: 'autonomous'
    });

    await store.saveMovementMode(0);
    await store.clearAll();
    await expect(store.getCharacterBehaviorSettings()).resolves.toEqual({
      movementMode: 2,
      proactivityMode: 'autonomous'
    });
  });

  test('V3 迁移为 V5 时完整保留现行多档案、路由、位置、隐私、运动模式与 MCP', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'myself-v3-local-model-migration-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'settings.json');
    const providerProfiles = [
      {
        id: 'cloud-primary',
        displayName: '云端主模型',
        mode: 'custom',
        protocol: 'openai-compatible',
        baseUrl: 'https://api.example.com/v1',
        modelId: 'primary-tools-vision',
        additionalParameters: {},
        capabilities: ['chat', 'tools', 'vision']
      },
      {
        id: 'cloud-fallback',
        displayName: '云端备用模型',
        mode: 'custom',
        protocol: 'openai-compatible',
        baseUrl: 'https://api.example.com/v1',
        modelId: 'fallback-chat',
        additionalParameters: {},
        capabilities: ['chat']
      }
    ];
    const modelRoute = {
      primaryProfileId: 'cloud-primary',
      chatProfileId: 'cloud-primary',
      agentProfileId: 'cloud-primary',
      visionProfileId: 'cloud-primary',
      fallbackProfileIds: ['cloud-fallback'],
      allowCrossProviderFallback: false
    };
    const privacy = {
      dataCategories: { file: true, memory: false },
      longTermMemory: true,
      proactivityMode: 'passive' as const
    };
    const mcpServers = [{
      id: 'remote-tools',
      enabled: true,
      transport: {
        type: 'http' as const,
        url: 'https://mcp.example.com',
        secretNames: ['Authorization']
      },
      tools: {
        search: { enabled: true, readOnly: true, description: '搜索' }
      }
    }];
    const placement = {
      characterId: 'pet-a',
      scale: 1.25,
      footAnchorDip: { x: 640, y: 480 },
      displayId: 'display-main'
    };
    await writeFile(file, JSON.stringify({
      version: 3,
      providerProfiles,
      modelRoute,
      authorizedRoot: null,
      petPlacementState: { kind: 'ready', placements: [placement] },
      fileDisclosureAccepted: true,
      petAlwaysOnTop: true,
      privacy,
      movementStopped: true,
      mcpServers
    }), 'utf8');

    const store = new SettingsStore(file, async () => false);

    await expect(store.getLocalModelSettings()).resolves.toEqual({ enabled: true });
    await expect(store.getProviderSettings()).resolves.toEqual({
      profiles: providerProfiles.map(profile => ({ ...profile, hasStoredSecret: false })),
      route: modelRoute
    });
    await expect(store.getPetPlacementState('pet-a')).resolves.toEqual({
      kind: 'ready',
      placement
    });
    await expect(store.getPrivacySettings()).resolves.toEqual(privacy);
    await expect(store.getCharacterBehaviorSettings()).resolves.toEqual({
      movementMode: 0,
      proactivityMode: 'passive'
    });
    await expect(store.getMcpServerSettings()).resolves.toEqual(mcpServers);
    await expect(readFile(file, 'utf8')).resolves.toContain('"version": 5');
  });

  test('旧 V1 与缺失 privacy 的 V2 保留辅助模式并补齐未停止', async () => {
    const fixtures = [
      {
        version: 1,
        provider: null,
        authorizedRoot: null,
        petPosition: null,
        fileDisclosureAccepted: false
      },
      {
        version: 2,
        providerProfiles: [],
        modelRoute: {
          primaryProfileId: null, chatProfileId: null, agentProfileId: null,
          visionProfileId: null, fallbackProfileIds: [], allowCrossProviderFallback: false
        },
        authorizedRoot: null,
        petPosition: null,
        fileDisclosureAccepted: false
      }
    ];

    for (const [index, stored] of fixtures.entries()) {
      const directory = await mkdtemp(join(tmpdir(), `myself-behavior-migration-${index}-`));
      temporaryDirectories.push(directory);
      const file = join(directory, 'settings.json');
      await writeFile(file, JSON.stringify(stored), 'utf8');

      await expect(
        new SettingsStore(file, async () => false).getCharacterBehaviorSettings()
      ).resolves.toEqual({ movementMode: 2, proactivityMode: 'assistive' });
    }
  });

  test.each(['passive', 'assistive', 'autonomous'] as const)(
    '已有主动性档位 %s 原样保留且缺失停止字段补 false',
    async proactivityMode => {
      const directory = await mkdtemp(join(tmpdir(), 'myself-behavior-mode-'));
      temporaryDirectories.push(directory);
      const file = join(directory, 'settings.json');
      await writeFile(file, JSON.stringify({
        version: 2,
        providerProfiles: [],
        modelRoute: {
          primaryProfileId: null, chatProfileId: null, agentProfileId: null,
          visionProfileId: null, fallbackProfileIds: [], allowCrossProviderFallback: false
        },
        authorizedRoot: null,
        petPosition: null,
        fileDisclosureAccepted: false,
        privacy: {
          dataCategories: { file: false, screenshot: false, clipboard: false, memory: false },
          longTermMemory: false,
          proactivityMode
        }
      }), 'utf8');

      await expect(
        new SettingsStore(file, async () => false).getCharacterBehaviorSettings()
      ).resolves.toEqual({ movementMode: 2, proactivityMode });
    }
  );

  test('停止与恢复在重建 Store 后保留并返回冻结完整快照', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'myself-movement-stopped-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'settings.json');
    const store = new SettingsStore(file, async () => false);

    const stopped = await store.saveMovementMode(0);
    expect(stopped).toEqual({ movementMode: 0, proactivityMode: 'autonomous' });
    expect(Object.isFrozen(stopped)).toBe(true);
    await expect(
      new SettingsStore(file, async () => false).getCharacterBehaviorSettings()
    ).resolves.toEqual(stopped);

    const resumed = await new SettingsStore(file, async () => false).saveMovementMode(2);
    expect(resumed).toEqual({ movementMode: 2, proactivityMode: 'autonomous' });
    expect(Object.isFrozen(resumed)).toBe(true);
  });

  test('失效运动轮次不会进入持久化队列写入设置', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'myself-movement-cancelled-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'settings.json');
    const store = new SettingsStore(file, async () => false);

    await expect(store.saveMovementMode(0, () => false)).resolves.toBeNull();
    await expect(store.getCharacterBehaviorSettings()).resolves.toEqual({
      movementMode: 2,
      proactivityMode: 'autonomous'
    });
  });

  test('运动轮次在临时文件写入后失效时不提交正式设置并清理临时文件', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'myself-movement-commit-cancelled-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'settings.json');
    const store = new SettingsStore(file, async () => false);
    await store.saveMovementMode(2);
    let guardChecks = 0;

    await expect(store.saveMovementMode(0, () => {
      guardChecks += 1;
      return guardChecks < 3;
    })).resolves.toBeNull();

    expect(guardChecks).toBe(3);
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ movementMode: 2 });
    expect(await readdir(directory)).toEqual(['settings.json']);
  });

  test('隐私策略各现行数据类别可独立保存并返回完整行为快照', async () => {
    const store = await createStore();

    const snapshot = await store.savePrivacySettings({
      dataCategories: {
        file: true,
        memory: false
      },
      longTermMemory: true,
      proactivityMode: 'passive'
    });

    await expect(store.getPrivacySettings()).resolves.toEqual({
      dataCategories: {
        file: true,
        memory: false
      },
      longTermMemory: true,
      proactivityMode: 'passive'
    });

    expect(snapshot).toEqual({ movementMode: 2, proactivityMode: 'passive' });
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  test('旧版隐私设置缺少桌宠置顶字段时迁移为关闭且可持久化', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'myself-topmost-settings-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'settings.json');
    await writeFile(file, JSON.stringify({
      version: 2,
      providerProfiles: [],
      modelRoute: {
        primaryProfileId: null, chatProfileId: null, agentProfileId: null,
        visionProfileId: null, fallbackProfileIds: [], allowCrossProviderFallback: false
      },
      authorizedRoot: null,
      petPosition: null,
      fileDisclosureAccepted: false,
      privacy: {
        dataCategories: { file: false, screenshot: false, clipboard: false, memory: false },
        longTermMemory: false,
        proactivityMode: 'assistive'
      }
    }), 'utf8');

    const store = new SettingsStore(file, async () => false);
    await expect(store.getPetAlwaysOnTop()).resolves.toBe(false);
    await store.savePetAlwaysOnTop(true);
    const restarted = new SettingsStore(file, async () => false);
    await expect(restarted.getPetAlwaysOnTop()).resolves.toBe(true);
    await expect(restarted.getPrivacySettings()).resolves.not.toHaveProperty('petAlwaysOnTop');
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
