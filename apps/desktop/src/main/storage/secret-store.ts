import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface SecretEncryptionAdapter {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Promise<Buffer>;
  decryptString(value: Buffer): Promise<string>;
}

export type SecretSnapshot =
  | { kind: 'missing' }
  | { kind: 'session'; value: string }
  | { kind: 'persisted'; encrypted: Buffer }
  | { kind: 'legacy'; encrypted: Buffer };

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

function validateProfileId(profileId: string): string {
  if (typeof profileId !== 'string' || profileId.trim().length === 0) {
    throw new Error('INVALID_PROFILE_ID');
  }
  return profileId;
}

export class SecretStore {
  private readonly sessionSecrets = new Map<string, string>();
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly encryption: SecretEncryptionAdapter
  ) {}

  async save(profileId: string, secret: string, persist: boolean): Promise<void> {
    validateProfileId(profileId);
    await this.enqueue(async () => {
      if (!persist) {
        await this.removeSlot(profileId);
        this.sessionSecrets.set(profileId, secret);
        if (profileId === 'default') await this.removeLegacyFile();
        return;
      }
      if (!this.encryption.isEncryptionAvailable()) {
        throw new Error('SECRET_STORAGE_UNAVAILABLE');
      }
      const encrypted = await this.encryption.encryptString(secret);
      await atomicWrite(this.slotFile(profileId), encrypted);
      this.sessionSecrets.delete(profileId);
      if (profileId === 'default') await this.removeLegacyFile();
    });
  }

  async readForProviderCall(profileId = 'default'): Promise<string> {
    validateProfileId(profileId);
    return this.enqueue(async () => {
      const sessionSecret = this.sessionSecrets.get(profileId);
      if (sessionSecret !== undefined) return sessionSecret;
      if (!this.encryption.isEncryptionAvailable()) {
        throw new Error('SECRET_STORAGE_UNAVAILABLE');
      }
      try {
        return await this.encryption.decryptString(await readFile(this.slotFile(profileId)));
      } catch (error) {
        if (!isMissingFile(error) || profileId !== 'default') {
          if (isMissingFile(error)) throw new Error('SECRET_NOT_FOUND');
          throw error;
        }
      }

      return this.readAndMigrateLegacyDefault();
    });
  }

  async hasStoredSecret(profileId = 'default'): Promise<boolean> {
    validateProfileId(profileId);
    if (this.sessionSecrets.has(profileId)) return true;
    if (await this.fileExists(this.slotFile(profileId))) return true;
    return profileId === 'default' && this.fileExists(this.file);
  }

  async clear(profileId = 'default'): Promise<void> {
    validateProfileId(profileId);
    await this.enqueue(async () => {
      this.sessionSecrets.delete(profileId);
      await this.removeSlot(profileId);
      if (profileId === 'default') await this.removeLegacyFile();
    });
  }

  async clearAll(): Promise<void> {
    await this.enqueue(async () => {
      this.sessionSecrets.clear();
      await rm(this.profilesDirectory, { recursive: true, force: true });
      await this.removeLegacyFile();
    });
  }

  async snapshot(profileId: string): Promise<SecretSnapshot> {
    validateProfileId(profileId);
    return this.enqueue(async () => {
      const sessionSecret = this.sessionSecrets.get(profileId);
      if (sessionSecret !== undefined) {
        return { kind: 'session', value: sessionSecret };
      }
      try {
        return {
          kind: 'persisted',
          encrypted: Buffer.from(await readFile(this.slotFile(profileId)))
        };
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }
      if (profileId === 'default') {
        try {
          return {
            kind: 'legacy',
            encrypted: Buffer.from(await readFile(this.file))
          };
        } catch (error) {
          if (!isMissingFile(error)) throw error;
        }
      }
      return { kind: 'missing' };
    });
  }

  async restore(profileId: string, snapshot: SecretSnapshot): Promise<void> {
    validateProfileId(profileId);
    await this.enqueue(async () => {
      this.sessionSecrets.delete(profileId);
      await this.removeSlot(profileId);
      if (profileId === 'default') await this.removeLegacyFile();

      if (snapshot.kind === 'session') {
        this.sessionSecrets.set(profileId, snapshot.value);
      } else if (snapshot.kind === 'persisted') {
        await atomicWrite(this.slotFile(profileId), Buffer.from(snapshot.encrypted));
      } else if (snapshot.kind === 'legacy') {
        await atomicWrite(this.file, Buffer.from(snapshot.encrypted));
      }
    });
  }

  private get profilesDirectory(): string {
    return `${this.file}.profiles`;
  }

  private slotFile(profileId: string): string {
    const digest = createHash('sha256').update(profileId).digest('hex');
    return join(this.profilesDirectory, `${digest}.bin`);
  }

  private async readAndMigrateLegacyDefault(): Promise<string> {
    let encrypted: Buffer;
    try {
      encrypted = await readFile(this.file);
    } catch (error) {
      if (isMissingFile(error)) throw new Error('SECRET_NOT_FOUND');
      throw error;
    }

    // 迁移始终移动密文字节；失败时保留旧文件并直接解密供本次调用使用。
    try {
      await mkdir(this.profilesDirectory, { recursive: true });
      await rename(this.file, this.slotFile('default'));
    } catch {
      return this.encryption.decryptString(encrypted);
    }
    return this.encryption.decryptString(encrypted);
  }

  private async removeSlot(profileId: string): Promise<void> {
    const file = this.slotFile(profileId);
    await rm(file, { force: true });
    await rm(`${file}.tmp`, { force: true });
  }

  private async removeLegacyFile(): Promise<void> {
    await rm(this.file, { force: true });
    await rm(`${this.file}.tmp`, { force: true });
  }

  private async fileExists(file: string): Promise<boolean> {
    try {
      await readFile(file);
      return true;
    } catch (error) {
      if (isMissingFile(error)) return false;
      throw error;
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationQueue.then(operation, operation);
    this.operationQueue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
}
