import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const disclosureCategorySchema = z.enum([
  'conversation',
  'file',
  'screenshot',
  'clipboard',
  'memory'
]);
export type DisclosureCategory = z.infer<typeof disclosureCategorySchema>;

const identifierSchema = z.string().min(1).max(128);
const providerIdentitySchema = z.string().min(1).max(128);
const privacySessionInputSchema = z.object({
  incognito: z.boolean()
}).strict();

interface PrivacySessionRegistration {
  incognito: boolean;
}

interface PrivacySessionState extends PrivacySessionRegistration {
  generation: string;
}

type SessionInvalidationListener = (sessionId: string, generation: string) => void;

/**
 * 会话隐私状态只保存在 Electron Main，由持久化和披露边界共同查询。
 */
export class PrivacySessionRegistry {
  private readonly sessions = new Map<string, PrivacySessionState>();
  private readonly invalidationListeners = new Set<SessionInvalidationListener>();

  register(sessionIdInput: string, stateInput: PrivacySessionRegistration): void {
    const sessionId = identifierSchema.safeParse(sessionIdInput);
    const state = privacySessionInputSchema.safeParse(stateInput);
    if (!sessionId.success || !state.success) {
      throw new Error('PRIVACY_SESSION_INVALID');
    }
    const previous = this.sessions.get(sessionId.data);
    if (previous !== undefined) {
      this.notifyInvalidated(sessionId.data, previous.generation);
    }
    this.sessions.set(sessionId.data, {
      ...state.data,
      generation: randomUUID()
    });
  }

  unregister(sessionIdInput: string): boolean {
    const sessionId = identifierSchema.safeParse(sessionIdInput);
    if (!sessionId.success) return false;
    const previous = this.sessions.get(sessionId.data);
    if (previous === undefined) return false;
    this.sessions.delete(sessionId.data);
    this.notifyInvalidated(sessionId.data, previous.generation);
    return true;
  }

  isRegistered(sessionIdInput: string): boolean {
    const sessionId = identifierSchema.safeParse(sessionIdInput);
    return sessionId.success && this.sessions.has(sessionId.data);
  }

  isLongTermMemoryAllowed(sessionIdInput: string): boolean {
    const sessionId = identifierSchema.safeParse(sessionIdInput);
    if (!sessionId.success) return false;
    return this.sessions.get(sessionId.data)?.incognito === false;
  }

  assertConversationPersistenceAllowed(sessionIdInput: string): void {
    const sessionId = identifierSchema.safeParse(sessionIdInput);
    if (!sessionId.success || !this.sessions.has(sessionId.data)) {
      throw new Error('PRIVACY_SESSION_UNKNOWN');
    }
    if (this.sessions.get(sessionId.data)!.incognito) {
      throw new Error('PRIVACY_CONVERSATION_PERSISTENCE_DENIED');
    }
  }

  /**
   * 仅供 Main 内策略绑定会话生命周期，不进入 Renderer 或 IPC 契约。
   */
  getGenerationForMain(sessionIdInput: string): string | null {
    const sessionId = identifierSchema.safeParse(sessionIdInput);
    if (!sessionId.success) return null;
    return this.sessions.get(sessionId.data)?.generation ?? null;
  }

  onInvalidated(listener: SessionInvalidationListener): () => void {
    this.invalidationListeners.add(listener);
    return () => this.invalidationListeners.delete(listener);
  }

  private notifyInvalidated(sessionId: string, generation: string): void {
    for (const listener of this.invalidationListeners) {
      listener(sessionId, generation);
    }
  }
}

const disclosureMetadataSchema = z.object({
  itemCount: z.number().int().min(0).max(100_000).optional(),
  byteLength: z.number().int().min(0).max(100_000_000).optional(),
  extension: z.string().min(1).max(16).regex(/^[a-z0-9]+$/u).optional()
}).strict();

