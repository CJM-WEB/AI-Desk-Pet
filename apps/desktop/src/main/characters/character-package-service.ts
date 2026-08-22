import { createHash, randomUUID } from 'node:crypto';
import {
  lstatSync,
  readdirSync,
  realpathSync,
  rmSync,
  type Dirent
} from 'node:fs';
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
  type FileHandle
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve
} from 'node:path';
import { Transform, Writable, type Readable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import {
  CHARACTER_PACKAGE_LIMITS,
  characterSourceCatalogV1Schema,
  characterSourceFileName,
  validateCharacterPackageStructure,
  validatePackageEntries,
  type CharacterPackageFileMetadata,
  type CharacterPackageLimits,
  type CharacterSourceCatalogV1,
  type PackageEntryDescriptor
} from '@myself/character-assets';
import {
  type CharacterDraftV2,
  type CharacterManifestV2
} from '@myself/character-runtime';
import * as yauzl from 'yauzl';
import { ZipFile } from 'yazl';
import { z } from 'zod';
import { CharacterAssetService } from './character-asset-service';
import {
  finalizeCharacterManifestMigration,
  migrateCharacterDocument,
  prepareCharacterManifestMigration,
  type CharacterGeometryMigrationDependencies
} from './character-migrations';
import { CharacterStore } from './character-store';
import { atomicWriteFileExclusive } from '../storage/atomic-file-coordinator';

const SAFE_CHARACTER_ID = /^[a-z0-9][a-z0-9_-]{0,119}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_CREATE_ATTEMPTS = 32;
const MAX_IMPORT_RECOVERY_ENTRIES = 256;
const IMPORT_RECOVERY_BUDGET_MS = 2_000;
const MAX_IMPORT_MARKER_BYTES = 4_096;
const IMPORT_STAGING_PREFIX = 'ai-pet-character-package-';
const ROLLBACK_MARKER_PATTERN =
  /^\.package-import-rollback-([a-z0-9][a-z0-9_-]{0,119})\.json$/u;
const DETACHED_MARKER_EVIDENCE = new Error('DETACHED_MARKER_EVIDENCE');
const packageImportQueues = new Map<string, Promise<void>>();

const characterPackageImportMarkerV3Schema = z.object({
  version: z.literal(3),
  characterId: z.string().regex(SAFE_CHARACTER_ID),
  importTransactionId: z.string().regex(UUID_PATTERN)
}).strict();

type CharacterPackageImportMarkerV3 = Readonly<{
  version: 3;
  characterId: string;
  importTransactionId: string;
}>;

type ImportMarkerIdentity = Readonly<{
  dev: number;
  ino: number;
  size: number;
}>;

export type CharacterPackageRecoveryIssue = Readonly<{
  characterId: string;
  errorCode:
    | 'CHARACTER_IMPORT_RECOVERY_BLOCKED'
    | 'CHARACTER_IMPORT_RECOVERY_DEFERRED';
}>;

export type CharacterPackageRecoveryReport = Readonly<{
  issues: readonly CharacterPackageRecoveryIssue[];
}>;

export type CharacterPackageCheckpoint =
  | 'extract:before-file-open'
  | 'extract:after-file-open'
  | 'export:after-destination-write'
  | 'export:after-temp-write'
  | 'export:before-commit'
  | 'export:before-link'
  | 'export:cleanup-verified'
  | 'export:resource-validated'
  | 'import:validated';

export type CharacterPackageServiceDependencies = {
  temporaryDirectory?: string;
  onCheckpoint?: (
    checkpoint: CharacterPackageCheckpoint,
    stagingDirectory: string,
    targetPath?: string
  ) => Promise<void>;
  createId?: () => string;
  archiveFactory?: () => ZipFile;
  packageLimits?: Partial<CharacterPackageLimits>;
  store?: CharacterStore;
  assetService?: CharacterAssetService;
  recoveryNow?: () => number;
  geometryMigration?: CharacterGeometryMigrationDependencies;
};

type ScannedEntry = {
  descriptor: PackageEntryDescriptor;
  normalizedPath: string;
};

type ExtractedFileDescriptor = {
  archivePath: string;
  flatPath: string;
  byteLength: number;
};

type ExtractedFiles = ReadonlyMap<string, ExtractedFileDescriptor>;

type PreparedPackage = {
  originalId: string;
  draft: CharacterDraftV2;
  manifest: CharacterManifestV2;
  runtimeAssets: Readonly<Record<string, Uint8Array>>;
  sourceCatalog: CharacterSourceCatalogV1;
  sourceVersion: 1 | 2;
};

type DirectoryIdentity = {
  logicalPath: string;
  physicalPath: string;
  dev: number;
  ino: number;
};

type ExportedDiskFile = {
  archivePath: string;
  diskPath: string;
  byteLength: number;
  sha256: string;
  handle: FileHandle;
};

type FileIdentity = {
  physicalPath: string;
  dev: number;
  ino: number;
  byteLength: number;
};

type ExportedBufferFile = {
  archivePath: string;
  diskPath: string;
  byteLength: number;
  sha256: string;
  bytes: Buffer;
  directory: DirectoryIdentity;
  identity: FileIdentity;
};

type ArchiveIdentity = {
  dev: number;
  ino: number;
  byteLength: number;
  sha256: string;
};

type PathIdentity = Pick<ArchiveIdentity, 'dev' | 'ino'>;

type ArchiveDigest = Pick<ArchiveIdentity, 'byteLength' | 'sha256'>;

function packageError(code: string): Error {
  return new Error(code);
}

function sameImportMarkerIdentity(
  expected: ImportMarkerIdentity,
  current: ImportMarkerIdentity
): boolean {
  return expected.dev === current.dev
    && expected.ino === current.ino
    && expected.size === current.size;
}

function immutableRecoveryReport(
  issues: readonly CharacterPackageRecoveryIssue[]
): CharacterPackageRecoveryReport {
  const byCharacter = new Map<string, CharacterPackageRecoveryIssue>();
  for (const issue of issues) {
    const current = byCharacter.get(issue.characterId);
    if (
      !current
      || issue.errorCode === 'CHARACTER_IMPORT_RECOVERY_BLOCKED'
    ) {
      byCharacter.set(issue.characterId, issue);
    }
  }
  const frozenIssues = Object.freeze(
    [...byCharacter.values()]
      .sort((left, right) => left.characterId.localeCompare(right.characterId, 'en-US'))
      .map(issue => Object.freeze({ ...issue }))
  );
  return Object.freeze({ issues: frozenIssues });
}

function appendRecoveryIssue(
  issues: CharacterPackageRecoveryIssue[],
  characterId: string | undefined,
  errorCode: CharacterPackageRecoveryIssue['errorCode']
): void {
  if (characterId) issues.push({ characterId, errorCode });
  else console.error('CHARACTER_IMPORT_RECOVERY_UNATTRIBUTED');
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function isContained(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

function sameIdentity(
  left: Pick<DirectoryIdentity, 'dev' | 'ino'>,
  right: Pick<DirectoryIdentity, 'dev' | 'ino'>
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function captureDirectoryIdentity(
  path: string,
  root?: DirectoryIdentity
): Promise<DirectoryIdentity> {
  let information;
  let physicalPath: string;
  try {
    information = await lstat(path);
    physicalPath = await realpath(path);
  } catch {
    throw packageError('CHARACTER_PACKAGE_EXTRACTION_PATH_UNSAFE');
  }
  if (
    information.isSymbolicLink()
    || !information.isDirectory()
    || (root !== undefined && !isContained(root.physicalPath, physicalPath))
  ) {
    throw packageError('CHARACTER_PACKAGE_EXTRACTION_PATH_UNSAFE');
  }
  return {
    logicalPath: path,
    physicalPath,
    dev: information.dev,
    ino: information.ino
  };
}

async function assertDirectoryIdentity(
  expected: DirectoryIdentity,
  root: DirectoryIdentity
): Promise<void> {
  const current = await captureDirectoryIdentity(expected.logicalPath, root);
  if (
    !sameIdentity(expected, current)
    || current.physicalPath !== expected.physicalPath
  ) {
    throw packageError('CHARACTER_PACKAGE_EXTRACTION_PATH_UNSAFE');
  }
}

async function runExtractionCheckpoint(
  onCheckpoint: CharacterPackageServiceDependencies['onCheckpoint'],
  checkpoint: Extract<
    CharacterPackageCheckpoint,
    'extract:before-file-open' | 'extract:after-file-open'
  >,
  root: string,
  target: string
): Promise<void> {
  try {
    await onCheckpoint?.(checkpoint, root, target);
  } catch {
    throw packageError('CHARACTER_PACKAGE_EXTRACTION_PATH_UNSAFE');
  }
}

async function runExportResourceCheckpoint(
  onCheckpoint: CharacterPackageServiceDependencies['onCheckpoint'],
  characterDirectory: string,
  target: string
): Promise<void> {
  try {
    await onCheckpoint?.(
      'export:resource-validated',
      characterDirectory,
      target
    );
  } catch {
    throw packageError('CHARACTER_PACKAGE_EXPORT_SOURCE_CHANGED');
  }
}

export function classifyPackageEntry(
  entry: Pick<
    yauzl.Entry,
    'versionMadeBy' | 'externalFileAttributes' | 'fileName'
  >
): PackageEntryDescriptor['kind'] {
  const platform = entry.versionMadeBy >>> 8;
  const unixMode = entry.externalFileAttributes >>> 16;
  const unixKind = unixMode & 0o170000;
  const nameIsDirectory = entry.fileName.endsWith('/');

  // Unix 外部属性可表达链接、设备和管道；未知或非普通类型统一按不安全链接拒绝。
  if (platform === 3 && unixKind !== 0) {
    if (unixKind === 0o120000) return 'symlink';
    if (unixKind === 0o040000 && nameIsDirectory) return 'directory';
    if (unixKind === 0o100000 && !nameIsDirectory) return 'file';
    return 'symlink';
  }

  if ((entry.externalFileAttributes & 0x400) !== 0) return 'symlink';
  const dosDirectory = (entry.externalFileAttributes & 0x10) !== 0;
  return dosDirectory || nameIsDirectory ? 'directory' : 'file';
}

function descriptorFor(entry: yauzl.Entry): PackageEntryDescriptor {
  return {
    path: entry.fileName,
    compressedBytes: entry.compressedSize,
    uncompressedBytes: entry.uncompressedSize,
    kind: classifyPackageEntry(entry)
  };
}

function openZip(path: string, validateEntrySizes: boolean): Promise<yauzl.ZipFile> {
  return new Promise((resolveArchive, reject) => {
    yauzl.open(path, {
      lazyEntries: true,
      strictFileNames: false,
      validateEntrySizes
    }, (error, archive) => {
      if (error) reject(error);
      else resolveArchive(archive);
    });
  });
}

function mapArchiveError(error: unknown): Error {
  if (
    error instanceof Error
    && (
      error.message.includes('absolute path')
      || error.message.includes('invalid relative path')
      || error.message.includes('invalid characters in fileName')
    )
  ) {
    return packageError('CHARACTER_PACKAGE_PATH_REJECTED');
  }
  if (error instanceof Error && error.message.startsWith('CHARACTER_')) {
    return error;
  }
  return packageError('CHARACTER_PACKAGE_INVALID');
}

async function scanArchive(packagePath: string): Promise<ScannedEntry[]> {
  let archive: yauzl.ZipFile;
  try {
    archive = await openZip(packagePath, true);
  } catch (error) {
    throw mapArchiveError(error);
  }

  const descriptors = await new Promise<PackageEntryDescriptor[]>((resolveEntries, reject) => {
    const entries: PackageEntryDescriptor[] = [];
    const fail = (error: unknown): void => {
      archive.close();
      reject(mapArchiveError(error));
    };
    archive.on('error', fail);
    archive.on('entry', (entry: yauzl.Entry) => {
      entries.push(descriptorFor(entry));
      if (entries.length > CHARACTER_PACKAGE_LIMITS.maxEntries) {
        fail(packageError('CHARACTER_PACKAGE_ENTRY_COUNT_EXCEEDED'));
        return;
      }
      archive.readEntry();
    });
    archive.on('end', () => resolveEntries(entries));
    archive.readEntry();
  });
  const validation = validatePackageEntries(descriptors);
  return descriptors.map((descriptor, index) => ({
    descriptor,
    normalizedPath: validation.normalizedPaths[index]!
  }));
}

function sameDescriptor(
  left: PackageEntryDescriptor,
  right: PackageEntryDescriptor
): boolean {
  return (
    left.path === right.path
    && left.compressedBytes === right.compressedBytes
    && left.uncompressedBytes === right.uncompressedBytes
    && left.kind === right.kind
  );
}

async function extractFile(
  archive: yauzl.ZipFile,
  entry: yauzl.Entry,
  normalizedPath: string,
  root: DirectoryIdentity,
  entriesDirectory: DirectoryIdentity,
  totals: { bytes: number },
  onCheckpoint?: CharacterPackageServiceDependencies['onCheckpoint']
): Promise<ExtractedFileDescriptor> {
  const stream = await new Promise<Readable>((resolveStream, reject) => {
    archive.openReadStream(entry, (error, openedStream) => {
      if (error) reject(error);
      else resolveStream(openedStream);
    });
  });
  const destination = join(
    entriesDirectory.logicalPath,
    `${randomUUID()}.entry`
  );
  await runExtractionCheckpoint(
    onCheckpoint,
    'extract:before-file-open',
    root.logicalPath,
    destination
  );
  await assertDirectoryIdentity(root, root);
  await assertDirectoryIdentity(entriesDirectory, root);
  const handle = await open(destination, 'wx', 0o600);
  const openedIdentity = await handle.stat();
  let entryBytes = 0;
  try {
    await assertDirectoryIdentity(root, root);
    await assertDirectoryIdentity(entriesDirectory, root);
    let installedIdentity;
    try {
      installedIdentity = await lstat(destination);
    } catch {
      throw packageError('CHARACTER_PACKAGE_EXTRACTION_PATH_UNSAFE');
    }
    if (
      !openedIdentity.isFile()
      ||
      installedIdentity.isSymbolicLink()
      || !installedIdentity.isFile()
      || !sameIdentity(openedIdentity, installedIdentity)
    ) {
      throw packageError('CHARACTER_PACKAGE_EXTRACTION_PATH_UNSAFE');
    }
    await runExtractionCheckpoint(
      onCheckpoint,
      'extract:after-file-open',
      root.logicalPath,
      destination
    );
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk);
      entryBytes += bytes.byteLength;
      totals.bytes += bytes.byteLength;
      if (
        entryBytes > entry.uncompressedSize
        || totals.bytes
          > CHARACTER_PACKAGE_LIMITS.maxTotalUncompressedBytes
        || (
          entry.compressedSize === 0
            ? entryBytes > 0
            : entryBytes
              > entry.compressedSize
                * CHARACTER_PACKAGE_LIMITS.maxExpansionRatio
        )
      ) {
        throw packageError('CHARACTER_PACKAGE_STREAM_LIMIT_EXCEEDED');
      }
      let offset = 0;
      while (offset < bytes.byteLength) {
        const written = await handle.write(
          bytes,
          offset,
          bytes.byteLength - offset
        );
        offset += written.bytesWritten;
      }
    }
    if (entryBytes !== entry.uncompressedSize) {
      throw packageError('CHARACTER_PACKAGE_SIZE_MISMATCH');
    }
    await handle.sync();
    await assertDirectoryIdentity(root, root);
    await assertDirectoryIdentity(entriesDirectory, root);
    const completedHandleIdentity = await handle.stat();
    let completedPathIdentity;
    try {
      completedPathIdentity = await lstat(destination);
    } catch {
      throw packageError('CHARACTER_PACKAGE_EXTRACTION_PATH_UNSAFE');
    }
    if (
      !completedHandleIdentity.isFile()
      || !completedPathIdentity.isFile()
      || !sameIdentity(openedIdentity, completedHandleIdentity)
      || !sameIdentity(openedIdentity, completedPathIdentity)
    ) {
      throw packageError('CHARACTER_PACKAGE_EXTRACTION_PATH_UNSAFE');
    }
  } finally {
    await handle.close();
  }
  return {
    archivePath: normalizedPath,
    flatPath: destination,
    byteLength: entryBytes
  };
}

async function extractArchive(
  packagePath: string,
  root: DirectoryIdentity,
  entriesDirectory: DirectoryIdentity,
  expectedEntries: readonly ScannedEntry[],
  onCheckpoint?: CharacterPackageServiceDependencies['onCheckpoint']
): Promise<ExtractedFiles> {
  let archive: yauzl.ZipFile;
  try {
    archive = await openZip(packagePath, false);
  } catch (error) {
    throw mapArchiveError(error);
  }

  const totals = { bytes: 0 };
  const extractedFiles = new Map<string, ExtractedFileDescriptor>();
  await new Promise<void>((resolveExtraction, reject) => {
    let index = 0;
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      archive.close();
      reject(mapArchiveError(error));
    };
    archive.on('error', fail);
    archive.on('end', () => {
      if (settled) return;
      if (index !== expectedEntries.length) {
        fail(packageError('CHARACTER_PACKAGE_CHANGED_DURING_IMPORT'));
        return;
      }
      settled = true;
      resolveExtraction();
    });
    archive.on('entry', (entry: yauzl.Entry) => {
      void (async () => {
        const expected = expectedEntries[index];
        const actual = descriptorFor(entry);
        if (!expected || !sameDescriptor(expected.descriptor, actual)) {
          throw packageError('CHARACTER_PACKAGE_CHANGED_DURING_IMPORT');
        }
        index += 1;
        if (actual.kind === 'file') {
          const extracted = await extractFile(
            archive,
            entry,
            expected.normalizedPath,
            root,
            entriesDirectory,
            totals,
            onCheckpoint
          );
          extractedFiles.set(expected.normalizedPath, extracted);
        }
        archive.readEntry();
      })().catch(fail);
    });
    archive.readEntry();
  });
  return extractedFiles;
}

async function readJson(path: string): Promise<unknown> {
  try {
    const information = await lstat(path);
    if (
      information.isSymbolicLink()
      || !information.isFile()
      || information.size > CHARACTER_PACKAGE_LIMITS.maxJsonBytes
    ) {
      throw packageError('CHARACTER_PACKAGE_DOCUMENT_INVALID');
    }
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('CHARACTER_')) {
      throw error;
    }
    throw packageError('CHARACTER_PACKAGE_DOCUMENT_INVALID');
  }
}

