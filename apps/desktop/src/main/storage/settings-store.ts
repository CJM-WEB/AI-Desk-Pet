import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  modelRouteConfigSchema,
  providerCatalog,
  providerProfileV2Schema,
  storedProviderProfileV2Schema,
  type ModelCapability,
  type ModelRouteConfig,
  type ProviderProfileV2,
  type PublicSettings,
  type StoredProviderProfileV2
} from '@myself/shared-types';

const providerMetadataSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  baseUrl: z.string().url(),
  model: z.string().min(1)
}).strict();

const authorizedRootSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  pathHint: z.string().min(1),
  absolutePath: z.string().min(1)
}).strict();

const petPositionSchema = z.object({
  x: z.number(),
  y: z.number()
}).strict();

export const privacySettingsSchema = z.object({
  dataCategories: z.object({
    file: z.boolean(),
    screenshot: z.boolean(),
    clipboard: z.boolean(),
    memory: z.boolean()
  }).strict(),
  longTermMemory: z.boolean(),
  proactivityMode: z.enum(['passive', 'assistive', 'autonomous']),
  petAlwaysOnTop: z.boolean().default(false)
}).strict();
export type PrivacySettings = z.infer<typeof privacySettingsSchema>;

const mcpToolSettingsSchema = z.object({
  enabled: z.boolean(),
  readOnly: z.boolean(),
  description: z.string().max(500),
  definitionFingerprint: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  trustedReadFingerprint: z.string().regex(/^[a-f0-9]{64}$/u).optional()
}).strict();

export const mcpServerSettingsSchema = z.object({
  id: z.string().min(1).max(128),
  enabled: z.boolean(),
  transport: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('stdio'),
      command: z.string().min(1),
      args: z.array(z.string()),
      cwd: z.string().min(1),
      secretNames: z.array(z.string().min(1)),
      inheritEnv: z.array(z.string().min(1))
    }).strict(),
    z.object({
      type: z.literal('http'),
      url: z.string().url(),
      secretNames: z.array(z.string().min(1))
    }).strict()
  ]),
  tools: z.record(z.string(), mcpToolSettingsSchema)
}).strict();
export type McpServerSettings = z.infer<typeof mcpServerSettingsSchema>;

const storedSettingsV1Schema = z.object({
  version: z.literal(1),
  provider: providerMetadataSchema.nullable(),
  authorizedRoot: authorizedRootSchema.nullable(),
  petPosition: petPositionSchema.nullable(),
  fileDisclosureAccepted: z.boolean()
}).strict();

const storedSettingsV2Schema = z.object({
  version: z.literal(2),
  providerProfiles: z.array(storedProviderProfileV2Schema),
  modelRoute: modelRouteConfigSchema,
  authorizedRoot: authorizedRootSchema.nullable(),
  petPosition: petPositionSchema.nullable(),
  fileDisclosureAccepted: z.boolean(),
  privacy: privacySettingsSchema.optional(),
  mcpServers: z.array(mcpServerSettingsSchema).optional()
}).strict();

type ProviderMetadataInput = z.input<typeof providerMetadataSchema> & Record<string, unknown>;
type AuthorizedRootInput = z.input<typeof authorizedRootSchema>;
type PetPositionInput = z.input<typeof petPositionSchema>;
type StoredSettingsV1 = z.infer<typeof storedSettingsV1Schema>;
type StoredSettings = z.infer<typeof storedSettingsV2Schema>;

export interface ProviderSettingsSnapshot {
  profiles: ProviderProfileV2[];
  route: ModelRouteConfig;
}

function emptyModelRoute(): ModelRouteConfig {
  return {
    primaryProfileId: null,
    chatProfileId: null,
    agentProfileId: null,
    visionProfileId: null,
    fallbackProfileIds: [],
    allowCrossProviderFallback: false
  };
}

function defaultSettings(): StoredSettings {
  return {
    version: 2,
    providerProfiles: [],
    modelRoute: emptyModelRoute(),
    authorizedRoot: null,
    petPosition: null,
    fileDisclosureAccepted: false,
    privacy: defaultPrivacySettings(),
    mcpServers: []
  };
}

