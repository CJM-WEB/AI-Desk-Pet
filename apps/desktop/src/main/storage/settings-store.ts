import { mkdir, open, rename } from 'node:fs/promises';
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
import { characterIdSchema } from '../../shared/character-ipc';

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
  x: z.number().finite(),
  y: z.number().finite()
}).strict();

const PET_PLACEMENT_LIMIT = 256;
const SETTINGS_FILE_MAX_BYTES = 1024 * 1024;
const RETIRED_ZEN_PROVIDER_ID = 'opencode-zen-anonymous';
const petPlacementScaleSchema = z.number().finite().transform(value => (
  Math.min(2, Math.max(0.5, value))
));

/** Main 私有的按角色持久位置；不得通过 Renderer 设置契约暴露全局坐标。 */
export const storedPetPlacementSchema = z.object({
  characterId: characterIdSchema,
  scale: petPlacementScaleSchema,
  footAnchorDip: petPositionSchema,
  displayId: z.string().trim().min(1).max(256)
}).strict();
export type StoredPetPlacement = Readonly<z.infer<typeof storedPetPlacementSchema>>;

export type PetPlacementStateSnapshot =
  | Readonly<{
    kind: 'pending-legacy';
    windowPosition: Readonly<PetPositionInput>;
  }>
  | Readonly<{
    kind: 'ready';
    placement: StoredPetPlacement | null;
  }>;

const storedPetPlacementsSchema = z.array(storedPetPlacementSchema)
  .max(PET_PLACEMENT_LIMIT)
  .superRefine((placements, context) => {
    const characterIds = new Set<string>();
    placements.forEach((placement, index) => {
      if (characterIds.has(placement.characterId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'PET_PLACEMENT_CHARACTER_DUPLICATE',
          path: [index, 'characterId']
        });
      }
      characterIds.add(placement.characterId);
    });
  });

const pendingLegacyPetPlacementStateSchema = z.object({
  kind: z.literal('pending-legacy'),
  windowPosition: petPositionSchema
}).strict();

const readyPetPlacementStateSchema = z.object({
  kind: z.literal('ready'),
  placements: storedPetPlacementsSchema
}).strict();

const petPlacementStateSchema = z.discriminatedUnion('kind', [
  pendingLegacyPetPlacementStateSchema,
  readyPetPlacementStateSchema
]);

const petPlacementMigrationCommitSchema = z.object({
  expectedWindowPosition: petPositionSchema,
  placement: storedPetPlacementSchema
}).strict();

export const privacySettingsSchema = z.object({
  dataCategories: z.object({
    file: z.boolean(),
    screenshot: z.boolean(),
    clipboard: z.boolean(),
    memory: z.boolean()
  }).strict(),
  longTermMemory: z.boolean(),
  proactivityMode: z.enum(['passive', 'assistive', 'autonomous'])
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
  petAlwaysOnTop: z.boolean().optional(),
  privacy: privacySettingsSchema.optional(),
  movementStopped: z.boolean().optional(),
  mcpServers: z.array(mcpServerSettingsSchema).optional()
}).strict();

const storedSettingsV3Shape = {
  version: z.literal(3),
  providerProfiles: z.array(storedProviderProfileV2Schema),
  modelRoute: modelRouteConfigSchema,
  authorizedRoot: authorizedRootSchema.nullable(),
  petPlacementState: petPlacementStateSchema,
  fileDisclosureAccepted: z.boolean(),
  petAlwaysOnTop: z.boolean(),
  privacy: privacySettingsSchema,
  movementStopped: z.boolean(),
  mcpServers: z.array(mcpServerSettingsSchema)
};

const storedSettingsV3Schema = z.object(storedSettingsV3Shape).strict();

// 只放宽 ready 集合的单条内容，用于隔离损坏 placement 后保住其余设置。
const recoverableStoredSettingsV3Schema = z.object({
  ...storedSettingsV3Shape,
  petPlacementState: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('pending-legacy'),
      windowPosition: z.unknown()
    }).strict(),
    z.object({
      kind: z.literal('ready'),
      placements: z.array(z.unknown())
    }).strict()
  ])
}).strict();

type ProviderMetadataInput = z.input<typeof providerMetadataSchema> & Record<string, unknown>;
type AuthorizedRootInput = z.input<typeof authorizedRootSchema>;
type PetPositionInput = z.input<typeof petPositionSchema>;
type StoredSettingsV1 = z.infer<typeof storedSettingsV1Schema>;
type StoredSettingsV2 = z.infer<typeof storedSettingsV2Schema>;
type StoredSettings = z.infer<typeof storedSettingsV3Schema>;