const requestSchema = z.object({
  requestId: identifierSchema,
  sessionId: identifierSchema,
  targetProfileId: identifierSchema,
  categories: z.array(disclosureCategorySchema).min(1).max(5)
    .refine(categories => new Set(categories).size === categories.length),
  metadata: z.object({
    conversation: disclosureMetadataSchema.optional(),
    file: disclosureMetadataSchema.optional(),
    screenshot: disclosureMetadataSchema.optional(),
    clipboard: disclosureMetadataSchema.optional(),
    memory: disclosureMetadataSchema.optional()
  }).strict()
}).strict();

const grantBaseSchema = z.object({
  sessionId: identifierSchema,
  category: disclosureCategorySchema,
  targetProfileId: identifierSchema,
  allowCrossProvider: z.boolean()
}).strict();
const grantInputSchema = z.discriminatedUnion('scope', [
  grantBaseSchema.extend({
    scope: z.literal('request'),
    requestId: identifierSchema
  }).strict(),
  grantBaseSchema.extend({
    scope: z.literal('session')
  }).strict()
]);

export type DisclosureRequest = z.input<typeof requestSchema>;
export type DisclosureGrantInput = z.input<typeof grantInputSchema>;

type StoredDisclosureGrant = z.infer<typeof grantInputSchema> & {
  grantId: string;
  sessionGeneration: string;
  targetProviderIdentity: string;
  expiresAt: number | null;
};

export interface DisclosureManifestMetadata {
  category: DisclosureCategory;
  itemCount?: number;
  byteLength?: number;
  extension?: string;
}

export interface DisclosureManifest {
  requestId: string;
  targetProfileId: string;
  targetProviderIdentity: string;
  categories: DisclosureCategory[];
  metadata: DisclosureManifestMetadata[];
}

export interface DisclosurePolicyOptions {
  privacySessions: PrivacySessionRegistry;
  resolveProfileProvider(profileId: string): string | null;
  resolveCurrentSourceProvider(sessionId: string): string | null;
  now?: () => number;
  requestGrantTtlMs?: number;
  maxGrants?: number;
}

const DEFAULT_REQUEST_GRANT_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_GRANTS = 500;

export class DisclosurePolicy {
  private readonly grants = new Map<string, StoredDisclosureGrant>();
  private readonly now: () => number;
  private readonly requestGrantTtlMs: number;
  private readonly maxGrants: number;
  private readonly stopSessionInvalidationListener: () => void;

  constructor(private readonly options: DisclosurePolicyOptions) {
    this.now = options.now ?? Date.now;
    this.requestGrantTtlMs =
      options.requestGrantTtlMs ?? DEFAULT_REQUEST_GRANT_TTL_MS;
    this.maxGrants = options.maxGrants ?? DEFAULT_MAX_GRANTS;
    if (
      !Number.isSafeInteger(this.requestGrantTtlMs)
      || this.requestGrantTtlMs <= 0
      || !Number.isSafeInteger(this.maxGrants)
      || this.maxGrants <= 0
    ) {
      throw new Error('DISCLOSURE_CONFIG_INVALID');
    }
    this.stopSessionInvalidationListener = options.privacySessions.onInvalidated(
      (sessionId, generation) => {
        for (const [grantId, grant] of this.grants) {
          if (
            grant.sessionId === sessionId
            && grant.sessionGeneration === generation
          ) {
            this.grants.delete(grantId);
          }
        }
      }
    );
  }

