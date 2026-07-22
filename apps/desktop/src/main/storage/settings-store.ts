import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { PublicSettings } from '@myself/shared-types';

const providerMetadataSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  baseUrl: z.string().url(),
  model: z.string().min(1)
});

const authorizedRootSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  pathHint: z.string().min(1),
  absolutePath: z.string().min(1)
});

const petPositionSchema = z.object({
  x: z.number(),
  y: z.number()
});

const storedSettingsSchema = z.object({
  version: z.literal(1),
  provider: providerMetadataSchema.nullable(),
  authorizedRoot: authorizedRootSchema.nullable(),
  petPosition: petPositionSchema.nullable(),
  fileDisclosureAccepted: z.boolean()
}).strict();

type ProviderMetadataInput = z.input<typeof providerMetadataSchema> & Record<string, unknown>;
type AuthorizedRootInput = z.input<typeof authorizedRootSchema>;
type PetPositionInput = z.input<typeof petPositionSchema>;
type StoredSettings = z.infer<typeof storedSettingsSchema>;

function defaultSettings(): StoredSettings {
  return {
    version: 1,
    provider: null,
    authorizedRoot: null,
    petPosition: null,
    fileDisclosureAccepted: false
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

  private enqueueWrite(operation: () => Promise<void>): Promise<void> {
    const transaction = this.writeQueue.then(operation);
    this.writeQueue = transaction.catch(() => {});
    return transaction;
  }

  private async load(): Promise<StoredSettings> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as unknown;
      const result = storedSettingsSchema.safeParse(raw);
      if (result.success) return result.data;
    } catch (error) {
      if (isMissingFile(error)) return defaultSettings();
    }

    await rename(this.file, `${this.file}.corrupt-${Date.now()}`);
    return defaultSettings();
  }

  async getPublic(): Promise<PublicSettings> {
    await this.writeQueue;
    const settings = await this.load();
    return {
      version: 1,
      provider: settings.provider === null ? null : {
        ...settings.provider,
        hasStoredSecret: await this.hasStoredSecret()
      },
      authorizedRoot: settings.authorizedRoot === null ? null : {
        id: settings.authorizedRoot.id,
        displayName: settings.authorizedRoot.displayName,
        pathHint: settings.authorizedRoot.pathHint
      },
      petPosition: settings.petPosition,
      fileDisclosureAccepted: settings.fileDisclosureAccepted
    };
  }

  saveProviderMetadata(input: ProviderMetadataInput): Promise<void> {
    return this.enqueueWrite(async () => {
      const settings = await this.load();
      settings.provider = providerMetadataSchema.parse(input);
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
    await this.writeQueue;
    return (await this.load()).authorizedRoot?.absolutePath ?? null;
  }

  clearAll(): Promise<void> {
    return this.enqueueWrite(() => atomicWrite(this.file, defaultSettings()));
  }
}
