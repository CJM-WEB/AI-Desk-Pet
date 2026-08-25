import { describe, expect, test } from 'vitest';
import type {
  ModelRouteConfig,
  ProviderCatalogEntry,
  ProviderProfileV2
} from '@myself/shared-types';
import { ModelRouter } from '../src/model-router';

const 目录: ProviderCatalogEntry[] = [
  {
    catalogVersion: 1,
    providerId: 'alpha',
    displayName: 'Alpha',
    protocol: 'openai-compatible',
    baseUrl: 'https://alpha.example/v1',
    modelDiscoveryUrl: null,
    models: [
      {
        modelId: 'alpha-chat',
        displayName: 'Alpha Chat',
        capabilities: ['chat', 'streaming']
      },
      {
        modelId: 'alpha-agent',
        displayName: 'Alpha Agent',
        capabilities: ['chat', 'tools', 'streaming']
      },
      {
        modelId: 'alpha-vision',
        displayName: 'Alpha Vision',
        capabilities: ['chat', 'vision', 'streaming']
      }
    ],
    apiKeyHelpUrl: 'https://alpha.example/keys',
    requestLimits: {},
    compatibilityNotes: []
  },
  {
    catalogVersion: 1,
    providerId: 'beta',
    displayName: 'Beta',
    protocol: 'anthropic',
    baseUrl: 'https://beta.example/v1',
    modelDiscoveryUrl: null,
    models: [
      {
        modelId: 'beta-agent',
        displayName: 'Beta Agent',
        capabilities: ['chat', 'tools', 'streaming']
      }
    ],
    apiKeyHelpUrl: 'https://beta.example/keys',
    requestLimits: {},
    compatibilityNotes: []
  }
];

const 档案: ProviderProfileV2[] = [
  {
    id: 'alpha-chat',
    displayName: 'Alpha Chat',
    mode: 'preset',
    providerId: 'alpha',
    modelId: 'alpha-chat',
    hasStoredSecret: true
  },
  {
    id: 'alpha-agent',
    displayName: 'Alpha Agent',
    mode: 'preset',
    providerId: 'alpha',
    modelId: 'alpha-agent',
    hasStoredSecret: true
  },
  {
    id: 'alpha-vision',
    displayName: 'Alpha Vision',
    mode: 'preset',
    providerId: 'alpha',
    modelId: 'alpha-vision',
    hasStoredSecret: true
  },
  {
    id: 'beta-agent',
    displayName: 'Beta Agent',
    mode: 'preset',
    providerId: 'beta',
    modelId: 'beta-agent',
    hasStoredSecret: true
  },
  {
    id: 'custom-chat',
    displayName: 'Custom Chat',
    mode: 'custom',
    protocol: 'openai-compatible',
    baseUrl: 'https://custom.example/v1/',
    modelId: 'custom-chat',
    hasStoredSecret: true,
    additionalParameters: {}
  }
];

function 路由(overrides: Partial<ModelRouteConfig> = {}): ModelRouteConfig {
  return {
    primaryProfileId: 'alpha-chat',
    chatProfileId: null,
    agentProfileId: null,
    visionProfileId: null,
    fallbackProfileIds: [],
    allowCrossProviderFallback: false,
    ...overrides
  };
}

function 创建路由器(
  route: ModelRouteConfig,
  profiles: ProviderProfileV2[] = 档案,
  catalog: ProviderCatalogEntry[] = 目录
) {
  return new ModelRouter({ profiles, route, catalog });
}

const 空披露 = { allowedCrossProviderProfileIds: new Set<string>() };