export interface ProviderSettingsSnapshot {
  profiles: ProviderProfileV2[];
  route: ModelRouteConfig;
}

export type CharacterBehaviorSettingsSnapshot = Readonly<{
  movementStopped: boolean;
  proactivityMode: PrivacySettings['proactivityMode'];
}>;

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
    version: 3,
    providerProfiles: [],
    modelRoute: emptyModelRoute(),
    authorizedRoot: null,
    petPlacementState: { kind: 'ready', placements: [] },
    fileDisclosureAccepted: false,
    petAlwaysOnTop: false,
    privacy: defaultPrivacySettings(),
    movementStopped: false,
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
    proactivityMode: 'autonomous'
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 严格解析前只移除已退役 Zen 档案，保留可继续使用的其他历史设置。 */
function retireZenProviderSettings(raw: unknown): { changed: boolean; settings: unknown } {
  if (!isRecord(raw) || !Array.isArray(raw.providerProfiles)) {
    return { changed: false, settings: raw };
  }
  const retiredIds = new Set(raw.providerProfiles.flatMap(profile => (
    isRecord(profile)
    && profile.mode === 'preset'
    && profile.providerId === RETIRED_ZEN_PROVIDER_ID
    && typeof profile.id === 'string'
      ? [profile.id]
      : []
  )));
  if (retiredIds.size === 0) return { changed: false, settings: raw };

  const modelRoute = isRecord(raw.modelRoute)
    ? {
      ...raw.modelRoute,
      primaryProfileId: retiredIds.has(raw.modelRoute.primaryProfileId as string)
        ? null : raw.modelRoute.primaryProfileId,
      chatProfileId: retiredIds.has(raw.modelRoute.chatProfileId as string)
        ? null : raw.modelRoute.chatProfileId,
      agentProfileId: retiredIds.has(raw.modelRoute.agentProfileId as string)
        ? null : raw.modelRoute.agentProfileId,
      visionProfileId: retiredIds.has(raw.modelRoute.visionProfileId as string)
        ? null : raw.modelRoute.visionProfileId,
      fallbackProfileIds: Array.isArray(raw.modelRoute.fallbackProfileIds)
        ? raw.modelRoute.fallbackProfileIds.filter(id => !retiredIds.has(id as string))
        : raw.modelRoute.fallbackProfileIds
    }
    : raw.modelRoute;
  return {
    changed: true,
    settings: {
      ...raw,
      providerProfiles: raw.providerProfiles.filter(profile => !(
        isRecord(profile)
        && profile.mode === 'preset'
        && profile.providerId === RETIRED_ZEN_PROVIDER_ID
      )),
      modelRoute
    }
  };
}

function legacyPrivacySettings(): PrivacySettings {
  return {
    ...defaultPrivacySettings(),
    proactivityMode: 'assistive'
  };
}

function behaviorSettingsSnapshot(settings: StoredSettings): CharacterBehaviorSettingsSnapshot {
  return Object.freeze({
    movementStopped: settings.movementStopped ?? false,
    proactivityMode: (settings.privacy ?? legacyPrivacySettings()).proactivityMode
  });
}

function migrateV1Settings(settings: StoredSettingsV1): StoredSettings {
  if (settings.provider === null) {
    return {
      ...defaultSettings(),
      authorizedRoot: settings.authorizedRoot,
      petPlacementState: legacyPetPlacementState(settings.petPosition),
      fileDisclosureAccepted: settings.fileDisclosureAccepted,
      privacy: legacyPrivacySettings()
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
    version: 3,
    providerProfiles: [profile],
    modelRoute: {
      ...emptyModelRoute(),
      primaryProfileId: profile.id
    },
    authorizedRoot: settings.authorizedRoot,
    petPlacementState: legacyPetPlacementState(settings.petPosition),
    fileDisclosureAccepted: settings.fileDisclosureAccepted,
    petAlwaysOnTop: false,
    privacy: legacyPrivacySettings(),
    movementStopped: false,
    mcpServers: []
  };
}

function legacyPetPlacementState(position: PetPositionInput | null): StoredSettings['petPlacementState'] {
  return position === null
    ? { kind: 'ready', placements: [] }
    : { kind: 'pending-legacy', windowPosition: petPositionSchema.parse(position) };
}

function migrateV2Settings(settings: StoredSettingsV2): StoredSettings {
  return storedSettingsV3Schema.parse({
    version: 3,
    providerProfiles: settings.providerProfiles,
    modelRoute: settings.modelRoute,
    authorizedRoot: settings.authorizedRoot,
    petPlacementState: legacyPetPlacementState(settings.petPosition),
    fileDisclosureAccepted: settings.fileDisclosureAccepted,
    petAlwaysOnTop: settings.petAlwaysOnTop ?? false,
    privacy: settings.privacy ?? legacyPrivacySettings(),
    movementStopped: settings.movementStopped ?? false,
    mcpServers: settings.mcpServers ?? []
  });
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

/** 设置文件先按字节上限有界读取，避免超限内容进入 JSON 解析或占用无界内存。 */
async function readBoundedSettingsFile(file: string): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const metadata = await handle.stat();
    if (metadata.size > SETTINGS_FILE_MAX_BYTES) {
      throw settingsError('SETTINGS_FILE_TOO_LARGE');
    }
    const buffer = Buffer.allocUnsafe(SETTINGS_FILE_MAX_BYTES + 1);
    let totalBytes = 0;
    while (totalBytes <= SETTINGS_FILE_MAX_BYTES) {
      const { bytesRead } = await handle.read(
        buffer,
        totalBytes,
        buffer.length - totalBytes,
        null
      );
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
    }
    if (totalBytes > SETTINGS_FILE_MAX_BYTES) {
      throw settingsError('SETTINGS_FILE_TOO_LARGE');
    }
    return buffer.subarray(0, totalBytes).toString('utf8');
  } finally {
    await handle.close();
  }
}

