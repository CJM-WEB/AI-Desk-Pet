import { createHash } from 'node:crypto';
import { open as openFile, stat } from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import {
  characterSourceCatalogV1Schema,
  validateCharacterPackageStructure,
  WEBSITE_SHARED_PACKAGE_LIMITS,
  validatePackageEntries,
  type PackageEntryDescriptor
} from '@myself/character-assets';
import {
  characterDraftV1Schema,
  characterManifestV1Schema,
} from '@myself/character-runtime';
import sharp from 'sharp';
import * as yauzl from 'yauzl';

export const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 16_777_216;
const MAX_JSON_REVIEW_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_SIGNAL_BYTES = 4 * 1024 * 1024;
const MAX_SCAN_RESPONSE_BYTES = 12 * 1024 * 1024;
const UNIX_FILE_TYPE_MASK = 0xf000;
const UNIX_REGULAR_FILE = 0x8000;
const UNIX_DIRECTORY = 0x4000;
const UNIX_SYMBOLIC_LINK = 0xa000;
const HIDDEN_PATH_SEGMENT = /(?:^|\/)\.[^/]+/u;

export type ClamAvScanResult = {
  infected: boolean;
  signature?: string;
};

export interface ClamAvScanner {
  scan(input: {
    path: string;
    bytes: Buffer;
    signal?: AbortSignal;
  }): Promise<ClamAvScanResult>;
}

export type ImageModerationSignal = {
  path: string;
  provider: string;
  suggestion: 'pass' | 'review' | 'block';
  labels: readonly string[];
  ocrText?: string;
};

export interface ImageContentModerator {
  review(input: {
    path: string;
    bytes: Buffer;
    mime: 'image/png' | 'image/webp';
    signal?: AbortSignal;
  }): Promise<ImageModerationSignal>;
}

export type PackageFileSummary =
  | {
      path: string;
      kind: 'json';
      uncompressedBytes: number;
      sha256: string;
    }
  | {
      path: string;
      kind: 'image';
      mime: 'image/png' | 'image/webp';
      uncompressedBytes: number;
      sha256: string;
    };

export type PackageScanResult = {
  code: 'CHARACTER_PACKAGE_LOCAL_SCAN_COMPLETED';
  manualReviewRequired: true;
  archive: {
    sizeBytes: number;
    sha256: string;
  };
  summary: {
    fileCount: number;
    totalUncompressedBytes: number;
    files: PackageFileSummary[];
  };
  jsonTexts: Array<{
    path: string;
    text: string;
  }>;
  imageSignals: ImageModerationSignal[];
};

export type ArchiveIdentity = {
  sizeBytes: number;
  sha256: string;
};

export type ScanPackageInput = {
  archivePath: string;
  archive: ArchiveIdentity;
  clamav: ClamAvScanner;
  imageModerator: ImageContentModerator;
  signal?: AbortSignal;
};

type ScannedEntry = {
  zipEntry: yauzl.Entry;
  descriptor: PackageEntryDescriptor;
  normalizedPath: string;
};

function packageError(code: string, cause?: unknown): Error {
  return new Error(code, cause === undefined ? undefined : { cause });
}

function throwIfScanAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw packageError('SCANNER_SCAN_TIMEOUT', signal.reason);
  }
}

function entryKind(entry: yauzl.Entry): PackageEntryDescriptor['kind'] {
  const unixMode = entry.externalFileAttributes >>> 16;
  const unixType = unixMode & UNIX_FILE_TYPE_MASK;
  if (
    unixType === UNIX_SYMBOLIC_LINK
    || ![
      0,
      UNIX_REGULAR_FILE,
      UNIX_DIRECTORY
    ].includes(unixType)
    || (unixType === UNIX_DIRECTORY && !entry.fileName.endsWith('/'))
  ) {
    return 'symlink';
  }
  return entry.fileName.endsWith('/') ? 'directory' : 'file';
}

