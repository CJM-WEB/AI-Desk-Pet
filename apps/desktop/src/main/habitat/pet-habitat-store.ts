import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  atomicWriteText,
  enqueueFileOperation,
  uniqueCorruptFile
} from '../storage/atomic-file-coordinator';

const MAX_STORE_BYTES = 64 * 1024;
export const MAX_HABITAT_PUBLIC_NAME_CODE_POINTS = 80;

export function normalizeHabitatPublicName(value: string): string {
  return value.normalize('NFKC').trim();
}

export function isValidHabitatPublicName(value: string): boolean {
  const length = Array.from(normalizeHabitatPublicName(value)).length;
  return length >= 1 && length <= MAX_HABITAT_PUBLIC_NAME_CODE_POINTS;
}

export function isValidHabitatPathHint(value: string): boolean {
  const normalized = normalizeHabitatPublicName(value);
  return isValidHabitatPublicName(normalized)
    && normalized !== '.'
    && normalized !== '..'
    && !/[\\/:]/u.test(normalized);
}

const safeIdentifierSchema = z.string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u);
const boundedTextSchema = z.string()
  .transform(normalizeHabitatPublicName)
  .pipe(
    z.string()
      .min(1)
      .refine(
        isValidHabitatPublicName,
        '公开名称超过 80 个 Unicode 码点'
      )
  );
const pathHintSchema = boundedTextSchema.refine(
  isValidHabitatPathHint,
  '目录提示必须是单一末级显示名'
);
const coordinateSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite()
}).strict();
const directoryIdentitySchema = z.object({
  dev: z.number().finite().int().nonnegative(),
  ino: z.number().finite().int().nonnegative()
}).strict();

export const habitatDirectoryRecordSchema = z.object({
  id: safeIdentifierSchema,
  displayName: boundedTextSchema,
  pathHint: pathHintSchema,
  absolutePath: z.string().min(1).max(32_768),
  identity: directoryIdentitySchema,
  enabled: z.boolean()
}).strict();
export type HabitatDirectoryRecord = z.infer<typeof habitatDirectoryRecordSchema>;

const habitatPreferencesSchema = z.object({
  autoHideEnabled: z.boolean(),
  idleDelayMs: z.number().finite().int().min(1_000).max(86_400_000)
}).strict();

const habitatLocationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('desktop'),
    position: coordinateSchema.nullable()
  }).strict(),
  z.object({
    kind: z.literal('folder'),
    directoryId: safeIdentifierSchema,
    enteredAt: z.string().datetime({ offset: true }),
    previousDesktopPosition: coordinateSchema,
    localOffset: coordinateSchema
  }).strict()
]);

export const petHabitatSnapshotSchema = z.object({
  version: z.literal(1),
  preferences: habitatPreferencesSchema,
  directories: z.array(habitatDirectoryRecordSchema).max(128),
  location: habitatLocationSchema
}).strict().superRefine((snapshot, context) => {
  const ids = new Set<string>();
  for (const directory of snapshot.directories) {
    if (ids.has(directory.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: '目录标识重复',
        path: ['directories']
      });
    }
    ids.add(directory.id);
  }
  if (snapshot.location.kind === 'folder' && !ids.has(snapshot.location.directoryId)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: '当前位置引用了未知目录',
      path: ['location', 'directoryId']
    });
  }
});
export type PetHabitatSnapshot = z.infer<typeof petHabitatSnapshotSchema>;

export type HabitatDirectoryAvailability = 'available' | 'unavailable';

export interface RendererHabitatSnapshot {
  autoHideEnabled: boolean;
  idleDelayMs: number;
  directories: Array<{
    id: string;
    displayName: string;
    pathHint: string;
    enabled: boolean;
    availability: HabitatDirectoryAvailability;
  }>;
  location: { kind: 'desktop' } | { kind: 'folder'; directoryId: string };
}

export const DEFAULT_HABITAT_SNAPSHOT: PetHabitatSnapshot = {
  version: 1,
  preferences: {
    autoHideEnabled: false,
    idleDelayMs: 30_000
  },
  directories: [],
  location: {
    kind: 'desktop',
    position: null
  }
};

