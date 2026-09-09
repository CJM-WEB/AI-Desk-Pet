import { mkdir, open, rename, rm } from 'node:fs/promises';
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
import type { LocalModelSettings } from '../../shared/local-model-ipc';
import {
  DEFAULT_WORKSHOP_LAYOUT,
  workshopLayoutSettingsSchema,
  type WorkshopLayoutSettings
} from '../../shared/workshop-layout-ipc';

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
    memory: z.boolean()
  }).strict(),
  longTermMemory: z.boolean(),
  autonomousMoodEnabled: z.boolean().default(true),
  proactivityMode: z.enum(['passive', 'assistive', 'autonomous'])
}).strict();
export type PrivacySettings = z.infer<typeof privacySettingsSchema>;

/** 仅用于读取旧设置；文件披露 Gate 已退役，迁移后绝不再持久化。 */
const legacyPrivacySettingsSchema = z.object({
  dataCategories: z.object({
    file: z.boolean(),
    memory: z.boolean()
  }).strict(),
  longTermMemory: z.boolean(),
  proactivityMode: z.enum(['passive', 'assistive', 'autonomous'])
}).strict();

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
  privacy: legacyPrivacySettingsSchema.optional(),
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
  privacy: legacyPrivacySettingsSchema,
  movementStopped: z.boolean(),
  mcpServers: z.array(mcpServerSettingsSchema)
};

const storedSettingsV3Schema = z.object(storedSettingsV3Shape).strict();

const localModelSettingsSchema = z.object({
  enabled: z.boolean()
}).strict();

const storedSettingsV4Shape = {
  ...storedSettingsV3Shape,
  version: z.literal(4),
  localModel: localModelSettingsSchema
};

const storedSettingsV4Schema = z.object(storedSettingsV4Shape).strict();
const storedSettingsV5Shape = {
  ...storedSettingsV4Shape,
  version: z.literal(5),
  movementStopped: z.never().optional(),
  movementMode: z.union([z.literal(0), z.literal(1), z.literal(2)])
};

const storedSettingsV5Schema = z.object(storedSettingsV5Shape).strict();
const { fileDisclosureAccepted: _legacyFileDisclosureAccepted, ...storedSettingsV5WithoutDisclosure } = storedSettingsV5Shape;
const storedSettingsV6Shape = {
  ...storedSettingsV5WithoutDisclosure,
  version: z.literal(6),
  privacy: privacySettingsSchema,
  workshopLayout: workshopLayoutSettingsSchema.default(DEFAULT_WORKSHOP_LAYOUT)
};
const storedSettingsV6Schema = z.object(storedSettingsV6Shape).strict();

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

const recoverableStoredSettingsV5Schema = z.object({
  ...storedSettingsV5Shape,
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

const recoverableStoredSettingsV6Schema = z.object({
  ...storedSettingsV6Shape,
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

const recoverableStoredSettingsV4Schema = z.object({
  ...storedSettingsV4Shape,
  petPlacementState: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('pending-legacy'), windowPosition: z.unknown() }).strict(),
    z.object({ kind: z.literal('ready'), placements: z.array(z.unknown()) }).strict()
  ])
}).strict();

type ProviderMetadataInput = z.input<typeof providerMetadataSchema> & Record<string, unknown>;
type AuthorizedRootInput = z.input<typeof authorizedRootSchema>;
type PetPositionInput = z.input<typeof petPositionSchema>;
type StoredSettingsV1 = z.infer<typeof storedSettingsV1Schema>;
type StoredSettingsV2 = z.infer<typeof storedSettingsV2Schema>;
type StoredSettingsV3 = z.infer<typeof storedSettingsV3Schema>;
type StoredSettings = z.infer<typeof storedSettingsV6Schema>;

export interface ProviderSettingsSnapshot {
  profiles: ProviderProfileV2[];
  route: ModelRouteConfig;
}

export type CharacterBehaviorSettingsSnapshot = Readonly<{
  movementMode: CharacterMovementMode;
  proactivityMode: PrivacySettings['proactivityMode'];
}>;

/** 0 持续静止、1 持续运动、2 每轮等待 10–30 秒后自主活动。 */
export type CharacterMovementMode = 0 | 1 | 2;

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
    version: 6,
    providerProfiles: [],
    modelRoute: emptyModelRoute(),
    authorizedRoot: null,
    petPlacementState: { kind: 'ready', placements: [] },
    petAlwaysOnTop: false,
    privacy: defaultPrivacySettings(),
    movementMode: 2,
    mcpServers: [],
    localModel: { enabled: true },
    workshopLayout: DEFAULT_WORKSHOP_LAYOUT
  };
}

