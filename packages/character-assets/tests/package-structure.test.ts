import { createHash } from 'node:crypto';
import type { CharacterManifestV1 } from '@myself/character-runtime';
import { describe, expect, it } from 'vitest';
import {
  characterSourceCatalogV1Schema,
  characterSourceFileName,
  validateCharacterPackageStructure,
  type CharacterPackageStructureInput
} from '../src/package-structure';

const SOURCE_ID = '11111111-1111-4111-8111-111111111111';
const COMPILED_BYTES = Buffer.from('compiled');
const SOURCE_BYTES = Buffer.from('source');

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function manifest(id = 'test-pet'): CharacterManifestV1 {
  return {
    version: 1,
    id,
    name: '测试桌宠',
    thumbnailAssetId: 'idle',
    compilerVersion: '1.0.0',
    resources: [{
      assetId: 'idle',
      fileName: 'idle.png',
      byteLength: COMPILED_BYTES.byteLength,
      sha256: sha256(COMPILED_BYTES)
    }],
    states: []
  };
}

function validInput(): CharacterPackageStructureInput {
  const sourceCatalog = characterSourceCatalogV1Schema.parse({
    version: 1,
    characterId: 'test-pet',
    sources: [{
      assetId: SOURCE_ID,
      displayName: 'idle.png',
      mimeType: 'image/png',
      byteLength: SOURCE_BYTES.byteLength,
      sha256: sha256(SOURCE_BYTES)
    }]
  });
  return {
    draftId: 'test-pet',
    manifest: manifest(),
    sourceCatalog,
    files: [
      { path: 'draft/draft.json', kind: 'json' as const },
      { path: 'compiled/manifest.json', kind: 'json' as const },
      { path: 'source/catalog.json', kind: 'json' as const },
      {
        path: 'compiled/idle.png',
        kind: 'image' as const,
        mime: 'image/png' as const,
        byteLength: COMPILED_BYTES.byteLength,
        sha256: sha256(COMPILED_BYTES)
      },
      {
        path: `source/${SOURCE_ID}.png`,
        kind: 'image' as const,
        mime: 'image/png' as const,
        byteLength: SOURCE_BYTES.byteLength,
        sha256: sha256(SOURCE_BYTES)
      }
    ]
  };
}

describe('角色包完整结构校验', () => {
  it('接受声明与实际文件完全一致的角色包', () => {
    expect(() => validateCharacterPackageStructure(validInput()))
      .not.toThrow();
  });

  it('要求草稿、发布清单和源目录使用同一个角色标识', () => {
    const input = validInput();
    input.sourceCatalog = {
      ...input.sourceCatalog,
      characterId: 'other-pet'
    };

    expect(() => validateCharacterPackageStructure(input))
      .toThrow('CHARACTER_PACKAGE_ID_MISMATCH');
  });

  it.each([
    ['缺少必需文件', (files: ReturnType<typeof validInput>['files']) => files.slice(1)],
    ['包含未声明文件', (files: ReturnType<typeof validInput>['files']) => [
      ...files,
      { path: 'source/extra.png', kind: 'image' as const, mime: 'image/png' as const }
    ]],
    ['重复实际文件', (files: ReturnType<typeof validInput>['files']) => [
      ...files,
      files[0]!
    ]]
  ])('%s时拒绝', (_name, mutate) => {
    const input = validInput();
    input.files = mutate(input.files);

    expect(() => validateCharacterPackageStructure(input))
      .toThrow('CHARACTER_PACKAGE_STRUCTURE_INVALID');
  });

  it.each([
    ['字节数伪造', { byteLength: SOURCE_BYTES.byteLength + 1 }],
    ['摘要伪造', { sha256: 'b'.repeat(64) }],
    ['媒体类型伪造', { mime: 'image/webp' as const }]
  ])('源文件%s时拒绝', (_name, patch) => {
    const input = validInput();
    input.files = input.files.map(file => (
      file.path.startsWith('source/') && file.path !== 'source/catalog.json'
        ? { ...file, ...patch }
        : file
    ));

    expect(() => validateCharacterPackageStructure(input))
      .toThrow('CHARACTER_PACKAGE_RESOURCE_INVALID');
  });

  it('统一生成源文件在压缩包内的路径', () => {
    expect(characterSourceFileName({
      assetId: SOURCE_ID,
      displayName: 'idle',
      mimeType: 'image/png',
      byteLength: 1,
      sha256: 'a'.repeat(64)
    })).toBe(`${SOURCE_ID}.png`);
  });
});
