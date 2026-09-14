import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { afterEach, describe, expect, test } from 'vitest';
import { CharacterPackageService } from '../../apps/desktop/src/main/characters/character-package-service';
import { CharacterAssetService } from '../../apps/desktop/src/main/characters/character-asset-service';
import { CharacterStore } from '../../apps/desktop/src/main/characters/character-store';
import { materializeCharacterWorkshopFixtures } from '../fixtures/character-workshop-assets';

const temporaryDirectories: string[] = [];

// 独立展开 PNG 压缩流，比较完整像素表示与其他块；编码字节可随无损导出变化。
function pngContent(bytes: Uint8Array) {
  const png = Buffer.from(bytes);
  const imageData: Buffer[] = [];
  const metadata: Buffer[] = [png.subarray(0, 8)];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const end = offset + length + 12;
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') {
      imageData.push(png.subarray(offset + 8, end - 4));
    } else metadata.push(png.subarray(offset, end));
    offset = end;
  }
  return { filtered: inflateSync(Buffer.concat(imageData)), metadata };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('角色工作室 E2E 素材夹具', () => {
  test('生成的安全角色包可由正式 V3 导入链直接使用', async () => {
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

    expect(draft.version).toBe(3);
    expect(draft.idleStateId).toBe('idle');
    expect(draft.states.find(state => state.id === 'custom-wave')?.enterConditions)
      .toEqual([{ mode: 'all', clauses: [{ kind: 'event', event: 'user-interaction' }] }]);
    expect(draft.defaultSkinId).toBe('winter');
    expect(draft.skins.map(skin => skin.id)).toEqual(['default', 'winter']);
    expect(draft.skins[0]?.presentations).toHaveLength(8);
    expect(draft.skins[1]?.presentations).toHaveLength(8);
    expect(draft.skins[1]?.presentations.find(
      presentation => presentation.actionId === 'safe-idle-action'
    )).toMatchObject({ playbackRate: 1.5, mirrorX: true });
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
      const importedBytes = await assetService.readSource(importedId, assetId);
      expect(importedBytes.byteLength).toBeLessThanOrEqual(expectedSourceBytes.byteLength);
      expect(pngContent(importedBytes)).toEqual(pngContent(expectedSourceBytes));
    }));

    const manifest = await store.getPublishedManifest(importedId);
    expect(manifest.version).toBe(3);
    expect(manifest.idleStateId).toBe('idle');
    expect(manifest.defaultSkinId).toBe('winter');
    expect(manifest.skins.map(skin => skin.id)).toEqual(['default', 'winter']);
    expect(manifest.skins[1]?.presentations.find(
      presentation => presentation.actionId === 'safe-idle-action'
    )).toMatchObject({ playbackRate: 1.5, mirrorX: true });
    expect(manifest?.actions.find(action => action.id === 'safe-idle-action')?.loopPolicy)
      .toBe('until-interrupted');
    expect(manifest?.skins.flatMap(skin => skin.presentations)
      .flatMap(presentation => presentation.frames)
      .every(frame => frame.assetId === 'atlas')).toBe(true);
  });
});