async function assertSingleDiskZip(archivePath: string): Promise<void> {
  const archive = await openFile(archivePath, 'r');
  try {
    const information = await archive.stat();
    const tailLength = Math.min(information.size, 65_557);
    const tail = Buffer.allocUnsafe(tailLength);
    await archive.read(tail, 0, tailLength, information.size - tailLength);
    const signature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
    const eocdOffset = tail.lastIndexOf(signature);
    if (eocdOffset < 0) {
      throw packageError('CHARACTER_PACKAGE_ZIP_INVALID');
    }
    const diskNumber = tail.readUInt16LE(eocdOffset + 4);
    const centralDirectoryDisk = tail.readUInt16LE(eocdOffset + 6);
    const entriesOnDisk = tail.readUInt16LE(eocdOffset + 8);
    const totalEntries = tail.readUInt16LE(eocdOffset + 10);
    if (
      diskNumber !== 0
      || centralDirectoryDisk !== 0
      || entriesOnDisk !== totalEntries
    ) {
      throw packageError('CHARACTER_PACKAGE_MULTIDISK_REJECTED');
    }
  } finally {
    await archive.close();
  }
}

async function openZip(archivePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, {
      autoClose: false,
      lazyEntries: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: false
    }, (error, zipFile) => {
      if (error || !zipFile) {
        reject(packageError('CHARACTER_PACKAGE_ZIP_INVALID', error));
        return;
      }
      resolve(zipFile);
    });
  });
}

async function collectEntries(zipFile: yauzl.ZipFile): Promise<ScannedEntry[]> {
  return new Promise((resolve, reject) => {
    const entries: ScannedEntry[] = [];
    const fail = (error: unknown) => {
      if (
        error instanceof Error
        && error.message.startsWith('invalid relative path:')
      ) {
        reject(packageError('CHARACTER_PACKAGE_PATH_REJECTED', error));
        return;
      }
      reject(
        error instanceof Error
          ? error
          : packageError('CHARACTER_PACKAGE_ZIP_INVALID')
      );
    };

    zipFile.once('error', fail);
    zipFile.on('entry', (entry: yauzl.Entry) => {
      if (entry.isEncrypted()) {
        reject(packageError('CHARACTER_PACKAGE_ENCRYPTED_REJECTED'));
        return;
      }
      const kind = entryKind(entry);
      const normalizedPath = entry.fileName.replaceAll('\\', '/').normalize('NFC');
      entries.push({
        zipEntry: entry,
        normalizedPath,
        descriptor: {
          path: entry.fileName,
          compressedBytes: entry.compressedSize,
          uncompressedBytes: entry.uncompressedSize,
          kind
        }
      });
      zipFile.readEntry();
    });
    zipFile.once('end', () => resolve(entries));
    zipFile.readEntry();
  });
}

async function readEntryBytes(
  zipFile: yauzl.ZipFile,
  entry: ScannedEntry,
  signal?: AbortSignal
): Promise<Buffer> {
  throwIfScanAborted(signal);
  const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) => {
    zipFile.openReadStream(entry.zipEntry, (error, input) => {
      if (error || !input) {
        reject(packageError('CHARACTER_PACKAGE_ZIP_INVALID', error));
        return;
      }
      resolve(input);
    });
  });

  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of stream) {
    throwIfScanAborted(signal);
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += bytes.byteLength;
    if (byteLength > entry.descriptor.uncompressedBytes) {
      throw packageError('CHARACTER_PACKAGE_ENTRY_SIZE_MISMATCH');
    }
    chunks.push(bytes);
  }
  if (byteLength !== entry.descriptor.uncompressedBytes) {
    throw packageError('CHARACTER_PACKAGE_ENTRY_SIZE_MISMATCH');
  }
  throwIfScanAborted(signal);
  return Buffer.concat(chunks, byteLength);
}

function extension(path: string): '.json' | '.png' | '.webp' {
  const lowerPath = path.toLocaleLowerCase('en-US');
  if (lowerPath.endsWith('.json')) return '.json';
  if (lowerPath.endsWith('.png')) return '.png';
  if (lowerPath.endsWith('.webp')) return '.webp';
  throw packageError('CHARACTER_PACKAGE_FILE_TYPE_REJECTED');
}

function hasPngSignature(bytes: Buffer): boolean {
  return bytes.byteLength >= 8
    && bytes.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );
}

function hasWebpSignature(bytes: Buffer): boolean {
  return bytes.byteLength >= 12
    && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
}

