import { createHash, randomUUID } from 'node:crypto';
import {
  lstatSync,
  readdirSync,
  realpathSync,
  rmSync
} from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
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
  validatePackageEntries,
  type CharacterPackageLimits,
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
  migrateCharacterDocument,
  migrateCharacterManifest
} from './character-migrations';
import { CharacterStore } from './character-store';

const SAFE_CHARACTER_ID = /^[a-z0-9][a-z0-9_-]{0,119}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA_256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_CREATE_ATTEMPTS = 32;
const ROLLBACK_MARKER_PATTERN =
  /^\.package-import-rollback-([a-z0-9][a-z0-9_-]{0,119})\.json$/u;
const packageImportQueues = new Map<string, Promise<void>>();

const sourceCatalogSchema = z.object({
  version: z.literal(1),
  characterId: z.string().regex(SAFE_CHARACTER_ID),
  sources: z.array(z.object({
    assetId: z.string().regex(UUID_PATTERN),
    displayName: z.string().min(1).max(255),
    mimeType: z.enum(['image/png', 'image/webp']),
    byteLength: z.number().int().safe().nonnegative(),
    sha256: z.string().regex(SHA_256_PATTERN)
  }).strict()).max(2_000)
}).strict().superRefine((catalog, context) => {
  const ids = new Set<string>();
  catalog.sources.forEach((source, index) => {
    if (ids.has(source.assetId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: '源素材标识必须唯一。',
        path: ['sources', index, 'assetId']
      });
    }
    ids.add(source.assetId);
  });
});

type SourceCatalog = z.output<typeof sourceCatalogSchema>;

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
  sourceCatalog: SourceCatalog;
  sourceVersion: 1 | 2;
};

type DirectoryIdentity = {
  logicalPath: string;
  physicalPath: string;
  dev: number;
  ino: number;
};