async function readRegularFile(path: string): Promise<Buffer> {
  const information = await lstat(path);
  if (
    information.isSymbolicLink()
    || !information.isFile()
    || information.size > CHARACTER_PACKAGE_LIMITS.maxResourceBytes
  ) {
    throw packageError('CHARACTER_PACKAGE_LINK_REJECTED');
  }
  return readFile(path);
}

async function openVerifiedRegularFile(
  path: string,
  maxBytes: number
): Promise<{ handle: FileHandle; byteLength: number; sha256: string }> {
  let pathIdentity;
  try {
    pathIdentity = await lstat(path);
  } catch {
    throw packageError('CHARACTER_PACKAGE_RESOURCE_INVALID');
  }
  if (
    pathIdentity.isSymbolicLink()
    || !pathIdentity.isFile()
    || pathIdentity.size > maxBytes
  ) {
    throw packageError('CHARACTER_PACKAGE_RESOURCE_INVALID');
  }
  const handle = await open(path, 'r');
  try {
    const openedIdentity = await handle.stat();
    if (
      !openedIdentity.isFile()
      || !sameIdentity(pathIdentity, openedIdentity)
      || openedIdentity.size !== pathIdentity.size
    ) {
      throw packageError('CHARACTER_PACKAGE_RESOURCE_INVALID');
    }
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let byteLength = 0;
    while (byteLength < openedIdentity.size) {
      const result = await handle.read(
        buffer,
        0,
        Math.min(buffer.byteLength, openedIdentity.size - byteLength),
        byteLength
      );
      if (result.bytesRead === 0) {
        throw packageError('CHARACTER_PACKAGE_RESOURCE_INVALID');
      }
      byteLength += result.bytesRead;
      if (byteLength > maxBytes) {
        throw packageError('CHARACTER_PACKAGE_RESOURCE_INVALID');
      }
      hash.update(buffer.subarray(0, result.bytesRead));
    }
    const completedIdentity = await handle.stat();
    if (
      !completedIdentity.isFile()
      || !sameIdentity(openedIdentity, completedIdentity)
      || completedIdentity.size !== byteLength
    ) {
      throw packageError('CHARACTER_PACKAGE_RESOURCE_INVALID');
    }
    return {
      handle,
      byteLength,
      sha256: hash.digest('hex')
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

/** 将受控目录内的文件读取为有界私有快照，并绑定目录与文件身份。 */
async function readVerifiedContainedSnapshot(
  directory: DirectoryIdentity,
  owner: DirectoryIdentity,
  path: string,
  maxBytes: number
): Promise<{
  bytes: Buffer;
  byteLength: number;
  sha256: string;
  identity: FileIdentity;
}> {
  try {
    await assertDirectoryIdentity(directory, owner);
  } catch {
    throw packageError('CHARACTER_PACKAGE_EXPORT_SOURCE_CHANGED');
  }

  let physicalPath: string;
  let pathIdentity;
  try {
    physicalPath = await realpath(path);
    pathIdentity = await lstat(path);
  } catch {
    throw packageError('CHARACTER_PACKAGE_RESOURCE_INVALID');
  }
  if (
    !isContained(directory.physicalPath, physicalPath)
    || pathIdentity.isSymbolicLink()
    || !pathIdentity.isFile()
    || pathIdentity.size > maxBytes
  ) {
    throw packageError('CHARACTER_PACKAGE_RESOURCE_INVALID');
  }

  const handle = await open(path, 'r');
  try {
    const openedIdentity = await handle.stat();
    if (
      !openedIdentity.isFile()
      || !sameIdentity(pathIdentity, openedIdentity)
      || openedIdentity.size !== pathIdentity.size
    ) {
      throw packageError('CHARACTER_PACKAGE_EXPORT_SOURCE_CHANGED');
    }

    const bytes = Buffer.allocUnsafe(openedIdentity.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(
        bytes,
        offset,
        bytes.byteLength - offset,
        offset
      );
      if (result.bytesRead === 0) {
        throw packageError('CHARACTER_PACKAGE_EXPORT_SOURCE_CHANGED');
      }
      offset += result.bytesRead;
    }

    const completedHandleIdentity = await handle.stat();
    let completedPathIdentity;
    let completedPhysicalPath: string;
    try {
      completedPathIdentity = await lstat(path);
      completedPhysicalPath = await realpath(path);
      await assertDirectoryIdentity(directory, owner);
    } catch {
      throw packageError('CHARACTER_PACKAGE_EXPORT_SOURCE_CHANGED');
    }
    if (
      !completedHandleIdentity.isFile()
      || !completedPathIdentity.isFile()
      || !sameIdentity(openedIdentity, completedHandleIdentity)
      || !sameIdentity(openedIdentity, completedPathIdentity)
      || completedHandleIdentity.size !== bytes.byteLength
      || completedPathIdentity.size !== bytes.byteLength
      || completedPhysicalPath !== physicalPath
    ) {
      throw packageError('CHARACTER_PACKAGE_EXPORT_SOURCE_CHANGED');
    }

    return {
      bytes,
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
      identity: {
        physicalPath,
        dev: openedIdentity.dev,
        ino: openedIdentity.ino,
        byteLength: bytes.byteLength
      }
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** checkpoint 后只复核来源身份；归档内容始终使用已持有的私有快照。 */
async function assertExportSnapshotIdentity(
  file: ExportedBufferFile,
  owner: DirectoryIdentity
): Promise<void> {
  try {
    await assertDirectoryIdentity(file.directory, owner);
    const current = await lstat(file.diskPath);
    const physicalPath = await realpath(file.diskPath);
    if (
      current.isSymbolicLink()
      || !current.isFile()
      || !sameIdentity(file.identity, current)
      || current.size !== file.identity.byteLength
      || physicalPath !== file.identity.physicalPath
    ) {
      throw packageError('CHARACTER_PACKAGE_EXPORT_SOURCE_CHANGED');
    }
  } catch (error) {
    if (
      error instanceof Error
      && error.message === 'CHARACTER_PACKAGE_EXPORT_SOURCE_CHANGED'
    ) {
      throw error;
    }
    throw packageError('CHARACTER_PACKAGE_EXPORT_SOURCE_CHANGED');
  }
}

/** 从已打开句柄捕获创建时身份，不重新信任可变路径。 */
async function captureHandleIdentity(handle: FileHandle): Promise<PathIdentity> {
  try {
    const current = await handle.stat();
    if (!current.isFile()) {
      throw packageError('CHARACTER_PACKAGE_EXPORT_SOURCE_CHANGED');
    }
    return { dev: current.dev, ino: current.ino };
  } catch {
    throw packageError('CHARACTER_PACKAGE_EXPORT_SOURCE_CHANGED');
  }
}

/** 在关闭句柄前失效化本方 inode，避免移动后的归档或半成品残留。 */
async function invalidateHandle(handle: FileHandle): Promise<void> {
  await handle.truncate(0);
  await handle.sync();
}

/**
 * 仅同步清理身份未变且只含本方零字节临时文件的私有 staging。
 * 同步检查到删除之间不运行 checkpoint，也不把观察到的陌生 inode 当作清理目标。
 */
function cleanupPrivateExportStaging(
  staging: DirectoryIdentity,
  temporaryPath: string,
  temporaryIdentity: PathIdentity
): void {
  try {
    const directory = lstatSync(staging.logicalPath);
    const entries = readdirSync(staging.logicalPath, { withFileTypes: true });
    if (
      !directory.isDirectory()
      || directory.isSymbolicLink()
      || !sameIdentity(staging, directory)
      || realpathSync.native(staging.logicalPath) !== staging.physicalPath
      || entries.length !== 1
      || entries[0]?.name !== 'archive.tmp'
      || !entries[0].isFile()
    ) {
      return;
    }
    const temporary = lstatSync(temporaryPath);
    if (
      temporary.isSymbolicLink()
      || !temporary.isFile()
      || !sameIdentity(temporaryIdentity, temporary)
      || temporary.size !== 0
    ) {
      return;
    }
    rmSync(staging.logicalPath, { recursive: true, force: true });
  } catch {
    // 身份、内容或清理状态不确定时保留隔离目录，避免误删陌生文件。
  }
}

/** 仅判断路径是否仍绑定到已知句柄身份，不返回陌生路径身份。 */
async function assertPathIdentity(
  path: string,
  expected: PathIdentity
): Promise<void> {
  let current;
  try {
    current = await lstat(path);
  } catch {
    throw packageError('CHARACTER_PACKAGE_EXPORT_SOURCE_CHANGED');
  }
  if (
    current.isSymbolicLink()
    || !current.isFile()
    || !sameIdentity(expected, current)
  ) {
    throw packageError('CHARACTER_PACKAGE_EXPORT_SOURCE_CHANGED');
  }
}

/** 将归档流直接写入可信句柄，并同步记录实际写入摘要。 */
function createHandleArchiveWriter(handle: FileHandle): {
  stream: Writable;
  digest(): ArchiveDigest;
} {
  const hash = createHash('sha256');
  let byteLength = 0;
  let completed: ArchiveDigest | undefined;
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const position = byteLength;
      void (async () => {
        let written = 0;
        while (written < chunk.byteLength) {
          const result = await handle.write(
            chunk,
            written,
            chunk.byteLength - written,
            position + written
          );
          if (result.bytesWritten === 0) {
            throw packageError('CHARACTER_PACKAGE_EXPORT_SOURCE_CHANGED');
          }
          written += result.bytesWritten;
        }
        byteLength += chunk.byteLength;
        hash.update(chunk);
      })().then(() => callback(), callback);
    },
    final(callback) {
      completed = { byteLength, sha256: hash.digest('hex') };
      callback();
    }
  });
  return {
    stream,
    digest() {
      if (completed === undefined) {
        throw packageError('CHARACTER_PACKAGE_EXPORT_SOURCE_CHANGED');
      }
      return completed;
    }
  };
}

/** 从可信临时句柄复制到可信目标句柄，并校验实际复制字节。 */
async function copyVerifiedArchive(
  source: FileHandle,
  destination: FileHandle,
  expected: ArchiveDigest
): Promise<void> {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  while (offset < expected.byteLength) {
    const result = await source.read(
      buffer,
      0,
      Math.min(buffer.byteLength, expected.byteLength - offset),
      offset
    );
    if (result.bytesRead === 0) {
      throw packageError('CHARACTER_PACKAGE_EXPORT_SOURCE_CHANGED');
    }
    let written = 0;
    while (written < result.bytesRead) {
      const writeResult = await destination.write(
        buffer,
        written,
        result.bytesRead - written,
        offset + written
      );
      if (writeResult.bytesWritten === 0) {
        throw packageError('CHARACTER_PACKAGE_EXPORT_SOURCE_CHANGED');
      }
      written += writeResult.bytesWritten;
    }
    hash.update(buffer.subarray(0, result.bytesRead));
    offset += result.bytesRead;
  }
  if (hash.digest('hex') !== expected.sha256) {
    throw packageError('CHARACTER_PACKAGE_EXPORT_SOURCE_CHANGED');
  }
}

/** 从可信句柄重读并复核身份、大小和哈希。 */
async function assertHandleArchiveIdentity(
  handle: FileHandle,
  expected: ArchiveIdentity
): Promise<void> {
  try {
    const before = await handle.stat();
    if (
      !before.isFile()
      || !sameIdentity(expected, before)
      || before.size !== expected.byteLength
    ) {
      throw packageError('CHARACTER_PACKAGE_EXPORT_SOURCE_CHANGED');
    }
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < expected.byteLength) {
      const result = await handle.read(
        buffer,
        0,
        Math.min(buffer.byteLength, expected.byteLength - offset),
        offset
      );
      if (result.bytesRead === 0) {
        throw packageError('CHARACTER_PACKAGE_EXPORT_SOURCE_CHANGED');
      }
      offset += result.bytesRead;
      hash.update(buffer.subarray(0, result.bytesRead));
    }
    const after = await handle.stat();
    if (
      !after.isFile()
      || !sameIdentity(expected, after)
      || after.size !== expected.byteLength
      || hash.digest('hex') !== expected.sha256
    ) {
      throw packageError('CHARACTER_PACKAGE_EXPORT_SOURCE_CHANGED');
    }
  } catch (error) {
    if (
      error instanceof Error
      && error.message === 'CHARACTER_PACKAGE_EXPORT_SOURCE_CHANGED'
    ) {
      throw error;
    }
    throw packageError('CHARACTER_PACKAGE_EXPORT_SOURCE_CHANGED');
  }
}

/** 校验真正送入 ZIP 的流字节，不缓存完整素材。 */
function createVerifiedExportStream(file: ExportedDiskFile): Transform {
  const hash = createHash('sha256');
  let byteLength = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      byteLength += chunk.byteLength;
      if (byteLength > file.byteLength) {
        callback(packageError('CHARACTER_PACKAGE_EXPORT_SOURCE_CHANGED'));
        return;
      }
      hash.update(chunk);
      callback(undefined, chunk);
    },
    flush(callback) {
      if (
        byteLength !== file.byteLength
        || hash.digest('hex') !== file.sha256
      ) {
        callback(packageError('CHARACTER_PACKAGE_EXPORT_SOURCE_CHANGED'));
        return;
      }
      callback();
    }
  });
}

