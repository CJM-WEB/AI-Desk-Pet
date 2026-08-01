import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZipFile } from 'yazl';

export type ZipFixtureEntry = {
  path: string;
  bytes?: Buffer;
  mode?: number;
  compress?: boolean;
};

export async function zipFixture(entries: readonly ZipFixtureEntry[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'package-scanner-test-'));
  const archivePath = join(directory, 'fixture.zip');
  const zip = new ZipFile();

  const encodedPathPatches: Array<{ safe: Buffer; unsafe: Buffer }> = [];
  for (const [index, entry] of entries.entries()) {
    const unsafe = Buffer.from(entry.path);
    const safePath = entry.path.includes('..')
      ? `${String(index).padStart(unsafe.byteLength - 5, '0')}.json`
      : entry.path;
    if (safePath !== entry.path) {
      encodedPathPatches.push({
        safe: Buffer.from(safePath),
        unsafe
      });
    }
    zip.addBuffer(entry.bytes ?? Buffer.from('{}'), safePath, {
      compress: entry.compress ?? true,
      ...(entry.mode === undefined ? {} : { mode: entry.mode })
    });
  }

  zip.end();
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(archivePath);
    zip.outputStream.pipe(output);
    output.on('close', resolve);
    output.on('error', reject);
    zip.outputStream.on('error', reject);
  });
  if (encodedPathPatches.length > 0) {
    const archive = await readFile(archivePath);
    for (const patch of encodedPathPatches) {
      if (patch.safe.byteLength !== patch.unsafe.byteLength) {
        throw new Error('测试夹具的安全路径与恶意路径字节数必须一致。');
      }
      let offset = archive.indexOf(patch.safe);
      while (offset >= 0) {
        patch.unsafe.copy(archive, offset);
        offset = archive.indexOf(patch.safe, offset + patch.safe.byteLength);
      }
    }
    await writeFile(archivePath, archive);
  }
  return archivePath;
}

export const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

export const ONE_PIXEL_WEBP = Buffer.from(
  'UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoBAAEAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=',
  'base64'
);

export const SOURCE_ASSET_ID = '11111111-1111-4111-8111-111111111111';

export function corruptedPixelPng(): Buffer {
  const bytes = Buffer.from(ONE_PIXEL_PNG);
  const idatOffset = bytes.indexOf(Buffer.from('IDAT'));
  if (idatOffset < 0) {
    throw new Error('PNG 测试夹具缺少 IDAT 数据块。');
  }
  bytes[idatOffset + 5] = (bytes[idatOffset + 5] ?? 0) ^ 0xff;
  return bytes;
}

type CentralDirectoryPatch = {
  generalPurposeBitFlag?: number;
  compressedSize?: number;
  uncompressedSize?: number;
  externalFileAttributes?: number;
};

export async function patchCentralDirectoryEntries(
  archivePath: string,
  patchForPath: (path: string) => CentralDirectoryPatch | undefined
): Promise<void> {
  const archive = await readFile(archivePath);
  let offset = 0;

  while (offset <= archive.length - 46) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) {
      offset += 1;
      continue;
    }

    const fileNameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const path = archive.subarray(offset + 46, offset + 46 + fileNameLength).toString('utf8');
    const patch = patchForPath(path);

    if (patch?.generalPurposeBitFlag !== undefined) {
      archive.writeUInt16LE(patch.generalPurposeBitFlag, offset + 8);
    }
    if (patch?.compressedSize !== undefined) {
      archive.writeUInt32LE(patch.compressedSize, offset + 20);
    }
    if (patch?.uncompressedSize !== undefined) {
      archive.writeUInt32LE(patch.uncompressedSize, offset + 24);
    }
    if (patch?.externalFileAttributes !== undefined) {
      archive.writeUInt32LE(patch.externalFileAttributes, offset + 38);
    }

    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  await writeFile(archivePath, archive);
}

export function validManifest(
  resource: {
    assetId?: string;
    fileName?: string;
    bytes?: Buffer;
    sha256?: string;
    byteLength?: number;
  } = {}
): Record<string, unknown> {
  const assetId = resource.assetId ?? 'idle';
  const fileName = resource.fileName ?? 'idle.png';
  const bytes = resource.bytes ?? ONE_PIXEL_PNG;
  return {
    version: 1,
    id: 'test-pet',
    name: '测试桌宠',
    thumbnailAssetId: 'idle',
    compilerVersion: '1.0.0',
    resources: [{
      assetId,
      fileName,
      sha256: resource.sha256
        ?? createHash('sha256').update(bytes).digest('hex'),
      byteLength: resource.byteLength ?? bytes.byteLength
    }],
    states: [{
      id: 'idle',
      kind: 'core',
      actions: [{
        id: 'idle',
        name: '待机',
        fps: 12,
        loop: true,
        weight: 1,
        anchors: {
          ground: { x: 0.5, y: 1 }
        },
        frames: [{
          assetId: 'idle',
          x: 0,
          y: 0,
          width: 1,
          height: 1
        }]
      }]
    }]
  };
}

export function validDraft(id = 'test-pet'): Record<string, unknown> {
  return {
    version: 1,
    id,
    name: '测试桌宠',
    states: []
  };
}

export function validSourceCatalog(options: {
  characterId?: string;
  bytes?: Buffer;
  mimeType?: 'image/png' | 'image/webp';
  byteLength?: number;
  sha256?: string;
} = {}): Record<string, unknown> {
  const bytes = options.bytes ?? ONE_PIXEL_PNG;
  return {
    version: 1,
    characterId: options.characterId ?? 'test-pet',
    sources: [{
      assetId: SOURCE_ASSET_ID,
      displayName: 'idle',
      mimeType: options.mimeType ?? 'image/png',
      byteLength: options.byteLength ?? bytes.byteLength,
      sha256: options.sha256
        ?? createHash('sha256').update(bytes).digest('hex')
    }]
  };
}

export function validPackageEntries(options: {
  draftId?: string;
  manifest?: Record<string, unknown>;
  sourceCatalog?: Record<string, unknown>;
  compiledBytes?: Buffer;
  compiledFileName?: string;
  sourceBytes?: Buffer;
  sourceMimeType?: 'image/png' | 'image/webp';
} = {}): ZipFixtureEntry[] {
  const compiledBytes = options.compiledBytes ?? ONE_PIXEL_PNG;
  const compiledFileName = options.compiledFileName ?? 'idle.png';
  const sourceBytes = options.sourceBytes ?? ONE_PIXEL_PNG;
  const sourceMimeType = options.sourceMimeType ?? 'image/png';
  const sourceExtension = sourceMimeType === 'image/png' ? '.png' : '.webp';
  const manifest = options.manifest ?? validManifest({
    fileName: compiledFileName,
    bytes: compiledBytes
  });
  const sourceCatalog = options.sourceCatalog ?? validSourceCatalog({
    bytes: sourceBytes,
    mimeType: sourceMimeType
  });
  return [
    {
      path: 'draft/draft.json',
      bytes: Buffer.from(JSON.stringify(validDraft(options.draftId)))
    },
    {
      path: 'compiled/manifest.json',
      bytes: Buffer.from(JSON.stringify(manifest))
    },
    {
      path: 'source/catalog.json',
      bytes: Buffer.from(JSON.stringify(sourceCatalog))
    },
    {
      path: `compiled/${compiledFileName}`,
      bytes: compiledBytes
    },
    {
      path: `source/${SOURCE_ASSET_ID}${sourceExtension}`,
      bytes: sourceBytes
    }
  ];
}