type CharacterOwnership = {
  characterId: string;
  physicalPath: string;
  dev: number;
  ino: number;
  draftSha256: string;
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

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
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

async function captureCharacterOwnership(
  charactersDirectory: string,
  characterId: string
): Promise<CharacterOwnership> {
  if (!SAFE_CHARACTER_ID.test(characterId)) {
    throw packageError('CHARACTER_PACKAGE_ROLLBACK_FAILED');
  }
  const root = await captureDirectoryIdentity(charactersDirectory);
  const characterPath = resolve(charactersDirectory, characterId);
  if (!isContained(root.logicalPath, characterPath)) {
    throw packageError('CHARACTER_PACKAGE_ROLLBACK_FAILED');
  }
  const character = await captureDirectoryIdentity(characterPath, root);
  const draftPath = resolve(characterPath, 'draft', 'draft.json');
  let before;
  let draftPhysicalPath: string;
  try {
    before = await lstat(draftPath);
    draftPhysicalPath = await realpath(draftPath);
  } catch {
    throw packageError('CHARACTER_PACKAGE_ROLLBACK_FAILED');
  }
  if (
    before.isSymbolicLink()
    || !before.isFile()
    || !isContained(character.physicalPath, draftPhysicalPath)
  ) {
    throw packageError('CHARACTER_PACKAGE_ROLLBACK_FAILED');
  }
  const draft = await readFile(draftPath);
  let after;
  let completedPhysicalPath: string;
  try {
    after = await lstat(draftPath);
    completedPhysicalPath = await realpath(draftPath);
  } catch {
    throw packageError('CHARACTER_PACKAGE_ROLLBACK_FAILED');
  }
  if (
    !after.isFile()
    || !sameIdentity(before, after)
    || completedPhysicalPath !== draftPhysicalPath
  ) {
    throw packageError('CHARACTER_PACKAGE_ROLLBACK_FAILED');
  }
  return {
    characterId,
    physicalPath: character.physicalPath,
    dev: character.dev,
    ino: character.ino,
    draftSha256: sha256(draft)
  };
}

function sameCharacterOwnership(
  expected: CharacterOwnership,
  current: CharacterOwnership
): boolean {
  return (
    expected.characterId === current.characterId
    && expected.physicalPath === current.physicalPath
    && expected.dev === current.dev
    && expected.ino === current.ino
    && expected.draftSha256 === current.draftSha256
  );
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

function sourceFileName(source: SourceCatalog['sources'][number]): string {
  return `${source.assetId}${source.mimeType === 'image/png' ? '.png' : '.webp'}`;
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
  files: ExtractedFiles
): Promise<PreparedPackage> {
  let draftResult: ReturnType<typeof migrateCharacterDocument>;
  let manifestResult: ReturnType<typeof migrateCharacterManifest>;
  try {
    draftResult = migrateCharacterDocument(
      await readJson(extractedPath(files, 'draft/draft.json'))
    );
    manifestResult = migrateCharacterManifest(
      await readJson(extractedPath(files, 'compiled/manifest.json'))
    );
  } catch {
    throw packageError('CHARACTER_PACKAGE_INVALID');
  }
  const sourceResult = sourceCatalogSchema.safeParse(
    await readJson(extractedPath(files, 'source/catalog.json'))
  );
  if (
    !sourceResult.success
    || draftResult.sourceVersion !== manifestResult.sourceVersion
  ) {
    throw packageError('CHARACTER_PACKAGE_INVALID');
  }
  const draft = draftResult.document;
  const manifest = manifestResult.document;
  const sourceCatalog = sourceResult.data;
  if (
    draft.id !== manifest.id
    || draft.id !== sourceCatalog.characterId
  ) {
    throw packageError('CHARACTER_PACKAGE_ID_MISMATCH');
  }

  const expectedFiles = new Set([
    'draft/draft.json',
    'compiled/manifest.json',
    'source/catalog.json',
    ...manifest.resources.map(resource => `compiled/${resource.fileName}`),
    ...sourceCatalog.sources.map(source => `source/${sourceFileName(source)}`)
  ]);
  const actualFiles = entries
    .filter(entry => entry.descriptor.kind === 'file')
    .map(entry => entry.normalizedPath);
  if (
    actualFiles.length !== expectedFiles.size
    || actualFiles.some(path => !expectedFiles.has(path))
  ) {
    throw packageError('CHARACTER_PACKAGE_STRUCTURE_INVALID');
  }

  const runtimeAssets: Record<string, Uint8Array> = {};
  for (const resource of manifest.resources) {
    const bytes = await readRegularFile(
      extractedPath(files, `compiled/${resource.fileName}`)
    );
    if (
      bytes.byteLength !== resource.byteLength
      || sha256(bytes) !== resource.sha256
    ) {
      throw packageError('CHARACTER_PACKAGE_RESOURCE_INVALID');
    }
    runtimeAssets[resource.fileName] = bytes;
  }

  for (const source of sourceCatalog.sources) {
    const fileName = sourceFileName(source);
    const bytes = await readRegularFile(
      extractedPath(files, `source/${fileName}`)
    );
    if (
      bytes.byteLength !== source.byteLength
      || sha256(bytes) !== source.sha256
    ) {
      throw packageError('CHARACTER_PACKAGE_RESOURCE_INVALID');
    }
  }

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
      const fileName = sourceFileName(source);
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

  initialize(): Promise<void> {
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
  ): Promise<void> {
    await writeFile(
      this.rollbackMarker(characterId),
      jsonBytes({
        version: 3,
        characterId,
        importTransactionId
      }),
      { flag: 'wx', mode: 0o600 }
    );
  }

  private async recoverPendingRollbacks(): Promise<void> {
    let entries;
    try {
      entries = await readdir(this.charactersDirectory, {
        withFileTypes: true
      });
    } catch (error) {
      if (isMissing(error)) return;
      throw packageError('CHARACTER_PACKAGE_ROLLBACK_FAILED');
    }
    try {
      const existing = new Set(
        (await this.store.list()).map(character => character.id)
      );
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const match = ROLLBACK_MARKER_PATTERN.exec(entry.name);
        if (!match) continue;
        const characterId = match[1]!;
        const marker = this.rollbackMarker(characterId);
        const document = JSON.parse(await readFile(marker, 'utf8')) as unknown;
        if (
          typeof document === 'object'
          && document !== null
          && 'version' in document
          && document.version === 3
          && 'characterId' in document
          && document.characterId === characterId
          && 'importTransactionId' in document
          && typeof document.importTransactionId === 'string'
          && UUID_PATTERN.test(document.importTransactionId)
        ) {
          await this.store.rollbackImportedCharacter(
            characterId,
            document.importTransactionId
          );
          await rm(marker, { force: true });
          continue;
        }
        if (
          typeof document === 'object'
          && document !== null
          && 'version' in document
          && document.version === 1
          && 'characterId' in document
          && document.characterId === characterId
        ) {
          await rm(marker, { force: true });
          continue;
        }
        if (
          typeof document !== 'object'
          || document === null
          || !('version' in document)
          || document.version !== 2
          || !('ownership' in document)
          || typeof document.ownership !== 'object'
          || document.ownership === null
        ) {
          throw packageError('CHARACTER_PACKAGE_ROLLBACK_FAILED');
        }
        const ownership = document.ownership as Partial<CharacterOwnership>;
        if (
          ownership.characterId !== characterId
          || typeof ownership.physicalPath !== 'string'
          || typeof ownership.dev !== 'number'
          || !Number.isFinite(ownership.dev)
          || !Number.isInteger(ownership.dev)
          || ownership.dev < 0
          || typeof ownership.ino !== 'number'
          || !Number.isFinite(ownership.ino)
          || !Number.isInteger(ownership.ino)
          || ownership.ino < 0
          || typeof ownership.draftSha256 !== 'string'
          || !SHA_256_PATTERN.test(ownership.draftSha256)
        ) {
          throw packageError('CHARACTER_PACKAGE_ROLLBACK_FAILED');
        }
        if (existing.has(characterId)) {
          const current = await captureCharacterOwnership(
            this.charactersDirectory,
            characterId
          );
          if (sameCharacterOwnership(
            ownership as CharacterOwnership,
            current
          )) {
            await this.store.delete(characterId);
            existing.delete(characterId);
          }
        }
        await rm(marker, { force: true });
      }
    } catch (error) {
      if (
        error instanceof Error
        && error.message === 'CHARACTER_PACKAGE_ROLLBACK_FAILED'
      ) {
        throw error;
      }
      throw packageError('CHARACTER_PACKAGE_ROLLBACK_FAILED');
    }
  }

  private async preserveRollback(
    ownership: CharacterOwnership
  ): Promise<never> {
    const characterId = ownership.characterId;
    const marker = this.rollbackMarker(characterId);
    try {
      await writeFile(
        marker,
        jsonBytes({ version: 2, ownership }),
        { flag: 'wx', mode: 0o600 }
      );
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
        throw packageError('CHARACTER_PACKAGE_ROLLBACK_FAILED');
      }
    }
    throw packageError('CHARACTER_PACKAGE_ROLLBACK_FAILED');
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
        const archivePath = `source/${sourceFileName(source)}`;
        const diskPath = resolve(sourceRoot, sourceFileName(source));
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
        const archivePath = `source/${sourceFileName(source)}`;
        const diskPath = resolve(sourceRoot, sourceFileName(source));
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
    await this.recoverPendingRollbacks();
    await mkdir(this.temporaryDirectory, { recursive: true });
    const stagingDirectory = await mkdtemp(
      join(this.temporaryDirectory, 'ai-pet-character-package-')
    );
    const stagingIdentity = await captureDirectoryIdentity(stagingDirectory);
    await assertDirectoryIdentity(stagingIdentity, stagingIdentity);
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
    let ownership: CharacterOwnership | undefined;
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
      const prepared = await preparePackage(entries, extractedFiles);
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
        try {
          await this.writePendingImport(createdId, importTransactionId);
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
            existing.add(createdId);
            continue;
          }
          throw error;
        }
        try {
          await this.store.create(
            { id: createdId, name: prepared.draft.name },
            { importTransactionId }
          );
          ownsCreatedRole = true;
          ownership = await captureCharacterOwnership(
            this.charactersDirectory,
            createdId
          );
          break;
        } catch (error) {
          await rm(this.rollbackMarker(createdId), { force: true });
          if (!isCharacterAlreadyExists(error)) throw error;
          existing.add(createdId);
        }
      }
      if (
        !ownsCreatedRole
        || createdId === undefined
        || importTransactionId === undefined
      ) {
        throw packageError('CHARACTER_PACKAGE_ID_GENERATION_FAILED');
      }

      const sourceDirectory = resolve(this.charactersDirectory, createdId, 'source');
      const characterDirectory = resolve(this.charactersDirectory, createdId);
      if (!isContained(characterDirectory, sourceDirectory)) {
        throw packageError('CHARACTER_PACKAGE_IMPORT_PATH_UNSAFE');
      }
      const nextSourceCatalog: SourceCatalog = {
        ...prepared.sourceCatalog,
        characterId: createdId
      };
      for (const source of prepared.sourceCatalog.sources) {
        const fileName = sourceFileName(source);
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
      ownership = await captureCharacterOwnership(
        this.charactersDirectory,
        createdId
      );
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
      await rm(this.rollbackMarker(createdId), { force: true });
      return createdId;
    } catch (error) {
      if (ownsCreatedRole && createdId !== undefined) {
        try {
          await this.store.delete(createdId);
          await rm(this.rollbackMarker(createdId), { force: true });
        } catch {
          const rollbackOwnership = ownership
            ?? await captureCharacterOwnership(
              this.charactersDirectory,
              createdId
            );
          await this.preserveRollback(rollbackOwnership);
        }
      }
      throw error;
    } finally {
      await rm(stagingDirectory, { recursive: true, force: true });
    }
  }
}