  grant(input: DisclosureGrantInput): string {
    const parsed = grantInputSchema.safeParse(input);
    if (!parsed.success) throw new Error('DISCLOSURE_GRANT_INVALID');
    if (!this.options.privacySessions.isRegistered(parsed.data.sessionId)) {
      throw new Error('DISCLOSURE_SESSION_UNKNOWN');
    }
    const sessionGeneration = this.options.privacySessions.getGenerationForMain(
      parsed.data.sessionId
    );
    if (sessionGeneration === null) {
      throw new Error('DISCLOSURE_SESSION_UNKNOWN');
    }
    const targetProviderIdentity = this.resolveProvider(parsed.data.targetProfileId);
    this.removeExpiredGrants();
    if (this.grants.size >= this.maxGrants) {
      throw new Error('DISCLOSURE_GRANT_LIMIT_EXCEEDED');
    }
    if ([...this.grants.values()].some(grant => this.sameGrant(grant, parsed.data))) {
      throw new Error('DISCLOSURE_GRANT_DUPLICATE');
    }

    const grantId = randomUUID();
    this.grants.set(grantId, {
      ...parsed.data,
      grantId,
      sessionGeneration,
      targetProviderIdentity,
      expiresAt: parsed.data.scope === 'request'
        ? this.now() + this.requestGrantTtlMs
        : null
    });
    return grantId;
  }

  revoke(grantId: string): boolean {
    const parsed = identifierSchema.safeParse(grantId);
    return parsed.success && this.grants.delete(parsed.data);
  }

  revokeAllForSession(sessionId: string): number {
    const parsed = identifierSchema.safeParse(sessionId);
    if (!parsed.success) throw new Error('DISCLOSURE_SESSION_UNKNOWN');
    let removed = 0;
    for (const [grantId, grant] of this.grants) {
      if (grant.sessionId === parsed.data) {
        this.grants.delete(grantId);
        removed += 1;
      }
    }
    return removed;
  }

  dispose(): void {
    this.stopSessionInvalidationListener();
    this.grants.clear();
  }

  createManifest(requestInput: DisclosureRequest): DisclosureManifest {
    return this.createManifestWithSource(
      requestInput,
      sessionId => this.options.resolveCurrentSourceProvider(sessionId),
      false
    );
  }

  /** 仅供 Main 内可信组合根为保守历史来源生成清单。 */
  createManifestForSource(
    requestInput: DisclosureRequest,
    sourceProviderIdentity: string
  ): DisclosureManifest {
    return this.createManifestWithSource(
      requestInput,
      () => sourceProviderIdentity,
      true
    );
  }

  private createManifestWithSource(
    requestInput: DisclosureRequest,
    resolveSourceProvider: (sessionId: string) => string | null,
    requestScopedConversationOnly: boolean
  ): DisclosureManifest {
    const parsed = requestSchema.safeParse(requestInput);
    if (!parsed.success) throw new Error('DISCLOSURE_REQUEST_INVALID');
    const request = parsed.data;
    if (!this.options.privacySessions.isRegistered(request.sessionId)) {
      throw new Error('DISCLOSURE_SESSION_UNKNOWN');
    }
    const sessionGeneration = this.options.privacySessions.getGenerationForMain(
      request.sessionId
    );
    if (sessionGeneration === null) {
      throw new Error('DISCLOSURE_SESSION_UNKNOWN');
    }
    if (
      request.categories.includes('memory')
      && !this.options.privacySessions.isLongTermMemoryAllowed(request.sessionId)
    ) {
      throw new Error('DISCLOSURE_INCOGNITO_MEMORY_DENIED');
    }

    const targetProviderIdentity = this.resolveProvider(request.targetProfileId);
    let sourceProviderIdentity: string | null;
    try {
      sourceProviderIdentity = resolveSourceProvider(request.sessionId);
    } catch {
      throw new Error('DISCLOSURE_SOURCE_PROVIDER_UNKNOWN');
    }
    if (
      sourceProviderIdentity === null
      || !providerIdentitySchema.safeParse(sourceProviderIdentity).success
    ) {
      throw new Error('DISCLOSURE_SOURCE_PROVIDER_UNKNOWN');
    }
    this.removeExpiredGrants();

    const requestGrantsToConsume = new Set<string>();
    for (const category of request.categories) {
      for (const grantId of this.requireAuthorization(
        request,
        category,
        sessionGeneration,
        sourceProviderIdentity,
        targetProviderIdentity,
        requestScopedConversationOnly
      )) {
        requestGrantsToConsume.add(grantId);
      }
    }

    const manifest: DisclosureManifest = {
      requestId: request.requestId,
      targetProfileId: request.targetProfileId,
      targetProviderIdentity,
      categories: [...request.categories],
      metadata: request.categories.flatMap(category => {
        const metadata = request.metadata[category];
        if (metadata === undefined) return [];
        return [{
          category,
          ...(metadata.itemCount === undefined ? {} : { itemCount: metadata.itemCount }),
          ...(metadata.byteLength === undefined ? {} : { byteLength: metadata.byteLength }),
          ...(metadata.extension === undefined ? {} : { extension: metadata.extension })
        }];
      })
    };

    // 只有完整清单成功构造后，才原子消费本次使用的请求级授权。
    for (const grantId of requestGrantsToConsume) this.grants.delete(grantId);
    return manifest;
  }

