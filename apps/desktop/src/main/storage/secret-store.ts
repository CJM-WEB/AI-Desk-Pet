import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface SecretEncryptionAdapter {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Promise<Buffer>;
  decryptString(value: Buffer): Promise<string>;
}

async function atomicWrite(file: string, value: Buffer): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporaryFile = `${file}.tmp`;
  const handle = await open(temporaryFile, 'w');
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryFile, file);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export class SecretStore {
  private sessionSecret: string | null = null;

  constructor(
    private readonly file: string,
    private readonly encryption: SecretEncryptionAdapter
  ) {}

  async save(secret: string, persist: boolean): Promise<void> {
    if (!persist) {
      await rm(this.file, { force: true });
      await rm(`${this.file}.tmp`, { force: true });
      this.sessionSecret = secret;
      return;
    }
    if (!this.encryption.isEncryptionAvailable()) {
      throw new Error('SECRET_STORAGE_UNAVAILABLE');
    }
    const encrypted = await this.encryption.encryptString(secret);
    await atomicWrite(this.file, encrypted);
    this.sessionSecret = null;
  }

  async readForProviderCall(): Promise<string> {
    if (this.sessionSecret !== null) return this.sessionSecret;
    if (!this.encryption.isEncryptionAvailable()) {
      throw new Error('SECRET_STORAGE_UNAVAILABLE');
    }
    try {
      return await this.encryption.decryptString(await readFile(this.file));
    } catch (error) {
      if (isMissingFile(error)) throw new Error('SECRET_NOT_FOUND');
      throw error;
    }
  }

  async hasStoredSecret(): Promise<boolean> {
    if (this.sessionSecret !== null) return true;
    try {
      await readFile(this.file);
      return true;
    } catch (error) {
      if (isMissingFile(error)) return false;
      throw error;
    }
  }

  async clear(): Promise<void> {
    this.sessionSecret = null;
    await rm(this.file, { force: true });
    await rm(`${this.file}.tmp`, { force: true });
  }
}
