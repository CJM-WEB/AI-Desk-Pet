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
import { createWriteStream as openWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { finished } from 'node:stream/promises';
import {
  convertCharacterManifestV1ToV2,
  type CharacterManifestV1,
  type CharacterManifestV2
} from '@myself/character-runtime';
import * as yauzl from 'yauzl';
import { ZipFile } from 'yazl';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  classifyPackageEntry,
  CharacterPackageService,
  type CharacterPackageServiceDependencies
} from '../src/main/characters/character-package-service';
import { CharacterAssetService } from '../src/main/characters/character-asset-service';
import { CharacterStore } from '../src/main/characters/character-store';

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==',
  'base64'
);

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
  return {
    manifest: convertCharacterManifestV1ToV2(legacy.manifest).document,
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
    await rm(testDirectory, { recursive: true, force: true });
  });

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

  test('V2 导出直接读取正式草稿与发布清单', async () => {
    await createPublishedCharacter();
    const destination = join(testDirectory, 'v2-export.zip');

    await new CharacterPackageService(charactersDirectory)
      .exportCharacter('demo', destination);

    const files = await readZip(destination);
    expect(JSON.parse(files.get('draft/draft.json')!.toString('utf8')))
      .toMatchObject({ version: 2, id: 'demo' });
    expect(JSON.parse(files.get('compiled/manifest.json')!.toString('utf8')))
      .toMatchObject({
        version: 2,
        id: 'demo',
        identity: { description: '演示角色' }
      });
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

    const importedId = await new CharacterPackageService(importedCharacters, {
      store,
      assetService: new CharacterAssetService(importedCharacters)
    }).importCharacter(packagePath);

    expect(importedId).toBe('legacy');
    await expect(store.getDraft(importedId)).resolves.toMatchObject({ version: 2 });
    await expect(store.getPublishedManifest(importedId))
      .resolves.toMatchObject({ version: 2 });
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
    const exported = join(testDirectory, `${slug}.source.zip`);
    await new CharacterPackageService(charactersDirectory)
      .exportCharacter('demo', exported);
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

  test('导出只包含指定角色草稿、源素材和运行时必需文件', async () => {
    const { sourceAssetId } = await createPublishedCharacter();
    await Promise.all([
      writeFile(join(testDirectory, 'settings.json'), '{"secret":"SETTINGS_PRIVATE"}'),
      writeFile(join(testDirectory, 'keys.json'), '{"key":"KEY_PRIVATE"}'),
      mkdir(join(testDirectory, 'authorizations')),
      mkdir(join(testDirectory, 'conversations'))
    ]);
    const destination = join(testDirectory, 'demo.zip');

    await new CharacterPackageService(charactersDirectory)
      .exportCharacter('demo', destination);

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
  });

  test('导入在隔离临时目录完成校验后才创建角色', async () => {
    await createPublishedCharacter();
    const packagePath = join(testDirectory, 'demo.zip');
    await new CharacterPackageService(charactersDirectory)
      .exportCharacter('demo', packagePath);
    const importedCharacters = join(testDirectory, 'imported-characters');
    const temporaryDirectory = join(testDirectory, 'isolated');
    await mkdir(temporaryDirectory);
    let observedIsolation = false;
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
        observedIsolation = true;
      }
    };

    const importedId = await new CharacterPackageService(
      importedCharacters,
      dependencies
    ).importCharacter(packagePath);

    expect(observedIsolation).toBe(true);
    expect(importedId).toBe('demo');
    await expect(new CharacterStore(importedCharacters).getRuntimeManifest(importedId))
      .resolves.toMatchObject({ id: importedId, name: '演示角色' });
    await expect(readdir(temporaryDirectory)).resolves.toEqual([]);
  });

  test.each([
    'junction',
    'directory'
  ] as const)('解压文件前父目录被替换为%s时拒绝且不写入替代目录', async replacement => {
    await createPublishedCharacter();
    const packagePath = join(testDirectory, 'demo.zip');
    await new CharacterPackageService(charactersDirectory)
      .exportCharacter('demo', packagePath);
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
    const packagePath = join(testDirectory, 'demo.zip');
    await new CharacterPackageService(charactersDirectory)
      .exportCharacter('demo', packagePath);
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
    const packagePath = join(testDirectory, 'demo.zip');
    await new CharacterPackageService(charactersDirectory)
      .exportCharacter('demo', packagePath);
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
    const packagePath = join(testDirectory, 'demo.zip');
    await new CharacterPackageService(charactersDirectory)
      .exportCharacter('demo', packagePath);
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

  test('回滚删除失败时写入 marker 并在下一次导入前恢复', async () => {
    await createPublishedCharacter();
    const packagePath = join(testDirectory, 'demo.zip');
    await new CharacterPackageService(charactersDirectory)
      .exportCharacter('demo', packagePath);
    const importedCharacters = join(testDirectory, 'rollback-characters');
    class RollbackFailingStore extends CharacterStore {
      override async saveDraft(): Promise<void> {
        throw new Error('SAVE_DRAFT_FAILED');
      }

      override async delete(): Promise<void> {
        throw new Error('DELETE_FAILED');
      }
    }
    const marker = join(
      importedCharacters,
      '.package-import-rollback-demo.json'
    );

    await expect(new CharacterPackageService(importedCharacters, {
      store: new RollbackFailingStore(importedCharacters),
      assetService: new CharacterAssetService(importedCharacters)
    }).importCharacter(packagePath))
      .rejects.toThrow('CHARACTER_PACKAGE_ROLLBACK_FAILED');
    await expect(access(marker)).resolves.toBeUndefined();

    const importedId = await new CharacterPackageService(importedCharacters)
      .importCharacter(packagePath);
    expect(importedId).toBe('demo');
    await expect(access(marker)).rejects.toThrow();
  });

  test('应用重启初始化会按所有权令牌回滚创建后中断的半安装角色', async () => {
    const importedCharacters = join(testDirectory, 'crashed-import-characters');
    const transactionId = '33333333-3333-4333-8333-333333333333';
    const store = new CharacterStore(importedCharacters);
    await mkdir(importedCharacters, { recursive: true });
    await writeFile(
      join(importedCharacters, '.package-import-rollback-demo.json'),
      JSON.stringify({
        version: 3,
        characterId: 'demo',
        importTransactionId: transactionId
      }),
      'utf8'
    );
    await store.create(
      { id: 'demo', name: '半安装角色' },
      { importTransactionId: transactionId }
    );

    await new CharacterPackageService(importedCharacters, { store }).initialize();

    await expect(store.list()).resolves.toEqual([]);
    await expect(access(join(importedCharacters, 'demo'))).rejects.toThrow();
    await expect(access(join(
      importedCharacters,
      '.package-import-rollback-demo.json'
    ))).rejects.toThrow();
  });

  test('同一存储根目录的并发导入严格串行且不会回滚活跃事务', async () => {
    await createPublishedCharacter();
    const packagePath = join(testDirectory, 'demo.zip');
    await new CharacterPackageService(charactersDirectory)
      .exportCharacter('demo', packagePath);
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

  test('rollback marker 不得删除复用同一 ID 的新角色', async () => {
    await createPublishedCharacter();
    const packagePath = join(testDirectory, 'demo.zip');
    await new CharacterPackageService(charactersDirectory)
      .exportCharacter('demo', packagePath);
    const importedCharacters = join(testDirectory, 'reused-id-characters');
    class RollbackFailingStore extends CharacterStore {
      override async saveDraft(): Promise<void> {
        throw new Error('SAVE_DRAFT_FAILED');
      }

      override async delete(): Promise<void> {
        throw new Error('DELETE_FAILED');
      }
    }
    const marker = join(
      importedCharacters,
      '.package-import-rollback-demo.json'
    );

    await expect(new CharacterPackageService(importedCharacters, {
      store: new RollbackFailingStore(importedCharacters),
      assetService: new CharacterAssetService(importedCharacters)
    }).importCharacter(packagePath))
      .rejects.toThrow('CHARACTER_PACKAGE_ROLLBACK_FAILED');

    const replacementStore = new CharacterStore(importedCharacters);
    await replacementStore.delete('demo');
    await replacementStore.create({ id: 'demo', name: '替代角色' });
    const replacementDraft = await replacementStore.getDraft('demo');

    const importedId = await new CharacterPackageService(
      importedCharacters,
      { createId: () => 'owned-retry' }
    ).importCharacter(packagePath);

    expect(importedId).toBe('demo-import-ownedretry');
    await expect(replacementStore.getDraft('demo')).resolves
      .toEqual(replacementDraft);
    await expect(access(marker)).rejects.toThrow();
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
    const exported = join(testDirectory, 'demo.zip');
    await new CharacterPackageService(charactersDirectory)
      .exportCharacter('demo', exported);
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