/** 适配 yazl 未完整声明的运行时 EventEmitter 与 Node Readable 能力。 */
function forwardArchiveError(archive: ZipFile): void {
  const output = archive.outputStream as unknown as Readable;
  (archive as unknown as {
    once(event: 'error', listener: (error: Error) => void): void;
  }).once('error', error => output.destroy(error));
}

function destroyArchiveOutput(archive: ZipFile, error: Error): void {
  (archive.outputStream as unknown as Readable).destroy(error);
}

function addPackageBytes(
  current: number,
  additional: number,
  limit: number
): number {
  if (!Number.isSafeInteger(additional) || additional < 0) {
    throw packageError('CHARACTER_PACKAGE_RESOURCE_INVALID');
  }
  const total = current + additional;
  if (!Number.isSafeInteger(total) || total > limit) {
    throw packageError('CHARACTER_PACKAGE_TOTAL_BYTES_EXCEEDED');
  }
  return total;
}

function extractedPath(
  files: ExtractedFiles,
  archivePath: string
): string {
  const extracted = files.get(archivePath);
  if (!extracted) {
    throw packageError('CHARACTER_PACKAGE_STRUCTURE_INVALID');
  }
  return extracted.flatPath;
}

async function preparePackage(
  entries: readonly ScannedEntry[],
  files: ExtractedFiles,
  geometryMigration: CharacterGeometryMigrationDependencies
): Promise<PreparedPackage> {
  let draftResult: ReturnType<typeof migrateCharacterDocument>;
  let manifestResult: ReturnType<typeof prepareCharacterManifestMigration>;
  try {
    draftResult = migrateCharacterDocument(
      await readJson(extractedPath(files, 'draft/draft.json'))
    );
    manifestResult = prepareCharacterManifestMigration(
      await readJson(extractedPath(files, 'compiled/manifest.json'))
    );
  } catch {
    throw packageError('CHARACTER_PACKAGE_INVALID');
  }
  const sourceResult = characterSourceCatalogV1Schema.safeParse(
    await readJson(extractedPath(files, 'source/catalog.json'))
  );
  if (
    !sourceResult.success
    || draftResult.sourceVersion !== manifestResult.sourceVersion
  ) {
    throw packageError('CHARACTER_PACKAGE_INVALID');
  }
  const draft = draftResult.document;
  const sourceCatalog = sourceResult.data;
  const packageFiles = new Map<string, CharacterPackageFileMetadata>(
    entries
    .filter(entry => entry.descriptor.kind === 'file')
    .map(entry => {
      const path = entry.normalizedPath;
      const lowerPath = path.toLocaleLowerCase('en-US');
      const metadata: CharacterPackageFileMetadata = lowerPath.endsWith('.json')
        ? { path, kind: 'json' }
        : {
            path,
            kind: 'image',
            mime: lowerPath.endsWith('.png') ? 'image/png' : 'image/webp'
          };
      return [path, metadata];
    })
  );

  const runtimeAssets: Record<string, Uint8Array> = {};
  for (const resource of manifestResult.document.resources) {
    const path = `compiled/${resource.fileName}`;
    const bytes = await readRegularFile(
      extractedPath(files, path)
    );
    const actualSha256 = sha256(bytes);
    // Alpha 解码只接收已经由清单长度与摘要共同验证的可信资源。
    if (
      bytes.byteLength !== resource.byteLength
      || actualSha256 !== resource.sha256
    ) {
      throw packageError('CHARACTER_PACKAGE_RESOURCE_INVALID');
    }
    const lowerName = resource.fileName.toLocaleLowerCase('en-US');
    packageFiles.set(path, {
      path,
      kind: lowerName.endsWith('.json') ? 'json' : 'image',
      ...(lowerName.endsWith('.json')
        ? {}
        : {
            mime: lowerName.endsWith('.png')
              ? 'image/png' as const
              : 'image/webp' as const
      }),
      byteLength: bytes.byteLength,
      sha256: actualSha256
    });
    runtimeAssets[resource.fileName] = bytes;
  }
  let manifest: CharacterManifestV2;
  try {
    manifest = (await finalizeCharacterManifestMigration(
      manifestResult,
      runtimeAssets,
      geometryMigration
    )).document;
  } catch {
    throw packageError('CHARACTER_PACKAGE_INVALID');
  }

  for (const source of sourceCatalog.sources) {
    const fileName = characterSourceFileName(source);
    const path = `source/${fileName}`;
    const bytes = await readRegularFile(
      extractedPath(files, path)
    );
    packageFiles.set(path, {
      path,
      kind: 'image',
      mime: source.mimeType,
      byteLength: bytes.byteLength,
      sha256: sha256(bytes)
    });
  }
  validateCharacterPackageStructure({
    draftId: draft.id,
    manifest,
    sourceCatalog,
    files: [...packageFiles.values()]
  });

  return {
    originalId: draft.id,
    draft,
    manifest,
    runtimeAssets,
    sourceCatalog,
    sourceVersion: draftResult.sourceVersion
  };
}

