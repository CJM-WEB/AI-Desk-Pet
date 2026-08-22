import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm
} from 'node:fs/promises';
import {
  basename,
  extname,
  isAbsolute,
  join,
  normalize,
  parse,
  relative,
  resolve
} from 'node:path';
import {
  CHARACTER_RESOURCE_LIMITS,
  parseCharacterImageMetadata,
  type CharacterImageMimeType as SharedCharacterImageMimeType
} from '@myself/character-assets';

export type CharacterImageMimeType = SharedCharacterImageMimeType;

export type SourceCatalogEntry = {
  assetId: string;
  displayName: string;
  mimeType: CharacterImageMimeType;
  byteLength: number;
  sha256: string;
};

export type ImportedSource = SourceCatalogEntry;

export type SaveCompiledInput = {
  assetId: string;
  mimeType: CharacterImageMimeType;
  bytes: Uint8Array;
  sourceChecksums: Record<string, string>;
  expectedPreviousSha256?: string;
  signal?: AbortSignal;
};

export type CharacterAssetOperationCheckpoint =
  | 'lock:after-create'
  | 'source:list-before-read'
  | 'source:before-stage'
  | 'source:after-temp-open'
  | 'source:before-commit'
  | 'source:before-read'
  | 'compiled:before-save'
  | 'compiled:after-temp-open'
  | 'compiled:before-install';

export type CharacterAssetServiceDependencies = {
  renamePath?: (source: string, destination: string) => Promise<void>;
  onCheckpoint?: (checkpoint: CharacterAssetOperationCheckpoint) => Promise<void>;
  now?: () => number;
  lockLeaseMs?: number;
  lockInitializationGraceMs?: number;
  lockHeartbeatIntervalMs?: number;
  scheduleLockHeartbeat?: (callback: () => void, intervalMs: number) => unknown;
  cancelLockHeartbeat?: (handle: unknown) => void;
};

type SourceCatalog = {
  version: 1;
  characterId: string;
  sources: SourceCatalogEntry[];
};

type CompiledResourceEntry = {
  assetId: string;
  mimeType: CharacterImageMimeType;
  byteLength: number;
  sha256: string;
  sourceChecksums: Record<string, string>;
};

type CompiledCatalog = {
  version: 1;
  characterId: string;
  resources: CompiledResourceEntry[];
};

type PathIdentity = {
  physicalPath: string;
  device: number;
  inode: number;
  kind: 'file' | 'directory';
};

type CharacterPaths = {
  lease: CharacterLeaseGuard;
  characterDirectory: string;
  characterIdentity: PathIdentity;
  sourceDirectory: string;
  sourceIdentity: PathIdentity;
  compiledDirectory: string;
  compiledIdentity: PathIdentity;
};

type CharacterLeaseGuard = {
  ownerToken: string;
  assertOwned: () => Promise<void>;
  release: () => Promise<void>;
};

// lost 只允许从 false 变为 true，后续心跳恢复也不能让旧持有者重新获得提交资格。
type CharacterLeaseState = {
  lost: boolean;
};

type PreparedSource = SourceCatalogEntry & {
  selectedPath: string;
  extension: '.png' | '.webp';
  bytes: Uint8Array;
};

type SourceTransactionMarker = {
  version: 1 | 2;
  phase: 'prepared' | 'installing' | 'catalog-committed';
  hadCatalog: boolean;
  ownerToken?: string;
  transactionId?: string;
  entries: Array<{
    assetId: string;
    extension: '.png' | '.webp';
  }>;
};

type CompiledTransactionMarker = {
  version: 1 | 2;
  phase: 'prepared' | 'previous-moved' | 'installed' | 'catalog-committed';
  hadCatalog: boolean;
  ownerToken?: string;
  transactionId?: string;
  assetId: string;
  previousExtension?: '.png' | '.webp';
  nextExtension: '.png' | '.webp';
};

type CharacterLockMarker = {
  version: 1;
  ownerToken: string;
  pid: number;
  createdAt: number;
  heartbeatAt: number;
};

const CHARACTER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,119}$/u;
const COMPILED_ASSET_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,119}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA_256_PATTERN = /^[a-f0-9]{64}$/u;
const SOURCE_CATALOG_FILE = 'catalog.json';
const COMPILED_CATALOG_FILE = 'catalog.json';
const SOURCE_TRANSACTION_DIRECTORY = '.source-import-transaction';
const COMPILED_TRANSACTION_DIRECTORY = '.compiled-save-transaction';
const LOCK_DIRECTORY = '.locks';
const LOCK_RECLAIM_ATTEMPTS = 4;
const DEFAULT_LOCK_LEASE_MS = 10_000;
const DEFAULT_LOCK_INITIALIZATION_GRACE_MS = 2_000;
const DEFAULT_LOCK_HEARTBEAT_INTERVAL_MS = 2_000;
const CATALOG_TEMP_PATTERN =
  /^catalog\.json\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/u;
const MAX_COMPILED_BYTES_PER_CHARACTER =
  CHARACTER_RESOURCE_LIMITS.maxTotalSourceBytesPerCharacter;
const characterQueues = new Map<string, Promise<void>>();

function characterError(code: string): Error {
  return new Error(code);
}

function isKnownCharacterError(cause: unknown): cause is Error {
  return cause instanceof Error && cause.message.startsWith('CHARACTER_');
}

function isMissingFile(cause: unknown): boolean {
  return cause instanceof Error
    && 'code' in cause
    && (cause.code === 'ENOENT' || cause.code === 'ENOTDIR');
}

function isExclusiveOpenConflict(cause: unknown): boolean {
  return cause instanceof Error
    && 'code' in cause
    && cause.code === 'EEXIST';
}

function parseCharacterLockMarker(value: unknown): CharacterLockMarker | undefined {
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, [
      'version',
      'ownerToken',
      'pid',
      'createdAt',
      'heartbeatAt'
    ])
    || value.version !== 1
    || !Number.isSafeInteger(value.pid)
    || (value.pid as number) < 1
    || typeof value.ownerToken !== 'string'
    || !UUID_PATTERN.test(value.ownerToken)
    || !Number.isFinite(value.createdAt)
    || (value.createdAt as number) < 0
    || !Number.isFinite(value.heartbeatAt)
    || (value.heartbeatAt as number) < (value.createdAt as number)
  ) {
    return undefined;
  }
  return value as CharacterLockMarker;
}

function normalizedPath(path: string): string {
  const normalized = normalize(path);
  return process.platform === 'win32'
    ? normalized.toLocaleLowerCase('en-US')
    : normalized;
}

function isContained(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === '' || (
    child !== '..'
    && !child.startsWith(`..${parse(candidate).root === '/' ? '/' : '\\'}`)
    && !isAbsolute(child)
  );
}

function sameIdentity(left: PathIdentity, right: PathIdentity): boolean {
  return left.kind === right.kind
    && left.device === right.device
    && left.inode === right.inode
    && normalizedPath(left.physicalPath) === normalizedPath(right.physicalPath);
}

function sameNodeIdentity(left: PathIdentity, right: PathIdentity): boolean {
  return left.kind === right.kind
    && left.device === right.device
    && left.inode === right.inode;
}

function extensionForMime(mimeType: CharacterImageMimeType): '.png' | '.webp' {
  return mimeType === 'image/png' ? '.png' : '.webp';
}

function mimeForExtension(extension: string): CharacterImageMimeType | undefined {
  if (extension === '.png') return 'image/png';
  if (extension === '.webp') return 'image/webp';
  return undefined;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('操作已取消。', 'AbortError');
  }
}

function validImageStructure(
  bytes: Uint8Array,
  mimeType: CharacterImageMimeType
): boolean {
  try {
    parseCharacterImageMetadata(bytes, mimeType);
    return true;
  } catch {
    return false;
  }
}

function detectedImageMime(bytes: Uint8Array): CharacterImageMimeType | undefined {
  for (const mimeType of ['image/png', 'image/webp'] as const) {
    if (validImageStructure(bytes, mimeType)) return mimeType;
  }
  return undefined;
}

function validateCharacterId(characterId: string): void {
  if (!CHARACTER_ID_PATTERN.test(characterId)) {
    throw characterError('CHARACTER_INVALID_ID');
  }
}

function validateSha(value: unknown): value is string {
  return typeof value === 'string' && SHA_256_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(record).every(key => allowed.has(key))
    && keys.every(key => key in record);
}

function parseSourceEntry(value: unknown): SourceCatalogEntry | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'assetId',
    'displayName',
    'mimeType',
    'byteLength',
    'sha256'
  ])) {
    return undefined;
  }
  if (
    typeof value.assetId !== 'string'
    || !UUID_PATTERN.test(value.assetId)
    || typeof value.displayName !== 'string'
    || value.displayName.length < 1
    || value.displayName.length > 255
    || basename(value.displayName) !== value.displayName
    || (value.mimeType !== 'image/png' && value.mimeType !== 'image/webp')
    || !Number.isSafeInteger(value.byteLength)
    || (value.byteLength as number) < 1
    || (value.byteLength as number) > CHARACTER_RESOURCE_LIMITS.maxSourceBytesPerFile
    || !validateSha(value.sha256)
  ) {
    return undefined;
  }
  return value as SourceCatalogEntry;
}

