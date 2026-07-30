export type CharacterPackageLimits = {
  readonly maxEntries: number;
  readonly maxFiles: number;
  readonly maxTotalUncompressedBytes: number;
  readonly maxJsonBytes: number;
  readonly maxResourceBytes: number;
  readonly maxExpansionRatio: number;
};

export const CHARACTER_PACKAGE_LIMITS: CharacterPackageLimits = Object.freeze({
  maxEntries: 2_000,
  maxFiles: 2_000,
  maxTotalUncompressedBytes: 256 * 1024 * 1024,
  maxJsonBytes: 2 * 1024 * 1024,
  maxResourceBytes: 32 * 1024 * 1024,
  maxExpansionRatio: 100
});
const ALLOWED_FILE_EXTENSIONS = new Set(['.json', '.png', '.webp']);
const WINDOWS_RESERVED_NAME =
  /^(con|prn|aux|nul|com(?:[1-9]|[¹²³])|lpt(?:[1-9]|[¹²³]))(?:\.|$)/iu;

export type PackageEntryDescriptor = {
  path: string;
  compressedBytes: number;
  uncompressedBytes: number;
  kind: 'file' | 'directory' | 'symlink';
};

export type PackageValidationResult = {
  fileCount: number;
  totalUncompressedBytes: number;
  normalizedPaths: string[];
};

function packageError(code: string): Error {
  return new Error(code);
}

function validateByteCount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw packageError('CHARACTER_PACKAGE_ENTRY_INVALID');
  }
}

function normalizeEntryPath(entry: PackageEntryDescriptor): string {
  if (
    typeof entry.path !== 'string'
    || entry.path.length === 0
    || entry.path.includes('\0')
  ) {
    throw packageError('CHARACTER_PACKAGE_PATH_REJECTED');
  }

  const normalized = entry.path.replaceAll('\\', '/').normalize('NFC');
  if (
    normalized.startsWith('/')
    || /^[a-z]:/iu.test(normalized)
  ) {
    throw packageError('CHARACTER_PACKAGE_PATH_REJECTED');
  }

  const segments = normalized.split('/');
  if (entry.kind === 'directory' && segments.at(-1) === '') {
    segments.pop();
  }
  if (
    segments.length === 0
    || segments.some(segment => (
      segment.length === 0
      || segment === '..'
      || segment === '.'
      || segment.includes(':')
      || segment !== segment.replace(/[. ]+$/u, '')
      || WINDOWS_RESERVED_NAME.test(segment)
    ))
  ) {
    throw packageError('CHARACTER_PACKAGE_PATH_REJECTED');
  }

  const joined = segments.join('/');
  return entry.kind === 'directory' ? `${joined}/` : joined;
}

function windowsCollisionKey(path: string): string {
  return path
    .replace(/\/$/u, '')
    .split('/')
    .map(segment => segment
      .normalize('NFC')
      .replace(/[. ]+$/u, '')
      .toLocaleLowerCase('en-US'))
    .join('/');
}

function validateFileType(path: string): void {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const extensionIndex = name.lastIndexOf('.');
  const extension = extensionIndex < 0
    ? ''
    : name.slice(extensionIndex).toLocaleLowerCase('en-US');
  if (!ALLOWED_FILE_EXTENSIONS.has(extension)) {
    throw packageError('CHARACTER_PACKAGE_FILE_TYPE_REJECTED');
  }
}

export function validatePackageEntries(
  entries: readonly PackageEntryDescriptor[]
): PackageValidationResult {
  if (
    entries.filter(entry => entry.kind === 'file').length
      > CHARACTER_PACKAGE_LIMITS.maxFiles
  ) {
    throw packageError('CHARACTER_PACKAGE_FILE_COUNT_EXCEEDED');
  }
  if (entries.length > CHARACTER_PACKAGE_LIMITS.maxEntries) {
    throw packageError('CHARACTER_PACKAGE_ENTRY_COUNT_EXCEEDED');
  }
  const normalizedPaths: string[] = [];
  const seenPaths = new Map<string, PackageEntryDescriptor['kind']>();
  let fileCount = 0;
  let totalUncompressedBytes = 0;

  for (const entry of entries) {
    validateByteCount(entry.compressedBytes);
    validateByteCount(entry.uncompressedBytes);
    if (entry.kind === 'symlink') {
      throw packageError('CHARACTER_PACKAGE_LINK_REJECTED');
    }
    if (entry.kind !== 'file' && entry.kind !== 'directory') {
      throw packageError('CHARACTER_PACKAGE_ENTRY_INVALID');
    }
    if (
      entry.kind === 'directory'
      && (entry.compressedBytes !== 0 || entry.uncompressedBytes !== 0)
    ) {
      throw packageError('CHARACTER_PACKAGE_ENTRY_INVALID');
    }

    const normalizedPath = normalizeEntryPath(entry);
    const comparisonPath = windowsCollisionKey(normalizedPath);
    if (seenPaths.has(comparisonPath)) {
      throw packageError('CHARACTER_PACKAGE_DUPLICATE_ENTRY');
    }
    const segments = comparisonPath.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      if (seenPaths.get(segments.slice(0, index).join('/')) === 'file') {
        throw packageError('CHARACTER_PACKAGE_PATH_PREFIX_CONFLICT');
      }
    }
    if (
      entry.kind === 'file'
      && [...seenPaths.keys()].some(path => path.startsWith(`${comparisonPath}/`))
    ) {
      throw packageError('CHARACTER_PACKAGE_PATH_PREFIX_CONFLICT');
    }
    seenPaths.set(comparisonPath, entry.kind);
    normalizedPaths.push(normalizedPath);

    if (entry.kind === 'directory') continue;
    validateFileType(normalizedPath);
    fileCount += 1;
    if (fileCount > CHARACTER_PACKAGE_LIMITS.maxFiles) {
      throw packageError('CHARACTER_PACKAGE_FILE_COUNT_EXCEEDED');
    }
    if (
      normalizedPath.endsWith('.json')
      && entry.uncompressedBytes > CHARACTER_PACKAGE_LIMITS.maxJsonBytes
    ) {
      throw packageError('CHARACTER_PACKAGE_JSON_TOO_LARGE');
    }
    if (
      !normalizedPath.endsWith('.json')
      && entry.uncompressedBytes > CHARACTER_PACKAGE_LIMITS.maxResourceBytes
    ) {
      throw packageError('CHARACTER_PACKAGE_RESOURCE_TOO_LARGE');
    }
    if (
      (entry.compressedBytes === 0 && entry.uncompressedBytes > 0)
      || entry.uncompressedBytes
        > entry.compressedBytes * CHARACTER_PACKAGE_LIMITS.maxExpansionRatio
    ) {
      throw packageError('CHARACTER_PACKAGE_EXPANSION_LIMIT');
    }
    totalUncompressedBytes += entry.uncompressedBytes;
    if (
      totalUncompressedBytes
        > CHARACTER_PACKAGE_LIMITS.maxTotalUncompressedBytes
    ) {
      throw packageError('CHARACTER_PACKAGE_TOTAL_BYTES_EXCEEDED');
    }
  }

  return {
    fileCount,
    totalUncompressedBytes,
    normalizedPaths
  };
}