function defaultPrivacySettings(): PrivacySettings {
  return {
    dataCategories: {
      file: false,
      screenshot: false,
      clipboard: false,
      memory: false
    },
    longTermMemory: false,
    proactivityMode: 'assistive',
    petAlwaysOnTop: false
  };
}

function migrateV1Settings(settings: StoredSettingsV1): StoredSettings {
  if (settings.provider === null) {
    return {
      ...defaultSettings(),
      authorizedRoot: settings.authorizedRoot,
      petPosition: settings.petPosition,
      fileDisclosureAccepted: settings.fileDisclosureAccepted
    };
  }

  const profile: StoredProviderProfileV2 = {
    id: settings.provider.id,
    displayName: settings.provider.displayName,
    mode: 'custom',
    protocol: 'openai-compatible',
    baseUrl: settings.provider.baseUrl,
    modelId: settings.provider.model,
    additionalParameters: {}
  };
  return {
    version: 2,
    providerProfiles: [profile],
    modelRoute: {
      ...emptyModelRoute(),
      primaryProfileId: profile.id
    },
    authorizedRoot: settings.authorizedRoot,
    petPosition: settings.petPosition,
    fileDisclosureAccepted: settings.fileDisclosureAccepted,
    privacy: defaultPrivacySettings(),
    mcpServers: []
  };
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function atomicWrite(file: string, value: StoredSettings): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporaryFile = `${file}.tmp`;
  const handle = await open(temporaryFile, 'w');
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryFile, file);
}

function settingsError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function storedProfile(profile: ProviderProfileV2): StoredProviderProfileV2 {
  const { hasStoredSecret: _hasStoredSecret, ...metadata } = profile;
  return storedProviderProfileV2Schema.parse(metadata);
}

function profileCapabilities(profile: StoredProviderProfileV2): readonly ModelCapability[] {
  if (profile.mode === 'custom') return profile.capabilities ?? ['chat'];
  const provider = providerCatalog.find(entry => entry.providerId === profile.providerId);
  if (!provider) throw settingsError('PROVIDER_MODEL_NOT_FOUND');
  const model = provider.models.find(entry => entry.modelId === profile.modelId);
  return model?.capabilities ?? profile.capabilities ?? ['chat'];
}

function providerIdentity(profile: StoredProviderProfileV2): string {
  if (profile.mode === 'preset') return `preset:${profile.providerId}`;
  const url = new URL(profile.baseUrl);
  return `custom:${profile.protocol}:${url.origin}`;
}

function validateRoute(
  route: ModelRouteConfig,
  profiles: readonly StoredProviderProfileV2[]
): void {
  const byId = new Map(profiles.map(profile => [profile.id, profile]));
  const referencedIds = [
    route.primaryProfileId,
    route.chatProfileId,
    route.agentProfileId,
    route.visionProfileId,
    ...route.fallbackProfileIds
  ].filter((value): value is string => value !== null);
  for (const profileId of referencedIds) {
    if (!byId.has(profileId)) throw settingsError('PROVIDER_PROFILE_NOT_FOUND');
  }
  if (new Set(route.fallbackProfileIds).size !== route.fallbackProfileIds.length) {
    throw settingsError('DUPLICATE_FALLBACK_PROFILE');
  }

  const agentProfileId = route.agentProfileId ?? route.primaryProfileId;
  if (agentProfileId) {
    const agent = byId.get(agentProfileId)!;
    if (!profileCapabilities(agent).includes('tools')) {
      throw settingsError('AGENT_MODEL_REQUIRES_TOOLS');
    }
  }
  if (route.visionProfileId) {
    const vision = byId.get(route.visionProfileId)!;
    if (!profileCapabilities(vision).includes('vision')) {
      throw settingsError('VISION_MODEL_REQUIRES_VISION');
    }
  }

  const primary = route.primaryProfileId ? byId.get(route.primaryProfileId) : undefined;
  if (!route.allowCrossProviderFallback && primary) {
    const primaryProvider = providerIdentity(primary!);
    for (const fallbackId of route.fallbackProfileIds) {
      if (providerIdentity(byId.get(fallbackId)!) !== primaryProvider) {
        throw settingsError('CROSS_PROVIDER_FALLBACK_NOT_AUTHORIZED');
      }
    }
  }
}