function parseSourceCatalog(value: unknown, characterId: string): SourceCatalog {
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, ['version', 'characterId', 'sources'])
    || value.version !== 1
    || value.characterId !== characterId
    || !Array.isArray(value.sources)
  ) {
    throw characterError('CHARACTER_SOURCE_CATALOG_INVALID');
  }
  const sources = value.sources.map(parseSourceEntry);
  if (sources.some(entry => !entry)) {
    throw characterError('CHARACTER_SOURCE_CATALOG_INVALID');
  }
  const typed = sources as SourceCatalogEntry[];
  if (new Set(typed.map(entry => entry.assetId)).size !== typed.length) {
    throw characterError('CHARACTER_SOURCE_CATALOG_INVALID');
  }
  return { version: 1, characterId, sources: typed };
}

function parseSourceChecksums(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value) || Object.keys(value).length === 0) return undefined;
  const entries = Object.entries(value);
  if (entries.some(([assetId, checksum]) => (
    !UUID_PATTERN.test(assetId) || !validateSha(checksum)
  ))) {
    return undefined;
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function parseCompiledEntry(value: unknown): CompiledResourceEntry | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'assetId',
    'mimeType',
    'byteLength',
    'sha256',
    'sourceChecksums'
  ])) {
    return undefined;
  }
  const sourceChecksums = parseSourceChecksums(value.sourceChecksums);
  if (
    typeof value.assetId !== 'string'
    || !COMPILED_ASSET_ID_PATTERN.test(value.assetId)
    || (value.mimeType !== 'image/png' && value.mimeType !== 'image/webp')
    || !Number.isSafeInteger(value.byteLength)
    || (value.byteLength as number) < 1
    || (value.byteLength as number) > CHARACTER_RESOURCE_LIMITS.maxSourceBytesPerFile
    || !validateSha(value.sha256)
    || !sourceChecksums
  ) {
    return undefined;
  }
  return {
    assetId: value.assetId,
    mimeType: value.mimeType,
    byteLength: value.byteLength as number,
    sha256: value.sha256,
    sourceChecksums
  };
}

function parseCompiledCatalog(value: unknown, characterId: string): CompiledCatalog {
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, ['version', 'characterId', 'resources'])
    || value.version !== 1
    || value.characterId !== characterId
    || !Array.isArray(value.resources)
  ) {
    throw characterError('CHARACTER_COMPILED_CATALOG_INVALID');
  }
  const resources = value.resources.map(parseCompiledEntry);
  if (resources.some(entry => !entry)) {
    throw characterError('CHARACTER_COMPILED_CATALOG_INVALID');
  }
  const typed = resources as CompiledResourceEntry[];
  if (new Set(typed.map(entry => entry.assetId)).size !== typed.length) {
    throw characterError('CHARACTER_COMPILED_CATALOG_INVALID');
  }
  return { version: 1, characterId, resources: typed };
}

function parseSourceMarker(value: unknown): SourceTransactionMarker {
  const hasValidOwnership = isRecord(value) && (
    value.version === 1
    || (
      value.version === 2
      && typeof value.ownerToken === 'string'
      && UUID_PATTERN.test(value.ownerToken)
      && typeof value.transactionId === 'string'
      && UUID_PATTERN.test(value.transactionId)
    )
  );
  if (
    !isRecord(value)
    || !hasValidOwnership
    || !['prepared', 'installing', 'catalog-committed'].includes(String(value.phase))
    || typeof value.hadCatalog !== 'boolean'
    || !Array.isArray(value.entries)
  ) {
    throw characterError('CHARACTER_SOURCE_TRANSACTION_INVALID');
  }
  const entries = value.entries.map(entry => {
    if (
      !isRecord(entry)
      || typeof entry.assetId !== 'string'
      || !UUID_PATTERN.test(entry.assetId)
      || (entry.extension !== '.png' && entry.extension !== '.webp')
    ) {
      throw characterError('CHARACTER_SOURCE_TRANSACTION_INVALID');
    }
    return {
      assetId: entry.assetId,
      extension: entry.extension as '.png' | '.webp'
    };
  });
  return {
    version: value.version as 1 | 2,
    phase: value.phase as SourceTransactionMarker['phase'],
    hadCatalog: value.hadCatalog,
    ...(value.version === 2
      ? {
          ownerToken: value.ownerToken as string,
          transactionId: value.transactionId as string
        }
      : {}),
    entries
  };
}

function parseCompiledMarker(value: unknown): CompiledTransactionMarker {
  const hasValidOwnership = isRecord(value) && (
    value.version === 1
    || (
      value.version === 2
      && typeof value.ownerToken === 'string'
      && UUID_PATTERN.test(value.ownerToken)
      && typeof value.transactionId === 'string'
      && UUID_PATTERN.test(value.transactionId)
    )
  );
  if (
    !isRecord(value)
    || !hasValidOwnership
    || ![
      'prepared',
      'previous-moved',
      'installed',
      'catalog-committed'
    ].includes(String(value.phase))
    || typeof value.hadCatalog !== 'boolean'
    || typeof value.assetId !== 'string'
    || !COMPILED_ASSET_ID_PATTERN.test(value.assetId)
    || (value.previousExtension !== undefined
      && value.previousExtension !== '.png'
      && value.previousExtension !== '.webp')
    || (value.nextExtension !== '.png' && value.nextExtension !== '.webp')
  ) {
    throw characterError('CHARACTER_COMPILED_TRANSACTION_INVALID');
  }
  return {
    version: value.version as 1 | 2,
    phase: value.phase as CompiledTransactionMarker['phase'],
    hadCatalog: value.hadCatalog,
    ...(value.version === 2
      ? {
          ownerToken: value.ownerToken as string,
          transactionId: value.transactionId as string
        }
      : {}),
    assetId: value.assetId,
    ...(value.previousExtension === undefined
      ? {}
      : { previousExtension: value.previousExtension }),
    nextExtension: value.nextExtension
  };
}

function enqueueCharacterOperation<T>(
  key: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = characterQueues.get(key) ?? Promise.resolve();
  const current = previous.then(operation);
  const settled = current.then(() => undefined, () => undefined);
  characterQueues.set(key, settled);
  void settled.then(() => {
    if (characterQueues.get(key) === settled) characterQueues.delete(key);
  });
  return current;
}

export class CharacterAssetService {
  private readonly renamePath: (source: string, destination: string) => Promise<void>;
  private readonly now: () => number;
  private readonly lockLeaseMs: number;
  private readonly lockInitializationGraceMs: number;
  private readonly lockHeartbeatIntervalMs: number;
  private readonly scheduleLockHeartbeat: (
    callback: () => void,
    intervalMs: number
  ) => unknown;
  private readonly cancelLockHeartbeat: (handle: unknown) => void;

  constructor(
    private readonly charactersDirectory: string,
    private readonly dependencies: CharacterAssetServiceDependencies = {}
  ) {
    this.renamePath = dependencies.renamePath ?? rename;
    this.now = dependencies.now ?? Date.now;
    this.lockLeaseMs = dependencies.lockLeaseMs ?? DEFAULT_LOCK_LEASE_MS;
    this.lockInitializationGraceMs =
      dependencies.lockInitializationGraceMs ?? DEFAULT_LOCK_INITIALIZATION_GRACE_MS;
    this.lockHeartbeatIntervalMs = dependencies.lockHeartbeatIntervalMs
      ?? Math.min(
        DEFAULT_LOCK_HEARTBEAT_INTERVAL_MS,
        Math.max(1, Math.floor(this.lockLeaseMs / 4))
      );
    this.scheduleLockHeartbeat = dependencies.scheduleLockHeartbeat
      ?? ((callback, intervalMs) => setInterval(callback, intervalMs));
    this.cancelLockHeartbeat = dependencies.cancelLockHeartbeat
      ?? (handle => clearInterval(handle as ReturnType<typeof setInterval>));
    if (
      !Number.isFinite(this.lockLeaseMs)
      || this.lockLeaseMs <= 0
      || !Number.isFinite(this.lockInitializationGraceMs)
      || this.lockInitializationGraceMs < 0
      || !Number.isFinite(this.lockHeartbeatIntervalMs)
      || this.lockHeartbeatIntervalMs <= 0
      || this.lockHeartbeatIntervalMs >= this.lockLeaseMs
    ) {
      throw characterError('CHARACTER_LOCK_CONFIG_INVALID');
    }
  }

  importSources(
    characterId: string,
    selectedPaths: readonly string[]
  ): Promise<ImportedSource[]> {
    return this.runPublic(
      characterId,
      'CHARACTER_SOURCE_IMPORT_FAILED',
      async paths => this.importSourcesLocked(paths, characterId, selectedPaths)
    );
  }

