import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { CharacterPackageService } from '../../apps/desktop/src/main/characters/character-package-service';
import { CharacterAssetService } from '../../apps/desktop/src/main/characters/character-asset-service';
import { CharacterStore } from '../../apps/desktop/src/main/characters/character-store';
import { materializeCharacterWorkshopFixtures } from '../fixtures/character-workshop-assets';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('角色工作室 E2E 素材夹具', () => {
  test('生成的安全角色包可由严格 V2 导入链读取', async () => {
    const baseDirectory = await mkdtemp(join(tmpdir(), 'ai-pet-workshop-fixture-'));
    temporaryDirectories.push(baseDirectory);
    const assetsDirectory = join(baseDirectory, 'assets');
    const packagesDirectory = join(baseDirectory, 'packages');
    const exportsDirectory = join(baseDirectory, 'exports');
    await Promise.all([
      mkdir(assetsDirectory),
      mkdir(packagesDirectory),
      mkdir(exportsDirectory)
    ]);

    const paths = await materializeCharacterWorkshopFixtures(
      resolve(import.meta.dirname, '../..'),
      baseDirectory,
      assetsDirectory,
      packagesDirectory,
      exportsDirectory
    );
    const importedRoot = join(baseDirectory, 'imported');
    const importedId = await new CharacterPackageService(importedRoot)
      .importCharacter(paths.safeCharacterPackage);
    const store = new CharacterStore(importedRoot);
    const draft = await store.getDraft(importedId);

    expect(draft.version).toBe(2);
    expect(draft.defaultSkinId).toBe('default');
    expect(draft.skins[0]?.presentations).toHaveLength(8);
    expect(draft.states.map(state => state.id)).toEqual([
      'idle',
      'listening',
      'thinking',
      'moving',
      'success',
      'error',
      'carrying',
      'custom-wave'
    ]);

    // 草稿必须引用可继续编辑的正式 source，而不是只存在于发布产物中的 atlas。
    const sourceAssetIds = [...new Set(draft.skins.flatMap(skin => (
      skin.presentations.flatMap(presentation => (
        presentation.frames.map(frame => frame.assetId)
      ))
    )))];
    expect(sourceAssetIds).toHaveLength(1);
    const expectedSourceBytes = new Uint8Array(
      await readFile(join(assetsDirectory, 'idle.png'))
    );
    const assetService = new CharacterAssetService(importedRoot);
    await Promise.all(sourceAssetIds.map(async assetId => {
      await expect(assetService.readSource(importedId, assetId))
        .resolves.toEqual(expectedSourceBytes);
    }));

    const manifest = await store.getPublishedManifest(importedId);
    expect(manifest?.actions.find(action => action.id === 'safe-idle-action')?.loopPolicy)
      .toBe('until-interrupted');
    expect(manifest?.skins.flatMap(skin => skin.presentations)
      .flatMap(presentation => presentation.frames)
      .every(frame => frame.assetId === 'atlas')).toBe(true);
  });
});