  private resolveProvider(profileId: string): string {
    let providerIdentity: string | null;
    try {
      providerIdentity = this.options.resolveProfileProvider(profileId);
    } catch {
      throw new Error('DISCLOSURE_PROFILE_UNKNOWN');
    }
    if (
      providerIdentity === null
      || !providerIdentitySchema.safeParse(providerIdentity).success
    ) {
      throw new Error('DISCLOSURE_PROFILE_UNKNOWN');
    }
    return providerIdentity;
  }

  private requireAuthorization(
    request: z.infer<typeof requestSchema>,
    category: DisclosureCategory,
    sessionGeneration: string,
    sourceProviderIdentity: string,
    targetProviderIdentity: string,
    requestScopedConversationOnly: boolean
  ): string[] {
    const scoped = [...this.grants.values()].filter(grant =>
      grant.sessionId === request.sessionId
      && grant.sessionGeneration === sessionGeneration
      && grant.category === category
      && (
        grant.scope === 'session'
        || grant.requestId === request.requestId
      )
    );
    const targetMatched = scoped.filter(grant =>
      grant.targetProfileId === request.targetProfileId
      && grant.targetProviderIdentity === targetProviderIdentity
    );
    if (scoped.length > 0 && targetMatched.length === 0) {
      throw new Error('DISCLOSURE_TARGET_MISMATCH');
    }

    const crossesProvider = sourceProviderIdentity !== targetProviderIdentity;
    if (crossesProvider) {
      const authorized = targetMatched.filter(grant =>
        grant.allowCrossProvider
        && (
          !requestScopedConversationOnly
          || category !== 'conversation'
          || grant.scope === 'request'
        )
      );
      if (authorized.length === 0) {
        throw new Error('DISCLOSURE_CROSS_PROVIDER_NOT_AUTHORIZED');
      }
      return authorized
        .filter(grant => grant.scope === 'request')
        .map(grant => grant.grantId);
    }

    if (category === 'conversation') {
      return targetMatched
        .filter(grant => grant.scope === 'request')
        .map(grant => grant.grantId);
    }
    if (targetMatched.length === 0) {
      throw new Error('DISCLOSURE_CATEGORY_NOT_AUTHORIZED');
    }
    return targetMatched
      .filter(grant => grant.scope === 'request')
      .map(grant => grant.grantId);
  }

  private removeExpiredGrants(): void {
    const now = this.now();
    for (const [grantId, grant] of this.grants) {
      if (grant.expiresAt !== null && grant.expiresAt <= now) {
        this.grants.delete(grantId);
      }
    }
  }

  private sameGrant(
    stored: StoredDisclosureGrant,
    candidate: z.infer<typeof grantInputSchema>
  ): boolean {
    return stored.scope === candidate.scope
      && stored.sessionId === candidate.sessionId
      && stored.sessionGeneration
        === this.options.privacySessions.getGenerationForMain(candidate.sessionId)
      && stored.category === candidate.category
      && stored.targetProfileId === candidate.targetProfileId
      && (
        stored.scope === 'session'
        || (
          candidate.scope === 'request'
          && stored.requestId === candidate.requestId
        )
      );
  }
}