function importedId(originalId: string, existing: ReadonlySet<string>, createId: () => string): string {
  if (!existing.has(originalId)) return originalId;
  const prefix = originalId.slice(0, 101).replace(/[-_]+$/u, '') || 'character';
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = createId().toLocaleLowerCase('en-US').replace(/[^a-z0-9]/gu, '').slice(0, 12);
    const candidate = `${prefix}-import-${suffix}`;
    if (SAFE_CHARACTER_ID.test(candidate) && !existing.has(candidate)) {
      return candidate;
    }
  }
  throw packageError('CHARACTER_PACKAGE_ID_GENERATION_FAILED');
}

function isCharacterAlreadyExists(error: unknown): boolean {
  return error instanceof Error && error.message === 'CHARACTER_ALREADY_EXISTS';
}

async function validateSourcesInIsolation(
  stagingDirectory: string,
  prepared: PreparedPackage,
  files: ExtractedFiles
): Promise<void> {
  const validationRoot = join(stagingDirectory, '.source-validation');
  const characterDirectory = join(validationRoot, prepared.originalId);
  const sourceDirectory = join(characterDirectory, 'source');
  try {
    await Promise.all([
      mkdir(sourceDirectory, { recursive: true }),
      mkdir(join(characterDirectory, 'compiled'), { recursive: true })
    ]);
    for (const source of prepared.sourceCatalog.sources) {
      const fileName = characterSourceFileName(source);
      await copyFile(
        extractedPath(files, `source/${fileName}`),
        join(sourceDirectory, fileName)
      );
    }
    await writeFile(
      join(sourceDirectory, 'catalog.json'),
      jsonBytes(prepared.sourceCatalog),
      { flag: 'wx', mode: 0o600 }
    );
    const service = new CharacterAssetService(validationRoot);
    const sources = await service.listSources(prepared.originalId);
    for (const source of sources) {
      await service.readSource(prepared.originalId, source.assetId);
    }
  } finally {
    await rm(validationRoot, { recursive: true, force: true });
  }
}

