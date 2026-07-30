import { readFile, rename, stat } from 'node:fs/promises';
import { z } from 'zod';
import {
  atomicWriteText,
  canonicalFilePath,
  enqueueFileOperation,
  uniqueCorruptFile
} from '../storage/atomic-file-coordinator';

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_MAX_TITLE_LENGTH = 120;
const DEFAULT_MAX_BODY_LENGTH = 4_096;
const DEFAULT_MAX_FILE_BYTES = 1_048_576;

const sessionIdSchema = z.string().min(1).max(128);
const memoryIdSchema = z.string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u);
const storedMemorySchema = z.object({
  id: memoryIdSchema,
  title: z.string().min(1),
  body: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();
const memoryFileSchema = z.object({
  version: z.literal(1),
  memories: z.array(storedMemorySchema)
}).strict();

export interface MemorySessionResolver {
  isLongTermMemoryAllowed(sessionId: string): boolean;
}

export interface MemoryEntry {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryInput {
  id: string;
  title: string;
  body: string;
}

export interface LocalMemoryStoreOptions {
  enabled?: boolean;
  maxEntries?: number;
  maxTitleLength?: number;
  maxBodyLength?: number;
  maxFileBytes?: number;
}

interface MemoryFile {
  version: 1;
  memories: MemoryEntry[];
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function cloneEntry(entry: MemoryEntry): MemoryEntry {
  return { ...entry };
}

export class LocalMemoryStore {
  private readonly file: string;
  private enabled: boolean;
  private readonly maxEntries: number;
  private readonly maxTitleLength: number;
  private readonly maxBodyLength: number;
  private readonly maxFileBytes: number;

  constructor(
    file: string,
    private readonly sessions: MemorySessionResolver,
    options: LocalMemoryStoreOptions = {}
  ) {
    this.file = canonicalFilePath(file);
    this.enabled = options.enabled ?? false;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxTitleLength = options.maxTitleLength ?? DEFAULT_MAX_TITLE_LENGTH;
    this.maxBodyLength = options.maxBodyLength ?? DEFAULT_MAX_BODY_LENGTH;
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  list(sessionId: string): Promise<MemoryEntry[]> {
    return this.enqueue(async () => {
      this.requireAccess(sessionId);
      return (await this.load()).memories.map(cloneEntry);
    });
  }

  get(sessionId: string, id: string): Promise<MemoryEntry | null> {
    return this.enqueue(async () => {
      this.requireAccess(sessionId);
      const parsedId = this.parseId(id);
      const entry = (await this.load()).memories.find(memory => memory.id === parsedId);
      return entry === undefined ? null : cloneEntry(entry);
    });
  }

  upsert(sessionId: string, input: MemoryInput): Promise<MemoryEntry> {
    return this.enqueue(async () => {
      this.requireAccess(sessionId);
      const parsed = this.parseInput(input);
      const memoryFile = await this.load();
      const existingIndex = memoryFile.memories.findIndex(memory => memory.id === parsed.id);
      if (existingIndex < 0 && memoryFile.memories.length >= this.maxEntries) {
        throw new Error('MEMORY_LIMIT_EXCEEDED');
      }

      const now = new Date().toISOString();
      const next: MemoryEntry = {
        ...parsed,
        createdAt: existingIndex < 0
          ? now
          : memoryFile.memories[existingIndex]!.createdAt,
        updatedAt: now
      };
      if (existingIndex < 0) {
        memoryFile.memories.push(next);
      } else {
        memoryFile.memories[existingIndex] = next;
      }
      await this.write(memoryFile);
      return cloneEntry(next);
    });
  }

  delete(sessionId: string, id: string): Promise<boolean> {
    return this.enqueue(async () => {
      this.requireAccess(sessionId);
      const parsedId = this.parseId(id);
      const memoryFile = await this.load();
      const nextMemories = memoryFile.memories.filter(memory => memory.id !== parsedId);
      if (nextMemories.length === memoryFile.memories.length) return false;
      await this.write({ version: 1, memories: nextMemories });
      return true;
    });
  }

  clear(sessionId: string): Promise<void> {
    return this.enqueue(async () => {
      this.requireAccess(sessionId);
      await this.write({ version: 1, memories: [] });
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    return enqueueFileOperation(this.file, async () => {
      try {
        return await operation();
      } catch (error) {
        if (
          error instanceof Error
          && /^MEMORY_[A-Z_]+$/u.test(error.message)
        ) {
          throw error;
        }
        throw new Error('MEMORY_STORAGE_FAILED');
      }
    });
  }

  private requireAccess(sessionIdInput: string): void {
    if (!this.enabled) throw new Error('MEMORY_DISABLED');
    const sessionId = sessionIdSchema.safeParse(sessionIdInput);
    if (!sessionId.success) throw new Error('MEMORY_SESSION_NOT_ALLOWED');
    try {
      if (!this.sessions.isLongTermMemoryAllowed(sessionId.data)) {
        throw new Error('MEMORY_SESSION_NOT_ALLOWED');
      }
    } catch {
      throw new Error('MEMORY_SESSION_NOT_ALLOWED');
    }
  }

  private parseId(id: string): string {
    const parsed = memoryIdSchema.safeParse(id);
    if (!parsed.success) throw new Error('MEMORY_INPUT_INVALID');
    return parsed.data;
  }

  private parseInput(input: MemoryInput): MemoryInput {
    const schema = z.object({
      id: memoryIdSchema,
      title: z.string().min(1).max(this.maxTitleLength),
      body: z.string().min(1).max(this.maxBodyLength)
    }).strict();
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw new Error('MEMORY_INPUT_INVALID');
    return parsed.data;
  }

  private async load(): Promise<MemoryFile> {
    try {
      const fileStats = await stat(this.file);
      if (fileStats.size > this.maxFileBytes) return this.quarantineCorruptFile();
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as unknown;
      const parsed = memoryFileSchema.safeParse(raw);
      if (!parsed.success) return this.quarantineCorruptFile();
      if (parsed.data.memories.length > this.maxEntries) {
        return this.quarantineCorruptFile();
      }
      if (
        new Set(parsed.data.memories.map(memory => memory.id)).size
        !== parsed.data.memories.length
      ) {
        return this.quarantineCorruptFile();
      }
      if (parsed.data.memories.some(memory =>
        memory.title.length > this.maxTitleLength
        || memory.body.length > this.maxBodyLength
      )) {
        return this.quarantineCorruptFile();
      }
      return {
        version: 1,
        memories: parsed.data.memories.map(cloneEntry)
      };
    } catch (error) {
      if (isMissingFile(error)) return { version: 1, memories: [] };
      return this.quarantineCorruptFile();
    }
  }

  private async quarantineCorruptFile(): Promise<MemoryFile> {
    try {
      await rename(this.file, uniqueCorruptFile(this.file));
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    return { version: 1, memories: [] };
  }

  private async write(memoryFile: MemoryFile): Promise<void> {
    const content = `${JSON.stringify(memoryFile, null, 2)}\n`;
    if (Buffer.byteLength(content, 'utf8') > this.maxFileBytes) {
      throw new Error('MEMORY_LIMIT_EXCEEDED');
    }
    await atomicWriteText(this.file, content);
  }
}