describe('ModelRouter', () => {
  test('自定义档案声明 tools 能力后可参与 Agent 主路由与备用路由', () => {
    const customAgent: ProviderProfileV2 = {
      id: 'custom-agent',
      displayName: 'Custom Agent',
      mode: 'custom',
      protocol: 'openai-compatible',
      baseUrl: 'https://custom-agent.example/v1',
      modelId: 'custom-agent',
      additionalParameters: {},
      capabilities: ['chat', 'tools'],
      hasStoredSecret: true
    };
    const selection = new ModelRouter({
      profiles: [customAgent],
      route: {
        primaryProfileId: 'custom-agent',
        chatProfileId: null,
        agentProfileId: 'custom-agent',
        visionProfileId: null,
        fallbackProfileIds: [],
        allowCrossProviderFallback: false
      },
      catalog: []
    }).select('agent', { allowedCrossProviderProfileIds: new Set() });

    expect(selection.profile).toEqual(customAgent);
  });

  test('默认单模型用于聊天，并提供预置档案披露目标', () => {
    const selection = 创建路由器(路由()).select('chat', 空披露);

    expect(selection).toEqual({
      profile: 档案[0],
      disclosureTarget: { profileId: 'alpha-chat', providerIdentity: 'provider:alpha' },
      fallbackProfiles: []
    });
  });

  test('代理主档案缺少工具能力时拒绝路由', () => {
    const router = 创建路由器(路由({ agentProfileId: 'alpha-chat' }));

    expect(() => router.select('agent', 空披露)).toThrow('MODEL_CAPABILITY_REQUIRED');
  });

  test('显式视觉路由选择视觉档案', () => {
    const selection = 创建路由器(路由({ visionProfileId: 'alpha-vision' })).select('vision', 空披露);

    expect(selection).toEqual({
      profile: 档案[2],
      disclosureTarget: { profileId: 'alpha-vision', providerIdentity: 'provider:alpha' },
      fallbackProfiles: []
    });
  });

  test('同一提供商备用档案按配置顺序返回并排除主档案', () => {
    const selection = 创建路由器(路由({
      fallbackProfileIds: ['alpha-chat', 'alpha-agent', 'alpha-agent', 'alpha-vision']
    })).select('chat', 空披露);

    expect(selection.fallbackProfiles).toEqual([档案[1], 档案[2]]);
  });

  test('缺少所需能力的备用档案会被过滤', () => {
    const selection = 创建路由器(路由({
      agentProfileId: 'alpha-agent',
      fallbackProfileIds: ['alpha-chat', 'alpha-vision']
    })).select('agent', 空披露);

    expect(selection.fallbackProfiles).toEqual([]);
  });

  test('全局未授权跨提供商备用时拒绝且没有同提供商替代', () => {
    const router = 创建路由器(路由({
      agentProfileId: 'alpha-agent',
      fallbackProfileIds: ['beta-agent'],
      allowCrossProviderFallback: false
    }));

    expect(() => router.select('agent', {
      allowedCrossProviderProfileIds: new Set(['beta-agent'])
    })).toThrow('MODEL_CROSS_PROVIDER_FALLBACK_NOT_AUTHORIZED');
  });

  test('本次披露未授权跨提供商备用时拒绝且没有同提供商替代', () => {
    const router = 创建路由器(路由({
      agentProfileId: 'alpha-agent',
      fallbackProfileIds: ['beta-agent'],
      allowCrossProviderFallback: true
    }));

    expect(() => router.select('agent', 空披露)).toThrow('MODEL_CROSS_PROVIDER_FALLBACK_NOT_AUTHORIZED');
  });

  test('两级授权满足后返回跨提供商备用档案', () => {
    const selection = 创建路由器(路由({
      agentProfileId: 'alpha-agent',
      fallbackProfileIds: ['beta-agent'],
      allowCrossProviderFallback: true
    })).select('agent', {
      allowedCrossProviderProfileIds: new Set(['beta-agent'])
    });

    expect(selection.fallbackProfiles).toEqual([档案[3]]);
  });

  test('拒绝重复档案 ID、未知主档案和未知预置提供商', () => {
    expect(() => 创建路由器(路由(), [
      {
        id: 'duplicated',
        displayName: '重复档案',
        mode: 'preset',
        providerId: 'alpha',
        modelId: 'alpha-chat',
        hasStoredSecret: true
      },
      {
        id: 'duplicated',
        displayName: '重复档案',
        mode: 'preset',
        providerId: 'alpha',
        modelId: 'alpha-chat',
        hasStoredSecret: true
      }
    ])).toThrow('MODEL_PROFILE_ID_DUPLICATED');
    expect(() => 创建路由器(路由({ primaryProfileId: 'missing' }))).not.toThrow();
    expect(() => 创建路由器(路由({ primaryProfileId: 'missing' })).select('chat', 空披露)).toThrow(
      'MODEL_PROFILE_NOT_FOUND'
    );
    expect(() => 创建路由器(路由(), [{
      id: 'missing-provider',
      displayName: '未知提供商',
      mode: 'preset',
      providerId: 'missing',
      modelId: 'alpha-chat',
      hasStoredSecret: true
    }])).toThrow('MODEL_PROVIDER_NOT_FOUND');
  });

  test('已知预置提供商的目录外模型可按声明能力用于聊天', () => {
    const unknownPreset: ProviderProfileV2 = {
      id: 'alpha-new',
      displayName: 'Alpha New',
      mode: 'preset',
      providerId: 'alpha',
      modelId: 'alpha-new-model',
      capabilities: ['chat'],
      hasStoredSecret: true
    };

    expect(() => new ModelRouter({
      profiles: [unknownPreset],
      route: 路由({ primaryProfileId: 'alpha-new' }),
      catalog: 目录
    }).select('chat', 空披露)).not.toThrow();
  });

  test('构造输入与选择输出均不会污染路由器内部配置', () => {
    const profiles = structuredClone(档案);
    const catalog = structuredClone(目录);
    const config = 路由({ fallbackProfileIds: ['alpha-agent'] });
    const disclosure = { allowedCrossProviderProfileIds: new Set<string>() };
    const router = 创建路由器(config, profiles, catalog);

    profiles[0]!.displayName = '外部污染';
    catalog[0]!.models[0]!.capabilities.push('tools');
    config.fallbackProfileIds.push('alpha-vision');
    const first = router.select('chat', disclosure);
    first.profile.displayName = '输出污染';
    first.fallbackProfiles.push(档案[2]!);
    disclosure.allowedCrossProviderProfileIds.add('beta-agent');
    const second = router.select('chat', disclosure);

    expect(second.profile).toEqual(档案[0]);
    expect(second.fallbackProfiles).toEqual([档案[1]]);
    expect(second.disclosureTarget).toEqual({
      profileId: 'alpha-chat',
      providerIdentity: 'provider:alpha'
    });
  });

  test('自定义档案仅具备保守能力并规范化披露目标', () => {
    const selection = 创建路由器(路由({ primaryProfileId: 'custom-chat' })).select('chat', 空披露);

    expect(selection.disclosureTarget).toEqual({
      profileId: 'custom-chat',
      providerIdentity: 'custom:openai-compatible:https://custom.example/v1'
    });
    expect(() => 创建路由器(路由({ primaryProfileId: 'custom-chat' })).select('agent', 空披露)).toThrow(
      'MODEL_CAPABILITY_REQUIRED'
    );
  });

  test('内置 preset 档案仅允许聊天和工具路由', () => {
    const localProfile: ProviderProfileV2 = {
      id: 'builtin-local',
      displayName: '内置本地模型',
      mode: 'preset',
      providerId: 'builtin-local',
      modelId: 'builtin-local',
      capabilities: ['chat', 'tools'],
      hasStoredSecret: false
    };
    const localCatalog: ProviderCatalogEntry = {
      catalogVersion: 1,
      providerId: 'builtin-local',
      displayName: '内置本地模型',
      protocol: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:0',
      modelDiscoveryUrl: null,
      models: [{
        modelId: 'builtin-local',
        displayName: '内置本地模型',
        capabilities: ['chat', 'tools']
      }],
      apiKeyHelpUrl: 'https://local-model.invalid/',
      requestLimits: {},
      compatibilityNotes: []
    };
    const router = new ModelRouter({
      profiles: [localProfile],
      route: 路由({
        primaryProfileId: 'builtin-local',
        chatProfileId: 'builtin-local',
        agentProfileId: 'builtin-local',
        visionProfileId: 'builtin-local'
      }),
      catalog: [localCatalog]
    });

    expect(router.select('chat', 空披露).fallbackProfiles).toEqual([]);
    expect(router.select('agent', 空披露).fallbackProfiles).toEqual([]);
    expect(() => router.select('vision', 空披露)).toThrow('MODEL_CAPABILITY_REQUIRED');
  });
});