  listSources(characterId: string): Promise<SourceCatalogEntry[]> {
    return this.runPublic(
      characterId,
      'CHARACTER_SOURCE_LIST_FAILED',
      async paths => {
        await this.checkpoint('source:list-before-read');
        await paths.lease.assertOwned();
        const { catalog, existed } = await this.loadSourceCatalog(paths, characterId);
        if (!existed) {
          await this.writeCatalog(
            join(paths.sourceDirectory, SOURCE_CATALOG_FILE),
            catalog,
            paths.sourceIdentity,
            paths.lease
          );
        }
        return structuredClone(catalog.sources);
      }
    );
  }

  readSource(characterId: string, assetId: string): Promise<Uint8Array> {
    return this.runPublic(
      characterId,
      'CHARACTER_SOURCE_READ_FAILED',
      async paths => {
        if (!UUID_PATTERN.test(assetId)) {
          throw characterError('CHARACTER_ASSET_ID_INVALID');
        }
        const { catalog } = await this.loadSourceCatalog(paths, characterId);
        const entry = catalog.sources.find(source => source.assetId === assetId);
        if (!entry) throw characterError('CHARACTER_SOURCE_NOT_FOUND');
        const file = join(
          paths.sourceDirectory,
          `${assetId}${extensionForMime(entry.mimeType)}`
        );
        const fileIdentity = await this.captureIdentity(file, 'file');
        await this.checkpoint('source:before-read');
        await this.assertIdentity(paths.sourceDirectory, paths.sourceIdentity);
        const bytes = await this.readStableFile(file, fileIdentity, paths.sourceIdentity);
        if (
          bytes.byteLength !== entry.byteLength
          || sha256(bytes) !== entry.sha256
          || !validImageStructure(bytes, entry.mimeType)
        ) {
          throw characterError('CHARACTER_SOURCE_INTEGRITY_FAILED');
        }
        return bytes;
      }
    );
  }

  saveCompiled(characterId: string, input: SaveCompiledInput): Promise<void> {
    return this.runPublic(
      characterId,
      'CHARACTER_COMPILED_SAVE_FAILED',
      async paths => this.saveCompiledLocked(paths, characterId, input)
    );
  }

  private async runPublic<T>(
    characterId: string,
    stableFailureCode: string,
    operation: (paths: CharacterPaths) => Promise<T>
  ): Promise<T> {
    try {
      validateCharacterId(characterId);
      const key = normalizedPath(`${resolve(this.charactersDirectory)}\0${characterId}`);
      return await enqueueCharacterOperation(key, async () => {
        const lease = await this.acquireCharacterLock(characterId);
        try {
          await lease.assertOwned();
          const paths = await this.safeCharacterPaths(characterId, lease);
          await this.recoverTransactions(paths, characterId);
          await lease.assertOwned();
          const recoveredPaths = await this.safeCharacterPaths(characterId, lease);
          return await operation(recoveredPaths);
        } finally {
          await lease.release();
        }
      });
    } catch (cause) {
      if (
        isKnownCharacterError(cause)
        || (cause instanceof DOMException && cause.name === 'AbortError')
      ) {
        throw cause;
      }
      throw characterError(stableFailureCode);
    }
  }

  private async importSourcesLocked(
    paths: CharacterPaths,
    characterId: string,
    selectedPaths: readonly string[]
  ): Promise<ImportedSource[]> {
    if (selectedPaths.length > CHARACTER_RESOURCE_LIMITS.maxSourceFilesPerImport) {
      throw characterError('CHARACTER_SOURCE_COUNT_EXCEEDED');
    }
    const { catalog, existed: catalogExisted } =
      await this.loadSourceCatalog(paths, characterId);
    await this.checkpoint('source:before-stage');

    const selectedImages = selectedPaths.filter(path => (
      mimeForExtension(extname(path).toLocaleLowerCase('en-US')) !== undefined
    ));
    const prepared: PreparedSource[] = [];
    for (const selectedPath of selectedImages) {
      if (!isAbsolute(selectedPath)) {
        throw characterError('CHARACTER_SOURCE_PATH_UNSAFE');
      }
      await this.assertNoLinks(selectedPath, 'CHARACTER_SOURCE_PATH_UNSAFE');
      const identity = await this.captureIdentity(selectedPath, 'file');
      const bytes = await this.readStableFile(selectedPath, identity);
      if (bytes.byteLength > CHARACTER_RESOURCE_LIMITS.maxSourceBytesPerFile) {
        throw characterError('CHARACTER_SOURCE_FILE_TOO_LARGE');
      }
      const extension = extname(selectedPath).toLocaleLowerCase('en-US') as
        | '.png'
        | '.webp';
      const mimeType = mimeForExtension(extension)!;
      if (!validImageStructure(bytes, mimeType)) {
        const signatureMime = detectedImageMime(bytes);
        throw characterError(signatureMime && signatureMime !== mimeType
          ? 'CHARACTER_SOURCE_SIGNATURE_INVALID'
          : 'CHARACTER_SOURCE_STRUCTURE_INVALID');
      }
      prepared.push({
        assetId: randomUUID(),
        displayName: basename(selectedPath),
        mimeType,
        byteLength: bytes.byteLength,
        sha256: sha256(bytes),
        selectedPath,
        extension,
        bytes
      });
    }

    const existingBytes = await this.storageByteLength(paths.sourceDirectory);
    const incomingBytes = prepared.reduce((total, entry) => total + entry.byteLength, 0);
    if (
      existingBytes + incomingBytes
      > CHARACTER_RESOURCE_LIMITS.maxTotalSourceBytesPerCharacter
    ) {
      throw characterError('CHARACTER_SOURCE_TOTAL_BYTES_EXCEEDED');
    }
    if (prepared.length === 0) return [];

    const transactionId = randomUUID();
    const transaction = join(
      paths.characterDirectory,
      `${SOURCE_TRANSACTION_DIRECTORY}.${transactionId}`
    );
    const stagedDirectory = join(transaction, 'staged');
    let transactionIdentity: PathIdentity | undefined;
    let marker: SourceTransactionMarker | undefined;
    let markerPersisted = false;
    try {
      await mkdir(stagedDirectory, { recursive: true });
      transactionIdentity = await this.captureIdentity(transaction, 'directory');
      const stagedIdentity = await this.captureIdentity(stagedDirectory, 'directory');
      if (catalogExisted) {
        await this.writeNewFile(
          join(transaction, 'previous-catalog.json'),
          new TextEncoder().encode(JSON.stringify(catalog)),
          transactionIdentity,
          'source:after-temp-open',
          paths.lease
        );
      }
      for (const entry of prepared) {
        await this.writeNewFile(
          join(stagedDirectory, `${entry.assetId}${entry.extension}`),
          entry.bytes,
          stagedIdentity,
          'source:after-temp-open',
          paths.lease
        );
      }

      marker = {
        version: 2,
        phase: 'prepared',
        hadCatalog: catalogExisted,
        ownerToken: paths.lease.ownerToken,
        transactionId,
        entries: prepared.map(entry => ({
          assetId: entry.assetId,
          extension: entry.extension
        }))
      };
      await this.writeCatalog(
        join(transaction, 'marker.json'),
        marker,
        transactionIdentity,
        paths.lease
      );
      markerPersisted = true;
      await this.checkpoint('source:before-commit');
      await paths.lease.assertOwned();
      await this.assertIdentity(paths.sourceDirectory, paths.sourceIdentity);
      marker = { ...marker, phase: 'installing' };
      await this.writeCatalog(
        join(transaction, 'marker.json'),
        marker,
        transactionIdentity,
        paths.lease
      );
      for (const entry of prepared) {
        await this.assertIdentity(paths.sourceDirectory, paths.sourceIdentity);
        await this.assertIdentity(stagedDirectory, stagedIdentity);
        await this.renameStable(
          join(stagedDirectory, `${entry.assetId}${entry.extension}`),
          join(paths.sourceDirectory, `${entry.assetId}${entry.extension}`),
          stagedIdentity,
          paths.sourceIdentity,
          undefined,
          paths.lease
        );
        await this.assertIdentity(paths.sourceDirectory, paths.sourceIdentity);
      }

      const nextCatalog: SourceCatalog = {
        version: 1,
        characterId,
        sources: [
          ...catalog.sources,
          ...prepared.map(({
            selectedPath: _selectedPath,
            extension: _extension,
            bytes: _bytes,
            ...entry
          }) => entry)
        ]
      };
      await this.writeCatalog(
        join(paths.sourceDirectory, SOURCE_CATALOG_FILE),
        nextCatalog,
        paths.sourceIdentity,
        paths.lease
      );
      marker = { ...marker, phase: 'catalog-committed' };
      await this.writeCatalog(
        join(transaction, 'marker.json'),
        marker,
        transactionIdentity,
        paths.lease
      );
      await paths.lease.assertOwned();
      await this.assertSourceTransactionOwned(transaction, transactionIdentity, marker);
      await this.removeTransactionDirectory(
        transaction,
        transactionIdentity,
        paths.characterDirectory,
        paths.characterIdentity,
        paths.lease
      );
      return prepared.map(({
        selectedPath: _selectedPath,
        extension: _extension,
        bytes: _bytes,
        ...entry
      }) => entry);
    } catch (cause) {
      if (transactionIdentity && await this.leaseIsOwned(paths.lease)) {
        if (marker && markerPersisted) {
          await this.rollbackSourceTransaction(
            paths,
            marker,
            transaction,
            transactionIdentity,
            paths.lease
          ).catch(() => undefined);
        } else {
          await this.removeTransactionDirectory(
            transaction,
            transactionIdentity,
            paths.characterDirectory,
            paths.characterIdentity,
            paths.lease
          ).catch(() => undefined);
        }
      }
      throw cause;
    }
  }

