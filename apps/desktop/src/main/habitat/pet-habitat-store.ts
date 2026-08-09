import { randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, mkdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { dirname, win32 } from 'node:path';
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
const decimalIdentityPartSchema = z.string().regex(/^(?:0|[1-9]\d*)$/u);
const directoryIdentitySchema = z.object({
  dev: decimalIdentityPartSchema,
  ino: decimalIdentityPartSchema
}).strict();
const legacyDirectoryIdentitySchema = z.object({
  dev: z.number().safe().int().nonnegative(),
  ino: z.number().safe().int().nonnegative()
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

const legacyHabitatDirectoryEnvelopeSchema = habitatDirectoryRecordSchema
  .omit({ identity: true })
  .extend({ identity: z.unknown() });

const habitatPreferencesSchema = z.object({
  enabled: z.boolean().default(false),
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
export type HabitatLocation = z.infer<typeof habitatLocationSchema>;

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
export type PetHabitatSnapshot = z.input<typeof petHabitatSnapshotSchema>;

const legacyPetHabitatSnapshotEnvelopeSchema = z.object({
  version: z.literal(1),
  preferences: habitatPreferencesSchema,
  directories: z.array(z.unknown()).max(128),
  location: habitatLocationSchema
}).strict();

export type HabitatDirectoryAvailability = 'available' | 'unavailable';

export interface RendererHabitatSnapshot {
  enabled: boolean;
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
    enabled: false,
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
  dev: bigint;
  ino: bigint;
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

export type HabitatStoreCheckpoint = 'before-commit';

export interface PetHabitatStoreDependencies {
  writeText?: typeof atomicWriteText;
  onCheckpoint?: (checkpoint: HabitatStoreCheckpoint) => Promise<void>;
}

export type HabitatDirectoryPathUpdateResult =
  | 'updated'
  | 'unchanged'
  | 'missing'
  | 'conflict';

export type HabitatDirectoryAddResult = 'added' | 'duplicate' | 'conflict';
export type HabitatDirectoryToggleResult = 'updated' | 'unchanged' | 'missing';
export type HabitatDirectoryRemoveResult = 'removed' | 'missing' | 'in-use';

export interface HabitatDirectoryPathUpdate {
  directoryId: string;
  expectedIdentity: HabitatDirectoryRecord['identity'];
  expectedAbsolutePath: string;
  absolutePath: string;
}

export type HabitatLocationExpectation = HabitatLocation;

export interface HabitatLocationUpdate {
  expected: HabitatLocationExpectation;
  location: HabitatLocation;
  expectedDirectory?: HabitatDirectoryRecord;
}

export type HabitatLocationUpdateResult = {
  status: 'updated' | 'unchanged' | 'conflict';
  snapshot: PetHabitatSnapshot;
};

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

function sameDirectoryIdentity(
  left: HabitatDirectoryRecord['identity'],
  right: HabitatDirectoryRecord['identity']
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function migrateLegacySnapshot(input: unknown): PetHabitatSnapshot | undefined {
  const legacy = legacyPetHabitatSnapshotEnvelopeSchema.safeParse(input);
  if (!legacy.success) return undefined;
  const directories: HabitatDirectoryRecord[] = [];
  const directoryIds = new Set<string>();
  const discardedIds = new Set<string>();
  for (const inputDirectory of legacy.data.directories) {
    const envelope = legacyHabitatDirectoryEnvelopeSchema.safeParse(inputDirectory);
    if (!envelope.success || directoryIds.has(envelope.data.id)) return undefined;
    directoryIds.add(envelope.data.id);
    const currentIdentity = directoryIdentitySchema.safeParse(envelope.data.identity);
    const legacyIdentity = legacyDirectoryIdentitySchema.safeParse(envelope.data.identity);
    const identity = currentIdentity.success
      ? currentIdentity.data
      : legacyIdentity.success
        ? {
            dev: String(legacyIdentity.data.dev),
            ino: String(legacyIdentity.data.ino)
          }
        : undefined;
    if (identity === undefined) {
      discardedIds.add(envelope.data.id);
      continue;
    }
    const { identity: _identity, ...directory } = envelope.data;
    directories.push({
      ...directory,
      identity
    });
  }
  if (
    legacy.data.location.kind === 'folder'
    && !directoryIds.has(legacy.data.location.directoryId)
  ) return undefined;
  // 身份无法无损恢复时只撤销对应授权，并沿用进入前桌面坐标。
  const location = legacy.data.location.kind === 'folder'
    && discardedIds.has(legacy.data.location.directoryId)
    ? {
        kind: 'desktop' as const,
        position: legacy.data.location.previousDesktopPosition
      }
    : legacy.data.location;
  const migrated = petHabitatSnapshotSchema.safeParse({
    ...legacy.data,
    directories,
    location
  });
  return migrated.success ? migrated.data : undefined;
}

function samePrivatePath(left: string, right: string): boolean {
  return win32.normalize(left).toLocaleLowerCase('en-US')
    === win32.normalize(right).toLocaleLowerCase('en-US');
}

function locationMatchesExpectation(
  location: HabitatLocation,
  expected: HabitatLocationExpectation
): boolean {
  if (location.kind !== expected.kind) return false;
  if (location.kind === 'desktop' && expected.kind === 'desktop') {
    return location.position === expected.position || (
      location.position !== null
      && expected.position !== null
      && location.position.x === expected.position.x
      && location.position.y === expected.position.y
    );
  }
  return location.kind === 'folder'
    && expected.kind === 'folder'
    && location.directoryId === expected.directoryId
    && location.enteredAt === expected.enteredAt
    && location.previousDesktopPosition.x === expected.previousDesktopPosition.x
    && location.previousDesktopPosition.y === expected.previousDesktopPosition.y
    && location.localOffset.x === expected.localOffset.x
    && location.localOffset.y === expected.localOffset.y;
}

function sameLocationTarget(left: HabitatLocation, right: HabitatLocation): boolean {
  return left.kind === right.kind && (
    left.kind === 'desktop'
    || (right.kind === 'folder' && left.directoryId === right.directoryId)
  );
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
    enabled: parsed.preferences.enabled,
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

  /** 原子替换偏好字段，保留并发提交的位置和目录事实。 */
  updatePreferences(input: PetHabitatSnapshot['preferences']): Promise<void> {
    return this.enqueue(async () => {
      const preferences = habitatPreferencesSchema.parse(input);
      try {
        const snapshot = await this.loadUnsafe();
        await this.writeSnapshot(petHabitatSnapshotSchema.parse({
          ...snapshot,
          preferences
        }));
      } catch (error) {
        if (isKnownHabitatError(error)) throw error;
        if (isStorageNamespaceChanged(error)) throw new Error('HABITAT_STORAGE_CHANGED');
        throw new Error('HABITAT_STORAGE_FAILED');
      }
    });
  }

  /** 原子追加已授权目录，并复核并发加入的路径与身份冲突。 */
  addDirectory(input: HabitatDirectoryRecord): Promise<HabitatDirectoryAddResult> {
    return this.enqueue(async () => {
      const directory = habitatDirectoryRecordSchema.parse(input);
      try {
        const snapshot = await this.loadUnsafe();
        for (const existing of snapshot.directories) {
          const pathMatches = samePrivatePath(existing.absolutePath, directory.absolutePath);
          const identityMatches = sameDirectoryIdentity(existing.identity, directory.identity);
          if (pathMatches && identityMatches) return 'duplicate';
          if (existing.id === directory.id || pathMatches || identityMatches) return 'conflict';
        }
        await this.writeSnapshot(petHabitatSnapshotSchema.parse({
          ...snapshot,
          directories: [...snapshot.directories, directory]
        }));
        return 'added';
      } catch (error) {
        if (isKnownHabitatError(error)) throw error;
        if (isStorageNamespaceChanged(error)) throw new Error('HABITAT_STORAGE_CHANGED');
        throw new Error('HABITAT_STORAGE_FAILED');
      }
    });
  }

  /** 原子切换单个目录，不覆盖并发修改的其他目录字段。 */
  setDirectoryEnabled(
    directoryId: string,
    enabled: boolean
  ): Promise<HabitatDirectoryToggleResult> {
    return this.enqueue(async () => {
      const parsed = z.object({
        directoryId: safeIdentifierSchema,
        enabled: z.boolean()
      }).strict().parse({ directoryId, enabled });
      try {
        const snapshot = await this.loadUnsafe();
        const index = snapshot.directories.findIndex(directory => (
          directory.id === parsed.directoryId
        ));
        if (index < 0) return 'missing';
        if (snapshot.directories[index]!.enabled === parsed.enabled) return 'unchanged';
        const directories = snapshot.directories.slice();
        directories[index] = { ...directories[index]!, enabled: parsed.enabled };
        await this.writeSnapshot(petHabitatSnapshotSchema.parse({ ...snapshot, directories }));
        return 'updated';
      } catch (error) {
        if (isKnownHabitatError(error)) throw error;
        if (isStorageNamespaceChanged(error)) throw new Error('HABITAT_STORAGE_CHANGED');
        throw new Error('HABITAT_STORAGE_FAILED');
      }
    });
  }

  /** 原子删除配置记录；当前 folder 引用仍存在时拒绝删除。 */
  removeDirectory(directoryId: string): Promise<HabitatDirectoryRemoveResult> {
    return this.enqueue(async () => {
      const parsedId = safeIdentifierSchema.parse(directoryId);
      try {
        const snapshot = await this.loadUnsafe();
        const exists = snapshot.directories.some(directory => directory.id === parsedId);
        if (!exists) return 'missing';
        if (
          snapshot.location.kind === 'folder'
          && snapshot.location.directoryId === parsedId
        ) return 'in-use';
        await this.writeSnapshot(petHabitatSnapshotSchema.parse({
          ...snapshot,
          directories: snapshot.directories.filter(directory => directory.id !== parsedId)
        }));
        return 'removed';
      } catch (error) {
        if (isKnownHabitatError(error)) throw error;
        if (isStorageNamespaceChanged(error)) throw new Error('HABITAT_STORAGE_CHANGED');
        throw new Error('HABITAT_STORAGE_FAILED');
      }
    });
  }

  /**
   * 在同一文件队列中复核启用态、身份和旧路径，避免迟到续接覆盖并发更改。
   */
  updateDirectoryPath(
    input: HabitatDirectoryPathUpdate
  ): Promise<HabitatDirectoryPathUpdateResult> {
    return this.enqueue(async () => {
      const parsedInput = z.object({
        directoryId: safeIdentifierSchema,
        expectedIdentity: directoryIdentitySchema,
        expectedAbsolutePath: z.string().min(1).max(32_768),
        absolutePath: z.string().min(1).max(32_768)
      }).strict().parse(input);
      try {
        const snapshot = await this.loadUnsafe();
        const index = snapshot.directories.findIndex(directory => (
          directory.id === parsedInput.directoryId
        ));
        if (index < 0) return 'missing';
        const current = snapshot.directories[index]!;
        if (
          !current.enabled
          || !sameDirectoryIdentity(current.identity, parsedInput.expectedIdentity)
        ) return 'missing';
        if (!samePrivatePath(current.absolutePath, parsedInput.expectedAbsolutePath)) {
          return 'conflict';
        }

        const conflicts = snapshot.directories.some((directory, otherIndex) => (
          otherIndex !== index
          && (
            sameDirectoryIdentity(directory.identity, parsedInput.expectedIdentity)
            || samePrivatePath(directory.absolutePath, parsedInput.absolutePath)
          )
        ));
        if (conflicts) return 'conflict';
        if (samePrivatePath(current.absolutePath, parsedInput.absolutePath)) return 'unchanged';

        const directories = snapshot.directories.slice();
        directories[index] = { ...current, absolutePath: parsedInput.absolutePath };
        await this.writeSnapshot(petHabitatSnapshotSchema.parse({ ...snapshot, directories }));
        return 'updated';
      } catch (error) {
        if (isKnownHabitatError(error)) throw error;
        if (isStorageNamespaceChanged(error)) throw new Error('HABITAT_STORAGE_CHANGED');
        throw new Error('HABITAT_STORAGE_FAILED');
      }
    });
  }

  /**
   * 在同一文件队列中条件更新稳定位置，只替换 location 并保留最新配置与目录记录。
   */
  updateLocation(input: HabitatLocationUpdate): Promise<HabitatLocationUpdateResult> {
    return this.enqueue(async () => {
      const parsedInput = z.object({
        expected: habitatLocationSchema,
        location: habitatLocationSchema,
        expectedDirectory: habitatDirectoryRecordSchema.optional()
      }).strict().parse(input);
      try {
        const snapshot = await this.loadUnsafe();
        if (parsedInput.location.kind === 'folder') {
          const expectedDirectory = parsedInput.expectedDirectory;
          const current = expectedDirectory === undefined
            ? undefined
            : snapshot.directories.find(directory => directory.id === expectedDirectory.id);
          if (
            expectedDirectory === undefined
            || parsedInput.location.directoryId !== expectedDirectory.id
            || current === undefined
            || !current.enabled
            || !sameDirectoryIdentity(current.identity, expectedDirectory.identity)
            || !samePrivatePath(current.absolutePath, expectedDirectory.absolutePath)
          ) {
            return { status: 'conflict', snapshot };
          }
        }

        if (!locationMatchesExpectation(snapshot.location, parsedInput.expected)) {
          return {
            status: sameLocationTarget(snapshot.location, parsedInput.location)
              ? 'unchanged' as const
              : 'conflict' as const,
            snapshot
          };
        }

        const updated = petHabitatSnapshotSchema.parse({
          ...snapshot,
          location: parsedInput.location
        });
        await this.writeSnapshot(updated);
        return { status: 'updated', snapshot: cloneSnapshot(updated) };
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
    let fileInformation: BigIntStats;
    try {
      fileInformation = await lstat(this.file, { bigint: true });
    } catch (error) {
      if (isMissingFile(error)) return cloneSnapshot(DEFAULT_HABITAT_SNAPSHOT);
      throw error;
    }

    const parentBefore = await this.captureParentIdentity();
    if (
      fileInformation.isSymbolicLink()
      || !fileInformation.isFile()
      || fileInformation.size > BigInt(MAX_STORE_BYTES)
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
    const snapshot = validated.success ? validated.data : migrateLegacySnapshot(parsed);
    if (snapshot === undefined) return this.quarantine(parentBefore);

    const parentAfter = await this.captureParentIdentity();
    if (!sameParent(parentBefore, parentAfter)) throw new Error('HABITAT_STORAGE_CHANGED');
    if (!validated.success) await this.writeSnapshot(snapshot);
    return cloneSnapshot(snapshot);
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
    const entry = await lstat(stagedFile, { bigint: true });
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
      lstat(parent, { bigint: true }),
      stat(parent, { bigint: true }),
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
