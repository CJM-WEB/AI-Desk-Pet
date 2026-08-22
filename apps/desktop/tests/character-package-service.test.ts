import { createHash } from 'node:crypto';
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import * as fsPromises from 'node:fs/promises';
import { createWriteStream as openWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { finished } from 'node:stream/promises';
import {
  characterManifestV2Schema,
  convertCharacterManifestV1ToV2,
  type CharacterManifestV1,
  type CharacterManifestV2
} from '@myself/character-runtime';
import * as yauzl from 'yauzl';
import { ZipFile } from 'yazl';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  classifyPackageEntry,
  CharacterPackageService,
  type CharacterPackageServiceDependencies
} from '../src/main/characters/character-package-service';
import { CharacterAssetService } from '../src/main/characters/character-asset-service';
import { CharacterStore } from '../src/main/characters/character-store';
import * as atomicFileCoordinator from '../src/main/storage/atomic-file-coordinator';

const fsMockState = vi.hoisted(() => ({
  link: undefined as unknown as typeof fsPromises.link,
  open: undefined as unknown as typeof fsPromises.open,
  rm: undefined as unknown as typeof fsPromises.rm,
  rename: undefined as unknown as typeof fsPromises.rename
}));
const atomicMockState = vi.hoisted(() => ({
  writeExclusive: undefined as unknown as typeof atomicFileCoordinator.atomicWriteFileExclusive
}));

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof fsPromises>();
  fsMockState.link = actual.link;
  fsMockState.open = actual.open;
  fsMockState.rm = actual.rm;
  fsMockState.rename = actual.rename;
  return {
    ...actual,
    link: vi.fn(actual.link),
    open: vi.fn(actual.open),
    rm: vi.fn(actual.rm),
    rename: vi.fn(actual.rename)
  };
});

vi.mock('../src/main/storage/atomic-file-coordinator', async importOriginal => {
  const actual = await importOriginal<typeof atomicFileCoordinator>();
  atomicMockState.writeExclusive = actual.atomicWriteFileExclusive;
  return {
    ...actual,
    atomicWriteFileExclusive: vi.fn(actual.atomicWriteFileExclusive)
  };
});

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==',
  'base64'
);
const IMPORT_TOKEN = '33333333-3333-4333-8333-333333333333';
const BROKEN_MARKER_BYTES = Buffer.from('{"version":3');

type RecoveryMarkerSeed = Readonly<{
  fileCharacterId: string;
  bytes?: Buffer;
  bodyCharacterId?: string;
  importTransactionId?: string;
}>;

class AbsentRollbackStore extends CharacterStore {
  override async rollbackImportedCharacter(
    _characterId: string,
    _importTransactionId: string
  ) {
    return { kind: 'absent' } as const;
  }
}

function checksum(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function legacyRuntime(characterId: string): {
  manifest: CharacterManifestV1;
  assets: Readonly<Record<string, Uint8Array>>;
} {
  const bytes = new Uint8Array([1, 2, 3]);
  return {
    manifest: {
      version: 1,
      id: characterId,
      name: '演示角色',
      thumbnailAssetId: 'atlas',
      compilerVersion: '1.0.0',
      resources: [{
        assetId: 'atlas',
        fileName: 'atlas.png',
        sha256: checksum(bytes),
        byteLength: bytes.byteLength
      }],
      states: [{
        id: 'idle',
        kind: 'core',
        actions: [{
          id: 'idle-main',
          name: '待机',
          fps: 8,
          loop: true,
          weight: 1,
          frames: [{
            assetId: 'atlas',
            x: 0,
            y: 0,
            width: 1,
            height: 1
          }],
          anchors: { ground: { x: 0.5, y: 1 } }
        }]
      }]
    },
    assets: { 'atlas.png': bytes }
  };
}

function runtime(characterId: string): {
  manifest: CharacterManifestV2;
  assets: Readonly<Record<string, Uint8Array>>;
} {
  const legacy = legacyRuntime(characterId);
  const manifest = convertCharacterManifestV1ToV2(legacy.manifest).document;
  const presentation = manifest.skins[0]!.presentations[0]!;
  presentation.frames[0]!.id = 'carry-commit';
  presentation.commitFrameId = 'carry-commit';
  presentation.geometry = {
    visualBounds: { x: 0, y: 0, width: 1, height: 1 },
    groundAnchor: { ...presentation.anchors.ground },
    resourceRevision: manifest.resources[0]!.sha256
  };
  return {
    manifest: characterManifestV2Schema.parse(manifest),
    assets: legacy.assets
  };
}

type ZipInput = {
  path: string;
  bytes?: Uint8Array | string;
  mode?: number;
  directory?: boolean;
};

async function writeZip(destination: string, entries: readonly ZipInput[]): Promise<void> {
  const archive = new ZipFile();
  for (const entry of entries) {
    const options = entry.mode === undefined ? {} : { mode: entry.mode };
    if (entry.directory) {
      archive.addEmptyDirectory(entry.path, options);
      continue;
    }
    archive.addBuffer(
      Buffer.from(entry.bytes ?? ''),
      entry.path,
      options
    );
  }
  const output = openWriteStream(destination, { flags: 'wx' });
  archive.outputStream.pipe(output);
  archive.end();
  await finished(output);
}

function openZip(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true }, (error, archive) => {
      if (error) reject(error);
      else resolve(archive);
    });
  });
}

async function readZip(path: string): Promise<Map<string, Buffer>> {
  const archive = await openZip(path);
  const files = new Map<string, Buffer>();
  return new Promise((resolve, reject) => {
    archive.on('error', reject);
    archive.on('end', () => resolve(files));
    archive.on('entry', (entry: yauzl.Entry) => {
      if (entry.fileName.endsWith('/')) {
        archive.readEntry();
        return;
      }
      archive.openReadStream(entry, (error, stream) => {
        if (error) {
          reject(error);
          return;
        }
        const chunks: Buffer[] = [];
        stream.on('error', reject);
        stream.on('data', chunk => chunks.push(Buffer.from(chunk)));
        stream.on('end', () => {
          files.set(entry.fileName, Buffer.concat(chunks));
          archive.readEntry();
        });
      });
    });
    archive.readEntry();
  });
}