  private async saveCompiledLocked(
    paths: CharacterPaths,
    characterId: string,
    input: SaveCompiledInput
  ): Promise<void> {
    throwIfAborted(input.signal);
    await this.checkpoint('compiled:before-save');
    if (!COMPILED_ASSET_ID_PATTERN.test(input.assetId)) {
      throw characterError('CHARACTER_COMPILED_ASSET_ID_INVALID');
    }
    if (!validImageStructure(input.bytes, input.mimeType)) {
      throw characterError('CHARACTER_COMPILED_STRUCTURE_INVALID');
    }
    if (input.bytes.byteLength > CHARACTER_RESOURCE_LIMITS.maxSourceBytesPerFile) {
      throw characterError('CHARACTER_COMPILED_FILE_TOO_LARGE');
    }

    const sourceChecksums = parseSourceChecksums(input.sourceChecksums);
    if (!sourceChecksums) {
      throw characterError('CHARACTER_COMPILED_SOURCE_REQUIRED');
    }
    const { catalog: sourceCatalog } = await this.loadSourceCatalog(paths, characterId);
    for (const [assetId, expectedChecksum] of Object.entries(sourceChecksums)) {
      const source = sourceCatalog.sources.find(entry => entry.assetId === assetId);
      if (!source) throw characterError('CHARACTER_COMPILED_SOURCE_NOT_FOUND');
      if (source.sha256 !== expectedChecksum) {
        throw characterError('CHARACTER_COMPILED_SOURCE_MISMATCH');
      }
      const sourceFile = join(
        paths.sourceDirectory,
        `${source.assetId}${extensionForMime(source.mimeType)}`
      );
      const sourceIdentity = await this.captureIdentity(sourceFile, 'file');
      const sourceBytes = await this.readStableFile(
        sourceFile,
        sourceIdentity,
        paths.sourceIdentity
      );
      if (
        sourceBytes.byteLength !== source.byteLength
        || sha256(sourceBytes) !== source.sha256
        || !validImageStructure(sourceBytes, source.mimeType)
      ) {
        throw characterError('CHARACTER_COMPILED_SOURCE_MISMATCH');
      }
    }

    const { catalog, existed: catalogExisted } =
      await this.loadCompiledCatalog(paths, characterId);
    const previous = catalog.resources.find(entry => entry.assetId === input.assetId);
    const pngPath = join(paths.compiledDirectory, `${input.assetId}.png`);
    const webpPath = join(paths.compiledDirectory, `${input.assetId}.webp`);
    const physicalCandidates = await Promise.all([
      this.optionalIdentity(pngPath, 'file'),
      this.optionalIdentity(webpPath, 'file')
    ]);
    const physicalCount = physicalCandidates.filter(Boolean).length;

    if (!previous) {
      if (input.expectedPreviousSha256 !== undefined || physicalCount !== 0) {
        throw characterError('CHARACTER_COMPILED_CONFLICT');
      }
    } else {
      if (
        !validateSha(input.expectedPreviousSha256)
        || input.expectedPreviousSha256 !== previous.sha256
        || physicalCount !== 1
      ) {
        throw characterError('CHARACTER_COMPILED_CONFLICT');
      }
      const previousFile = join(
        paths.compiledDirectory,
        `${previous.assetId}${extensionForMime(previous.mimeType)}`
      );
      const previousIdentity = await this.captureIdentity(previousFile, 'file');
      const previousBytes = await this.readStableFile(
        previousFile,
        previousIdentity,
        paths.compiledIdentity
      );
      if (
        previousBytes.byteLength !== previous.byteLength
        || sha256(previousBytes) !== previous.sha256
        || !validImageStructure(previousBytes, previous.mimeType)
      ) {
        throw characterError('CHARACTER_COMPILED_INTEGRITY_FAILED');
      }
    }

    const existingBytes = await this.storageByteLength(paths.compiledDirectory);
    const nextTotal = existingBytes
      - (previous?.byteLength ?? 0)
      + input.bytes.byteLength;
    if (nextTotal > MAX_COMPILED_BYTES_PER_CHARACTER) {
      throw characterError('CHARACTER_COMPILED_TOTAL_BYTES_EXCEEDED');
    }

    const nextEntry: CompiledResourceEntry = {
      assetId: input.assetId,
      mimeType: input.mimeType,
      byteLength: input.bytes.byteLength,
      sha256: sha256(input.bytes),
      sourceChecksums
    };
    const nextCatalog: CompiledCatalog = {
      version: 1,
      characterId,
      resources: [
        ...catalog.resources.filter(entry => entry.assetId !== input.assetId),
        nextEntry
      ]
    };
    await this.commitCompiledTransaction(
      paths,
      catalog,
      catalogExisted,
      previous,
      nextEntry,
      nextCatalog,
      input.bytes,
      input.signal
    );
  }

  private async commitCompiledTransaction(
    paths: CharacterPaths,
    previousCatalog: CompiledCatalog,
    catalogExisted: boolean,
    previous: CompiledResourceEntry | undefined,
    next: CompiledResourceEntry,
    nextCatalog: CompiledCatalog,
    bytes: Uint8Array,
    signal?: AbortSignal
  ): Promise<void> {
    const transactionId = randomUUID();
    const transaction = join(
      paths.characterDirectory,
      `${COMPILED_TRANSACTION_DIRECTORY}.${transactionId}`
    );
    const nextExtension = extensionForMime(next.mimeType);
    const stagedFile = join(transaction, `next${nextExtension}`);
    let transactionIdentity: PathIdentity | undefined;
    let marker: CompiledTransactionMarker | undefined;
    let markerPersisted = false;
    try {
      await mkdir(transaction, { recursive: true });
      transactionIdentity = await this.captureIdentity(transaction, 'directory');
      await this.writeNewFile(
        stagedFile,
        bytes,
        transactionIdentity,
        'compiled:after-temp-open',
        paths.lease
      );
      if (catalogExisted) {
        await this.writeNewFile(
          join(transaction, 'previous-catalog.json'),
          new TextEncoder().encode(JSON.stringify(previousCatalog)),
          transactionIdentity,
          'compiled:after-temp-open',
          paths.lease
        );
      }
      marker = {
        version: 2,
        phase: 'prepared',
        hadCatalog: catalogExisted,
        ownerToken: paths.lease.ownerToken,
        transactionId,
        assetId: next.assetId,
        ...(previous
          ? { previousExtension: extensionForMime(previous.mimeType) }
          : {}),
        nextExtension
      };
      await this.writeCatalog(
        join(transaction, 'marker.json'),
        marker,
        transactionIdentity,
        paths.lease
      );
      markerPersisted = true;
      throwIfAborted(signal);
      await this.checkpoint('compiled:before-install');
      await paths.lease.assertOwned();
      await this.assertIdentity(paths.compiledDirectory, paths.compiledIdentity);
      if (previous) {
        const previousFile = join(
          paths.compiledDirectory,
          `${previous.assetId}${extensionForMime(previous.mimeType)}`
        );
        await this.renameStable(
          previousFile,
          join(transaction, 'previous-resource'),
          paths.compiledIdentity,
          transactionIdentity,
          undefined,
          paths.lease
        );
        marker = { ...marker, phase: 'previous-moved' };
        await this.writeCatalog(
          join(transaction, 'marker.json'),
          marker,
          transactionIdentity,
          paths.lease
        );
      }
      throwIfAborted(signal);
      await this.assertIdentity(paths.compiledDirectory, paths.compiledIdentity);
      await this.renameStable(
        stagedFile,
        join(paths.compiledDirectory, `${next.assetId}${nextExtension}`),
        transactionIdentity,
        paths.compiledIdentity,
        undefined,
        paths.lease
      );
      await this.assertIdentity(paths.compiledDirectory, paths.compiledIdentity);
      marker = { ...marker, phase: 'installed' };
      await this.writeCatalog(
        join(transaction, 'marker.json'),
        marker,
        transactionIdentity,
        paths.lease
      );
      throwIfAborted(signal);
      await this.writeCatalog(
        join(paths.compiledDirectory, COMPILED_CATALOG_FILE),
        nextCatalog,
        paths.compiledIdentity,
        paths.lease
      );
      marker = { ...marker, phase: 'catalog-committed' };
      await this.writeCatalog(
        join(transaction, 'marker.json'),
        marker,
        transactionIdentity,
        paths.lease
      );
      await paths.lease.assertOwned();
      await this.assertCompiledTransactionOwned(transaction, transactionIdentity, marker);
      await this.removeTransactionDirectory(
        transaction,
        transactionIdentity,
        paths.characterDirectory,
        paths.characterIdentity,
        paths.lease
      );
    } catch (cause) {
      if (transactionIdentity && await this.leaseIsOwned(paths.lease)) {
        if (marker && markerPersisted) {
          await this.rollbackCompiledTransaction(
            paths,
            marker,
            transaction,
            transactionIdentity,
            paths.lease
          ).catch(() => undefined);
        } else {
          await this.removeTransactionDirectory(
            transaction,
            transactionIdentity,
            paths.characterDirectory,
            paths.characterIdentity,
            paths.lease
          ).catch(() => undefined);
        }
      }
      throw cause;
    }
  }