/**
 * Electron Main 的角色包服务。ZIP 始终先在隔离目录完成策略、结构和内容校验。
 */
export class CharacterPackageService {
  private readonly store: CharacterStore;
  private readonly assetService: CharacterAssetService;
  private readonly temporaryDirectory: string;
  private readonly createId: () => string;
  private readonly archiveFactory: () => ZipFile;
  private readonly packageLimits: CharacterPackageLimits;
  private readonly recoveryNow: () => number;
  private readonly geometryMigration: CharacterGeometryMigrationDependencies;

  constructor(
    private readonly charactersDirectory: string,
    private readonly dependencies: CharacterPackageServiceDependencies = {}
  ) {
    this.store = dependencies.store ?? new CharacterStore(charactersDirectory);
    this.assetService = dependencies.assetService
      ?? new CharacterAssetService(charactersDirectory);
    this.temporaryDirectory = dependencies.temporaryDirectory ?? tmpdir();
    this.createId = dependencies.createId ?? randomUUID;
    this.archiveFactory = dependencies.archiveFactory ?? (() => new ZipFile());
    this.recoveryNow = dependencies.recoveryNow ?? Date.now;
    this.geometryMigration = dependencies.geometryMigration ?? {
      decodeAlpha: async () => {
        throw packageError('CHARACTER_PACKAGE_RESOURCE_INVALID');
      }
    };
    this.packageLimits = {
      ...CHARACTER_PACKAGE_LIMITS,
      ...dependencies.packageLimits
    };
  }

  private rollbackMarker(characterId: string): string {
    return join(
      this.charactersDirectory,
      `.package-import-rollback-${characterId}.json`
    );
  }

  initialize(): Promise<CharacterPackageRecoveryReport> {
    return this.enqueueImport(() => this.recoverPendingRollbacks());
  }

  private enqueueImport<T>(operation: () => Promise<T>): Promise<T> {
    const absoluteRoot = resolve(this.charactersDirectory);
    const queueKey = process.platform === 'win32'
      ? absoluteRoot.toLocaleLowerCase('en-US')
      : absoluteRoot;
    const previous = packageImportQueues.get(queueKey) ?? Promise.resolve();
    const transaction = previous.then(operation);
    const tail = transaction.then(() => undefined, () => undefined);
    packageImportQueues.set(queueKey, tail);
    void tail.then(() => {
      if (packageImportQueues.get(queueKey) === tail) {
        packageImportQueues.delete(queueKey);
      }
    });
    return transaction;
  }

  private async writePendingImport(
    characterId: string,
    importTransactionId: string
  ): Promise<ImportMarkerIdentity> {
    const marker = this.rollbackMarker(characterId);
    const bytes = jsonBytes({
      version: 3,
      characterId,
      importTransactionId
    });
    await atomicWriteFileExclusive(
      marker,
      bytes
    );
    const snapshot = await this.readOwnedMarker(marker);
    if (!snapshot.bytes.equals(bytes)) {
      throw packageError('CHARACTER_PACKAGE_ROLLBACK_FAILED');
    }
    return snapshot.identity;
  }

