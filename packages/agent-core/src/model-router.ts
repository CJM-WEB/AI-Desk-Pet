import type {
  ModelCapability,
  ModelRouteConfig,
  ProviderCatalogEntry,
  ProviderProfileV2
} from '@myself/shared-types';
import type {
  ModelDisclosureTarget,
  ModelRequestKind,
  ModelSelection,
  RouteDisclosure
} from './types';

interface ModelRouterOptions {
  profiles: ProviderProfileV2[];
  route: ModelRouteConfig;
  catalog: ProviderCatalogEntry[];
}

interface ResolvedProfile {
  profile: ProviderProfileV2;
  capabilities: ReadonlySet<ModelCapability>;
  disclosureTarget: ModelDisclosureTarget;
}

const requiredCapabilities: Record<ModelRequestKind, readonly ModelCapability[]> = {
  chat: ['chat'],
  agent: ['chat', 'tools'],
  vision: ['chat', 'vision']
};

/**
 * 仅根据内存中的档案、目录和披露授权生成路由计划。
 * 此类不创建 Provider，也不接触密钥、网络或工具执行。
 */
export class ModelRouter {
  private readonly profilesById: ReadonlyMap<string, ResolvedProfile>;
  private readonly route: ModelRouteConfig;

  constructor({ profiles, route, catalog }: ModelRouterOptions) {
    const copiedCatalog = structuredClone(catalog);
    const copiedRoute: ModelRouteConfig = {
      ...route,
      fallbackProfileIds: [...route.fallbackProfileIds]
    };
    const profilesById = new Map<string, ResolvedProfile>();

    for (const profile of structuredClone(profiles)) {
      if (profilesById.has(profile.id)) throw new Error('MODEL_PROFILE_ID_DUPLICATED');
      profilesById.set(profile.id, this.resolveProfile(profile, copiedCatalog));
    }

    this.profilesById = profilesById;
    this.route = copiedRoute;
  }

  select(requestKind: ModelRequestKind, disclosure: RouteDisclosure): ModelSelection {
    const primaryProfileId = this.primaryProfileIdFor(requestKind);
    if (!primaryProfileId) throw new Error('MODEL_ROUTE_NOT_CONFIGURED');

    const primary = this.profileById(primaryProfileId);
    if (!this.supports(primary, requestKind)) throw new Error('MODEL_CAPABILITY_REQUIRED');

    const fallbackProfiles = this.selectFallbacks(primary, requestKind, disclosure);
    return {
      profile: structuredClone(primary.profile),
      disclosureTarget: { ...primary.disclosureTarget },
      fallbackProfiles: fallbackProfiles.map(profile => structuredClone(profile.profile))
    };
  }

  private primaryProfileIdFor(requestKind: ModelRequestKind): string | null {
    if (requestKind === 'chat') return this.route.chatProfileId ?? this.route.primaryProfileId;
    if (requestKind === 'agent') return this.route.agentProfileId ?? this.route.primaryProfileId;
    return this.route.visionProfileId ?? this.route.primaryProfileId;
  }

  private selectFallbacks(
    primary: ResolvedProfile,
    requestKind: ModelRequestKind,
    disclosure: RouteDisclosure
  ): ResolvedProfile[] {
    const fallbackIds = [...new Set(this.route.fallbackProfileIds)]
      .filter(profileId => profileId !== primary.profile.id);
    if (fallbackIds.length === 0) return [];

    const eligible = fallbackIds
      .map(profileId => this.profileById(profileId))
      .filter(profile => this.supports(profile, requestKind));
    const sameProvider = eligible.filter(profile =>
      profile.disclosureTarget.providerIdentity === primary.disclosureTarget.providerIdentity
    );
    const crossProvider = eligible.filter(profile =>
      profile.disclosureTarget.providerIdentity !== primary.disclosureTarget.providerIdentity
    );
    const allowedCrossProvider = crossProvider.filter(profile =>
      this.route.allowCrossProviderFallback
      && disclosure.allowedCrossProviderProfileIds.has(profile.profile.id)
    );

    if (crossProvider.length > 0 && sameProvider.length === 0 && allowedCrossProvider.length === 0) {
      throw new Error('MODEL_CROSS_PROVIDER_FALLBACK_NOT_AUTHORIZED');
    }

    return eligible.filter(profile =>
      profile.disclosureTarget.providerIdentity === primary.disclosureTarget.providerIdentity
      || (this.route.allowCrossProviderFallback
        && disclosure.allowedCrossProviderProfileIds.has(profile.profile.id))
    );
  }

  private profileById(profileId: string): ResolvedProfile {
    const profile = this.profilesById.get(profileId);
    if (!profile) throw new Error('MODEL_PROFILE_NOT_FOUND');
    return profile;
  }

  private supports(profile: ResolvedProfile, requestKind: ModelRequestKind): boolean {
    return requiredCapabilities[requestKind].every(capability => profile.capabilities.has(capability));
  }

  private resolveProfile(
    profile: ProviderProfileV2,
    catalog: readonly ProviderCatalogEntry[]
  ): ResolvedProfile {
    if (profile.mode === 'custom') {
      return {
        profile,
        capabilities: new Set(['chat', 'streaming']),
        disclosureTarget: {
          profileId: profile.id,
          providerIdentity: `custom:${profile.protocol}:${profile.baseUrl.replace(/\/+$/u, '')}`
        }
      };
    }

    const provider = catalog.find(entry => entry.providerId === profile.providerId);
    if (!provider) throw new Error('MODEL_PROVIDER_NOT_FOUND');
    const model = provider.models.find(entry => entry.modelId === profile.modelId);
    if (!model) throw new Error('MODEL_MODEL_NOT_FOUND');
    return {
      profile,
      capabilities: new Set(model.capabilities),
      disclosureTarget: {
        profileId: profile.id,
        providerIdentity: `provider:${profile.providerId}`
      }
    };
  }
}