  private async acquireCharacterLock(
    characterId: string
  ): Promise<CharacterLeaseGuard> {
    // 租约覆盖崩溃、PID 复用和协作进程竞争；不防御同一 Windows 用户在每个系统调用间持续篡改私有 userData。
    const root = resolve(this.charactersDirectory);
    await this.assertNoLinks(root, 'CHARACTER_PATH_UNSAFE');
    const rootIdentity = await this.captureIdentity(root, 'directory');
    const lockDirectory = join(root, LOCK_DIRECTORY);
    await mkdir(lockDirectory, { recursive: true });
    await this.assertIdentity(root, rootIdentity);
    const lockDirectoryIdentity = await this.captureIdentity(lockDirectory, 'directory');
    if (!isContained(rootIdentity.physicalPath, lockDirectoryIdentity.physicalPath)) {
      throw characterError('CHARACTER_PATH_UNSAFE');
    }

    const lockFile = join(lockDirectory, `${characterId}.lock`);
    for (let attempt = 0; attempt < LOCK_RECLAIM_ATTEMPTS; attempt += 1) {
      const ownerToken = randomUUID();
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      let originalLockIdentity: PathIdentity | undefined;
      try {
        await this.assertIdentity(lockDirectory, lockDirectoryIdentity);
        handle = await open(lockFile, 'wx');
        const created = await handle.stat();
        originalLockIdentity = {
          physicalPath: resolve(lockFile),
          device: created.dev,
          inode: created.ino,
          kind: 'file'
        };
        await this.checkpoint('lock:after-create');
        await this.assertIdentity(lockDirectory, lockDirectoryIdentity);
        const createdAt = this.now();
        const marker: CharacterLockMarker = {
          version: 1,
          ownerToken,
          pid: process.pid,
          createdAt,
          heartbeatAt: createdAt
        };
        await handle.writeFile(JSON.stringify(marker), 'utf8');
        await handle.sync();
        await handle.close();
        handle = undefined;
        await this.assertIdentity(lockDirectory, lockDirectoryIdentity);
        let lockIdentity: PathIdentity;
        try {
          lockIdentity = await this.captureIdentity(lockFile, 'file');
        } catch {
          // 原 inode 已离开锁路径时，无锁窗口与替代 inode 都属于同一种租约丢失。
          throw characterError('CHARACTER_ASSET_LEASE_LOST');
        }
        if (!sameNodeIdentity(lockIdentity, originalLockIdentity)) {
          throw characterError('CHARACTER_ASSET_LEASE_LOST');
        }
        const state: CharacterLeaseState = { lost: false };
        const stopHeartbeat = this.startCharacterLockHeartbeat(
          lockFile,
          lockIdentity,
          ownerToken,
          createdAt,
          state
        );
        const guard: CharacterLeaseGuard = {
          ownerToken,
          assertOwned: async () => {
            await this.assertCharacterLockOwned(
              lockFile,
              lockDirectoryIdentity,
              lockIdentity,
              ownerToken,
              state
            );
          },
          release: async () => {
            await stopHeartbeat();
            await this.releaseCharacterLock(
              lockFile,
              lockDirectory,
              lockDirectoryIdentity,
              lockIdentity,
              ownerToken
            );
          }
        };
        await guard.assertOwned();
        return guard;
      } catch (cause) {
        await handle?.close().catch(() => undefined);
        if (!isExclusiveOpenConflict(cause)) {
          if (originalLockIdentity) {
            await this.removeOwnedLockFile(
              lockFile,
              lockDirectoryIdentity,
              originalLockIdentity
            );
          }
          throw cause;
        }
      }

      const lockIdentity = await this.captureIdentity(lockFile, 'file');
      let marker: CharacterLockMarker | undefined;
      try {
        const bytes = await this.readStableFile(
          lockFile,
          lockIdentity,
          lockDirectoryIdentity
        );
        marker = parseCharacterLockMarker(
          JSON.parse(new TextDecoder().decode(bytes))
        );
      } catch {
        marker = undefined;
      }
      const information = await lstat(lockFile);
      if (
        information.dev !== lockIdentity.device
        || information.ino !== lockIdentity.inode
      ) {
        throw characterError('CHARACTER_PATH_IDENTITY_CHANGED');
      }
      const now = this.now();
      const active = marker
        ? now - marker.heartbeatAt <= this.lockLeaseMs
        : now - information.mtimeMs <= this.lockInitializationGraceMs;
      if (active) {
        throw characterError('CHARACTER_ASSET_BUSY');
      }

      const staleFile = join(
        lockDirectory,
        `.${characterId}.${randomUUID()}.stale`
      );
      try {
        await this.renameStable(
          lockFile,
          staleFile,
          lockDirectoryIdentity,
          lockDirectoryIdentity,
          lockIdentity
        );
        await rm(staleFile, { force: true });
        await this.assertIdentity(lockDirectory, lockDirectoryIdentity);
      } catch (cause) {
        if (!isMissingFile(cause)) throw cause;
      }
    }
    throw characterError('CHARACTER_ASSET_BUSY');
  }

  private startCharacterLockHeartbeat(
    lockFile: string,
    lockIdentity: PathIdentity,
    ownerToken: string,
    createdAt: number,
    state: CharacterLeaseState
  ): () => Promise<void> {
    let stopped = false;
    let pending = Promise.resolve();
    const timer = this.scheduleLockHeartbeat(() => {
      if (stopped) return;
      pending = pending.then(async () => {
        const renewed = await this.refreshCharacterLock(
          lockFile,
          lockIdentity,
          ownerToken,
          createdAt
        );
        if (!renewed) state.lost = true;
      }).catch(() => {
        state.lost = true;
      });
    }, this.lockHeartbeatIntervalMs);
    return async () => {
      stopped = true;
      this.cancelLockHeartbeat(timer);
      await pending;
    };
  }