  /** marker 字节和物理身份必须来自同一只普通文件句柄。 */
  private async readOwnedMarker(
    marker: string
  ): Promise<{ bytes: Buffer; identity: ImportMarkerIdentity }> {
    let handle: FileHandle | undefined;
    try {
      const pathStats = await lstat(marker);
      if (pathStats.isSymbolicLink() || !pathStats.isFile()) {
        throw packageError('CHARACTER_PACKAGE_ROLLBACK_FAILED');
      }
      handle = await open(marker, 'r');
      const before = await handle.stat();
      if (
        !before.isFile()
        || !sameIdentity(pathStats, before)
        || before.size > MAX_IMPORT_MARKER_BYTES
      ) {
        throw packageError('CHARACTER_PACKAGE_ROLLBACK_FAILED');
      }
      const identity = {
        dev: before.dev,
        ino: before.ino,
        size: before.size
      };
      const bytes = Buffer.alloc(MAX_IMPORT_MARKER_BYTES + 1);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const result = await handle.read(
          bytes,
          offset,
          bytes.byteLength - offset,
          offset
        );
        if (result.bytesRead === 0) break;
        offset += result.bytesRead;
      }
      const after = await handle.stat();
      if (
        !after.isFile()
        || !sameImportMarkerIdentity(identity, {
          dev: after.dev,
          ino: after.ino,
          size: after.size
        })
        || offset !== identity.size
      ) {
        throw packageError('CHARACTER_PACKAGE_ROLLBACK_FAILED');
      }
      return { bytes: bytes.subarray(0, offset), identity };
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async requireOwnedMarker(
    marker: string,
    expected: ImportMarkerIdentity
  ): Promise<void> {
    const current = (await this.readOwnedMarker(marker)).identity;
    if (!sameImportMarkerIdentity(expected, current)) {
      throw packageError('CHARACTER_PACKAGE_ROLLBACK_FAILED');
    }
  }

  private async completeOwnedMarker(
    marker: string,
    expected: ImportMarkerIdentity
  ): Promise<void> {
    const relocated = await this.relocateOwnedMarker(marker, expected);
    try {
      await rm(relocated);
    } catch (error) {
      await this.restoreRelocatedMarker(relocated, marker, error);
    }
  }

  /** 正式名只能通过排他 hard link 恢复；双故障留下不可执行证据。 */
  private async restoreRelocatedMarker(
    relocated: string,
    marker: string,
    cause: unknown
  ): Promise<never> {
    try {
      await link(relocated, marker);
    } catch {
      console.error('CHARACTER_IMPORT_RECOVERY_DETACHED_EVIDENCE');
      throw DETACHED_MARKER_EVIDENCE;
    }
    throw cause;
  }

  /** 先移走路径再复核，避免复核后的原路径替代文件被误删。 */
  private async relocateOwnedMarker(
    marker: string,
    expected: ImportMarkerIdentity
  ): Promise<string> {
    const relocated = `${marker}.complete-${randomUUID()}.tmp`;
    await rename(marker, relocated);
    try {
      await this.requireOwnedMarker(relocated, expected);
    } catch (error) {
      await this.restoreRelocatedMarker(relocated, marker, error);
    }
    return relocated;
  }

  private async preserveMarkerEvidence(
    marker: string,
    bytes: Uint8Array,
    expected: ImportMarkerIdentity
  ): Promise<void> {
    await this.requireOwnedMarker(marker, expected);
    const evidence = `${marker}.corrupt-${randomUUID()}`;
    await atomicWriteFileExclusive(evidence, bytes);
    await this.completeOwnedMarker(marker, expected);
  }

  private async recoverPendingRollbacks(): Promise<CharacterPackageRecoveryReport> {
    let entries: Dirent<string>[];
    try {
      entries = await readdir(this.charactersDirectory, { withFileTypes: true });
    } catch {
      console.error('CHARACTER_IMPORT_RECOVERY_SCAN_FAILED');
      return immutableRecoveryReport([]);
    }

    let activeCharacterId: string | undefined;
    try {
      activeCharacterId = (await this.store.list())
        .find(character => character.active)?.id;
    } catch {
      console.error('CHARACTER_IMPORT_RECOVERY_SCAN_FAILED');
    }
    const candidates = entries
      .filter(entry => (
        entry.isFile()
        && entry.name.startsWith('.package-import-rollback-')
        && entry.name.endsWith('.json')
        && !['.tmp', '.corrupt-', '.complete-'].some(part => entry.name.includes(part))
      ))
      .map(entry => ({
        marker: join(this.charactersDirectory, entry.name),
        name: entry.name,
        characterId: ROLLBACK_MARKER_PATTERN.exec(entry.name)?.[1]
      }))
      .sort((left, right) => {
        const leftActive = activeCharacterId !== undefined && left.characterId === activeCharacterId;
        const rightActive = activeCharacterId !== undefined && right.characterId === activeCharacterId;
        if (leftActive !== rightActive) return leftActive ? -1 : 1;
        return left.name.localeCompare(right.name, 'en-US');
      });
    if (candidates.length > MAX_IMPORT_RECOVERY_ENTRIES) {
      console.error('CHARACTER_IMPORT_RECOVERY_LIMIT_REACHED');
    }
    const inventory = candidates.slice(0, MAX_IMPORT_RECOVERY_ENTRIES);
    const startedAt = this.recoveryNow();
    const issues: CharacterPackageRecoveryIssue[] = [];

    for (const [index, item] of inventory.entries()) {
      if (
        index > 0
        && this.recoveryNow() - startedAt >= IMPORT_RECOVERY_BUDGET_MS
      ) {
        appendRecoveryIssue(issues, item.characterId, 'CHARACTER_IMPORT_RECOVERY_DEFERRED');
        continue;
      }

      try {
        const snapshot = await this.readOwnedMarker(item.marker);
        let document: CharacterPackageImportMarkerV3 | undefined;
        try {
          const decoded = JSON.parse(snapshot.bytes.toString('utf8')) as unknown;
          const parsed = characterPackageImportMarkerV3Schema.safeParse(decoded);
          if (
            parsed.success
            && parsed.data.characterId === item.characterId
          ) {
            document = parsed.data;
          }
        } catch {
          document = undefined;
        }

        if (!document) {
          await this.preserveMarkerEvidence(
            item.marker,
            snapshot.bytes,
            snapshot.identity
          );
          appendRecoveryIssue(issues, item.characterId, 'CHARACTER_IMPORT_RECOVERY_BLOCKED');
          continue;
        }

        await this.requireOwnedMarker(item.marker, snapshot.identity);
        const result = await this.store.rollbackImportedCharacter(
          document.characterId,
          document.importTransactionId
        );
        switch (result.kind) {
          case 'rolled-back':
          case 'absent':
            await this.completeOwnedMarker(item.marker, snapshot.identity);
            break;
          case 'ownership-mismatch':
          case 'active-character':
            await this.preserveMarkerEvidence(
              item.marker,
              snapshot.bytes,
              snapshot.identity
            );
            issues.push({
              characterId: document.characterId,
              errorCode: 'CHARACTER_IMPORT_RECOVERY_BLOCKED'
            });
            break;
        }
      } catch (error) {
        if (error === DETACHED_MARKER_EVIDENCE) continue;
        if (item.characterId) console.error('CHARACTER_IMPORT_RECOVERY_ITEM_FAILED');
        appendRecoveryIssue(issues, item.characterId, 'CHARACTER_IMPORT_RECOVERY_BLOCKED');
      }
    }
    return immutableRecoveryReport(issues);
  }

  /** 以临时与目标 FileHandle 为信任根流式写入，拒绝信任路径替换。 */
  private async writeArchive(
    destination: string,
    archive: ZipFile,
    startStreams?: () => void
  ): Promise<void> {
    const stagingDirectory = await mkdtemp(
      join(dirname(destination), '.character-export-')
    );
    await chmod(stagingDirectory, 0o700);
    const stagingIdentity = await captureDirectoryIdentity(stagingDirectory);
    const temporaryDestination = join(stagingDirectory, 'archive.tmp');
    let temporaryHandle: FileHandle | undefined;
    let temporaryIdentity: PathIdentity | undefined;
    let destinationHandle: FileHandle | undefined;
    let destinationIdentity: PathIdentity | undefined;
    let committed = false;
    try {
      temporaryHandle = await open(
        temporaryDestination,
        'wx+',
        0o600
      );
      temporaryIdentity = await captureHandleIdentity(temporaryHandle);
      const archiveWriter = createHandleArchiveWriter(temporaryHandle);
      forwardArchiveError(archive);
      const transfer = pipeline(
        archive.outputStream,
        archiveWriter.stream
      );
      startStreams?.();
      archive.end();
      await transfer;
      const archiveIdentity: ArchiveIdentity = {
        ...temporaryIdentity,
        ...archiveWriter.digest()
      };
      await assertHandleArchiveIdentity(temporaryHandle, archiveIdentity);
      await this.dependencies.onCheckpoint?.(
        'export:after-temp-write',
        stagingDirectory,
        destination
      );
      await assertHandleArchiveIdentity(temporaryHandle, archiveIdentity);
      await assertPathIdentity(temporaryDestination, temporaryIdentity);
      await this.dependencies.onCheckpoint?.(
        'export:before-commit',
        stagingDirectory,
        destination
      );
      await assertHandleArchiveIdentity(temporaryHandle, archiveIdentity);
      await assertPathIdentity(temporaryDestination, temporaryIdentity);
      await this.dependencies.onCheckpoint?.(
        'export:before-link',
        stagingDirectory,
        destination
      );
      await assertHandleArchiveIdentity(temporaryHandle, archiveIdentity);
      await assertPathIdentity(temporaryDestination, temporaryIdentity);
      try {
        destinationHandle = await open(destination, 'wx+', 0o600);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
          throw packageError('CHARACTER_PACKAGE_DESTINATION_EXISTS');
        }
        throw error;
      }
      destinationIdentity = await captureHandleIdentity(destinationHandle);
      await copyVerifiedArchive(
        temporaryHandle,
        destinationHandle,
        archiveIdentity
      );
      await this.dependencies.onCheckpoint?.(
        'export:after-destination-write',
        stagingDirectory,
        destination
      );
      await assertHandleArchiveIdentity(destinationHandle, {
        ...destinationIdentity,
        byteLength: archiveIdentity.byteLength,
        sha256: archiveIdentity.sha256
      });
      await assertPathIdentity(destination, destinationIdentity);
      committed = true;
    } finally {
      try {
        if (!committed && destinationHandle !== undefined) {
          await invalidateHandle(destinationHandle);
        }
        if (temporaryHandle !== undefined) {
          await invalidateHandle(temporaryHandle);
        }
        if (!committed && destinationHandle !== undefined) {
          await this.dependencies.onCheckpoint?.(
            'export:cleanup-verified',
            stagingDirectory,
            destination
          );
        }
      } finally {
        await destinationHandle?.close().catch(() => undefined);
        await temporaryHandle?.close().catch(() => undefined);
        if (temporaryIdentity !== undefined) {
          cleanupPrivateExportStaging(
            stagingIdentity,
            temporaryDestination,
            temporaryIdentity
          );
        }
      }
    }
  }

