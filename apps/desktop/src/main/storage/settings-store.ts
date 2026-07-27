import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  modelRouteConfigSchema,
  providerCatalog,
  storedProviderProfileV2Schema,
  type ModelRouteConfig,
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
  fileDisclosureAccepted: z.boolean()
}).strict();

type ProviderMetadataInput = z.input<typeof providerMetadataSchema> & Record<string, unknown>;
type AuthorizedRootInput = z.input<typeof authorizedRootSchema>;
type PetPositionInput = z.input<typeof petPositionSchema>;
type StoredSettingsV1 = z.infer<typeof storedSettingsV1Schema>;
type StoredSettings = z.infer<typeof storedSettingsV2Schema>;

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
    fileDisclosureAccepted: false
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
    fileDisclosureAccepted: settings.fileDisclosureAccepted
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

export class SettingsStore {
  private writeQueue = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly hasStoredSecret: () => Promise<boolean>
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
    if (v2.success) return v2.data;

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
      hasStoredSecret: await this.hasStoredSecret()
    };
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