describe('角色包 Main 服务', () => {
  let testDirectory: string;
  let charactersDirectory: string;

  beforeEach(async () => {
    testDirectory = await mkdtemp(join(tmpdir(), 'ai-pet-character-package-'));
    charactersDirectory = join(testDirectory, 'characters');
  });

  test('DOS reparse-point 属性按不安全链接处理', () => {
    expect(classifyPackageEntry({
      versionMadeBy: 0,
      externalFileAttributes: 0x400,
      fileName: 'source/link.png'
    })).toBe('symlink');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(fsPromises.link).mockReset().mockImplementation(fsMockState.link);
    vi.mocked(fsPromises.open).mockReset().mockImplementation(fsMockState.open);
    vi.mocked(fsPromises.rm).mockReset().mockImplementation(fsMockState.rm);
    vi.mocked(fsPromises.rename).mockReset().mockImplementation(fsMockState.rename);
    vi.mocked(atomicFileCoordinator.atomicWriteFileExclusive)
      .mockReset()
      .mockImplementation(atomicMockState.writeExclusive);
    await rm(testDirectory, { recursive: true, force: true });
  });

  function rollbackMarker(root: string, characterId: string): string {
    return join(root, `.package-import-rollback-${characterId}.json`);
  }

  function markerV3(characterId: string, importTransactionId: string): Buffer {
    return Buffer.from(JSON.stringify({
      version: 3,
      characterId,
      importTransactionId
    }));
  }

  async function seedRecoveryMarkers(
    rootName: string,
    markers: readonly RecoveryMarkerSeed[]
  ): Promise<{
    root: string;
    bytesByCharacterId: ReadonlyMap<string, Buffer>;
  }> {
    const root = join(testDirectory, rootName);
    const bytesByCharacterId = new Map<string, Buffer>();
    await mkdir(root, { recursive: true });
    for (const marker of markers) {
      const bytes = marker.bytes ?? markerV3(
        marker.bodyCharacterId ?? marker.fileCharacterId,
        marker.importTransactionId ?? IMPORT_TOKEN
      );
      await writeFile(rollbackMarker(root, marker.fileCharacterId), bytes);
      bytesByCharacterId.set(marker.fileCharacterId, bytes);
    }
    return { root, bytesByCharacterId };
  }

  async function preservedEvidence(root: string, characterId: string): Promise<Buffer> {
    const prefix = `.package-import-rollback-${characterId}.json.corrupt-`;
    const name = (await readdir(root)).find(candidate => candidate.startsWith(prefix));
    expect(name).toBeDefined();
    return readFile(join(root, name!));
  }

  async function createPublishedCharacter(
    characterId = 'demo'
  ): Promise<{ store: CharacterStore; sourceAssetId: string }> {
    const store = new CharacterStore(charactersDirectory);
    await store.create({ id: characterId, name: '演示角色' });
    const selectedDirectory = join(testDirectory, 'selected');
    await mkdir(selectedDirectory);
    const source = join(selectedDirectory, 'idle.png');
    await writeFile(source, PNG_BYTES);
    const [imported] = await new CharacterAssetService(charactersDirectory)
      .importSources(characterId, [source]);
    const published = runtime(characterId);
    await store.publishCompiled(characterId, published.manifest, published.assets);
    return { store, sourceAssetId: imported!.assetId };
  }

  async function exportDemoPackage(
    fileName = 'demo.zip',
    sourceRoot = charactersDirectory
  ): Promise<string> {
    const packagePath = join(testDirectory, fileName);
    await new CharacterPackageService(sourceRoot).exportCharacter('demo', packagePath);
    return packagePath;
  }

  test('V2 导出直接读取正式草稿与发布清单', async () => {
    await createPublishedCharacter();
    const destination = await exportDemoPackage('v2-export.zip');

    const files = await readZip(destination);
    expect(JSON.parse(files.get('draft/draft.json')!.toString('utf8')))
      .toMatchObject({ version: 2, id: 'demo' });
    expect(JSON.parse(files.get('compiled/manifest.json')!.toString('utf8')))
      .toMatchObject({
        version: 2,
        id: 'demo',
        identity: { description: '演示角色' },
        skins: [{
          presentations: [{ commitFrameId: 'carry-commit' }]
        }]
      });
    expect((await readdir(testDirectory)).some(name => (
      name.startsWith('.character-export-')
    ))).toBe(false);
  });

  test('V1 角色包在 staging 内统一转换为 V2 后安装', async () => {
    const packagePath = join(testDirectory, 'legacy-v1.zip');
    const legacy = legacyRuntime('legacy');
    await writeZip(packagePath, [
      {
        path: 'draft/draft.json',
        bytes: JSON.stringify({
          version: 1,
          id: 'legacy',
          name: '旧版角色',
          states: legacy.manifest.states
        })
      },
      {
        path: 'compiled/manifest.json',
        bytes: JSON.stringify({ ...legacy.manifest, name: '旧版角色' })
      },
      {
        path: 'source/catalog.json',
        bytes: JSON.stringify({ version: 1, characterId: 'legacy', sources: [] })
      },
      { path: 'compiled/atlas.png', bytes: legacy.assets['atlas.png']! }
    ]);
    const importedCharacters = join(testDirectory, 'legacy-imported');
    const store = new CharacterStore(importedCharacters);
    const decodeAlpha = vi.fn(async () => ({
      width: 1, height: 1, alpha: new Uint8Array([255])
    }));

    const importedId = await new CharacterPackageService(importedCharacters, {
      store,
      assetService: new CharacterAssetService(importedCharacters),
      geometryMigration: { decodeAlpha }
    }).importCharacter(packagePath);

    expect(importedId).toBe('legacy');
    await expect(store.getDraft(importedId)).resolves.toMatchObject({ version: 2 });
    await expect(store.getPublishedManifest(importedId))
      .resolves.toMatchObject({
        version: 2,
        skins: [{ presentations: [{ geometry: {
          visualBounds: { x: 0, y: 0, width: 1, height: 1 }
        } }] }]
      });
    expect(decodeAlpha).toHaveBeenCalledOnce();
  });

  test('旧包资源校验失败时不会进入 Alpha 解码', async () => {
    const packagePath = join(testDirectory, 'legacy-resource-mismatch.zip');
    const legacy = legacyRuntime('legacy-resource-mismatch');
    await writeZip(packagePath, [
      {
        path: 'draft/draft.json',
        bytes: JSON.stringify({
          version: 1,
          id: 'legacy-resource-mismatch',
          name: '损坏旧角色',
          states: legacy.manifest.states
        })
      },
      {
        path: 'compiled/manifest.json',
        bytes: JSON.stringify({ ...legacy.manifest, name: '损坏旧角色' })
      },
      {
        path: 'source/catalog.json',
        bytes: JSON.stringify({
          version: 1,
          characterId: 'legacy-resource-mismatch',
          sources: []
        })
      },
      { path: 'compiled/atlas.png', bytes: Buffer.from([1, 2, 4]) }
    ]);
    const importedCharacters = join(testDirectory, 'legacy-resource-mismatch-imported');
    const store = new CharacterStore(importedCharacters);
    const decodeAlpha = vi.fn(async () => ({
      width: 1, height: 1, alpha: new Uint8Array([255])
    }));

    await expect(new CharacterPackageService(importedCharacters, {
      store,
      assetService: new CharacterAssetService(importedCharacters),
      geometryMigration: { decodeAlpha }
    }).importCharacter(packagePath)).rejects.toThrow(
      'CHARACTER_PACKAGE_RESOURCE_INVALID'
    );
    expect(decodeAlpha).not.toHaveBeenCalled();
  });

  test('旧包图片结构预检失败时不创建或发布角色', async () => {
    const packagePath = join(testDirectory, 'legacy-structure-invalid.zip');
    const legacy = legacyRuntime('legacy-structure-invalid');
    await writeZip(packagePath, [
      {
        path: 'draft/draft.json',
        bytes: JSON.stringify({
          version: 1,
          id: 'legacy-structure-invalid',
          name: '结构损坏角色',
          states: legacy.manifest.states
        })
      },
      {
        path: 'compiled/manifest.json',
        bytes: JSON.stringify({ ...legacy.manifest, name: '结构损坏角色' })
      },
      {
        path: 'source/catalog.json',
        bytes: JSON.stringify({
          version: 1,
          characterId: 'legacy-structure-invalid',
          sources: []
        })
      },
      { path: 'compiled/atlas.png', bytes: legacy.assets['atlas.png']! }
    ]);
    const importedCharacters = join(testDirectory, 'legacy-structure-invalid-imported');
    const store = new CharacterStore(importedCharacters);

    await expect(new CharacterPackageService(importedCharacters, {
      store,
      assetService: new CharacterAssetService(importedCharacters),
      geometryMigration: {
        decodeAlpha: async () => {
          throw new Error('CHARACTER_IMAGE_STRUCTURE_INVALID');
        }
      }
    }).importCharacter(packagePath)).rejects.toThrow('CHARACTER_PACKAGE_INVALID');
    await expect(store.list()).resolves.toEqual([]);
  });

  test.each([
    {
      name: '未知 V2 字段',
      slug: 'unknown-v2-field',
      mutate(files: Map<string, Buffer>) {
        const draft = JSON.parse(files.get('draft/draft.json')!.toString('utf8'));
        draft.shell = 'powershell.exe';
        files.set('draft/draft.json', Buffer.from(JSON.stringify(draft)));
      }
    },
    {
      name: 'capabilityRef',
      slug: 'capability-ref',
      mutate(files: Map<string, Buffer>) {
        const manifest = convertCharacterManifestV1ToV2(
          legacyRuntime('demo').manifest
        ).document as unknown as {
          actions: Array<Record<string, unknown>>;
        };
        manifest.actions[0]!.capabilityRef = 'agent:run-shell';
        files.set('compiled/manifest.json', Buffer.from(JSON.stringify(manifest)));
      }
    },
    {
      name: '混合 V1/V2 来源版本',
      slug: 'mixed-source-version',
      mutate(files: Map<string, Buffer>) {
        const legacy = legacyRuntime('demo');
        files.set('compiled/manifest.json', Buffer.from(JSON.stringify(
          convertCharacterManifestV1ToV2(legacy.manifest).document
        )));
        files.set('draft/draft.json', Buffer.from(JSON.stringify({
          version: 1,
          id: 'demo',
          name: '演示角色',
          states: legacy.manifest.states
        })));
      }
    }
  ])('拒绝$name且不创建角色', async ({ slug, mutate }) => {
    await createPublishedCharacter();
    const exported = await exportDemoPackage(`${slug}.source.zip`);
    const files = await readZip(exported);
    mutate(files);
    const malicious = join(testDirectory, `${slug}.zip`);
    await writeZip(malicious, [...files].map(([path, bytes]) => ({ path, bytes })));
    const importedCharacters = join(testDirectory, `${slug}-characters`);
    const store = new CharacterStore(importedCharacters);

    await expect(new CharacterPackageService(importedCharacters, { store })
      .importCharacter(malicious)).rejects.toThrow('CHARACTER_PACKAGE_INVALID');
    await expect(store.list()).resolves.toEqual([]);
  });

  test('恢复包只包含原始草稿、已验证目录和源素材', async () => {
    const store = new CharacterStore(charactersDirectory);
    await store.create({ id: 'demo', name: '待恢复角色' });
    const selectedDirectory = join(testDirectory, 'recovery-selected');
    await mkdir(selectedDirectory);
    const sourcePath = join(selectedDirectory, 'idle.png');
    await writeFile(sourcePath, PNG_BYTES);
    const [source] = await new CharacterAssetService(charactersDirectory)
      .importSources('demo', [sourcePath]);
    const originalDraft = { version: 3, id: 'demo', name: '待恢复角色' };
    await writeFile(
      join(charactersDirectory, 'demo', 'draft', 'draft.json'),
      JSON.stringify(originalDraft)
    );
    await writeFile(
      join(charactersDirectory, 'demo', '.package-import-owner.json'),
      JSON.stringify({ importTransactionId: '不得导出' })
    );
    await writeFile(
      join(charactersDirectory, 'demo', 'private.txt'),
      'C:\\private\\characters\\demo'
    );
    await expect(store.list()).resolves.toMatchObject([{
      id: 'demo',
      migrationErrorCode: 'CHARACTER_MIGRATION_FAILED',
      migrationRecoveryAvailable: true
    }]);
    const destination = join(testDirectory, 'recovery.zip');

    await new CharacterPackageService(charactersDirectory, { store })
      .exportCharacterRecovery('demo', destination);

    const files = await readZip(destination);
    expect([...files.keys()].sort()).toEqual([
      'recovery/original-draft.json',
      'source/catalog.json',
      `source/${source!.assetId}.png`
    ].sort());
    expect(JSON.parse(
      files.get('recovery/original-draft.json')!.toString('utf8')
    )).toEqual(originalDraft);
    const serialized = Buffer.concat([...files.values()]).toString('utf8');
    expect(serialized).not.toContain('importTransactionId');
    expect(serialized).not.toContain('C:\\private');
  });

  test('恢复导出使用 checkpoint 前的不可变草稿与素材快照', async () => {
    const store = new CharacterStore(charactersDirectory);
    await store.create({ id: 'demo', name: '待恢复角色' });
    const selectedDirectory = join(testDirectory, 'snapshot-selected');
    await mkdir(selectedDirectory);
    const selectedSource = join(selectedDirectory, 'idle.png');
    await writeFile(selectedSource, PNG_BYTES);
    const [source] = await new CharacterAssetService(charactersDirectory)
      .importSources('demo', [selectedSource]);
    const draftPath = join(charactersDirectory, 'demo', 'draft', 'draft.json');
    const sourcePath = join(
      charactersDirectory,
      'demo',
      'source',
      `${source!.assetId}.png`
    );
    const originalDraft = Buffer.from(JSON.stringify({
      version: 3,
      id: 'demo',
      name: '待恢复角色'
    }));
    await writeFile(draftPath, originalDraft);
    const destination = join(testDirectory, 'snapshot-recovery.zip');
    let mutated = false;
    const service = new CharacterPackageService(charactersDirectory, {
      store,
      async onCheckpoint(checkpoint, _root, targetPath) {
        if (
          checkpoint !== 'export:resource-validated'
          || targetPath !== sourcePath
          || mutated
        ) {
          return;
        }
        mutated = true;
        await writeFile(draftPath, Buffer.alloc(originalDraft.byteLength, 0x20));
        await writeFile(sourcePath, Buffer.alloc(PNG_BYTES.byteLength, 0x42));
      }
    });

    await service.exportCharacterRecovery('demo', destination);

    expect(mutated).toBe(true);
    const files = await readZip(destination);
    expect(files.get('recovery/original-draft.json')).toEqual(originalDraft);
    expect(files.get(`source/${source!.assetId}.png`)).toEqual(PNG_BYTES);
    const catalog = JSON.parse(
      files.get('source/catalog.json')!.toString('utf8')
    ) as { sources: Array<{ sha256: string }> };
    expect(catalog.sources[0]!.sha256).toBe(checksum(PNG_BYTES));
    expect(checksum(files.get(`source/${source!.assetId}.png`)!))
      .toBe(catalog.sources[0]!.sha256);
  });

  test.each(['draft', 'source'] as const)(
    '恢复快照后同路径重建 %s 目录时拒绝提交',
    async directoryName => {
      const store = new CharacterStore(charactersDirectory);
      await store.create({ id: 'demo', name: '待恢复角色' });
      const selectedDirectory = join(testDirectory, 'identity-selected');
      await mkdir(selectedDirectory);
      const selectedSource = join(selectedDirectory, 'idle.png');
      await writeFile(selectedSource, PNG_BYTES);
      const [source] = await new CharacterAssetService(charactersDirectory)
        .importSources('demo', [selectedSource]);
      const draftPath = join(charactersDirectory, 'demo', 'draft', 'draft.json');
      await writeFile(draftPath, JSON.stringify({
        version: 3,
        id: 'demo',
        name: '待恢复角色'
      }));
      const sourcePath = join(
        charactersDirectory,
        'demo',
        'source',
        `${source!.assetId}.png`
      );
      const destination = join(testDirectory, `identity-${directoryName}.zip`);
      let replaced = false;
      const service = new CharacterPackageService(charactersDirectory, {
        store,
        async onCheckpoint(checkpoint, _root, targetPath) {
          if (
            checkpoint !== 'export:resource-validated'
            || targetPath !== sourcePath
            || replaced
          ) {
            return;
          }
          replaced = true;
          const directory = join(charactersDirectory, 'demo', directoryName);
          const moved = `${directory}.original`;
          await rename(directory, moved);
          await mkdir(directory);
          for (const entry of await readdir(moved, { withFileTypes: true })) {
            if (!entry.isFile()) continue;
            await writeFile(
              join(directory, entry.name),
              await readFile(join(moved, entry.name))
            );
          }
        }
      });

      await expect(service.exportCharacterRecovery('demo', destination))
        .rejects.toThrow('CHARACTER_PACKAGE_EXPORT_SOURCE_CHANGED');
      expect(replaced).toBe(true);
      await expect(access(destination)).rejects.toThrow();
    }
  );

  test('提交前临时 ZIP 路径被替换时拒绝且不建立目标', async () => {
    await createPublishedCharacter();
    const destination = join(testDirectory, 'replaced-temporary.zip');
    let replaced = false;
    const service = new CharacterPackageService(charactersDirectory, {
      async onCheckpoint(checkpoint, stagingDirectory) {
        if (checkpoint !== 'export:before-commit' || replaced) return;
        replaced = true;
        const temporaryPath = join(stagingDirectory, 'archive.tmp');
        await rename(temporaryPath, `${temporaryPath}.original`);
        await writeFile(temporaryPath, 'ATTACKER_ARCHIVE');
      }
    });

    await expect(service.exportCharacter('demo', destination))
      .rejects.toThrow('CHARACTER_PACKAGE_EXPORT_SOURCE_CHANGED');
    expect(replaced).toBe(true);
    await expect(access(destination)).rejects.toThrow();
  });

  test('临时 ZIP 复核后、目标创建前被替换时拒绝且不删除陌生文件', async () => {
    await createPublishedCharacter();
    const destination = join(testDirectory, 'replaced-before-link.zip');
    let replacedTemporaryPath: string | undefined;
    const service = new CharacterPackageService(charactersDirectory, {
      async onCheckpoint(checkpoint, stagingDirectory) {
        if (checkpoint !== 'export:before-link' || replacedTemporaryPath) return;
        replacedTemporaryPath = join(stagingDirectory, 'archive.tmp');
        await rename(
          replacedTemporaryPath,
          `${replacedTemporaryPath}.original`
        );
        await writeFile(replacedTemporaryPath, 'ATTACKER_ARCHIVE');
      }
    });

    await expect(service.exportCharacter('demo', destination))
      .rejects.toThrow('CHARACTER_PACKAGE_EXPORT_SOURCE_CHANGED');
    expect(replacedTemporaryPath).toBeTypeOf('string');
    await expect(access(destination)).rejects.toThrow();
    await expect(readFile(replacedTemporaryPath!))
      .resolves.toEqual(Buffer.from('ATTACKER_ARCHIVE'));
  });

  test('归档写完、可信基准捕获前替换临时路径时拒绝提交', async () => {
    await createPublishedCharacter();
    const destination = join(testDirectory, 'replaced-before-baseline.zip');
    const attacker = Buffer.from('ATTACKER_ARCHIVE');
    let replacedTemporaryPath: string | undefined;
    const service = new CharacterPackageService(charactersDirectory, {
      async onCheckpoint(checkpoint, stagingDirectory) {
        if (checkpoint !== 'export:after-temp-write') return;
        replacedTemporaryPath = join(stagingDirectory, 'archive.tmp');
        await rename(
          replacedTemporaryPath,
          `${replacedTemporaryPath}.original`
        );
        await writeFile(replacedTemporaryPath, attacker);
      }
    });

    await expect(service.exportCharacter('demo', destination))
      .rejects.toThrow('CHARACTER_PACKAGE_EXPORT_SOURCE_CHANGED');
    await expect(access(destination)).rejects.toThrow();
    await expect(readFile(replacedTemporaryPath!)).resolves.toEqual(attacker);
  });

  test('目标写入后被并发替换时拒绝且不删除并发方文件', async () => {
    await createPublishedCharacter();
    const destination = join(testDirectory, 'replaced-after-write.zip');
    const competitor = Buffer.from('COMPETITOR');
    let replaced = false;
    const service = new CharacterPackageService(charactersDirectory, {
      async onCheckpoint(checkpoint) {
        if (checkpoint !== 'export:after-destination-write' || replaced) return;
        replaced = true;
        await rename(destination, `${destination}.original`);
        await writeFile(destination, competitor, { flag: 'wx' });
      }
    });

    await expect(service.exportCharacter('demo', destination))
      .rejects.toThrow('CHARACTER_PACKAGE_EXPORT_SOURCE_CHANGED');
    expect(replaced).toBe(true);
    await expect(readFile(destination)).resolves.toEqual(competitor);
  });

  test('清理校验后路径被替换时保留竞争方并失效化本方 inode', async () => {
    await createPublishedCharacter();
    const destination = join(testDirectory, 'cleanup-race.zip');
    const movedDestination = `${destination}.original`;
    const competitor = Buffer.from('COMPETITOR');
    let raced = false;
    const service = new CharacterPackageService(charactersDirectory, {
      async onCheckpoint(checkpoint, _root, targetPath) {
        if (checkpoint === 'export:after-destination-write') {
          throw new Error('FORCE_EXPORT_FAILURE');
        }
        if (
          checkpoint !== 'export:cleanup-verified'
          || targetPath !== destination
          || raced
        ) {
          return;
        }
        raced = true;
        await rename(destination, movedDestination);
        await writeFile(destination, competitor, { flag: 'wx' });
      }
    });

    await expect(service.exportCharacter('demo', destination))
      .rejects.toThrow('FORCE_EXPORT_FAILURE');
    expect(raced).toBe(true);
    await expect(readFile(destination)).resolves.toEqual(competitor);
    await expect(readFile(movedDestination))
      .resolves.toHaveLength(0);
  });

  test('导出只包含指定角色草稿、源素材和运行时必需文件', async () => {
    const { sourceAssetId } = await createPublishedCharacter();
    await Promise.all([
      writeFile(join(testDirectory, 'settings.json'), '{"secret":"SETTINGS_PRIVATE"}'),
      writeFile(join(testDirectory, 'keys.json'), '{"key":"KEY_PRIVATE"}'),
      mkdir(join(testDirectory, 'authorizations')),
      mkdir(join(testDirectory, 'conversations'))
    ]);
    const destination = await exportDemoPackage();

    const files = await readZip(destination);
    expect([...files.keys()].sort()).toEqual([
      'compiled/atlas.png',
      'compiled/manifest.json',
      'draft/draft.json',
      'source/catalog.json',
      `source/${sourceAssetId}.png`
    ].sort());
    const serialized = Buffer.concat([...files.values()]).toString('utf8');
    expect(serialized).not.toContain('SETTINGS_PRIVATE');
    expect(serialized).not.toContain('KEY_PRIVATE');
  });

  test('导出预估总量超过统一角色包限额时拒绝', async () => {
    await createPublishedCharacter();
    const destination = join(testDirectory, 'too-large.zip');
    const service = new CharacterPackageService(charactersDirectory, {
      packageLimits: {
        maxTotalUncompressedBytes: 64
      }
    });

    await expect(service.exportCharacter('demo', destination))
      .rejects.toThrow('CHARACTER_PACKAGE_TOTAL_BYTES_EXCEEDED');
    await expect(access(destination)).rejects.toThrow();
  });

  test('导出磁盘资源通过 yazl 流式写入', async () => {
    const { sourceAssetId } = await createPublishedCharacter();
    const destination = join(testDirectory, 'streamed.zip');
    const streamedPaths: string[] = [];
    const service = new CharacterPackageService(charactersDirectory, {
      archiveFactory() {
        const archive = new ZipFile();
        const addReadStream = archive.addReadStream.bind(archive);
        archive.addReadStream = (stream, metadataPath, options) => {
          streamedPaths.push(metadataPath);
          addReadStream(stream, metadataPath, options);
        };
        return archive;
      }
    });

    await service.exportCharacter('demo', destination);

    expect(streamedPaths.sort()).toEqual([
      'compiled/atlas.png',
      `source/${sourceAssetId}.png`
    ]);
  });

  test('普通导出拒绝 checkpoint 后同 inode 等长改写的实际流字节', async () => {
    await createPublishedCharacter();
    const destination = join(testDirectory, 'mutated-stream.zip');
    const mutatedBytes = Buffer.from([9, 8, 7]);
    let mutated = false;
    const service = new CharacterPackageService(charactersDirectory, {
      async onCheckpoint(checkpoint, _root, targetPath) {
        if (
          checkpoint !== 'export:resource-validated'
          || !targetPath?.endsWith('atlas.png')
          || mutated
        ) {
          return;
        }
        mutated = true;
        await writeFile(targetPath, mutatedBytes);
      }
    });

    await expect(service.exportCharacter('demo', destination))
      .rejects.toThrow('CHARACTER_PACKAGE_EXPORT_SOURCE_CHANGED');
    expect(mutated).toBe(true);
    await expect(access(destination)).rejects.toThrow();
  });

  test.each([
    'same-size-file',
    'symlink'
  ] as const)('资源校验后路径替换为%s时不得泄露替换内容', async replacement => {
    await createPublishedCharacter();
    const destination = join(testDirectory, `replaced-${replacement}.zip`);
    const replacementBytes = Buffer.from([9, 8, 7]);
    const external = join(testDirectory, `external-${replacement}.png`);
    await writeFile(external, replacementBytes);
    let replaced = false;
    const dependencies = {
      async onCheckpoint(...args: unknown[]) {
        const [checkpoint, _directory, targetPath] = args;
        if (
          checkpoint !== 'export:resource-validated'
          || typeof targetPath !== 'string'
          || !targetPath.endsWith('atlas.png')
          || replaced
        ) {
          return;
        }
        replaced = true;
        await rename(targetPath, `${targetPath}.verified`);
        if (replacement === 'symlink') {
          await symlink(external, targetPath, 'file');
        } else {
          await writeFile(targetPath, replacementBytes, { flag: 'wx' });
        }
      }
    } as unknown as CharacterPackageServiceDependencies;

    let exportError: unknown;
    try {
      await new CharacterPackageService(charactersDirectory, dependencies)
        .exportCharacter('demo', destination);
    } catch (error) {
      exportError = error;
    }

    expect(replaced).toBe(true);
    if (exportError !== undefined) {
      expect(exportError).toMatchObject({
        message: 'CHARACTER_PACKAGE_EXPORT_SOURCE_CHANGED'
      });
      await expect(access(destination)).rejects.toThrow();
    } else {
      const files = await readZip(destination);
      expect(files.get('compiled/atlas.png')).toEqual(Buffer.from([1, 2, 3]));
      expect(files.get('compiled/atlas.png')).not.toEqual(replacementBytes);
    }
  });

  test('导出提交时并发出现目标文件不得覆盖', async () => {
    await createPublishedCharacter();
    const destination = join(testDirectory, 'concurrent.zip');
    const competitor = Buffer.from('COMPETITOR');
    const service = new CharacterPackageService(charactersDirectory, {
      async onCheckpoint(checkpoint) {
        if (checkpoint === 'export:before-commit') {
          await writeFile(destination, competitor, { flag: 'wx' });
        }
      }
    });

    await expect(service.exportCharacter('demo', destination))
      .rejects.toThrow('CHARACTER_PACKAGE_DESTINATION_EXISTS');
    await expect(readFile(destination)).resolves.toEqual(competitor);
  });

  test('归档输出流错误时导出失败且不留下目标文件', async () => {
    await createPublishedCharacter();
    const destination = join(testDirectory, 'stream-error.zip');
    const service = new CharacterPackageService(charactersDirectory, {
      archiveFactory() {
        const archive = new ZipFile();
        archive.end = () => {
          (archive.outputStream as unknown as {
            destroy(error: Error): void;
          }).destroy(new Error('ARCHIVE_STREAM_FAILED'));
        };
        return archive;
      }
    });

    await expect(service.exportCharacter('demo', destination))
      .rejects.toThrow('ARCHIVE_STREAM_FAILED');
    await expect(access(destination)).rejects.toThrow();
    expect((await readdir(testDirectory)).some(name => (
      name.startsWith('.character-export-')
    ))).toBe(false);
  });

  test('导入成功保留本方 staging 且不递归删除竞争目录', async () => {
    await createPublishedCharacter();
    const packagePath = await exportDemoPackage();
    const importedCharacters = join(testDirectory, 'imported-characters');
    const temporaryDirectory = join(testDirectory, 'isolated');
    await mkdir(temporaryDirectory);
    let observedIsolation = false;
    let observedStaging = '';
    const competitorFile = join(
      temporaryDirectory,
      'competitor-success',
      'competitor.txt'
    );
    const dependencies: CharacterPackageServiceDependencies = {
      temporaryDirectory,
      async onCheckpoint(checkpoint, stagingDirectory) {
        if (checkpoint !== 'import:validated') return;
        expect(stagingDirectory.startsWith(temporaryDirectory)).toBe(true);
        expect(await readdir(stagingDirectory)).toEqual(['entries']);
        const flatEntries = await readdir(
          join(stagingDirectory, 'entries'),
          { withFileTypes: true }
        );
        expect(flatEntries.length).toBeGreaterThan(0);
        expect(flatEntries.every(entry => (
          entry.isFile()
          && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.entry$/u
            .test(entry.name)
        ))).toBe(true);
        await expect(access(importedCharacters)).rejects.toThrow();
        await mkdir(dirname(competitorFile));
        await writeFile(competitorFile, 'COMPETITOR');
        observedStaging = stagingDirectory;
        observedIsolation = true;
      }
    };

    const importedId = await new CharacterPackageService(
      importedCharacters,
      dependencies
    ).importCharacter(packagePath);

    expect(observedIsolation).toBe(true);
    expect(importedId).toBe('demo');
    const importedStore = new CharacterStore(importedCharacters);
    await expect(importedStore.getRuntimeManifest(importedId))
      .resolves.toMatchObject({ id: importedId, name: '演示角色' });
    await expect(importedStore.getPublishedManifest(importedId))
      .resolves.toMatchObject({
        skins: [{ presentations: [{ commitFrameId: 'carry-commit' }] }]
      });
    await expect(access(observedStaging)).resolves.toBeUndefined();
    await expect(readFile(competitorFile, 'utf8')).resolves.toBe('COMPETITOR');
  });

  test('导入校验后 staging 被替换时不删除陌生替代目录', async () => {
    await createPublishedCharacter();
    const packagePath = await exportDemoPackage();
    const importedCharacters = join(testDirectory, 'imported-staging-replaced');
    const temporaryDirectory = join(testDirectory, 'import-staging-replaced');
    await mkdir(temporaryDirectory);
    let replacementFile = '';
    const service = new CharacterPackageService(importedCharacters, {
      temporaryDirectory,
      async onCheckpoint(checkpoint, stagingDirectory) {
        if (checkpoint !== 'import:validated') return;
        await rename(stagingDirectory, `${stagingDirectory}-original`);
        await mkdir(stagingDirectory);
        replacementFile = join(stagingDirectory, 'competitor.txt');
        await writeFile(replacementFile, 'COMPETITOR');
      }
    });

    await expect(service.importCharacter(packagePath)).rejects.toThrow();

    await expect(readFile(replacementFile, 'utf8')).resolves.toBe('COMPETITOR');
  });

  test('导入失败时保留被移动的本方 staging 与竞争目录', async () => {
    await createPublishedCharacter();
    const packagePath = await exportDemoPackage();
    const importedCharacters = join(testDirectory, 'imported-staging-moved');
    const temporaryDirectory = join(testDirectory, 'import-staging-moved');
    await mkdir(temporaryDirectory);
    let movedStaging = '';
    let competitorFile = '';
    const service = new CharacterPackageService(importedCharacters, {
      temporaryDirectory,
      async onCheckpoint(checkpoint, stagingDirectory) {
        if (checkpoint !== 'import:validated') return;
        movedStaging = `${stagingDirectory}-original`;
        await rename(stagingDirectory, movedStaging);
        await mkdir(stagingDirectory);
        competitorFile = join(stagingDirectory, 'competitor.txt');
        await writeFile(competitorFile, 'COMPETITOR');
      }
    });

    await expect(service.importCharacter(packagePath)).rejects.toThrow();

    await expect(access(movedStaging)).resolves.toBeUndefined();
    await expect(readFile(competitorFile, 'utf8')).resolves.toBe('COMPETITOR');
  });

  test('导入失败不扫描或删除无关命名目录', async () => {
    await createPublishedCharacter();
    const packagePath = await exportDemoPackage();
    const importedCharacters = join(testDirectory, 'imported-prefix-scope');
    const temporaryDirectory = join(testDirectory, 'import-prefix-scope');
    await mkdir(temporaryDirectory);
    const unrelatedDirectory = join(temporaryDirectory, 'unrelated-directory');
    const service = new CharacterPackageService(importedCharacters, {
      temporaryDirectory,
      async onCheckpoint(checkpoint, stagingDirectory) {
        if (checkpoint !== 'import:validated') return;
        await rename(stagingDirectory, unrelatedDirectory);
        await mkdir(stagingDirectory);
        await writeFile(join(stagingDirectory, 'competitor.txt'), 'COMPETITOR');
      }
    });

    await expect(service.importCharacter(packagePath)).rejects.toThrow();

    await expect(access(unrelatedDirectory)).resolves.toBeUndefined();
  });

  test.each([
    'junction',
    'directory'
  ] as const)('解压文件前父目录被替换为%s时拒绝且不写入替代目录', async replacement => {
    await createPublishedCharacter();
    const packagePath = await exportDemoPackage();
    const importedCharacters = join(testDirectory, `imported-${replacement}`);
    const external = join(testDirectory, `external-${replacement}`);
    await mkdir(external);
    let replaced = false;
    const dependencies = {
      async onCheckpoint(...args: unknown[]) {
        const [checkpoint, _stagingDirectory, targetPath] = args;
        if (
          checkpoint !== 'extract:after-file-open'
          || typeof targetPath !== 'string'
          || replaced
        ) {
          return;
        }
        replaced = true;
        const parent = dirname(targetPath);
        await rename(parent, `${parent}-original`);
        if (replacement === 'junction') {
          await symlink(external, parent, 'junction');
        } else {
          await mkdir(parent);
        }
      }
    } as unknown as CharacterPackageServiceDependencies;

    await expect(new CharacterPackageService(
      importedCharacters,
      dependencies
    ).importCharacter(packagePath)).rejects.toThrow(
      'CHARACTER_PACKAGE_EXTRACTION_PATH_UNSAFE'
    );

    expect(replaced).toBe(true);
    await expect(readdir(external)).resolves.toEqual([]);
  });

  test('同 ID 导入生成新安全 ID且不覆盖已有角色', async () => {
    const { store } = await createPublishedCharacter();
    const originalDraft = await store.getDraft('demo');
    const packagePath = join(testDirectory, 'demo.zip');
    const service = new CharacterPackageService(charactersDirectory);
    await service.exportCharacter('demo', packagePath);

    const importedId = await service.importCharacter(packagePath);

    expect(importedId).not.toBe('demo');
    expect(importedId).toMatch(/^[a-z0-9][a-z0-9_-]{0,119}$/u);
    await expect(store.getDraft('demo')).resolves.toEqual(originalDraft);
    await expect(store.getDraft(importedId)).resolves.toMatchObject({
      id: importedId,
      name: '演示角色'
    });
    await expect(store.getRuntimeManifest(importedId)).resolves.toMatchObject({
      id: importedId,
      name: '演示角色'
    });
    await expect(access(join(
      charactersDirectory,
      importedId,
      '.package-import-owner.json'
    ))).rejects.toThrow();
    expect((await readdir(charactersDirectory))
      .some(name => name.startsWith('.package-import-rollback-'))).toBe(false);
  });

  test('创建 ID 发生一次并发冲突时换用新 ID 且保留竞争实例', async () => {
    await createPublishedCharacter();
    const packagePath = await exportDemoPackage();
    const importedCharacters = join(testDirectory, 'racing-characters');
    const competitor = new CharacterStore(importedCharacters);
    let raced = false;
    class RacingStore extends CharacterStore {
      override async create(
        ...args: Parameters<CharacterStore['create']>
      ): Promise<void> {
        const [input] = args;
        if (!raced) {
          raced = true;
          await competitor.create(input);
          throw new Error('CHARACTER_ALREADY_EXISTS');
        }
        await super.create(...args);
      }
    }
    const racingStore = new RacingStore(importedCharacters);

    const importedId = await new CharacterPackageService(importedCharacters, {
      store: racingStore,
      assetService: new CharacterAssetService(importedCharacters),
      createId: () => 'retry-safe-id'
    }).importCharacter(packagePath);

    expect(importedId).toBe('demo-import-retrysafeid');
    await expect(competitor.getDraft('demo')).resolves.toMatchObject({
      id: 'demo',
      name: '演示角色'
    });
  });

  test('创建 ID 持续并发冲突时有界终止', async () => {
    await createPublishedCharacter();
    const packagePath = await exportDemoPackage();
    const importedCharacters = join(testDirectory, 'always-racing-characters');
    let attempts = 0;
    class AlwaysRacingStore extends CharacterStore {
      override async create(): Promise<void> {
        attempts += 1;
        throw new Error('CHARACTER_ALREADY_EXISTS');
      }
    }

    await expect(new CharacterPackageService(importedCharacters, {
      store: new AlwaysRacingStore(importedCharacters),
      assetService: new CharacterAssetService(importedCharacters),
      createId: () => `retry-${attempts}`
    }).importCharacter(packagePath))
      .rejects.toThrow('CHARACTER_PACKAGE_ID_GENERATION_FAILED');
    expect(attempts).toBeGreaterThan(1);
    expect(attempts).toBeLessThanOrEqual(32);
  });

  test.each([
    'source',
    'saveDraft',
    'publish'
  ] as const)('%s 阶段失败时删除已创建角色', async stage => {
    await createPublishedCharacter();
    const packagePath = await exportDemoPackage();
    const importedCharacters = join(testDirectory, `failed-${stage}`);
    class FailingStore extends CharacterStore {
      override async saveDraft(
        ...args: Parameters<CharacterStore['saveDraft']>
      ): Promise<void> {
        if (stage === 'saveDraft') throw new Error('SAVE_DRAFT_FAILED');
        await super.saveDraft(...args);
      }

      override async publishCompiled(
        ...args: Parameters<CharacterStore['publishCompiled']>
      ): Promise<void> {
        if (stage === 'publish') throw new Error('PUBLISH_FAILED');
        await super.publishCompiled(...args);
      }
    }
    class FailingAssetService extends CharacterAssetService {
      override async listSources(
        characterId: string
      ): ReturnType<CharacterAssetService['listSources']> {
        if (stage === 'source') throw new Error('SOURCE_FAILED');
        return super.listSources(characterId);
      }
    }
    const store = new FailingStore(importedCharacters);

    await expect(new CharacterPackageService(importedCharacters, {
      store,
      assetService: new FailingAssetService(importedCharacters)
    }).importCharacter(packagePath)).rejects.toThrow();
    await expect(store.list()).resolves.toEqual([]);
  });

  test('导入失败只调用带令牌回滚并保留无法完成的 v3 marker', async () => {
    await createPublishedCharacter();
    const packagePath = await exportDemoPackage();
    const importedCharacters = join(testDirectory, 'rollback-characters');
    class RollbackFailingStore extends CharacterStore {
      override async saveDraft(): Promise<void> {
        throw new Error('SAVE_DRAFT_FAILED');
      }

      override async rollbackImportedCharacter(
        ...args: Parameters<CharacterStore['rollbackImportedCharacter']>
      ): ReturnType<CharacterStore['rollbackImportedCharacter']> {
        await super.rollbackImportedCharacter(...args);
        return { kind: 'ownership-mismatch' };
      }
    }
    const store = new RollbackFailingStore(importedCharacters);
    const deleteSpy = vi.spyOn(store, 'delete');
    const rollbackSpy = vi.spyOn(store, 'rollbackImportedCharacter');
    const marker = join(
      importedCharacters,
      '.package-import-rollback-demo.json'
    );

    await expect(new CharacterPackageService(importedCharacters, {
      store,
      assetService: new CharacterAssetService(importedCharacters)
    }).importCharacter(packagePath))
      .rejects.toThrow('CHARACTER_PACKAGE_ROLLBACK_FAILED');
    expect(rollbackSpy).toHaveBeenCalledTimes(1);
    const [rolledBackId, rolledBackToken] = rollbackSpy.mock.calls[0]!;
    expect(rolledBackId).toBe('demo');
    expect(JSON.parse(await readFile(marker, 'utf8')).importTransactionId)
      .toBe(rolledBackToken);
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  test('已有 blocked marker 的目标导入稳定失败且不换 ID', async () => {
    await createPublishedCharacter();
    const packagePath = await exportDemoPackage();
    const root = join(testDirectory, 'blocked-target-import');
    const blockedTarget = 'demo-import-blockedtarge';
    const marker = rollbackMarker(root, blockedTarget);
    const markerBytes = markerV3(
      blockedTarget,
      IMPORT_TOKEN
    );
    const targetDirectory = join(root, blockedTarget);
    const targetBytes = Buffer.from('existing-target');
    const store = new CharacterStore(root);
    await store.create({ id: 'demo', name: '已有角色' });
    await mkdir(targetDirectory);
    await writeFile(join(targetDirectory, 'sentinel.bin'), targetBytes);
    await writeFile(marker, markerBytes);
    const actualExclusive = atomicMockState.writeExclusive;
    vi.mocked(atomicFileCoordinator.atomicWriteFileExclusive)
      .mockImplementation(async (file, content) => {
        if (file.startsWith(`${marker}.corrupt-`)) {
          throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
        }
        await actualExclusive(file, content);
      });
    const createId = vi.fn()
      .mockReturnValueOnce('blocked-target')
      .mockReturnValueOnce('unexpected-retry');

    await expect(new CharacterPackageService(root, {
      store,
      assetService: new CharacterAssetService(root),
      createId
    }).importCharacter(packagePath))
      .rejects.toThrow('CHARACTER_PACKAGE_ROLLBACK_FAILED');
    expect(createId).toHaveBeenCalledTimes(1);
    expect(await readFile(marker)).toEqual(markerBytes);
    expect(await readFile(join(targetDirectory, 'sentinel.bin'))).toEqual(targetBytes);
    await expect(access(join(root, 'unexpected-retry'))).rejects.toThrow();
  });

  test('v3 marker 完整发布后才创建 Store owner 且完成后复核并清理', async () => {
    await createPublishedCharacter();
    const packagePath = await exportDemoPackage();
    const root = join(testDirectory, 'ordered-import');
    const calls: string[] = [];
    const actualExclusive = atomicMockState.writeExclusive;
    vi.mocked(atomicFileCoordinator.atomicWriteFileExclusive)
      .mockImplementation(async (file, content) => {
        await actualExclusive(file, content);
        if (file.endsWith('.package-import-rollback-demo.json')) {
          calls.push('marker:published');
        }
      });
    class OrderedStore extends CharacterStore {
      override async create(...args: Parameters<CharacterStore['create']>) {
        await super.create(...args);
        calls.push('store:create-owner');
      }

      override async saveDraft(...args: Parameters<CharacterStore['saveDraft']>) {
        await super.saveDraft(...args);
        calls.push('draft:saved');
      }

      override async publishCompiled(...args: Parameters<CharacterStore['publishCompiled']>) {
        await super.publishCompiled(...args);
        calls.push('compiled:published');
      }

      override async completeImportedCharacter(
        ...args: Parameters<CharacterStore['completeImportedCharacter']>
      ) {
        const completed = await super.completeImportedCharacter(...args);
        calls.push('owner:completed');
        return completed;
      }
    }
    class OrderedAssets extends CharacterAssetService {
      override async listSources(
        ...args: Parameters<CharacterAssetService['listSources']>
      ) {
        const sources = await super.listSources(...args);
        calls.push('source:installed');
        return sources;
      }
    }
    const originalRm = fsMockState.rm;
    vi.mocked(fsPromises.rm).mockImplementation(async (...args) => {
      await originalRm(...args);
      if (String(args[0]).startsWith(
        `${rollbackMarker(root, 'demo')}.complete-`
      )) {
        calls.push('marker:completed');
      }
    });

    await new CharacterPackageService(root, {
      store: new OrderedStore(root),
      assetService: new OrderedAssets(root)
    }).importCharacter(packagePath);

    expect(calls).toEqual([
      'marker:published',
      'store:create-owner',
      'source:installed',
      'draft:saved',
      'compiled:published',
      'owner:completed',
      'marker:completed'
    ]);
  });

  test('v3 marker 发布后读取前被替换时不接纳替代 marker', async () => {
    await createPublishedCharacter();
    const packagePath = await exportDemoPackage();
    const root = join(testDirectory, 'published-marker-race');
    const marker = rollbackMarker(root, 'demo');
    const replacement = markerV3(
      'demo',
      '44444444-4444-4444-8444-444444444444'
    );
    await mkdir(root, { recursive: true });
    const actualExclusive = atomicMockState.writeExclusive;
    vi.mocked(atomicFileCoordinator.atomicWriteFileExclusive)
      .mockImplementation(async (file, content) => {
        await actualExclusive(file, content);
        if (file === marker) {
          await rm(marker);
          await writeFile(marker, replacement);
        }
      });
    const store = new CharacterStore(root);
    const createSpy = vi.spyOn(store, 'create');

    await expect(new CharacterPackageService(root, {
      store,
      assetService: new CharacterAssetService(root)
    }).importCharacter(packagePath))
      .rejects.toThrow('CHARACTER_PACKAGE_ROLLBACK_FAILED');
    expect(createSpy).not.toHaveBeenCalled();
    expect(await readFile(marker)).toEqual(replacement);
  });

  test('应用重启初始化会按所有权令牌回滚创建后中断的半安装角色', async () => {
    const { root } = await seedRecoveryMarkers('crashed-import-characters', [
      { fileCharacterId: 'demo' }
    ]);
    const setupStore = new CharacterStore(root);
    await setupStore.create(
      { id: 'demo', name: '半安装角色' },
      { importTransactionId: IMPORT_TOKEN }
    );
    const restartedStore = new CharacterStore(root);

    const report = await new CharacterPackageService(root, {
      store: restartedStore
    }).initialize();

    await expect(restartedStore.list()).resolves.toEqual([]);
    await expect(access(join(root, 'demo'))).rejects.toThrow();
    await expect(access(rollbackMarker(root, 'demo'))).rejects.toThrow();
    expect(report).toEqual({ issues: [] });
  });

  test('半截 marker 不阻断后续合法 v3 且原字节被排他隔离', async () => {
    const { root } = await seedRecoveryMarkers('isolated-recovery', [
      { fileCharacterId: 'broken', bytes: BROKEN_MARKER_BYTES },
      { fileCharacterId: 'BAD!', bytes: BROKEN_MARKER_BYTES },
      { fileCharacterId: 'healthy' }
    ]);
    const store = new CharacterStore(root);
    await store.create(
      { id: 'healthy', name: '待恢复角色' },
      { importTransactionId: IMPORT_TOKEN }
    );
    const rollbackSpy = vi.spyOn(store, 'rollbackImportedCharacter');
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const report = await new CharacterPackageService(root, { store }).initialize();

    expect(report).toEqual({
      issues: [{
        characterId: 'broken',
        errorCode: 'CHARACTER_IMPORT_RECOVERY_BLOCKED'
      }]
    });
    expect(await preservedEvidence(root, 'broken')).toEqual(BROKEN_MARKER_BYTES);
    expect(await preservedEvidence(root, 'BAD!')).toEqual(BROKEN_MARKER_BYTES);
    expect(logSpy).toHaveBeenCalledWith('CHARACTER_IMPORT_RECOVERY_UNATTRIBUTED');
    expect(rollbackSpy).toHaveBeenCalledWith('healthy', IMPORT_TOKEN);
    expect([IMPORT_TOKEN, root].some(value => JSON.stringify(report).includes(value))).toBe(false);
    expect(Object.isFrozen(report) && Object.isFrozen(report.issues)).toBe(true);
    expect(report.issues.every(Object.isFrozen)).toBe(true);
  });

  test('v1 与 v2 只保留证据且从不调用角色删除', async () => {
    const v1Bytes = Buffer.from(JSON.stringify({
      version: 1,
      characterId: 'legacy-v1'
    }));
    const v2Bytes = Buffer.from(JSON.stringify({
      version: 2,
      ownership: { characterId: 'legacy-v2' }
    }));
    const { root } = await seedRecoveryMarkers('legacy-recovery', [
      { fileCharacterId: 'legacy-v1', bytes: v1Bytes },
      { fileCharacterId: 'legacy-v2', bytes: v2Bytes }
    ]);
    const store = new CharacterStore(root);
    const deleteSpy = vi.spyOn(store, 'delete');
    const rollbackSpy = vi.spyOn(store, 'rollbackImportedCharacter');

    await expect(new CharacterPackageService(root, { store }).initialize())
      .resolves.toEqual({
        issues: [
          { characterId: 'legacy-v1', errorCode: 'CHARACTER_IMPORT_RECOVERY_BLOCKED' },
          { characterId: 'legacy-v2', errorCode: 'CHARACTER_IMPORT_RECOVERY_BLOCKED' }
        ]
      });
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(rollbackSpy).not.toHaveBeenCalled();
    expect(await preservedEvidence(root, 'legacy-v1')).toEqual(v1Bytes);
    expect(await preservedEvidence(root, 'legacy-v2')).toEqual(v2Bytes);
  });

  test.each([
    ['未知版本', 'unknown', () => Buffer.from(JSON.stringify({ version: 4, characterId: 'unknown' })), true],
    ['正文与文件名不一致', 'filename-id', () => markerV3('body-id', IMPORT_TOKEN), true],
    ['额外字段', 'extra-field', () => Buffer.from(JSON.stringify({
      version: 3,
      characterId: 'extra-field',
      importTransactionId: IMPORT_TOKEN,
      extra: true
    })), true],
    ['非法 UUID', 'invalid-uuid', () => markerV3('invalid-uuid', 'not-a-uuid'), true],
    ['字段类型错误', 'wrong-type', () => Buffer.from(JSON.stringify({
      version: '3',
      characterId: 'wrong-type',
      importTransactionId: IMPORT_TOKEN
    })), true],
    ['正文恰为 4096 字节', 'limit-exact', () => {
      const base = {
        version: 3,
        characterId: 'limit-exact',
        importTransactionId: IMPORT_TOKEN,
        padding: ''
      };
      const empty = JSON.stringify(base);
      return Buffer.from(JSON.stringify({
        ...base,
        padding: 'x'.repeat(4_096 - empty.length)
      }));
    }, true],
    ['正文超过 4096 字节', 'limit-over', () => Buffer.alloc(4_097, 0x78), false]
  ] as const)('%s时 fail closed', async (_name, characterId, createBytes, isolated) => {
    const bytes = createBytes();
    const { root } = await seedRecoveryMarkers(`strict-${characterId}`, [
      { fileCharacterId: characterId, bytes }
    ]);
    const marker = rollbackMarker(root, characterId);

    await expect(new CharacterPackageService(root).initialize()).resolves.toEqual({
      issues: [{
        characterId,
        errorCode: 'CHARACTER_IMPORT_RECOVERY_BLOCKED'
      }]
    });
    if (isolated) {
      expect(await preservedEvidence(root, characterId)).toEqual(bytes);
      await expect(access(marker)).rejects.toThrow();
    } else {
      expect(await readFile(marker)).toEqual(bytes);
    }
  });

  test('角色根目录不存在时记录固定扫描失败码', async () => {
    const root = join(testDirectory, 'missing-character-root');
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(new CharacterPackageService(root).initialize())
      .resolves.toEqual({ issues: [] });
    expect(logSpy).toHaveBeenCalledWith('CHARACTER_IMPORT_RECOVERY_SCAN_FAILED');
  });

  test('rolled-back 与 absent 完成 marker，ownership-mismatch 与 active-character 保留证据并 blocked', async () => {
    const kinds = new Map<string, 'rolled-back' | 'absent' | 'ownership-mismatch' | 'active-character'>([
      ['a-rolled', 'rolled-back'],
      ['b-absent', 'absent'],
      ['c-mismatch', 'ownership-mismatch'],
      ['d-active', 'active-character']
    ]);
    const { root, bytesByCharacterId } = await seedRecoveryMarkers(
      'rollback-kinds',
      Array.from(kinds.keys(), fileCharacterId => ({ fileCharacterId }))
    );
    const rollbackTokens: string[] = [];
    class ResultStore extends CharacterStore {
      override async rollbackImportedCharacter(
        characterId: string,
        importTransactionId: string
      ) {
        rollbackTokens.push(importTransactionId);
        return { kind: kinds.get(characterId)! };
      }
    }

    await expect(new CharacterPackageService(root, {
      store: new ResultStore(root)
    }).initialize()).resolves.toEqual({
      issues: [
        { characterId: 'c-mismatch', errorCode: 'CHARACTER_IMPORT_RECOVERY_BLOCKED' },
        { characterId: 'd-active', errorCode: 'CHARACTER_IMPORT_RECOVERY_BLOCKED' }
      ]
    });
    await expect(access(rollbackMarker(root, 'a-rolled'))).rejects.toThrow();
    await expect(access(rollbackMarker(root, 'b-absent'))).rejects.toThrow();
    expect(await preservedEvidence(root, 'c-mismatch'))
      .toEqual(bytesByCharacterId.get('c-mismatch'));
    expect(await preservedEvidence(root, 'd-active'))
      .toEqual(bytesByCharacterId.get('d-active'));
    expect(rollbackTokens).toEqual(Array(4).fill(IMPORT_TOKEN));
  });

  test('marker 读取后被替换时不删除替代文件且后续项继续', async () => {
    const replaced = Buffer.from('replacement');
    const { root } = await seedRecoveryMarkers('replacement-race', [
      { fileCharacterId: 'a-raced' },
      { fileCharacterId: 'b-healthy' }
    ]);
    class RacingStore extends CharacterStore {
      override async rollbackImportedCharacter(characterId: string) {
        if (characterId === 'a-raced') {
          await rm(rollbackMarker(root, characterId));
          await writeFile(rollbackMarker(root, characterId), replaced);
          return { kind: 'ownership-mismatch' } as const;
        }
        return { kind: 'absent' } as const;
      }
    }
    const store = new RacingStore(root);
    const rollbackSpy = vi.spyOn(store, 'rollbackImportedCharacter');

    await expect(new CharacterPackageService(root, { store }).initialize())
      .resolves.toEqual({
        issues: [{
          characterId: 'a-raced',
          errorCode: 'CHARACTER_IMPORT_RECOVERY_BLOCKED'
        }]
      });
    expect(await readFile(rollbackMarker(root, 'a-raced'))).toEqual(replaced);
    expect(rollbackSpy).toHaveBeenCalledWith('b-healthy', IMPORT_TOKEN);
  });

  test('marker 身份错且正式名恢复失败时只留 inert 证据', async () => {
    const replacement = Buffer.from('replacement-after-assert');
    const { root } = await seedRecoveryMarkers('completion-race', [
      { fileCharacterId: 'a-raced' },
      { fileCharacterId: 'b-healthy' }
    ]);
    const racedMarker = rollbackMarker(root, 'a-raced');
    const actualRename = fsMockState.rename;
    let replaced = false;
    vi.mocked(fsPromises.rename).mockImplementation(async (...args) => {
      if (!replaced && String(args[0]) === racedMarker) {
        replaced = true;
        await rm(racedMarker);
        await writeFile(racedMarker, replacement);
      }
      await actualRename(...args);
    });
    const originalLink = fsMockState.link;
    vi.mocked(fsPromises.link).mockImplementation(async (...args) => {
      if (String(args[1]) === racedMarker) {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      }
      await originalLink(...args);
    });
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = new AbsentRollbackStore(root);
    const rollbackSpy = vi.spyOn(store, 'rollbackImportedCharacter');

    await expect(new CharacterPackageService(root, { store }).initialize())
      .resolves.toEqual({ issues: [] });
    await expect(access(racedMarker)).rejects.toThrow();
    const detached = (await readdir(root)).find(name => (
      name.startsWith('.package-import-rollback-a-raced.json.complete-')
    ));
    expect(await readFile(join(root, detached!))).toEqual(replacement);
    expect(fsPromises.link).toHaveBeenCalledWith(join(root, detached!), racedMarker);
    expect(logSpy).toHaveBeenCalledWith('CHARACTER_IMPORT_RECOVERY_DETACHED_EVIDENCE');
    expect(rollbackSpy).toHaveBeenCalledWith('b-healthy', IMPORT_TOKEN);

    rollbackSpy.mockClear();
    logSpy.mockClear();
    await expect(new CharacterPackageService(root, { store }).initialize())
      .resolves.toEqual({ issues: [] });
    expect(await readFile(join(root, detached!))).toEqual(replacement);
    expect(rollbackSpy).not.toHaveBeenCalled();
  });

  test.each([
    ['证据目标冲突', 'EEXIST'],
    ['证据目标权限失败', 'EACCES'],
    ['证据发布 ENOSPC', 'ENOSPC']
  ])('%s时保留原 marker 且继续后续合法项', async (_name, code) => {
    const { root } = await seedRecoveryMarkers(`evidence-${code}`, [
      { fileCharacterId: 'a-broken', bytes: BROKEN_MARKER_BYTES },
      { fileCharacterId: 'b-healthy' }
    ]);
    const actualExclusive = atomicMockState.writeExclusive;
    vi.mocked(atomicFileCoordinator.atomicWriteFileExclusive)
      .mockImplementation(async (file, content) => {
        if (file.includes('a-broken')) {
          throw Object.assign(new Error(code), { code });
        }
        await actualExclusive(file, content);
      });
    const store = new AbsentRollbackStore(root);
    const rollbackSpy = vi.spyOn(store, 'rollbackImportedCharacter');

    await expect(new CharacterPackageService(root, { store }).initialize())
      .resolves.toEqual({
        issues: [{
          characterId: 'a-broken',
          errorCode: 'CHARACTER_IMPORT_RECOVERY_BLOCKED'
        }]
      });
    expect(await readFile(rollbackMarker(root, 'a-broken'))).toEqual(BROKEN_MARKER_BYTES);
    expect(rollbackSpy).toHaveBeenCalledWith('b-healthy', IMPORT_TOKEN);
  });

  test.each(['open', 'read'] as const)(
    'marker %s 失败只 blocked 当前项且继续后续合法项',
    async failure => {
    const { root } = await seedRecoveryMarkers(`${failure}-failure`, [
      { fileCharacterId: 'a-broken' },
      { fileCharacterId: 'b-healthy' }
    ]);
    const actualOpen = fsMockState.open;
    vi.mocked(fsPromises.open).mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('a-broken.json')) {
        if (failure === 'open') {
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        }
        const handle = await actualOpen(...args);
        return new Proxy(handle, {
          get(target, property) {
            if (property === 'read') {
              return async () => {
                throw Object.assign(new Error('EIO'), { code: 'EIO' });
              };
            }
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          }
        });
      }
      return actualOpen(...args);
    });
    const store = new AbsentRollbackStore(root);
    const rollbackSpy = vi.spyOn(store, 'rollbackImportedCharacter');

    await expect(new CharacterPackageService(root, { store }).initialize())
      .resolves.toEqual({
        issues: [{
          characterId: 'a-broken',
          errorCode: 'CHARACTER_IMPORT_RECOVERY_BLOCKED'
        }]
      });
    expect(rollbackSpy).toHaveBeenCalledWith('b-healthy', IMPORT_TOKEN);
  });

  test.each([
    ['单独清理失败恢复正式名并支持重试', false, true],
    ['清理与正式名恢复双故障只留 inert 证据', true, false]
  ])('%s', async (_name, rejectRestore, shouldRetry) => {
    const { root } = await seedRecoveryMarkers('cleanup-failure', [
      { fileCharacterId: 'a-broken', bytes: BROKEN_MARKER_BYTES },
      { fileCharacterId: 'b-healthy' }
    ]);
    const originalRm = fsMockState.rm;
    let rejectCleanup = true;
    vi.mocked(fsPromises.rm).mockImplementation(async (...args) => {
      if (rejectCleanup && String(args[0]).startsWith(
        `${rollbackMarker(root, 'a-broken')}.complete-`
      )) {
        rejectCleanup = false;
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      }
      return originalRm(...args);
    });
    if (rejectRestore) {
      const originalLink = fsMockState.link;
      vi.mocked(fsPromises.link).mockImplementation(async (...args) => {
        if (String(args[1]) === rollbackMarker(root, 'a-broken')) {
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        }
        await originalLink(...args);
      });
    }
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = new AbsentRollbackStore(root);
    const rollbackSpy = vi.spyOn(store, 'rollbackImportedCharacter');
    const expectedIssues = shouldRetry ? [{
      characterId: 'a-broken',
      errorCode: 'CHARACTER_IMPORT_RECOVERY_BLOCKED' as const
    }] : [];

    await expect(new CharacterPackageService(root, { store }).initialize())
      .resolves.toEqual({ issues: expectedIssues });
    if (shouldRetry) {
      expect(await readFile(rollbackMarker(root, 'a-broken'))).toEqual(BROKEN_MARKER_BYTES);
    } else {
      await expect(access(rollbackMarker(root, 'a-broken'))).rejects.toThrow();
    }
    expect(rollbackSpy).toHaveBeenCalledWith('b-healthy', IMPORT_TOKEN);
    expect(logSpy).toHaveBeenCalledWith(shouldRetry
      ? 'CHARACTER_IMPORT_RECOVERY_ITEM_FAILED'
      : 'CHARACTER_IMPORT_RECOVERY_DETACHED_EVIDENCE');

    const detached = (await readdir(root)).find(name => (
      name.includes('.complete-') && name.endsWith('.tmp')
    ));
    rollbackSpy.mockClear();
    logSpy.mockClear();
    await expect(new CharacterPackageService(root, { store }).initialize())
      .resolves.toEqual({ issues: expectedIssues });
    expect(await readFile(join(root, detached!))).toEqual(BROKEN_MARKER_BYTES);
    expect(rollbackSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });

  test('活动角色位于稳定排序第 257 位时仍提升到首位', async () => {
    const { root } = await seedRecoveryMarkers('active-first', [
      ...Array.from({ length: 256 }, (_, index) => ({
        fileCharacterId: `a-inactive-${String(index + 1).padStart(3, '0')}`
      })),
      { fileCharacterId: 'z-active' }
    ]);
    class ActiveStore extends AbsentRollbackStore {
      override async list() {
        return [{
          id: 'z-active',
          name: '活动角色',
          thumbnailAssetId: null,
          active: true,
          completeness: 'complete' as const,
          missingRequirements: [],
          migrationRecoveryAvailable: false,
          activationConfirmationRequired: false
        }];
      }
    }
    const store = new ActiveStore(root);
    const rollbackSpy = vi.spyOn(store, 'rollbackImportedCharacter');

    await new CharacterPackageService(root, { store }).initialize();

    const rolledBackIds = rollbackSpy.mock.calls.map(([characterId]) => characterId);
    expect(rolledBackIds).toHaveLength(256);
    expect(rolledBackIds[0]).toBe('z-active');
    expect(rolledBackIds).not.toContain('a-inactive-256');
  });

  test('无活动角色时稳定排序后截断且第 257 项不读取', async () => {
    const { root, bytesByCharacterId } = await seedRecoveryMarkers('inventory-limit', [
      { fileCharacterId: '0-healthy' },
      ...Array.from({ length: 256 }, (_, index) => ({
        fileCharacterId: `BAD-${String(index + 1).padStart(3, '0')}`,
        bytes: BROKEN_MARKER_BYTES
      }))
    ]);
    const store = new AbsentRollbackStore(root);
    const rollbackSpy = vi.spyOn(store, 'rollbackImportedCharacter');
    const untouchedMarker = rollbackMarker(root, 'BAD-256');
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(new CharacterPackageService(root, {
      store
    }).initialize()).resolves.toEqual({ issues: [] });
    expect(rollbackSpy).toHaveBeenCalledWith('0-healthy', IMPORT_TOKEN);
    expect(fsPromises.open).not.toHaveBeenCalledWith(untouchedMarker, 'r');
    await expect(access(rollbackMarker(root, '0-healthy'))).rejects.toThrow();
    expect(await readFile(untouchedMarker)).toEqual(bytesByCharacterId.get('BAD-256'));
    expect(logSpy.mock.calls.filter(([code]) => code === 'CHARACTER_IMPORT_RECOVERY_LIMIT_REACHED')).toHaveLength(1);
    expect(logSpy.mock.calls.filter(([code]) => code === 'CHARACTER_IMPORT_RECOVERY_UNATTRIBUTED')).toHaveLength(255);
  });

  test('达到 2000ms 软预算后只推迟未开始项', async () => {
    const { root } = await seedRecoveryMarkers('recovery-budget', [
      { fileCharacterId: 'a-first' },
      { fileCharacterId: 'b-deferred' }
    ]);
    const times = [0, 2_000];

    await expect(new CharacterPackageService(root, {
      store: new AbsentRollbackStore(root),
      recoveryNow: () => times.shift() ?? 2_000
    }).initialize()).resolves.toEqual({
      issues: [{
        characterId: 'b-deferred',
        errorCode: 'CHARACTER_IMPORT_RECOVERY_DEFERRED'
      }]
    });
    await expect(access(rollbackMarker(root, 'a-first'))).rejects.toThrow();
    await expect(access(rollbackMarker(root, 'b-deferred'))).resolves.toBeUndefined();
  });

  test('inventory 阶段跨预算后首项仍开始并完成', async () => {
    const { root } = await seedRecoveryMarkers('recovery-budget-item', [
      { fileCharacterId: 'only-item' }
    ]);
    let now = 0;
    class SlowInventoryStore extends AbsentRollbackStore {
      override async list() {
        now = 2_000;
        return [];
      }
    }

    await expect(new CharacterPackageService(root, {
      store: new SlowInventoryStore(root),
      recoveryNow: () => now
    }).initialize()).resolves.toEqual({ issues: [] });
    await expect(access(rollbackMarker(root, 'only-item'))).rejects.toThrow();
  });

  test('同一存储根目录的并发导入严格串行且不会回滚活跃事务', async () => {
    await createPublishedCharacter();
    const packagePath = await exportDemoPackage();
    const importedCharacters = join(testDirectory, 'concurrent-import-characters');
    let releaseFirstCreate = (): void => {};
    const firstCreatePending = new Promise<void>(resolve => {
      releaseFirstCreate = resolve;
    });
    let markFirstCreated = (): void => {};
    const firstCreated = new Promise<void>(resolve => {
      markFirstCreated = resolve;
    });
    let createCalls = 0;
    class BlockingStore extends CharacterStore {
      override async create(
        ...args: Parameters<CharacterStore['create']>
      ): Promise<void> {
        await super.create(...args);
        createCalls += 1;
        if (createCalls === 1) {
          markFirstCreated();
          await firstCreatePending;
        }
      }
    }
    const store = new BlockingStore(importedCharacters);
    const service = new CharacterPackageService(importedCharacters, {
      store,
      assetService: new CharacterAssetService(importedCharacters),
      createId: () => 'parallel-safe-id'
    });

    const firstImport = service.importCharacter(packagePath);
    await firstCreated;
    const secondImport = service.importCharacter(packagePath);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(createCalls).toBe(1);
    releaseFirstCreate();

    await expect(Promise.all([firstImport, secondImport])).resolves.toHaveLength(2);
    await expect(store.list()).resolves.toHaveLength(2);
  });

  test.each([
    {
      name: '脚本条目',
      entries: [{ path: 'scripts/run.js', bytes: 'alert(1)' }],
      error: 'CHARACTER_PACKAGE_FILE_TYPE_REJECTED'
    },
    {
      name: '符号链接',
      entries: [{ path: 'source/link.png', bytes: 'target', mode: 0o120777 }],
      error: 'CHARACTER_PACKAGE_LINK_REJECTED'
    },
    {
      name: '非普通 Unix 条目',
      entries: [{ path: 'source/device.png', bytes: 'device', mode: 0o060644 }],
      error: 'CHARACTER_PACKAGE_LINK_REJECTED'
    },
    {
      name: '大小写归一化重复条目',
      entries: [
        { path: 'draft/Draft.json', bytes: '{}' },
        { path: 'draft/draft.json', bytes: '{}' }
      ],
      error: 'CHARACTER_PACKAGE_DUPLICATE_ENTRY'
    },
    {
      name: '真实高压缩倍率条目',
      entries: [{ path: 'source/bomb.png', bytes: Buffer.alloc(50_000) }],
      error: 'CHARACTER_PACKAGE_EXPANSION_LIMIT'
    }
  ])('拒绝$name且不污染角色存储', async ({ entries, error }) => {
    const { store } = await createPublishedCharacter();
    const packagePath = join(testDirectory, 'malicious.zip');
    await writeZip(packagePath, entries);
    const before = await store.list();

    await expect(new CharacterPackageService(charactersDirectory)
      .importCharacter(packagePath)).rejects.toThrow(error);

    await expect(store.list()).resolves.toEqual(before);
    const roleDirectories = (await readdir(charactersDirectory, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && entry.name !== '.locks')
      .map(entry => entry.name);
    expect(roleDirectories).toEqual(['demo']);
  });

  test('源素材结构无效时回滚新角色且不覆盖原角色', async () => {
    const { store, sourceAssetId } = await createPublishedCharacter();
    const exported = await exportDemoPackage();
    const files = await readZip(exported);
    const invalidImage = Buffer.from('not-an-image');
    const catalog = JSON.parse(files.get('source/catalog.json')!.toString('utf8')) as {
      sources: Array<{ assetId: string; byteLength: number; sha256: string }>;
    };
    catalog.sources[0]!.byteLength = invalidImage.byteLength;
    catalog.sources[0]!.sha256 = checksum(invalidImage);
    const malicious = join(testDirectory, 'invalid-source.zip');
    await writeZip(malicious, [...files].map(([path, bytes]) => ({
      path,
      bytes: path === `source/${sourceAssetId}.png`
        ? invalidImage
        : path === 'source/catalog.json'
          ? JSON.stringify(catalog)
          : bytes
    })));
    const before = await store.list();
    let reachedValidatedCheckpoint = false;

    await expect(new CharacterPackageService(charactersDirectory, {
      async onCheckpoint(checkpoint) {
        if (checkpoint === 'import:validated') {
          reachedValidatedCheckpoint = true;
        }
      }
    })
      .importCharacter(malicious)).rejects.toThrow('CHARACTER_SOURCE_INTEGRITY_FAILED');

    expect(reachedValidatedCheckpoint).toBe(false);
    await expect(store.list()).resolves.toEqual(before);
    const roleDirectories = (await readdir(charactersDirectory, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && entry.name !== '.locks')
      .map(entry => entry.name);
    expect(roleDirectories).toEqual(['demo']);
  });
});