function parseJson(bytes: Buffer): { text: string; value: unknown } {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { text, value: JSON.parse(text) };
  } catch (error) {
    throw packageError('CHARACTER_PACKAGE_JSON_INVALID', error);
  }
}

async function validateImage(
  bytes: Buffer,
  expectedExtension: '.png' | '.webp'
): Promise<'image/png' | 'image/webp'> {
  const mime = expectedExtension === '.png' ? 'image/png' : 'image/webp';
  const signatureMatches = expectedExtension === '.png'
    ? hasPngSignature(bytes)
    : hasWebpSignature(bytes);
  if (!signatureMatches) {
    throw packageError('CHARACTER_PACKAGE_SIGNATURE_MISMATCH');
  }

  try {
    const image = sharp(bytes, {
      failOn: 'error',
      limitInputPixels: MAX_IMAGE_PIXELS
    });
    const metadata = await image.metadata();
    if (
      metadata.format !== expectedExtension.slice(1)
      || !metadata.width
      || !metadata.height
    ) {
      throw packageError('CHARACTER_PACKAGE_IMAGE_INVALID');
    }
    // 必须实际解码像素，避免只读取头部而放过损坏的压缩数据。
    await image.rotate().raw().toBuffer();
  } catch (error) {
    if (
      error instanceof Error
      && error.message === 'CHARACTER_PACKAGE_IMAGE_INVALID'
    ) {
      throw error;
    }
    throw packageError('CHARACTER_PACKAGE_IMAGE_INVALID', error);
  }
  return mime;
}

function assertVisiblePaths(entries: readonly ScannedEntry[]): void {
  if (entries.some(entry => HIDDEN_PATH_SEGMENT.test(entry.normalizedPath))) {
    throw packageError('CHARACTER_PACKAGE_PATH_REJECTED');
  }
}

function assertJsonReviewBudget(entries: readonly ScannedEntry[]): void {
  const totalJsonBytes = entries.reduce((total, entry) => (
    entry.descriptor.kind === 'file'
    && entry.normalizedPath.toLocaleLowerCase('en-US').endsWith('.json')
      ? total + entry.descriptor.uncompressedBytes
      : total
  ), 0);
  if (totalJsonBytes > MAX_JSON_REVIEW_BYTES) {
    throw packageError('CHARACTER_PACKAGE_JSON_REVIEW_BYTES_EXCEEDED');
  }
}