  async exportCharacter(characterId: string, destination: string): Promise<void> {
    const draft = await this.store.getDraft(characterId);
    const manifest = await this.store.getPublishedManifest(characterId);
    const sources = await this.assetService.listSources(characterId);
    const draftDocument = jsonBytes(draft);
    const sourceDocument = jsonBytes({ version: 1, characterId, sources });
    const manifestDocument = jsonBytes(manifest);
    const documents = [draftDocument, sourceDocument, manifestDocument];
    if (documents.some(document => (
      document.byteLength > this.packageLimits.maxJsonBytes
    ))) {
      throw packageError('CHARACTER_PACKAGE_JSON_TOO_LARGE');
    }

    const fileCount = 3 + sources.length + manifest.resources.length;
    if (
      fileCount > this.packageLimits.maxFiles
      || fileCount > this.packageLimits.maxEntries
    ) {
      throw packageError('CHARACTER_PACKAGE_FILE_COUNT_EXCEEDED');
    }
    let totalBytes = 0;
    for (const document of documents) {
      totalBytes = addPackageBytes(
        totalBytes,
        document.byteLength,
        this.packageLimits.maxTotalUncompressedBytes
      );
    }
    for (const byteLength of [
      ...sources.map(source => source.byteLength),
      ...manifest.resources.map(resource => resource.byteLength)
    ]) {
      if (byteLength > this.packageLimits.maxResourceBytes) {
        throw packageError('CHARACTER_PACKAGE_RESOURCE_TOO_LARGE');
      }
      totalBytes = addPackageBytes(
        totalBytes,
        byteLength,
        this.packageLimits.maxTotalUncompressedBytes
      );
    }

    const diskFiles: ExportedDiskFile[] = [];
    const resourceStreams: Readable[] = [];
    const startResourceStreams: Array<() => void> = [];
    const characterRoot = resolve(this.charactersDirectory, characterId);
    const sourceRoot = resolve(characterRoot, 'source');
    const compiledRoot = resolve(characterRoot, 'compiled');
    try {
      for (const source of sources) {
        const archivePath = `source/${characterSourceFileName(source)}`;
        const diskPath = resolve(sourceRoot, characterSourceFileName(source));
        if (!isContained(sourceRoot, diskPath)) {
          throw packageError('CHARACTER_PACKAGE_EXPORT_PATH_UNSAFE');
        }
        const verified = await openVerifiedRegularFile(
          diskPath,
          this.packageLimits.maxResourceBytes
        );
        const file = { archivePath, diskPath, ...verified };
        diskFiles.push(file);
        if (
          file.byteLength !== source.byteLength
          || file.sha256 !== source.sha256
        ) {
          throw packageError('CHARACTER_PACKAGE_RESOURCE_INVALID');
        }
        await runExportResourceCheckpoint(
          this.dependencies.onCheckpoint,
          characterRoot,
          diskPath
        );
      }

      for (const resource of manifest.resources) {
        const archivePath = `compiled/${resource.fileName}`;
        const diskPath = resolve(compiledRoot, resource.fileName);
        if (!isContained(compiledRoot, diskPath)) {
          throw packageError('CHARACTER_PACKAGE_EXPORT_PATH_UNSAFE');
        }
        const verified = await openVerifiedRegularFile(
          diskPath,
          this.packageLimits.maxResourceBytes
        );
        const file = { archivePath, diskPath, ...verified };
        diskFiles.push(file);
        if (
          file.byteLength !== resource.byteLength
          || file.sha256 !== resource.sha256
        ) {
          throw packageError('CHARACTER_PACKAGE_RESOURCE_INVALID');
        }
        await runExportResourceCheckpoint(
          this.dependencies.onCheckpoint,
          characterRoot,
          diskPath
        );
      }

      const archive = this.archiveFactory();
      archive.addBuffer(draftDocument, 'draft/draft.json');
      archive.addBuffer(sourceDocument, 'source/catalog.json');
      archive.addBuffer(manifestDocument, 'compiled/manifest.json');
      for (const file of diskFiles) {
        const sourceStream = file.handle.createReadStream({
          start: 0,
          autoClose: true
        });
        const verifiedStream = createVerifiedExportStream(file);
        sourceStream.on('error', error => verifiedStream.destroy(error));
        verifiedStream.on(
          'error',
          error => destroyArchiveOutput(archive, error)
        );
        resourceStreams.push(sourceStream, verifiedStream);
        archive.addReadStream(
          verifiedStream,
          file.archivePath,
          { size: file.byteLength }
        );
        startResourceStreams.push(() => {
          sourceStream.pipe(verifiedStream);
        });
      }

      await this.writeArchive(destination, archive, () => {
        for (const startStream of startResourceStreams) startStream();
      });
    } finally {
      for (const stream of resourceStreams) {
        if (!stream.destroyed) stream.destroy();
      }
      await Promise.allSettled(
        resourceStreams.map(stream => finished(stream))
      );
      await Promise.allSettled(
        diskFiles.map(file => file.handle.close())
      );
    }
  }