  private async refreshCharacterLock(
    lockFile: string,
    lockIdentity: PathIdentity,
    ownerToken: string,
    createdAt: number
  ): Promise<boolean> {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(lockFile, 'r+');
    } catch {
      return false;
    }
    try {
      const information = await handle.stat();
      if (
        !information.isFile()
        || information.dev !== lockIdentity.device
        || information.ino !== lockIdentity.inode
      ) {
        return false;
      }
      const current = parseCharacterLockMarker(
        JSON.parse(new TextDecoder().decode(await handle.readFile()))
      );
      if (!current || current.ownerToken !== ownerToken) return false;
      const now = this.now();
      if (now - current.heartbeatAt > this.lockLeaseMs) return false;
      const marker: CharacterLockMarker = {
        version: 1,
        ownerToken,
        pid: process.pid,
        createdAt,
        heartbeatAt: now
      };
      const bytes = new TextEncoder().encode(JSON.stringify(marker));
      await handle.write(bytes, 0, bytes.byteLength, 0);
      await handle.truncate(bytes.byteLength);
      await handle.sync();
      return true;
    } catch {
      return false;
    } finally {
      await handle.close();
    }
  }

  private async assertCharacterLockOwned(
    lockFile: string,
    lockDirectoryIdentity: PathIdentity,
    expectedLockIdentity: PathIdentity,
    ownerToken: string,
    state: CharacterLeaseState
  ): Promise<void> {
    // 栅栏同时验证持久失锁状态、最初 open('wx') 的 inode、ownerToken 与租约时效。
    if (state.lost) throw characterError('CHARACTER_ASSET_LEASE_LOST');
    try {
      const currentIdentity = await this.captureIdentity(lockFile, 'file');
      if (!sameNodeIdentity(currentIdentity, expectedLockIdentity)) {
        throw characterError('CHARACTER_ASSET_LEASE_LOST');
      }
      const bytes = await this.readStableFile(
        lockFile,
        currentIdentity,
        lockDirectoryIdentity
      );
      const marker = parseCharacterLockMarker(
        JSON.parse(new TextDecoder().decode(bytes))
      );
      if (
        !marker
        || marker.ownerToken !== ownerToken
        || this.now() - marker.heartbeatAt > this.lockLeaseMs
      ) {
        throw characterError('CHARACTER_ASSET_LEASE_LOST');
      }
    } catch {
      state.lost = true;
      throw characterError('CHARACTER_ASSET_LEASE_LOST');
    }
  }

  private async removeOwnedLockFile(
    lockFile: string,
    lockDirectoryIdentity: PathIdentity,
    expectedLockIdentity: PathIdentity
  ): Promise<void> {
    const current = await this.optionalIdentity(lockFile, 'file').catch(() => undefined);
    if (!current || !sameNodeIdentity(current, expectedLockIdentity)) return;
    const isolated = join(
      resolve(lockFile, '..'),
      `.abandoned.${basename(lockFile)}.${randomUUID()}`
    );
    try {
      await this.renameStable(
        lockFile,
        isolated,
        lockDirectoryIdentity,
        lockDirectoryIdentity,
        expectedLockIdentity
      );
      await rm(isolated, { force: true });
    } catch {
      // 路径已指向其他 inode 时，旧初始化者不得清理替代 owner。
    }
  }

  private async releaseCharacterLock(
    lockFile: string,
    lockDirectory: string,
    lockDirectoryIdentity: PathIdentity,
    expectedLockIdentity: PathIdentity,
    ownerToken: string
  ): Promise<void> {
    const lockIdentity = await this.optionalIdentity(lockFile, 'file');
    if (!lockIdentity || !sameIdentity(lockIdentity, expectedLockIdentity)) return;
    const bytes = await this.readStableFile(
      lockFile,
      lockIdentity,
      lockDirectoryIdentity
    );
    let marker: CharacterLockMarker | undefined;
    try {
      marker = parseCharacterLockMarker(JSON.parse(new TextDecoder().decode(bytes)));
    } catch {
      marker = undefined;
    }
    if (!marker || marker.ownerToken !== ownerToken) return;

    const isolated = join(
      lockDirectory,
      `.release.${basename(lockFile)}.${randomUUID()}`
    );
    try {
      await this.renameStable(
        lockFile,
        isolated,
        lockDirectoryIdentity,
        lockDirectoryIdentity,
        expectedLockIdentity
      );
    } catch (cause) {
      if (
        isMissingFile(cause)
        || (
          isKnownCharacterError(cause)
          && (
            cause.message === 'CHARACTER_PATH_UNSAFE'
            || cause.message === 'CHARACTER_PATH_IDENTITY_CHANGED'
          )
        )
      ) {
        return;
      }
      throw cause;
    }
    const isolatedIdentity = await this.captureIdentity(isolated, 'file');
    const isolatedBytes = await this.readStableFile(
      isolated,
      isolatedIdentity,
      lockDirectoryIdentity
    );
    let isolatedMarker: CharacterLockMarker | undefined;
    try {
      isolatedMarker = parseCharacterLockMarker(
        JSON.parse(new TextDecoder().decode(isolatedBytes))
      );
    } catch {
      isolatedMarker = undefined;
    }
    if (isolatedMarker?.ownerToken === ownerToken) {
      await rm(isolated, { force: true });
    }
    await this.assertIdentity(lockDirectory, lockDirectoryIdentity);
  }

  private async safeCharacterPaths(
    characterId: string,
    lease: CharacterLeaseGuard
  ): Promise<CharacterPaths> {
    const root = resolve(this.charactersDirectory);
    await this.assertNoLinks(root, 'CHARACTER_PATH_UNSAFE');
    const rootIdentity = await this.captureIdentity(root, 'directory');
    const characterDirectory = join(root, characterId);
    const characterIdentity = await this.captureIdentity(
      characterDirectory,
      'directory',
      'CHARACTER_NOT_FOUND'
    );
    const sourceDirectory = join(characterDirectory, 'source');
    const compiledDirectory = join(characterDirectory, 'compiled');
    const sourceIdentity = await this.captureIdentity(sourceDirectory, 'directory');
    const compiledIdentity = await this.captureIdentity(compiledDirectory, 'directory');
    const physicalCharacter = await realpath(characterDirectory);
    if (
      !isContained(rootIdentity.physicalPath, physicalCharacter)
      || !isContained(characterIdentity.physicalPath, sourceIdentity.physicalPath)
      || !isContained(characterIdentity.physicalPath, compiledIdentity.physicalPath)
    ) {
      throw characterError('CHARACTER_PATH_UNSAFE');
    }
    return {
      lease,
      characterDirectory,
      characterIdentity,
      sourceDirectory,
      sourceIdentity,
      compiledDirectory,
      compiledIdentity
    };
  }

  private async captureIdentity(
    path: string,
    kind: PathIdentity['kind'],
    missingCode = 'CHARACTER_PATH_UNSAFE'
  ): Promise<PathIdentity> {
    await this.assertNoLinks(path, 'CHARACTER_PATH_UNSAFE');
    let first;
    try {
      first = await lstat(path);
    } catch (cause) {
      if (isMissingFile(cause)) throw characterError(missingCode);
      throw cause;
    }
    if (
      first.isSymbolicLink()
      || (kind === 'file' ? !first.isFile() : !first.isDirectory())
    ) {
      throw characterError('CHARACTER_PATH_UNSAFE');
    }
    const physicalPath = await realpath(path);
    const second = await lstat(path);
    if (
      second.isSymbolicLink()
      || first.dev !== second.dev
      || first.ino !== second.ino
    ) {
      throw characterError('CHARACTER_PATH_IDENTITY_CHANGED');
    }
    return {
      physicalPath,
      device: first.dev,
      inode: first.ino,
      kind
    };
  }

  private async optionalIdentity(
    path: string,
    kind: PathIdentity['kind']
  ): Promise<PathIdentity | undefined> {
    try {
      return await this.captureIdentity(path, kind);
    } catch (cause) {
      if (isKnownCharacterError(cause) && cause.message === 'CHARACTER_PATH_UNSAFE') {
        try {
          await lstat(path);
        } catch (missing) {
          if (isMissingFile(missing)) return undefined;
        }
      }
      throw cause;
    }
  }

  private async assertIdentity(path: string, expected: PathIdentity): Promise<void> {
    try {
      const current = await this.captureIdentity(path, expected.kind);
      if (!sameIdentity(current, expected)) {
        throw characterError('CHARACTER_PATH_IDENTITY_CHANGED');
      }
    } catch (cause) {
      if (
        isKnownCharacterError(cause)
        && cause.message === 'CHARACTER_PATH_IDENTITY_CHANGED'
      ) {
        throw cause;
      }
      throw characterError('CHARACTER_PATH_IDENTITY_CHANGED');
    }
  }

  private async assertNoLinks(path: string, code: string): Promise<void> {
    const absolute = resolve(path);
    const root = parse(absolute).root;
    const segments = absolute.slice(root.length).split(/[\\/]+/u).filter(Boolean);
    let current = root;
    for (const segment of segments) {
      current = join(current, segment);
      try {
        if ((await lstat(current)).isSymbolicLink()) throw characterError(code);
      } catch (cause) {
        if (isMissingFile(cause)) return;
        throw cause;
      }
    }
  }

  private async readStableFile(
    path: string,
    expected: PathIdentity,
    parentIdentity?: PathIdentity
  ): Promise<Uint8Array> {
    if (parentIdentity) {
      await this.assertIdentity(resolve(path, '..'), parentIdentity);
    }
    await this.assertIdentity(path, expected);
    const handle = await open(path, 'r');
    try {
      const information = await handle.stat();
      if (
        !information.isFile()
        || information.dev !== expected.device
        || information.ino !== expected.inode
      ) {
        throw characterError('CHARACTER_PATH_IDENTITY_CHANGED');
      }
      const bytes = new Uint8Array(await handle.readFile());
      await this.assertIdentity(path, expected);
      if (parentIdentity) {
        await this.assertIdentity(resolve(path, '..'), parentIdentity);
      }
      return bytes;
    } finally {
      await handle.close();
    }
  }

  private async writeNewFile(
    path: string,
    bytes: Uint8Array,
    parentIdentity: PathIdentity,
    afterOpenCheckpoint?: CharacterAssetOperationCheckpoint,
    lease?: CharacterLeaseGuard
  ): Promise<void> {
    await lease?.assertOwned();
    await this.assertIdentity(resolve(path, '..'), parentIdentity);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, 'wx');
      if (afterOpenCheckpoint) await this.checkpoint(afterOpenCheckpoint);
      await lease?.assertOwned();
      await this.assertIdentity(resolve(path, '..'), parentIdentity);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.assertIdentity(resolve(path, '..'), parentIdentity);
      await this.captureIdentity(path, 'file');
    } catch (cause) {
      await handle?.close().catch(() => undefined);
      await this.removeCreatedFile(path, parentIdentity);
      throw cause;
    }
  }

  private async writeCatalog(
    path: string,
    value: unknown,
    parentIdentity: PathIdentity,
    lease?: CharacterLeaseGuard
  ): Promise<void> {
    await lease?.assertOwned();
    await this.assertIdentity(resolve(path, '..'), parentIdentity);
    const temporary = `${path}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, 'wx');
      await lease?.assertOwned();
      await this.assertIdentity(resolve(path, '..'), parentIdentity);
      await handle.writeFile(JSON.stringify(value), 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.assertIdentity(resolve(path, '..'), parentIdentity);
      const existing = await this.optionalIdentity(path, 'file');
      if (existing) await this.assertIdentity(path, existing);
      await lease?.assertOwned();
      await this.renameStable(
        temporary,
        path,
        parentIdentity,
        parentIdentity,
        undefined,
        lease
      );
    } catch (cause) {
      await handle?.close().catch(() => undefined);
      await this.removeCreatedFile(temporary, parentIdentity);
      throw cause;
    }
  }

  private async removeCreatedFile(
    path: string,
    parentIdentity: PathIdentity
  ): Promise<void> {
    try {
      await this.assertIdentity(resolve(path, '..'), parentIdentity);
      await rm(path, { force: true });
      await this.assertIdentity(resolve(path, '..'), parentIdentity);
    } catch {
      // 父目录已变化时不能沿原逻辑路径删除未知对象。
    }
  }

  private async renameStable(
    source: string,
    destination: string,
    sourceParentIdentity: PathIdentity,
    destinationParentIdentity: PathIdentity,
    expectedSourceIdentity?: PathIdentity,
    lease?: CharacterLeaseGuard
  ): Promise<void> {
    await lease?.assertOwned();
    await this.assertIdentity(resolve(source, '..'), sourceParentIdentity);
    await this.assertIdentity(resolve(destination, '..'), destinationParentIdentity);
    const sourceIdentity = await this.captureIdentity(source, 'file');
    if (expectedSourceIdentity && !sameIdentity(sourceIdentity, expectedSourceIdentity)) {
      throw characterError('CHARACTER_PATH_IDENTITY_CHANGED');
    }
    await lease?.assertOwned();
    await this.renamePath(source, destination);
    await this.assertIdentity(resolve(source, '..'), sourceParentIdentity);
    await this.assertIdentity(resolve(destination, '..'), destinationParentIdentity);
    const installedIdentity = await this.captureIdentity(destination, 'file');
    if (!sameNodeIdentity(sourceIdentity, installedIdentity)) {
      throw characterError('CHARACTER_PATH_IDENTITY_CHANGED');
    }
  }

  private async readJson(path: string, parentIdentity: PathIdentity): Promise<unknown> {
    const identity = await this.captureIdentity(path, 'file');
    const bytes = await this.readStableFile(path, identity, parentIdentity);
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw characterError('CHARACTER_CATALOG_JSON_INVALID');
    }
  }

  private async loadSourceCatalog(
    paths: CharacterPaths,
    characterId: string
  ): Promise<{ catalog: SourceCatalog; existed: boolean }> {
    const file = join(paths.sourceDirectory, SOURCE_CATALOG_FILE);
    if (!(await this.pathExists(file))) {
      return {
        catalog: { version: 1, characterId, sources: [] },
        existed: false
      };
    }
    const value = await this.readJson(file, paths.sourceIdentity);
    return { catalog: parseSourceCatalog(value, characterId), existed: true };
  }

  private async loadCompiledCatalog(
    paths: CharacterPaths,
    characterId: string
  ): Promise<{ catalog: CompiledCatalog; existed: boolean }> {
    const file = join(paths.compiledDirectory, COMPILED_CATALOG_FILE);
    if (!(await this.pathExists(file))) {
      return {
        catalog: { version: 1, characterId, resources: [] },
        existed: false
      };
    }
    const value = await this.readJson(file, paths.compiledIdentity);
    return { catalog: parseCompiledCatalog(value, characterId), existed: true };
  }

  private async storageByteLength(directory: string): Promise<number> {
    let total = 0;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === 'catalog.json') continue;
      if (entry.isSymbolicLink()) throw characterError('CHARACTER_PATH_UNSAFE');
      if (!entry.isFile()) continue;
      const identity = await this.captureIdentity(join(directory, entry.name), 'file');
      const information = await lstat(identity.physicalPath);
      total += information.size;
    }
    return total;
  }

  private async leaseIsOwned(lease: CharacterLeaseGuard): Promise<boolean> {
    try {
      await lease.assertOwned();
      return true;
    } catch {
      return false;
    }
  }

  private async findTransactionDirectories(
    paths: CharacterPaths,
    legacyName: string
  ): Promise<string[]> {
    await paths.lease.assertOwned();
    await this.assertIdentity(paths.characterDirectory, paths.characterIdentity);
    const prefix = `${legacyName}.`;
    const transactions: string[] = [];
    for (const entry of await readdir(paths.characterDirectory, { withFileTypes: true })) {
      if (entry.name !== legacyName && !entry.name.startsWith(prefix)) continue;
      if (
        entry.isSymbolicLink()
        || !entry.isDirectory()
        || (
          entry.name.startsWith(prefix)
          && !UUID_PATTERN.test(entry.name.slice(prefix.length))
        )
      ) {
        throw characterError('CHARACTER_PATH_UNSAFE');
      }
      transactions.push(join(paths.characterDirectory, entry.name));
    }
    await this.assertIdentity(paths.characterDirectory, paths.characterIdentity);
    return transactions.sort();
  }

  private assertTransactionMarkerLocation(
    transaction: string,
    legacyName: string,
    marker: SourceTransactionMarker | CompiledTransactionMarker,
    invalidCode: string
  ): void {
    const expectedName = marker.version === 1
      ? legacyName
      : `${legacyName}.${marker.transactionId}`;
    if (basename(transaction) !== expectedName) {
      throw characterError(invalidCode);
    }
  }

  // 运行期回滚必须同时匹配唯一目录 inode、ownerToken 与 transactionId，不能借用被替换的事务状态。
  private async assertSourceTransactionOwned(
    transaction: string,
    transactionIdentity: PathIdentity,
    expected: SourceTransactionMarker
  ): Promise<void> {
    await this.assertIdentity(transaction, transactionIdentity);
    const current = parseSourceMarker(await this.readJson(
      join(transaction, 'marker.json'),
      transactionIdentity
    ));
    if (
      expected.version !== 2
      || current.version !== 2
      || current.ownerToken !== expected.ownerToken
      || current.transactionId !== expected.transactionId
    ) {
      throw characterError('CHARACTER_SOURCE_TRANSACTION_INVALID');
    }
    this.assertTransactionMarkerLocation(
      transaction,
      SOURCE_TRANSACTION_DIRECTORY,
      current,
      'CHARACTER_SOURCE_TRANSACTION_INVALID'
    );
  }

  private async assertCompiledTransactionOwned(
    transaction: string,
    transactionIdentity: PathIdentity,
    expected: CompiledTransactionMarker
  ): Promise<void> {
    await this.assertIdentity(transaction, transactionIdentity);
    const current = parseCompiledMarker(await this.readJson(
      join(transaction, 'marker.json'),
      transactionIdentity
    ));
    if (
      expected.version !== 2
      || current.version !== 2
      || current.ownerToken !== expected.ownerToken
      || current.transactionId !== expected.transactionId
    ) {
      throw characterError('CHARACTER_COMPILED_TRANSACTION_INVALID');
    }
    this.assertTransactionMarkerLocation(
      transaction,
      COMPILED_TRANSACTION_DIRECTORY,
      current,
      'CHARACTER_COMPILED_TRANSACTION_INVALID'
    );
  }

  private async recoverTransactions(
    paths: CharacterPaths,
    characterId: string
  ): Promise<void> {
    await this.recoverSourceTransaction(paths, characterId);
    await this.recoverCompiledTransaction(paths, characterId);
    await this.cleanupCatalogTemps(
      paths.sourceDirectory,
      paths.sourceIdentity,
      paths.lease
    );
    await this.cleanupCatalogTemps(
      paths.compiledDirectory,
      paths.compiledIdentity,
      paths.lease
    );
  }

  private async recoverSourceTransaction(
    paths: CharacterPaths,
    characterId: string
  ): Promise<void> {
    const transactions = await this.findTransactionDirectories(
      paths,
      SOURCE_TRANSACTION_DIRECTORY
    );
    for (const transaction of transactions) {
      await this.recoverSourceTransactionDirectory(paths, characterId, transaction);
    }
  }

  private async recoverSourceTransactionDirectory(
    paths: CharacterPaths,
    characterId: string,
    transaction: string
  ): Promise<void> {
    const transactionIdentity = await this.captureIdentity(transaction, 'directory');
    if (!(await this.pathExists(join(transaction, 'marker.json')))) {
      await this.removeTransactionDirectory(
        transaction,
        transactionIdentity,
        paths.characterDirectory,
        paths.characterIdentity,
        paths.lease
      );
      return;
    }
    const marker = parseSourceMarker(await this.readJson(
      join(transaction, 'marker.json'),
      transactionIdentity
    ));
    this.assertTransactionMarkerLocation(
      transaction,
      SOURCE_TRANSACTION_DIRECTORY,
      marker,
      'CHARACTER_SOURCE_TRANSACTION_INVALID'
    );
    if (marker.phase !== 'catalog-committed') {
      for (const entry of marker.entries) {
        await paths.lease.assertOwned();
        await this.assertIdentity(paths.sourceDirectory, paths.sourceIdentity);
        await rm(join(
          paths.sourceDirectory,
          `${entry.assetId}${entry.extension}`
        ), { force: true });
        await this.assertIdentity(paths.sourceDirectory, paths.sourceIdentity);
      }
      const catalogFile = join(paths.sourceDirectory, SOURCE_CATALOG_FILE);
      if (marker.hadCatalog) {
        const previous = parseSourceCatalog(await this.readJson(
          join(transaction, 'previous-catalog.json'),
          transactionIdentity
        ), characterId);
        await this.writeCatalog(
          catalogFile,
          previous,
          paths.sourceIdentity,
          paths.lease
        );
      } else {
        await paths.lease.assertOwned();
        await this.assertIdentity(paths.sourceDirectory, paths.sourceIdentity);
        await rm(catalogFile, { force: true });
        await this.assertIdentity(paths.sourceDirectory, paths.sourceIdentity);
      }
    }
    await this.removeTransactionDirectory(
      transaction,
      transactionIdentity,
      paths.characterDirectory,
      paths.characterIdentity,
      paths.lease
    );
  }

  private async rollbackSourceTransaction(
    paths: CharacterPaths,
    marker: SourceTransactionMarker,
    transaction: string,
    transactionIdentity: PathIdentity,
    lease: CharacterLeaseGuard
  ): Promise<void> {
    await lease.assertOwned();
    await this.assertSourceTransactionOwned(transaction, transactionIdentity, marker);
    if (marker.phase === 'catalog-committed') {
      await this.removeTransactionDirectory(
        transaction,
        transactionIdentity,
        paths.characterDirectory,
        paths.characterIdentity,
        lease
      );
      return;
    }
    await this.assertIdentity(paths.sourceDirectory, paths.sourceIdentity);
    for (const entry of marker.entries) {
      await lease.assertOwned();
      await this.assertIdentity(paths.sourceDirectory, paths.sourceIdentity);
      await rm(join(
        paths.sourceDirectory,
        `${entry.assetId}${entry.extension}`
      ), { force: true });
      await this.assertIdentity(paths.sourceDirectory, paths.sourceIdentity);
    }
    const catalogFile = join(paths.sourceDirectory, SOURCE_CATALOG_FILE);
    if (marker.hadCatalog) {
      const previous = parseSourceCatalog(await this.readJson(
        join(transaction, 'previous-catalog.json'),
        transactionIdentity
      ), basename(paths.characterDirectory));
      await this.writeCatalog(catalogFile, previous, paths.sourceIdentity, lease);
    } else {
      await lease.assertOwned();
      await this.assertIdentity(paths.sourceDirectory, paths.sourceIdentity);
      await rm(catalogFile, { force: true });
      await this.assertIdentity(paths.sourceDirectory, paths.sourceIdentity);
    }
    await this.removeTransactionDirectory(
      transaction,
      transactionIdentity,
      paths.characterDirectory,
      paths.characterIdentity,
      lease
    );
  }

  private async recoverCompiledTransaction(
    paths: CharacterPaths,
    characterId: string
  ): Promise<void> {
    const transactions = await this.findTransactionDirectories(
      paths,
      COMPILED_TRANSACTION_DIRECTORY
    );
    for (const transaction of transactions) {
      await this.recoverCompiledTransactionDirectory(paths, characterId, transaction);
    }
  }

  private async recoverCompiledTransactionDirectory(
    paths: CharacterPaths,
    characterId: string,
    transaction: string
  ): Promise<void> {
    const transactionIdentity = await this.captureIdentity(transaction, 'directory');
    if (!(await this.pathExists(join(transaction, 'marker.json')))) {
      await this.removeTransactionDirectory(
        transaction,
        transactionIdentity,
        paths.characterDirectory,
        paths.characterIdentity,
        paths.lease
      );
      return;
    }
    const marker = parseCompiledMarker(await this.readJson(
      join(transaction, 'marker.json'),
      transactionIdentity
    ));
    this.assertTransactionMarkerLocation(
      transaction,
      COMPILED_TRANSACTION_DIRECTORY,
      marker,
      'CHARACTER_COMPILED_TRANSACTION_INVALID'
    );
    if (marker.phase !== 'catalog-committed') {
      await this.restoreCompiledTransaction(
        paths,
        characterId,
        marker,
        transaction,
        transactionIdentity,
        paths.lease
      );
    }
    await this.removeTransactionDirectory(
      transaction,
      transactionIdentity,
      paths.characterDirectory,
      paths.characterIdentity,
      paths.lease
    );
  }

  private async removeTransactionDirectory(
    transaction: string,
    transactionIdentity: PathIdentity,
    characterDirectory: string,
    characterIdentity: PathIdentity,
    lease: CharacterLeaseGuard
  ): Promise<void> {
    await lease.assertOwned();
    await this.assertIdentity(characterDirectory, characterIdentity);
    await this.assertIdentity(transaction, transactionIdentity);
    await rm(transaction, { recursive: true, force: true });
    await this.assertIdentity(characterDirectory, characterIdentity);
  }

  private async rollbackCompiledTransaction(
    paths: CharacterPaths,
    marker: CompiledTransactionMarker,
    transaction: string,
    transactionIdentity: PathIdentity,
    lease: CharacterLeaseGuard
  ): Promise<void> {
    await lease.assertOwned();
    await this.assertCompiledTransactionOwned(transaction, transactionIdentity, marker);
    if (marker.phase === 'catalog-committed') {
      await this.removeTransactionDirectory(
        transaction,
        transactionIdentity,
        paths.characterDirectory,
        paths.characterIdentity,
        lease
      );
      return;
    }
    await this.assertIdentity(paths.compiledDirectory, paths.compiledIdentity);
    await this.restoreCompiledTransaction(
      paths,
      basename(paths.characterDirectory),
      marker,
      transaction,
      transactionIdentity,
      lease
    );
    await this.removeTransactionDirectory(
      transaction,
      transactionIdentity,
      paths.characterDirectory,
      paths.characterIdentity,
      lease
    );
  }

  private async restoreCompiledTransaction(
    paths: CharacterPaths,
    characterId: string,
    marker: CompiledTransactionMarker,
    transaction: string,
    transactionIdentity: PathIdentity,
    lease: CharacterLeaseGuard
  ): Promise<void> {
    const nextFile = join(
      paths.compiledDirectory,
      `${marker.assetId}${marker.nextExtension}`
    );
    const previousBackup = join(transaction, 'previous-resource');
    const backupExists = await this.pathExists(previousBackup);
    if (marker.previousExtension) {
      if (backupExists) {
        const previousFile = join(
          paths.compiledDirectory,
          `${marker.assetId}${marker.previousExtension}`
        );
        await lease.assertOwned();
        await this.assertIdentity(paths.compiledDirectory, paths.compiledIdentity);
        await rm(nextFile, { force: true });
        if (previousFile !== nextFile) {
          await lease.assertOwned();
          await this.assertIdentity(paths.compiledDirectory, paths.compiledIdentity);
          await rm(previousFile, { force: true });
        }
        await this.assertIdentity(paths.compiledDirectory, paths.compiledIdentity);
        await this.renameStable(
          previousBackup,
          previousFile,
          transactionIdentity,
          paths.compiledIdentity,
          undefined,
          lease
        );
      } else if (
        marker.phase === 'previous-moved'
        || marker.phase === 'installed'
      ) {
        throw characterError('CHARACTER_COMPILED_TRANSACTION_INVALID');
      }
    } else {
      await lease.assertOwned();
      await this.assertIdentity(paths.compiledDirectory, paths.compiledIdentity);
      await rm(nextFile, { force: true });
      await this.assertIdentity(paths.compiledDirectory, paths.compiledIdentity);
    }
    const catalogFile = join(paths.compiledDirectory, COMPILED_CATALOG_FILE);
    if (marker.hadCatalog) {
      const previous = parseCompiledCatalog(await this.readJson(
        join(transaction, 'previous-catalog.json'),
        transactionIdentity
      ), characterId);
      await this.writeCatalog(
        catalogFile,
        previous,
        paths.compiledIdentity,
        lease
      );
    } else {
      await lease.assertOwned();
      await this.assertIdentity(paths.compiledDirectory, paths.compiledIdentity);
      await rm(catalogFile, { force: true });
      await this.assertIdentity(paths.compiledDirectory, paths.compiledIdentity);
    }
  }

  private async cleanupCatalogTemps(
    directory: string,
    identity: PathIdentity,
    lease: CharacterLeaseGuard
  ): Promise<void> {
    await lease.assertOwned();
    await this.assertIdentity(directory, identity);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!CATALOG_TEMP_PATTERN.test(entry.name)) continue;
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw characterError('CHARACTER_PATH_UNSAFE');
      }
      await lease.assertOwned();
      await rm(join(directory, entry.name), { force: true });
    }
    await this.assertIdentity(directory, identity);
  }

  private async checkpoint(checkpoint: CharacterAssetOperationCheckpoint): Promise<void> {
    await this.dependencies.onCheckpoint?.(checkpoint);
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await lstat(path);
      return true;
    } catch (cause) {
      if (isMissingFile(cause)) return false;
      throw cause;
    }
  }
}