function clonePlacement(placement: StoredPetPlacement): StoredPetPlacement {
  return Object.freeze({
    ...placement,
    footAnchorDip: Object.freeze({ ...placement.footAnchorDip })
  });
}

function cloneWindowPosition(position: PetPositionInput): Readonly<PetPositionInput> {
  return Object.freeze({ ...position });
}

function sanitizeRecoverableV3(raw: unknown): StoredSettings | null {
  if (raw && typeof raw === 'object') {
    const state = (raw as { petPlacementState?: unknown }).petPlacementState;
    if (state && typeof state === 'object') {
      const ready = state as { kind?: unknown; placements?: unknown };
      if (
        ready.kind === 'ready'
        && Array.isArray(ready.placements)
        && ready.placements.length > PET_PLACEMENT_LIMIT
      ) return null;
    }
  }
  const recoverable = recoverableStoredSettingsV3Schema.safeParse(raw);
  if (!recoverable.success) return null;
  if (recoverable.data.petPlacementState.kind === 'pending-legacy') {
    return storedSettingsV3Schema.parse({
      ...recoverable.data,
      petPlacementState: { kind: 'ready', placements: [] }
    });
  }
  const placements = new Map<string, StoredPetPlacement>();
  for (const candidate of recoverable.data.petPlacementState.placements) {
    const parsed = storedPetPlacementSchema.safeParse(candidate);
    if (!parsed.success) continue;
    // 后出现的同角色条目覆盖旧条目，清理后集合始终唯一且有界。
    placements.delete(parsed.data.characterId);
    placements.set(parsed.data.characterId, parsed.data);
    if (placements.size >= PET_PLACEMENT_LIMIT) break;
  }
  return storedSettingsV3Schema.parse({
    ...recoverable.data,
    petPlacementState: { kind: 'ready', placements: [...placements.values()] }
  });
}

type OversizedReadyPlacementRecovery = Readonly<{
  detected: boolean;
  settings: StoredSettings | null;
}>;