export class SettingsStore {
  private writeQueue = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly hasStoredSecret: (profileId?: string) => Promise<boolean>
  ) {}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const transaction = this.writeQueue.then(operation);
    this.writeQueue = transaction.then(() => undefined, () => undefined);
    return transaction;
  }

  private enqueueWrite(operation: () => Promise<void>): Promise<void> {
    return this.enqueue(operation);
  }

  private async quarantineCorruptFile(): Promise<StoredSettings> {
    await rename(this.file, `${this.file}.corrupt-${Date.now()}`);
    return defaultSettings();
  }

  private async load(): Promise<StoredSettings> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.file, 'utf8')) as unknown;
    } catch (error) {
      if (isMissingFile(error)) return defaultSettings();
      return this.quarantineCorruptFile();
    }

    const v2 = storedSettingsV2Schema.safeParse(raw);
    if (v2.success) {
      return {
        ...v2.data,
        privacy: v2.data.privacy ?? defaultPrivacySettings(),
        mcpServers: v2.data.mcpServers ?? []
      };
    }

    const v1 = storedSettingsV1Schema.safeParse(raw);
    if (v1.success) {
      const migrated = migrateV1Settings(v1.data);
      // 迁移写入失败必须向上传播，原 v1 文件保持不变。
      await atomicWrite(this.file, migrated);
      return migrated;
    }

    return this.quarantineCorruptFile();
  }

  private async publicProvider(settings: StoredSettings): Promise<PublicSettings['provider']> {
    const profile = settings.providerProfiles.find(value => value.id === settings.modelRoute.primaryProfileId);
    if (!profile) return null;

    const metadata = profile.mode === 'custom'
      ? profile
      : providerCatalog.find(entry => entry.providerId === profile.providerId);
    if (!metadata) return null;

    return {
      id: profile.id,
      displayName: profile.displayName,
      baseUrl: metadata.baseUrl,
      model: profile.modelId,
      hasStoredSecret: await this.hasStoredSecret(profile.id)
    };
  }

  async getProviderSettings(): Promise<ProviderSettingsSnapshot> {
    return this.enqueue(async () => {
      const settings = await this.load();
      const profiles = await Promise.all(settings.providerProfiles.map(async profile => (
        providerProfileV2Schema.parse({
          ...profile,
          hasStoredSecret: await this.hasStoredSecret(profile.id)
        })
      )));
      return {
        profiles,
        route: structuredClone(settings.modelRoute)
      };
    });
  }

  saveProviderProfile(input: ProviderProfileV2): Promise<void> {
    return this.enqueueWrite(async () => {
      const profile = storedProfile(providerProfileV2Schema.parse(input));
      profileCapabilities(profile);
      const settings = await this.load();
      settings.providerProfiles = [
        ...settings.providerProfiles.filter(value => value.id !== profile.id),
        profile
      ];
      await atomicWrite(this.file, settings);
    });
  }

  saveModelRoute(input: ModelRouteConfig): Promise<void> {
    return this.enqueueWrite(async () => {
      const route = modelRouteConfigSchema.parse(input);
      const settings = await this.load();
      validateRoute(route, settings.providerProfiles);
      settings.modelRoute = route;
      await atomicWrite(this.file, settings);
    });
  }

  deleteProviderProfile(profileId: string): Promise<void> {
    return this.enqueueWrite(async () => {
      const parsedId = z.string().min(1).parse(profileId);
      const settings = await this.load();
      if (!settings.providerProfiles.some(profile => profile.id === parsedId)) {
        throw settingsError('PROVIDER_PROFILE_NOT_FOUND');
      }
      settings.providerProfiles = settings.providerProfiles.filter(
        profile => profile.id !== parsedId
      );
      const route = settings.modelRoute;
      settings.modelRoute = {
        primaryProfileId: route.primaryProfileId === parsedId ? null : route.primaryProfileId,
        chatProfileId: route.chatProfileId === parsedId ? null : route.chatProfileId,
        agentProfileId: route.agentProfileId === parsedId ? null : route.agentProfileId,
        visionProfileId: route.visionProfileId === parsedId ? null : route.visionProfileId,
        fallbackProfileIds: route.fallbackProfileIds.filter(id => id !== parsedId),
        allowCrossProviderFallback: route.allowCrossProviderFallback
      };
      await atomicWrite(this.file, settings);
    });
  }

  async getPrivacySettings(): Promise<PrivacySettings> {
    return this.enqueue(async () => (
      structuredClone((await this.load()).privacy ?? defaultPrivacySettings())
    ));
  }

  savePrivacySettings(input: PrivacySettings): Promise<void> {
    return this.enqueueWrite(async () => {
      const privacy = privacySettingsSchema.parse(input);
      const settings = await this.load();
      settings.privacy = privacy;
      await atomicWrite(this.file, settings);
    });
  }

  async getMcpServerSettings(): Promise<McpServerSettings[]> {
    return this.enqueue(async () => (
      structuredClone((await this.load()).mcpServers ?? [])
    ));
  }

  saveMcpServerSettings(input: McpServerSettings): Promise<void> {
    return this.enqueueWrite(async () => {
      const server = mcpServerSettingsSchema.parse(input);
      const settings = await this.load();
      settings.mcpServers = [
        ...(settings.mcpServers ?? []).filter(candidate => candidate.id !== server.id),
        server
      ];
      await atomicWrite(this.file, settings);
    });
  }

  deleteMcpServerSettings(serverId: string): Promise<void> {
    return this.enqueueWrite(async () => {
      const id = z.string().min(1).max(128).parse(serverId);
      const settings = await this.load();
      settings.mcpServers = (settings.mcpServers ?? []).filter(
        candidate => candidate.id !== id
      );
      await atomicWrite(this.file, settings);
    });
  }

  revokeAuthorizedRoot(): Promise<void> {
    return this.enqueueWrite(async () => {
      const settings = await this.load();
      settings.authorizedRoot = null;
      await atomicWrite(this.file, settings);
    });
  }

  async getPublic(): Promise<PublicSettings> {
    return this.enqueue(async () => {
      const settings = await this.load();
      return {
        version: 1,
        provider: await this.publicProvider(settings),
        authorizedRoot: settings.authorizedRoot === null ? null : {
          id: settings.authorizedRoot.id,
          displayName: settings.authorizedRoot.displayName,
          pathHint: settings.authorizedRoot.pathHint
        },
        petPosition: settings.petPosition,
        fileDisclosureAccepted: settings.fileDisclosureAccepted
      };
    });
  }

  saveProviderMetadata(input: ProviderMetadataInput): Promise<void> {
    return this.enqueueWrite(async () => {
      const metadata = providerMetadataSchema.parse({
        id: input.id,
        displayName: input.displayName,
        baseUrl: input.baseUrl,
        model: input.model
      });
      const settings = await this.load();
      const profile: StoredProviderProfileV2 = {
        id: metadata.id,
        displayName: metadata.displayName,
        mode: 'custom',
        protocol: 'openai-compatible',
        baseUrl: metadata.baseUrl,
        modelId: metadata.model,
        additionalParameters: {}
      };
      settings.providerProfiles = [
        ...settings.providerProfiles.filter(value => value.id !== profile.id),
        profile
      ];
      settings.modelRoute.primaryProfileId = profile.id;
      await atomicWrite(this.file, settings);
    });
  }

  saveAuthorizedRoot(input: AuthorizedRootInput): Promise<void> {
    return this.enqueueWrite(async () => {
      const settings = await this.load();
      settings.authorizedRoot = authorizedRootSchema.parse(input);
      await atomicWrite(this.file, settings);
    });
  }

  savePetPosition(input: PetPositionInput): Promise<void> {
    return this.enqueueWrite(async () => {
      const settings = await this.load();
      settings.petPosition = petPositionSchema.parse(input);
      await atomicWrite(this.file, settings);
    });
  }

  async getAuthorizedRootPath(): Promise<string | null> {
    return this.enqueue(async () => (await this.load()).authorizedRoot?.absolutePath ?? null);
  }

  clearAll(): Promise<void> {
    return this.enqueueWrite(() => atomicWrite(this.file, defaultSettings()));
  }
}