function defaultPrivacySettings(): PrivacySettings {
  return {
    dataCategories: {
      memory: false
    },
    longTermMemory: false,
    autonomousMoodEnabled: true,
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

/** 历史占位从未接入采集运行时；严格解析前只移除两个退役键并保留其余隐私选择。 */
function retireUnusedPrivacyPlaceholders(raw: unknown): { changed: boolean; settings: unknown } {
  if (!isRecord(raw) || !isRecord(raw.privacy) || !isRecord(raw.privacy.dataCategories)) {
    return { changed: false, settings: raw };
  }
  const categories = raw.privacy.dataCategories;
  const changed = Object.hasOwn(categories, 'screenshot') || Object.hasOwn(categories, 'clipboard');
  if (!changed) return { changed: false, settings: raw };
  const { screenshot: _screenshot, clipboard: _clipboard, ...retainedCategories } = categories;
  return {
    changed: true,
    settings: {
      ...raw,
      privacy: {
        ...raw.privacy,
        dataCategories: retainedCategories
      }
    }
  };
}

function legacyPrivacySettings(): PrivacySettings {
  return {
    ...defaultPrivacySettings(),
    proactivityMode: 'assistive'
  };
}

function migratePrivacySettings(settings: z.infer<typeof legacyPrivacySettingsSchema>): PrivacySettings {
  return privacySettingsSchema.parse({
    ...settings,
    dataCategories: { memory: settings.dataCategories.memory }
  });
}

function behaviorSettingsSnapshot(settings: StoredSettings): CharacterBehaviorSettingsSnapshot {
  return Object.freeze({
    movementMode: settings.movementMode,
    proactivityMode: (settings.privacy ?? legacyPrivacySettings()).proactivityMode
  });
}

function migrateV1Settings(settings: StoredSettingsV1): StoredSettings {
  if (settings.provider === null) {
    return {
      ...defaultSettings(),
      authorizedRoot: settings.authorizedRoot,
      petPlacementState: legacyPetPlacementState(settings.petPosition),
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
    ...defaultSettings(),
    providerProfiles: [profile],
    modelRoute: {
      ...emptyModelRoute(),
      primaryProfileId: profile.id
    },
    authorizedRoot: settings.authorizedRoot,
    petPlacementState: legacyPetPlacementState(settings.petPosition),
    petAlwaysOnTop: false,
    privacy: legacyPrivacySettings(),
    movementMode: 2,
    mcpServers: []
  };
}

function legacyPetPlacementState(position: PetPositionInput | null): StoredSettings['petPlacementState'] {
  return position === null
    ? { kind: 'ready', placements: [] }
    : { kind: 'pending-legacy', windowPosition: petPositionSchema.parse(position) };
}

function migrateV2Settings(settings: StoredSettingsV2): StoredSettings {
  return storedSettingsV6Schema.parse({
    ...defaultSettings(),
    providerProfiles: settings.providerProfiles,
    modelRoute: settings.modelRoute,
    authorizedRoot: settings.authorizedRoot,
    petPlacementState: legacyPetPlacementState(settings.petPosition),
    petAlwaysOnTop: settings.petAlwaysOnTop ?? false,
    privacy: settings.privacy ? migratePrivacySettings(settings.privacy) : legacyPrivacySettings(),
    movementMode: settings.movementStopped === true ? 0 : 2,
    mcpServers: settings.mcpServers ?? []
  });
}

function migrateV3Settings(settings: StoredSettingsV3): StoredSettings {
  const { movementStopped } = settings;
  return storedSettingsV6Schema.parse({
    ...defaultSettings(),
    providerProfiles: settings.providerProfiles,
    modelRoute: settings.modelRoute,
    authorizedRoot: settings.authorizedRoot,
    petPlacementState: settings.petPlacementState,
    petAlwaysOnTop: settings.petAlwaysOnTop,
    privacy: migratePrivacySettings(settings.privacy),
    movementMode: movementStopped ? 0 : 2,
    mcpServers: settings.mcpServers
  });
}

function migrateV4Settings(
  settings: z.infer<typeof storedSettingsV4Schema>
): StoredSettings {
  const { movementStopped } = settings;
  return storedSettingsV6Schema.parse({
    ...defaultSettings(),
    providerProfiles: settings.providerProfiles,
    modelRoute: settings.modelRoute,
    authorizedRoot: settings.authorizedRoot,
    petPlacementState: settings.petPlacementState,
    petAlwaysOnTop: settings.petAlwaysOnTop,
    privacy: migratePrivacySettings(settings.privacy),
    movementMode: movementStopped ? 0 : 2,
    mcpServers: settings.mcpServers,
    localModel: settings.localModel
  });
}

function migrateV5Settings(settings: z.infer<typeof storedSettingsV5Schema>): StoredSettings {
  return storedSettingsV6Schema.parse({
    ...defaultSettings(),
    providerProfiles: settings.providerProfiles,
    modelRoute: settings.modelRoute,
    authorizedRoot: settings.authorizedRoot,
    petPlacementState: settings.petPlacementState,
    petAlwaysOnTop: settings.petAlwaysOnTop,
    privacy: migratePrivacySettings(settings.privacy),
    movementMode: settings.movementMode,
    mcpServers: settings.mcpServers,
    localModel: settings.localModel
  });
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function atomicWrite(file: string, value: StoredSettings): Promise<void>;
function atomicWrite(
  file: string,
  value: StoredSettings,
  canCommit: () => boolean
): Promise<boolean>;
async function atomicWrite(
  file: string,
  value: StoredSettings,
  canCommit?: () => boolean
): Promise<void | boolean> {
  await mkdir(dirname(file), { recursive: true });
  const temporaryFile = `${file}.tmp`;
  const handle = await open(temporaryFile, 'w');
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  // 临时文件完成落盘后再复核轮次所有权，旧轮不得通过 rename 覆盖正式设置。
  if (canCommit !== undefined && !canCommit()) {
    await rm(temporaryFile, { force: true });
    return false;
  }
  await rename(temporaryFile, file);
  return canCommit === undefined ? undefined : true;
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

function sanitizeRecoverableV3(raw: unknown): StoredSettingsV3 | null {
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
  const candidate = {
    ...(raw as Record<string, unknown>),
    petPlacementState: { kind: 'ready', placements: [] }
  };
  const current = storedSettingsV6Schema.safeParse(candidate);
  if (current.success) {
    return { detected: true, settings: current.data };
  }
  const v5 = storedSettingsV5Schema.safeParse(candidate);
  if (v5.success) {
    return { detected: true, settings: migrateV5Settings(v5.data) };
  }
  const v4 = storedSettingsV4Schema.safeParse(candidate);
  if (v4.success) {
    return { detected: true, settings: migrateV4Settings(v4.data) };
  }
  const legacy = storedSettingsV3Schema.safeParse(candidate);
  return {
    detected: true,
    settings: legacy.success ? migrateV3Settings(legacy.data) : null
  };
}

type RecoverablePetPlacementState = Readonly<{
  kind: 'pending-legacy';
  windowPosition?: unknown;
}> | Readonly<{
  kind: 'ready';
  placements: unknown[];
}>;

/** 单条 placement 损坏只影响其自身；其余已严格验证的设置必须保留。 */
function sanitizeRecoverablePetPlacementState(
  state: RecoverablePetPlacementState
): Readonly<{ kind: 'ready'; placements: StoredPetPlacement[] }> | null {
  if (state.kind === 'pending-legacy') return { kind: 'ready', placements: [] };
  if (state.placements.length > PET_PLACEMENT_LIMIT) return null;
  const placements = new Map<string, StoredPetPlacement>();
  for (const candidate of state.placements) {
    const parsed = storedPetPlacementSchema.safeParse(candidate);
    if (!parsed.success) continue;
    placements.delete(parsed.data.characterId);
    placements.set(parsed.data.characterId, parsed.data);
    if (placements.size >= PET_PLACEMENT_LIMIT) break;
  }
  return { kind: 'ready', placements: [...placements.values()] };
}

function sanitizeRecoverableV5(raw: unknown): StoredSettings | null {
  const recoverable = recoverableStoredSettingsV5Schema.safeParse(raw);
  if (!recoverable.success) return null;
  const petPlacementState = sanitizeRecoverablePetPlacementState(recoverable.data.petPlacementState);
  if (!petPlacementState) return null;
  return migrateV5Settings(storedSettingsV5Schema.parse({
    ...recoverable.data,
    petPlacementState
  }));
}

function sanitizeRecoverableV6(raw: unknown): StoredSettings | null {
  const recoverable = recoverableStoredSettingsV6Schema.safeParse(raw);
  if (!recoverable.success) return null;
  const petPlacementState = sanitizeRecoverablePetPlacementState(recoverable.data.petPlacementState);
  if (!petPlacementState) return null;
  return storedSettingsV6Schema.parse({ ...recoverable.data, petPlacementState });
}

function sanitizeRecoverableV4(raw: unknown): StoredSettings | null {
  const recoverable = recoverableStoredSettingsV4Schema.safeParse(raw);
  if (!recoverable.success) return null;
  const placement = recoverable.data.petPlacementState;
  const placements = new Map<string, StoredPetPlacement>();
  if (placement.kind === 'ready') {
    if (placement.placements.length > PET_PLACEMENT_LIMIT) return null;
    for (const candidate of placement.placements) {
      const parsed = storedPetPlacementSchema.safeParse(candidate);
      if (!parsed.success) continue;
      placements.delete(parsed.data.characterId);
      placements.set(parsed.data.characterId, parsed.data);
      if (placements.size >= PET_PLACEMENT_LIMIT) break;
    }
  }
  return migrateV4Settings(storedSettingsV4Schema.parse({
    ...recoverable.data,
    petPlacementState: placement.kind === 'pending-legacy'
      ? { kind: 'ready', placements: [] }
      : { kind: 'ready', placements: [...placements.values()] }
  }));
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
    const retiredPrivacy = retireUnusedPrivacyPlaceholders(raw);
    raw = retiredPrivacy.settings;

    const oversizedReady = recoverOversizedReadyPlacements(raw);
    if (oversizedReady.detected) {
      if (!oversizedReady.settings) return this.quarantineCorruptFile();
      await atomicWrite(this.file, oversizedReady.settings);
      return oversizedReady.settings;
    }

    const v6 = storedSettingsV6Schema.safeParse(raw);
    if (v6.success) {
      if (retiredZen.changed || retiredPrivacy.changed || JSON.stringify(v6.data) !== JSON.stringify(raw)) {
        await atomicWrite(this.file, v6.data);
      }
      return v6.data;
    }

    const v5 = storedSettingsV5Schema.safeParse(raw);
    if (v5.success) {
      const migrated = migrateV5Settings(v5.data);
      await atomicWrite(this.file, migrated);
      return migrated;
    }

    const v4 = storedSettingsV4Schema.safeParse(raw);
    if (v4.success) {
      const migrated = migrateV4Settings(v4.data);
      await atomicWrite(this.file, migrated);
      return migrated;
    }

    const recoveredV6 = sanitizeRecoverableV6(raw);
    if (recoveredV6) {
      await atomicWrite(this.file, recoveredV6);
      return recoveredV6;
    }

    const recoveredV5 = sanitizeRecoverableV5(raw);
    if (recoveredV5) {
      await atomicWrite(this.file, recoveredV5);
      return recoveredV5;
    }

    const recoveredV4 = sanitizeRecoverableV4(raw);
    if (recoveredV4) {
      await atomicWrite(this.file, recoveredV4);
      return recoveredV4;
    }

    const v3 = storedSettingsV3Schema.safeParse(raw);
    if (v3.success) {
      const migrated = migrateV3Settings(v3.data);
      await atomicWrite(this.file, migrated);
      return migrated;
    }

    const recoveredV3 = sanitizeRecoverableV3(raw);
    if (recoveredV3) {
      const migrated = migrateV3Settings(recoveredV3);
      await atomicWrite(this.file, migrated);
      return migrated;
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

  async getLocalModelSettings(): Promise<LocalModelSettings> {
    return this.enqueue(async () => structuredClone((await this.load()).localModel));
  }

  async getWorkshopLayout(): Promise<WorkshopLayoutSettings> {
    return this.enqueue(async () => structuredClone((await this.load()).workshopLayout));
  }

  saveLocalModelEnabled(enabled: boolean): Promise<void> {
    return this.enqueueWrite(async () => {
      const settings = await this.load();
      settings.localModel.enabled = z.boolean().parse(enabled);
      await atomicWrite(this.file, settings);
    });
  }

  saveWorkshopLayout(input: WorkshopLayoutSettings): Promise<WorkshopLayoutSettings> {
    return this.enqueue(async () => {
      const layout = workshopLayoutSettingsSchema.parse(input);
      const settings = await this.load();
      settings.workshopLayout = layout;
      await atomicWrite(this.file, settings);
      return structuredClone(layout);
    });
  }

  savePrivacySettings(input: z.input<typeof privacySettingsSchema>): Promise<CharacterBehaviorSettingsSnapshot> {
    return this.enqueue(async () => {
      const privacy = privacySettingsSchema.parse(input);
      const settings = await this.load();
      settings.privacy = privacy;
      await atomicWrite(this.file, settings);
      return behaviorSettingsSnapshot(settings);
    });
  }

  saveMovementMode(
    input: CharacterMovementMode,
    isCurrent: () => boolean = () => true
  ): Promise<CharacterBehaviorSettingsSnapshot | null> {
    return this.enqueue(async () => {
      const movementMode = z.union([z.literal(0), z.literal(1), z.literal(2)]).parse(input);
      if (!isCurrent()) return null;
      const settings = await this.load();
      if (!isCurrent()) return null;
      settings.movementMode = movementMode;
      if (!await atomicWrite(this.file, settings, isCurrent)) return null;
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
        }
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