interface ParentIdentity {
  physicalPath: string;
  dev: number;
  ino: number;
}

interface FileIdentity {
  dev: number;
  ino: number;
}

export type HabitatStoreCheckpoint = 'before-commit';

export interface PetHabitatStoreDependencies {
  writeText?: typeof atomicWriteText;
  onCheckpoint?: (checkpoint: HabitatStoreCheckpoint) => Promise<void>;
}

function cloneSnapshot(snapshot: PetHabitatSnapshot): PetHabitatSnapshot {
  return structuredClone(snapshot);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isKnownHabitatError(error: unknown): error is Error {
  return error instanceof Error && /^HABITAT_(?:STORAGE_FAILED|STORAGE_CHANGED)$/u.test(error.message);
}

function isStorageNamespaceChanged(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false;
  return error.code === 'ENOENT' || error.code === 'ENOTDIR';
}

function sameParent(left: ParentIdentity, right: ParentIdentity): boolean {
  const leftPath = process.platform === 'win32'
    ? left.physicalPath.toLocaleLowerCase('en-US')
    : left.physicalPath;
  const rightPath = process.platform === 'win32'
    ? right.physicalPath.toLocaleLowerCase('en-US')
    : right.physicalPath;
  return leftPath === rightPath && left.dev === right.dev && left.ino === right.ino;
}

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * 生成 Renderer 可见快照时只保留不可逆提示与不透明目录标识。
 */
export function projectHabitatSnapshot(
  snapshot: PetHabitatSnapshot,
  availabilityById: ReadonlyMap<string, HabitatDirectoryAvailability> = new Map()
): RendererHabitatSnapshot {
  const parsed = petHabitatSnapshotSchema.parse(snapshot);
  return {
    autoHideEnabled: parsed.preferences.autoHideEnabled,
    idleDelayMs: parsed.preferences.idleDelayMs,
    directories: parsed.directories.map(directory => ({
      id: directory.id,
      displayName: directory.displayName,
      pathHint: directory.pathHint,
      enabled: directory.enabled,
      availability: availabilityById.get(directory.id) ?? 'unavailable'
    })),
    location: parsed.location.kind === 'folder'
      ? { kind: 'folder', directoryId: parsed.location.directoryId }
      : { kind: 'desktop' }
  };
}

/**
 * 独立保存目录空间授权，不复用 Agent 授权根或其他设置文件。
 */
export class PetHabitatStore {
  private readonly writeText: typeof atomicWriteText;
  private readonly onCheckpoint?: PetHabitatStoreDependencies['onCheckpoint'];

  constructor(
    private readonly file: string,
    dependencies: PetHabitatStoreDependencies = {}
  ) {
    this.writeText = dependencies.writeText ?? atomicWriteText;
    this.onCheckpoint = dependencies.onCheckpoint;
  }

  load(): Promise<PetHabitatSnapshot> {
    return this.enqueue(async () => {
      try {
        return await this.loadUnsafe();
      } catch (error) {
        if (isKnownHabitatError(error)) throw error;
        throw new Error('HABITAT_STORAGE_FAILED');
      }
    });
  }

  save(input: PetHabitatSnapshot): Promise<void> {
    return this.enqueue(async () => {
      const snapshot = petHabitatSnapshotSchema.parse(input);
      try {
        await this.writeSnapshot(snapshot);
      } catch (error) {
        if (isKnownHabitatError(error)) throw error;
        if (isStorageNamespaceChanged(error)) throw new Error('HABITAT_STORAGE_CHANGED');
        throw new Error('HABITAT_STORAGE_FAILED');
      }
    });
  }

  clear(): Promise<void> {
    return this.save(DEFAULT_HABITAT_SNAPSHOT);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    return enqueueFileOperation(this.file, operation);
  }

  private async loadUnsafe(): Promise<PetHabitatSnapshot> {
    let fileInformation: Awaited<ReturnType<typeof lstat>>;
    try {
      fileInformation = await lstat(this.file);
    } catch (error) {
      if (isMissingFile(error)) return cloneSnapshot(DEFAULT_HABITAT_SNAPSHOT);
      throw error;
    }

    const parentBefore = await this.captureParentIdentity();
    if (
      fileInformation.isSymbolicLink()
      || !fileInformation.isFile()
      || fileInformation.size > MAX_STORE_BYTES
    ) {
      return this.quarantine(parentBefore);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.file, 'utf8')) as unknown;
    } catch {
      return this.quarantine(parentBefore);
    }
    const validated = petHabitatSnapshotSchema.safeParse(parsed);
    if (!validated.success) return this.quarantine(parentBefore);

    const parentAfter = await this.captureParentIdentity();
    if (!sameParent(parentBefore, parentAfter)) throw new Error('HABITAT_STORAGE_CHANGED');
    return cloneSnapshot(validated.data);
  }

  private async quarantine(parentBefore: ParentIdentity): Promise<PetHabitatSnapshot> {
    await rename(this.file, uniqueCorruptFile(this.file));
    const parentAfter = await this.captureParentIdentity();
    if (!sameParent(parentBefore, parentAfter)) throw new Error('HABITAT_STORAGE_CHANGED');
    return cloneSnapshot(DEFAULT_HABITAT_SNAPSHOT);
  }

  private async writeSnapshot(snapshot: PetHabitatSnapshot): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const parentBefore = await this.captureParentIdentity();
    const stagedFile = `${this.file}.${randomUUID()}.tmp`;
    let stagedIdentity: FileIdentity | undefined;
    try {
      await this.writeText(stagedFile, `${JSON.stringify(snapshot, null, 2)}\n`);
      stagedIdentity = await this.captureStagedFileIdentity(stagedFile);
      await this.onCheckpoint?.('before-commit');

      const parentAtCommit = await this.captureParentIdentity();
      if (!sameParent(parentBefore, parentAtCommit)) {
        throw new Error('HABITAT_STORAGE_CHANGED');
      }
      const stagedAtCommit = await this.captureStagedFileIdentity(stagedFile);
      if (!sameFile(stagedIdentity, stagedAtCommit)) {
        throw new Error('HABITAT_STORAGE_CHANGED');
      }

      await rename(stagedFile, this.file);
      stagedIdentity = undefined;
    } finally {
      if (stagedIdentity) {
        await this.removeStagedFileIfOwned(stagedFile, stagedIdentity, parentBefore);
      }
    }
  }

  /**
   * 暂存文件必须仍是本次写入创建的普通文件，避免提交或清理同名替代项。
   */
  private async captureStagedFileIdentity(stagedFile: string): Promise<FileIdentity> {
    const entry = await lstat(stagedFile);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error('HABITAT_STORAGE_CHANGED');
    }
    return { dev: entry.dev, ino: entry.ino };
  }

  /**
   * 只在父目录和暂存文件身份均未变化时清理本次写入的唯一暂存文件。
   */
  private async removeStagedFileIfOwned(
    stagedFile: string,
    stagedIdentity: FileIdentity,
    expectedParent: ParentIdentity
  ): Promise<void> {
    try {
      const currentParent = await this.captureParentIdentity();
      if (!sameParent(expectedParent, currentParent)) return;
      const currentStaged = await this.captureStagedFileIdentity(stagedFile);
      if (!sameFile(stagedIdentity, currentStaged)) return;
      await rm(stagedFile, { force: true });
    } catch {
      // 身份无法复核时保守保留，不能误删替代父目录中的同名文件。
    }
  }

  private async captureParentIdentity(): Promise<ParentIdentity> {
    const parent = dirname(this.file);
    const [entry, target, physicalPath] = await Promise.all([
      lstat(parent),
      stat(parent),
      realpath(parent)
    ]);
    if (
      entry.isSymbolicLink()
      || !entry.isDirectory()
      || !target.isDirectory()
      || entry.dev !== target.dev
      || entry.ino !== target.ino
    ) {
      throw new Error('HABITAT_STORAGE_CHANGED');
    }
    return { physicalPath, dev: entry.dev, ino: entry.ino };
  }
}