/** 只读取判别字段与数组长度；超限数组绝不先交给严格或 recoverable schema 深遍历。 */
function recoverOversizedReadyPlacements(raw: unknown): OversizedReadyPlacementRecovery {
  if (!raw || typeof raw !== 'object') return { detected: false, settings: null };
  const state = Reflect.get(raw, 'petPlacementState');
  if (!state || typeof state !== 'object' || Reflect.get(state, 'kind') !== 'ready') {
    return { detected: false, settings: null };
  }
  const placements = Reflect.get(state, 'placements');
  if (!Array.isArray(placements) || placements.length <= PET_PLACEMENT_LIMIT) {
    return { detected: false, settings: null };
  }
  const sanitized = storedSettingsV3Schema.safeParse({
    ...(raw as Record<string, unknown>),
    petPlacementState: { kind: 'ready', placements: [] }
  });
  return {
    detected: true,
    settings: sanitized.success ? sanitized.data : null
  };
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
      raw = JSON.parse(await readBoundedSettingsFile(this.file)) as unknown;
    } catch (error) {
      if (isMissingFile(error)) return defaultSettings();
      return this.quarantineCorruptFile();
    }
    const retiredZen = retireZenProviderSettings(raw);
    raw = retiredZen.settings;

    const oversizedReady = recoverOversizedReadyPlacements(raw);
    if (oversizedReady.detected) {
      if (!oversizedReady.settings) return this.quarantineCorruptFile();
      await atomicWrite(this.file, oversizedReady.settings);
      return oversizedReady.settings;
    }

    const v3 = storedSettingsV3Schema.safeParse(raw);
    if (v3.success) {
      if (retiredZen.changed || JSON.stringify(v3.data) !== JSON.stringify(raw)) {
        await atomicWrite(this.file, v3.data);
      }
      return v3.data;
    }

    const recoveredV3 = sanitizeRecoverableV3(raw);
    if (recoveredV3) {
      await atomicWrite(this.file, recoveredV3);
      return recoveredV3;
    }

    const v2 = storedSettingsV2Schema.safeParse(raw);
    if (v2.success) {
      const migrated = migrateV2Settings(v2.data);
      await atomicWrite(this.file, migrated);
      return migrated;
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

  async getCharacterBehaviorSettings(): Promise<CharacterBehaviorSettingsSnapshot> {
    return this.enqueue(async () => behaviorSettingsSnapshot(await this.load()));
  }

  savePrivacySettings(input: PrivacySettings): Promise<CharacterBehaviorSettingsSnapshot> {
    return this.enqueue(async () => {
      const privacy = privacySettingsSchema.parse(input);
      const settings = await this.load();
      settings.privacy = privacy;
      await atomicWrite(this.file, settings);
      return behaviorSettingsSnapshot(settings);
    });
  }

  saveMovementStopped(input: boolean): Promise<CharacterBehaviorSettingsSnapshot> {
    return this.enqueue(async () => {
      const movementStopped = z.boolean().parse(input);
      const settings = await this.load();
      settings.movementStopped = movementStopped;
      await atomicWrite(this.file, settings);
      return behaviorSettingsSnapshot(settings);
    });
  }

  async getPetAlwaysOnTop(): Promise<boolean> {
    return this.enqueue(async () => (await this.load()).petAlwaysOnTop ?? false);
  }

  savePetAlwaysOnTop(enabled: boolean): Promise<void> {
    return this.enqueueWrite(async () => {
      const settings = await this.load();
      settings.petAlwaysOnTop = z.boolean().parse(enabled);
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

  savePetPlacement(input: StoredPetPlacement): Promise<void> {
    return this.enqueueWrite(async () => {
      const placement = storedPetPlacementSchema.parse(input);
      const settings = await this.load();
      if (settings.petPlacementState.kind !== 'ready') {
        throw settingsError('PET_PLACEMENT_MIGRATION_REQUIRED');
      }
      const existing = settings.petPlacementState.placements.some(
        candidate => candidate.characterId === placement.characterId
      );
      if (!existing && settings.petPlacementState.placements.length >= PET_PLACEMENT_LIMIT) {
        throw settingsError('PET_PLACEMENT_CAPACITY_REACHED');
      }
      const placements = settings.petPlacementState.placements.filter(
        candidate => candidate.characterId !== placement.characterId
      );
      settings.petPlacementState = readyPetPlacementStateSchema.parse({
        kind: 'ready',
        placements: [...placements, placement]
      });
      await atomicWrite(this.file, settings);
    });
  }

  getPetPlacementState(characterId: string): Promise<PetPlacementStateSnapshot> {
    return this.enqueue(async () => {
      const parsedCharacterId = characterIdSchema.parse(characterId);
      const settings = await this.load();
      if (settings.petPlacementState.kind === 'pending-legacy') {
        return Object.freeze({
          kind: 'pending-legacy',
          windowPosition: cloneWindowPosition(settings.petPlacementState.windowPosition)
        });
      }
      const placement = settings.petPlacementState.placements.find(
        candidate => candidate.characterId === parsedCharacterId
      );
      return Object.freeze({
        kind: 'ready',
        placement: placement ? clonePlacement(placement) : null
      });
    });
  }

  commitPetPlacementMigration(input: unknown): Promise<void> {
    return this.enqueueWrite(async () => {
      const commit = petPlacementMigrationCommitSchema.parse(input);
      const settings = await this.load();
      if (
        settings.petPlacementState.kind !== 'pending-legacy'
        || settings.petPlacementState.windowPosition.x !== commit.expectedWindowPosition.x
        || settings.petPlacementState.windowPosition.y !== commit.expectedWindowPosition.y
      ) {
        throw settingsError('PET_PLACEMENT_MIGRATION_STALE');
      }
      settings.petPlacementState = {
        kind: 'ready',
        placements: [commit.placement]
      };
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
