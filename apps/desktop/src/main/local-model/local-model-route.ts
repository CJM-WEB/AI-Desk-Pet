import type {
  ModelRouteConfig,
  ProviderCatalogEntry,
  ProviderProfileV2
} from '@myself/shared-types';
import type { ProviderSettingsSnapshot } from '../storage/settings-store';

export const BUILTIN_LOCAL_PROFILE_ID = 'builtin-local';

/** 本地模型只在 Main 内存中使用，固定目录项不进入公开 providerCatalog。 */
export const BUILTIN_LOCAL_PROVIDER_CATALOG_ENTRY: ProviderCatalogEntry = {
  catalogVersion: 1,
  providerId: BUILTIN_LOCAL_PROFILE_ID,
  displayName: '内置本地模型',
  protocol: 'openai-compatible',
  baseUrl: 'http://127.0.0.1:0',
  modelDiscoveryUrl: null,
  models: [{
    modelId: BUILTIN_LOCAL_PROFILE_ID,
    displayName: '内置本地模型',
    capabilities: ['chat', 'tools']
  }],
  apiKeyHelpUrl: 'https://local-model.invalid/',
  requestLimits: {},
  compatibilityNotes: ['内置本地模型仅支持聊天和工具调用。']
};

const builtinLocalProfile: ProviderProfileV2 = {
  id: BUILTIN_LOCAL_PROFILE_ID,
  displayName: '内置本地模型',
  mode: 'preset',
  providerId: BUILTIN_LOCAL_PROFILE_ID,
  modelId: BUILTIN_LOCAL_PROFILE_ID,
  capabilities: ['chat', 'tools'],
  hasStoredSecret: false
};

const builtinLocalRoute: ModelRouteConfig = {
  primaryProfileId: BUILTIN_LOCAL_PROFILE_ID,
  chatProfileId: BUILTIN_LOCAL_PROFILE_ID,
  agentProfileId: BUILTIN_LOCAL_PROFILE_ID,
  visionProfileId: BUILTIN_LOCAL_PROFILE_ID,
  fallbackProfileIds: [],
  allowCrossProviderFallback: false
};

/** 生成只存在于 Main 内存的本地模型路由快照，不改写持久化云配置。 */
export function createLocalModelRoutingSnapshot(
  cloud: ProviderSettingsSnapshot,
  enabled: boolean
): ProviderSettingsSnapshot {
  const snapshot = structuredClone(cloud);
  if (!enabled) return snapshot;

  return {
    profiles: [
      ...snapshot.profiles.filter(profile => profile.id !== BUILTIN_LOCAL_PROFILE_ID),
      structuredClone(builtinLocalProfile)
    ],
    route: structuredClone(builtinLocalRoute)
  };
}