export async function scanPackage(
  input: ScanPackageInput
): Promise<PackageScanResult> {
  throwIfScanAborted(input.signal);
  const archiveInformation = await stat(input.archivePath);
  if (
    !archiveInformation.isFile()
    || archiveInformation.size <= 0
    || archiveInformation.size > MAX_ARCHIVE_BYTES
    || archiveInformation.size !== input.archive.sizeBytes
    || !/^[a-f0-9]{64}$/u.test(input.archive.sha256)
  ) {
    throw packageError('CHARACTER_PACKAGE_ARCHIVE_SIZE_REJECTED');
  }
  throwIfScanAborted(input.signal);
  await assertSingleDiskZip(input.archivePath);

  const zipFile = await openZip(input.archivePath);
  try {
    const entries = await collectEntries(zipFile);
    assertVisiblePaths(entries);
    assertJsonReviewBudget(entries);
    const validation = validatePackageEntries(
      entries.map(entry => entry.descriptor),
      WEBSITE_SHARED_PACKAGE_LIMITS
    );
    const files = entries.filter(entry => entry.descriptor.kind === 'file');
    const summaries: PackageFileSummary[] = [];
    const jsonTexts: PackageScanResult['jsonTexts'] = [];
    const imageSignals: ImageModerationSignal[] = [];
    let imageSignalBytes = 0;
    let draft: unknown;
    let manifest: unknown;
    let sourceCatalog: unknown;

    for (const entry of files) {
      throwIfScanAborted(input.signal);
      const bytes = await readEntryBytes(zipFile, entry, input.signal);
      let malwareResult: ClamAvScanResult;
      try {
        malwareResult = await input.clamav.scan({
          path: entry.normalizedPath,
          bytes,
          ...(input.signal ? { signal: input.signal } : {})
        });
      } catch (error) {
        throwIfScanAborted(input.signal);
        throw packageError('SCANNER_CLAMAV_UNAVAILABLE', error);
      }
      throwIfScanAborted(input.signal);
      if (malwareResult.infected) {
        throw packageError('CHARACTER_PACKAGE_MALWARE_DETECTED');
      }

      const fileExtension = extension(entry.normalizedPath);
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (fileExtension === '.json') {
        if (hasPngSignature(bytes) || hasWebpSignature(bytes)) {
          throw packageError('CHARACTER_PACKAGE_SIGNATURE_MISMATCH');
        }
        const parsed = parseJson(bytes);
        if (entry.normalizedPath === 'draft/draft.json') {
          draft = parsed.value;
        } else if (entry.normalizedPath === 'compiled/manifest.json') {
          manifest = parsed.value;
        } else if (entry.normalizedPath === 'source/catalog.json') {
          sourceCatalog = parsed.value;
        }
        jsonTexts.push({
          path: entry.normalizedPath,
          text: parsed.text
        });
        summaries.push({
          path: entry.normalizedPath,
          kind: 'json',
          uncompressedBytes: bytes.byteLength,
          sha256: digest
        });
        continue;
      }

      const mime = await validateImage(bytes, fileExtension);
      let signal: ImageModerationSignal;
      try {
        signal = await input.imageModerator.review({
          path: entry.normalizedPath,
          bytes,
          mime,
          ...(input.signal ? { signal: input.signal } : {})
        });
      } catch (error) {
        throwIfScanAborted(input.signal);
        throw packageError('SCANNER_IMAGE_MODERATION_UNAVAILABLE', error);
      }
      throwIfScanAborted(input.signal);
      imageSignalBytes += Buffer.byteLength(JSON.stringify(signal), 'utf8');
      if (imageSignalBytes > MAX_IMAGE_SIGNAL_BYTES) {
        throw packageError('CHARACTER_PACKAGE_SCAN_RESPONSE_TOO_LARGE');
      }
      imageSignals.push(signal);
      summaries.push({
        path: entry.normalizedPath,
        kind: 'image',
        mime,
        uncompressedBytes: bytes.byteLength,
        sha256: digest
      });
    }

    const draftResult = characterDraftV1Schema.safeParse(draft);
    const manifestResult = characterManifestV1Schema.safeParse(manifest);
    const sourceResult = characterSourceCatalogV1Schema.safeParse(sourceCatalog);
    if (!manifestResult.success) {
      throw packageError('CHARACTER_PACKAGE_MANIFEST_INVALID');
    }
    if (!draftResult.success || !sourceResult.success) {
      throw packageError('CHARACTER_PACKAGE_STRUCTURE_INVALID');
    }
    validateCharacterPackageStructure({
      draftId: draftResult.data.id,
      manifest: manifestResult.data,
      sourceCatalog: sourceResult.data,
      files: summaries.map(summary => ({
        path: summary.path,
        kind: summary.kind,
        ...(summary.kind === 'image' ? { mime: summary.mime } : {}),
        byteLength: summary.uncompressedBytes,
        sha256: summary.sha256
      }))
    });

    const result: PackageScanResult = {
      code: 'CHARACTER_PACKAGE_LOCAL_SCAN_COMPLETED',
      manualReviewRequired: true,
      archive: input.archive,
      summary: {
        fileCount: validation.fileCount,
        totalUncompressedBytes: validation.totalUncompressedBytes,
        files: summaries
      },
      jsonTexts,
      imageSignals
    };
    if (
      Buffer.byteLength(JSON.stringify(result), 'utf8')
      > MAX_SCAN_RESPONSE_BYTES
    ) {
      throw packageError('CHARACTER_PACKAGE_SCAN_RESPONSE_TOO_LARGE');
    }
    return result;
  } catch (error) {
    if (
      error instanceof Error
      && (
        error.message.startsWith('CHARACTER_PACKAGE_')
        || error.message.startsWith('SCANNER_')
      )
    ) {
      throw error;
    }
    throw packageError('CHARACTER_PACKAGE_ZIP_INVALID', error);
  } finally {
    zipFile.close();
  }
}