  /**
   * 迁移失败时只归档原始草稿和通过目录、大小及哈希校验的源素材。
   * 恢复包不遍历角色目录，因此不会携带事务标记或未知文件。
   */
  async exportCharacterRecovery(
    characterId: string,
    destination: string
  ): Promise<void> {
    if (!SAFE_CHARACTER_ID.test(characterId)) {
      throw packageError('CHARACTER_PACKAGE_EXPORT_PATH_UNSAFE');
    }
    const charactersRoot = await captureDirectoryIdentity(
      resolve(this.charactersDirectory)
    );
    const characterRootPath = resolve(this.charactersDirectory, characterId);
    if (!isContained(charactersRoot.logicalPath, characterRootPath)) {
      throw packageError('CHARACTER_PACKAGE_EXPORT_PATH_UNSAFE');
    }
    const characterRoot = await captureDirectoryIdentity(
      characterRootPath,
      charactersRoot
    );
    const sources = await this.assetService.listSources(characterId);
    const sourceDocument = jsonBytes({ version: 1, characterId, sources });
    if (sourceDocument.byteLength > this.packageLimits.maxJsonBytes) {
      throw packageError('CHARACTER_PACKAGE_JSON_TOO_LARGE');
    }
    const fileCount = 2 + sources.length;
    if (
      fileCount > this.packageLimits.maxFiles
      || fileCount > this.packageLimits.maxEntries
    ) {
      throw packageError('CHARACTER_PACKAGE_FILE_COUNT_EXCEEDED');
    }
    let totalBytes = sourceDocument.byteLength;
    for (const source of sources) {
      if (source.byteLength > this.packageLimits.maxResourceBytes) {
        throw packageError('CHARACTER_PACKAGE_RESOURCE_TOO_LARGE');
      }
      totalBytes = addPackageBytes(
        totalBytes,
        source.byteLength,
        this.packageLimits.maxTotalUncompressedBytes
      );
    }

    const bufferFiles: ExportedBufferFile[] = [];
    {
      const draftRootPath = resolve(characterRootPath, 'draft');
      const draftRoot = await captureDirectoryIdentity(
        draftRootPath,
        characterRoot
      );
      const draftPath = resolve(draftRootPath, 'draft.json');
      const draft = await readVerifiedContainedSnapshot(
        draftRoot,
        characterRoot,
        draftPath,
        this.packageLimits.maxJsonBytes
      );
      bufferFiles.push({
        archivePath: 'recovery/original-draft.json',
        diskPath: draftPath,
        directory: draftRoot,
        ...draft
      });
      totalBytes = addPackageBytes(
        totalBytes,
        draft.byteLength,
        this.packageLimits.maxTotalUncompressedBytes
      );

      const sourceRoot = resolve(characterRootPath, 'source');
      if (!isContained(characterRootPath, sourceRoot)) {
        throw packageError('CHARACTER_PACKAGE_EXPORT_PATH_UNSAFE');
      }
      const sourceRootIdentity = await captureDirectoryIdentity(
        sourceRoot,
        characterRoot
      );
      for (const source of sources) {
        await assertDirectoryIdentity(sourceRootIdentity, characterRoot);
        const archivePath = `source/${characterSourceFileName(source)}`;
        const diskPath = resolve(sourceRoot, characterSourceFileName(source));
        if (!isContained(sourceRoot, diskPath)) {
          throw packageError('CHARACTER_PACKAGE_EXPORT_PATH_UNSAFE');
        }
        const verified = await readVerifiedContainedSnapshot(
          sourceRootIdentity,
          characterRoot,
          diskPath,
          this.packageLimits.maxResourceBytes
        );
        const file = {
          archivePath,
          diskPath,
          directory: sourceRootIdentity,
          ...verified
        };
        bufferFiles.push(file);
        if (
          file.byteLength !== source.byteLength
          || file.sha256 !== source.sha256
        ) {
          throw packageError('CHARACTER_PACKAGE_RESOURCE_INVALID');
        }
        await runExportResourceCheckpoint(
          this.dependencies.onCheckpoint,
          characterRootPath,
          diskPath
        );
      }

      try {
        await assertDirectoryIdentity(characterRoot, charactersRoot);
      } catch {
        throw packageError('CHARACTER_PACKAGE_EXPORT_SOURCE_CHANGED');
      }
      for (const file of bufferFiles) {
        await assertExportSnapshotIdentity(file, characterRoot);
      }

      const archive = this.archiveFactory();
      archive.addBuffer(sourceDocument, 'source/catalog.json');
      for (const file of bufferFiles) {
        archive.addBuffer(file.bytes, file.archivePath);
      }

      await this.writeArchive(destination, archive);
    }
  }

  importCharacter(packagePath: string): Promise<string> {
    return this.enqueueImport(() => this.importCharacterUnlocked(packagePath));
  }

  private async importCharacterUnlocked(packagePath: string): Promise<string> {
    const recoveryReport = await this.recoverPendingRollbacks();
    const blockedCharacters = new Set(
      recoveryReport.issues
        .filter(issue => issue.errorCode === 'CHARACTER_IMPORT_RECOVERY_BLOCKED')
        .map(issue => issue.characterId)
    );
    await mkdir(this.temporaryDirectory, { recursive: true });
    const temporaryRootIdentity = await captureDirectoryIdentity(
      this.temporaryDirectory
    );
    const stagingDirectory = await mkdtemp(
      join(this.temporaryDirectory, IMPORT_STAGING_PREFIX)
    );
    const stagingIdentity = await captureDirectoryIdentity(
      stagingDirectory,
      temporaryRootIdentity
    );
    await assertDirectoryIdentity(stagingIdentity, temporaryRootIdentity);
    const entriesPath = join(stagingDirectory, 'entries');
    await mkdir(entriesPath, { recursive: false });
    await assertDirectoryIdentity(stagingIdentity, stagingIdentity);
    const entriesIdentity = await captureDirectoryIdentity(
      entriesPath,
      stagingIdentity
    );
    let createdId: string | undefined;
    let importTransactionId: string | undefined;
    let ownsCreatedRole = false;
    let markerIdentity: ImportMarkerIdentity | undefined;
    try {
      // 第一遍只做元数据策略校验，验证通过后第二遍才允许写入隔离目录。
      const entries = await scanArchive(packagePath);
      const extractedFiles = await extractArchive(
        packagePath,
        stagingIdentity,
        entriesIdentity,
        entries,
        this.dependencies.onCheckpoint
      );
      const prepared = await preparePackage(
        entries,
        extractedFiles,
        this.geometryMigration
      );
      await validateSourcesInIsolation(
        stagingDirectory,
        prepared,
        extractedFiles
      );
      await this.dependencies.onCheckpoint?.('import:validated', stagingDirectory);

      const existing = new Set((await this.store.list()).map(character => character.id));
      for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
        createdId = importedId(prepared.originalId, existing, this.createId);
        importTransactionId = randomUUID();
        if (blockedCharacters.has(createdId)) {
          throw packageError('CHARACTER_PACKAGE_ROLLBACK_FAILED');
        }
        try {
          markerIdentity = await this.writePendingImport(
            createdId,
            importTransactionId
          );
        } catch (error) {
          throw packageError('CHARACTER_PACKAGE_ROLLBACK_FAILED');
        }
        try {
          await this.store.create(
            { id: createdId, name: prepared.draft.name },
            { importTransactionId }
          );
          ownsCreatedRole = true;
          break;
        } catch (error) {
          if (!isCharacterAlreadyExists(error)) throw error;
          await this.completeOwnedMarker(
            this.rollbackMarker(createdId),
            markerIdentity
          );
          markerIdentity = undefined;
          existing.add(createdId);
        }
      }
      if (
        !ownsCreatedRole
        || createdId === undefined
        || importTransactionId === undefined
        || markerIdentity === undefined
      ) {
        throw packageError('CHARACTER_PACKAGE_ID_GENERATION_FAILED');
      }

      const sourceDirectory = resolve(this.charactersDirectory, createdId, 'source');
      const characterDirectory = resolve(this.charactersDirectory, createdId);
      if (!isContained(characterDirectory, sourceDirectory)) {
        throw packageError('CHARACTER_PACKAGE_IMPORT_PATH_UNSAFE');
      }
      const nextSourceCatalog: CharacterSourceCatalogV1 = {
        ...prepared.sourceCatalog,
        characterId: createdId
      };
      for (const source of prepared.sourceCatalog.sources) {
        const fileName = characterSourceFileName(source);
        await copyFile(
          extractedPath(extractedFiles, `source/${fileName}`),
          join(sourceDirectory, fileName)
        );
      }
      await writeFile(
        join(sourceDirectory, 'catalog.json'),
        jsonBytes(nextSourceCatalog),
        { flag: 'wx', mode: 0o600 }
      );
      const installedSources = await this.assetService.listSources(createdId);
      for (const source of installedSources) {
        await this.assetService.readSource(createdId, source.assetId);
      }

      await this.store.saveDraft(createdId, {
        ...prepared.draft,
        id: createdId
      });
      await this.store.publishCompiled(
        createdId,
        { ...prepared.manifest, id: createdId },
        prepared.runtimeAssets
      );
      if (!await this.store.completeImportedCharacter(
        createdId,
        importTransactionId
      )) {
        throw packageError('CHARACTER_PACKAGE_ROLLBACK_FAILED');
      }
      await this.completeOwnedMarker(
        this.rollbackMarker(createdId),
        markerIdentity
      );
      return createdId;
    } catch (error) {
      if (
        createdId !== undefined
        && importTransactionId !== undefined
        && markerIdentity !== undefined
      ) {
        try {
          const result = await this.store.rollbackImportedCharacter(
            createdId,
            importTransactionId
          );
          if (result.kind !== 'rolled-back' && result.kind !== 'absent') {
            throw packageError('CHARACTER_PACKAGE_ROLLBACK_FAILED');
          }
          await this.completeOwnedMarker(
            this.rollbackMarker(createdId),
            markerIdentity
          );
        } catch {
          throw packageError('CHARACTER_PACKAGE_ROLLBACK_FAILED');
        }
      }
      throw error;
    }
  }
}
