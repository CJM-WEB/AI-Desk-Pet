import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import type { CharacterManifestV1 } from '@myself/character-runtime';
import { CharacterAssetService } from '../../apps/desktop/src/main/characters/character-asset-service';
import { CharacterPackageService } from '../../apps/desktop/src/main/characters/character-package-service';
import { CharacterStore } from '../../apps/desktop/src/main/characters/character-store';

const SPRITE_NAMES = [
  'idle',
  'listening',
  'thinking',
  'moving',
  'acting',
  'carrying',
  'success',
  'error'
] as const;

export interface CharacterWorkshopFixturePaths {
  characterAssetsDirectory: string;
  safeCharacterPackage: string;
  maliciousCharacterPackage: string;
  characterExportDestination: string;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function writeTraversalArchive(destination: string): Promise<void> {
  const temporary = `${destination}.source`;
  const requireFromDesktop = createRequire(
    resolve('apps/desktop/package.json')
  );
  const { ZipFile } = requireFromDesktop('yazl') as {
    ZipFile: new () => {
      outputStream: Readable;
      addBuffer(bytes: Buffer, path: string): void;
      end(): void;
    };
  };
  const archive = new ZipFile();
  archive.addBuffer(Buffer.from('blocked', 'utf8'), 'aa/escape.txt');
  const output = createWriteStream(temporary, { flags: 'wx' });
  archive.outputStream.pipe(output);
  archive.end();
  await finished(output);

  // yazl 正确拒绝路径穿越，因此测试夹具只在临时目录内等长替换 ZIP 条目名。
  const source = await readFile(temporary);
  const safeName = Buffer.from('aa/escape.txt', 'utf8');
  const unsafeName = Buffer.from('../escape.txt', 'utf8');
  let replacements = 0;
  for (let offset = 0; offset <= source.length - safeName.length; offset += 1) {
    if (!source.subarray(offset, offset + safeName.length).equals(safeName)) continue;
    unsafeName.copy(source, offset);
    replacements += 1;
  }
  if (replacements !== 2) throw new Error('E2E_TRAVERSAL_ARCHIVE_BUILD_FAILED');
  await writeFile(destination, source, { flag: 'wx' });
  await rm(temporary, { force: true });
}

/**
 * 只把仓库内固定素材复制到本次 Electron fixture 的临时根，并生成两类角色包。
 */
export async function materializeCharacterWorkshopFixtures(
  workspaceRoot: string,
  baseDirectory: string,
  characterAssetsDirectory: string,
  packagesDirectory: string,
  exportsDirectory: string
): Promise<CharacterWorkshopFixturePaths> {
  const sourceDirectory = resolve(
    workspaceRoot,
    'apps/desktop/resources/characters/default'
  );
  await Promise.all(SPRITE_NAMES.map(name => (
    copyFile(
      join(sourceDirectory, `${name}.png`),
      join(characterAssetsDirectory, `${name}.png`)
    )
  )));

  const stagingCharacters = join(baseDirectory, '.fixture-characters');
  const store = new CharacterStore(stagingCharacters);
  const assets = new CharacterAssetService(stagingCharacters);
  const characterId = 'e2e-safe-character';
  await store.create({ id: characterId, name: 'E2E 安全角色' });
  const [source] = await assets.importSources(characterId, [
    join(characterAssetsDirectory, 'idle.png')
  ]);
  if (!source) throw new Error('E2E_CHARACTER_SOURCE_MISSING');
  const bytes = await readFile(join(characterAssetsDirectory, 'idle.png'));
  const action = (id: string, name: string) => ({
    id,
    name,
    fps: 8,
    loop: true,
    weight: 1,
    frames: [0, 1, 2, 3].map(index => ({
      assetId: 'atlas',
      x: index * 256,
      y: 0,
      width: 256,
      height: 256
    })),
    anchors: {
      ground: { x: 0.5, y: 1 },
      carry: { x: 0.7, y: 0.45 }
    }
  });
  const manifest: CharacterManifestV1 = {
    version: 1,
    id: characterId,
    name: 'E2E 安全角色',
    thumbnailAssetId: 'atlas',
    compilerVersion: 'e2e-fixture-1',
    resources: [{
      assetId: 'atlas',
      fileName: 'atlas.png',
      sha256: sha256(bytes),
      byteLength: bytes.byteLength
    }],
    states: [{
      id: 'idle',
      kind: 'core',
      actions: [action('idle-main', '待机')]
    }, {
      id: 'carrying',
      kind: 'core',
      actions: [action('carrying-main', '搬运')]
    }, {
      id: 'custom:wave',
      kind: 'extension',
      triggers: {
        events: ['single_click'],
        keywords: [],
        emotions: []
      },
      actions: [action('wave-main', '挥手')]
    }]
  };
  await store.publishCompiled(characterId, manifest, { 'atlas.png': bytes });

  const safeCharacterPackage = join(packagesDirectory, 'safe-character.zip');
  const maliciousCharacterPackage = join(
    packagesDirectory,
    'malicious-character.zip'
  );
  await new CharacterPackageService(stagingCharacters)
    .exportCharacter(characterId, safeCharacterPackage);
  await writeTraversalArchive(maliciousCharacterPackage);
  await rm(stagingCharacters, { recursive: true, force: true });

  return {
    characterAssetsDirectory,
    safeCharacterPackage,
    maliciousCharacterPackage,
    characterExportDestination: join(exportsDirectory, 'exported-character.zip')
  };
}
