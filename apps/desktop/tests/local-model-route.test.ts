import { describe, expect, test } from 'vitest';
import type { ProviderCatalogEntry } from '@myself/shared-types';
import { ModelRouter } from '@myself/agent-core';
import type { ProviderSettingsSnapshot } from '../src/main/storage/settings-store';
import {
  BUILTIN_LOCAL_PROFILE_ID,
  BUILTIN_LOCAL_PROVIDER_CATALOG_ENTRY,
  createLocalModelRoutingSnapshot
} from '../src/main/local-model/local-model-route';

const fixture: ProviderSettingsSnapshot = {
  profiles: [{
    id: 'cloud-chat',
    displayName: '云端聊天',
    mode: 'preset',
    providerId: 'cloud',
    modelId: 'cloud-chat',
    hasStoredSecret: true
  }],
  route: {
    primaryProfileId: 'cloud-chat',
    chatProfileId: null,
    agentProfileId: null,
    visionProfileId: null,
    fallbackProfileIds: ['cloud-chat'],
    allowCrossProviderFallback: false
  }
};

const cloudCatalog: ProviderCatalogEntry = {
  catalogVersion: 1,
  providerId: 'cloud',
  displayName: '云端',
  protocol: 'openai-compatible',
  baseUrl: 'https://cloud.example/v1',
  modelDiscoveryUrl: null,
  models: [{ modelId: 'cloud-chat', displayName: '云端聊天', capabilities: ['chat'] }],
  apiKeyHelpUrl: 'https://cloud.example/keys',
  requestLimits: {},
  compatibilityNotes: []
};

const emptyDisclosure = { allowedCrossProviderProfileIds: new Set<string>() };

function localRouter(snapshot: ProviderSettingsSnapshot): ModelRouter {
  return new ModelRouter({
    profiles: snapshot.profiles,
    route: snapshot.route,
    catalog: [cloudCatalog, BUILTIN_LOCAL_PROVIDER_CATALOG_ENTRY]
  });
}

describe('内置本地模型路由覆盖', () => {
  test('开启时只在内存追加本地档案并覆盖路由，关闭时无损返回云快照', () => {
    const cloud = structuredClone(fixture);

    const enabled = createLocalModelRoutingSnapshot(cloud, true);

    expect(enabled.route).toMatchObject({
      primaryProfileId: BUILTIN_LOCAL_PROFILE_ID,
      chatProfileId: BUILTIN_LOCAL_PROFILE_ID,
      agentProfileId: BUILTIN_LOCAL_PROFILE_ID,
      visionProfileId: BUILTIN_LOCAL_PROFILE_ID,
      fallbackProfileIds: [],
      allowCrossProviderFallback: false
    });
    expect(enabled.profiles).toContainEqual(expect.objectContaining({
      id: BUILTIN_LOCAL_PROFILE_ID,
      mode: 'preset',
      hasStoredSecret: false,
      capabilities: ['chat', 'tools']
    }));
    expect(cloud).toEqual(fixture);
    expect(createLocalModelRoutingSnapshot(cloud, false)).toEqual(cloud);
  });

  test('本地档案仅支持聊天和工具，视觉选择稳定拒绝且不保留备用模型', () => {
    const enabled = createLocalModelRoutingSnapshot(fixture, true);
    const localProfile = enabled.profiles.find(profile => profile.id === BUILTIN_LOCAL_PROFILE_ID);

    expect(localProfile).toBeDefined();
    expect(localProfile?.capabilities).toEqual(['chat', 'tools']);
    expect(localRouter(enabled).select('chat', emptyDisclosure)).toMatchObject({
      profile: expect.objectContaining({ id: BUILTIN_LOCAL_PROFILE_ID }),
      fallbackProfiles: []
    });
    expect(localRouter(enabled).select('agent', emptyDisclosure)).toMatchObject({
      profile: expect.objectContaining({ id: BUILTIN_LOCAL_PROFILE_ID }),
      fallbackProfiles: []
    });
    expect(() => localRouter(enabled).select('vision', emptyDisclosure))
      .toThrow('MODEL_CAPABILITY_REQUIRED');
  });

  test('调用方无法通过路由函数输入覆盖本地 URL 或模型 ID', () => {
    expect(BUILTIN_LOCAL_PROVIDER_CATALOG_ENTRY.providerId).toBe(BUILTIN_LOCAL_PROFILE_ID);
    expect(BUILTIN_LOCAL_PROVIDER_CATALOG_ENTRY.models).toEqual([expect.objectContaining({
      modelId: BUILTIN_LOCAL_PROFILE_ID
    })]);
  });
});
