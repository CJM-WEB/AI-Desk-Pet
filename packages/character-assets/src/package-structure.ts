import type { CharacterManifestV1 } from '@myself/character-runtime';
import { z } from 'zod';

const SAFE_CHARACTER_ID = /^[a-z0-9][a-z0-9_-]{0,119}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA_256_PATTERN = /^[a-f0-9]{64}$/u;

export const characterSourceCatalogV1Schema = z.object({
  version: z.literal(1),
  characterId: z.string().regex(SAFE_CHARACTER_ID),
  sources: z.array(z.object({
    assetId: z.string().regex(UUID_PATTERN),
    displayName: z.string().min(1).max(255),
    mimeType: z.enum(['image/png', 'image/webp']),
    byteLength: z.number().int().safe().nonnegative(),
    sha256: z.string().regex(SHA_256_PATTERN)
  }).strict()).max(2_000)
}).strict().superRefine((catalog, context) => {
  const ids = new Set<string>();
  catalog.sources.forEach((source, index) => {
    if (ids.has(source.assetId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: '源素材标识必须唯一。',
        path: ['sources', index, 'assetId']
      });
    }
    ids.add(source.assetId);
  });
});

export type CharacterSourceCatalogV1 =
  z.output<typeof characterSourceCatalogV1Schema>;

export type CharacterPackageFileMetadata = {
  path: string;
  kind: 'json' | 'image';
  mime?: 'image/png' | 'image/webp';
  byteLength?: number;
  sha256?: string;
};

export type CharacterPackageStructureInput = {
  draftId: string;
  manifest: CharacterManifestV1;
  sourceCatalog: CharacterSourceCatalogV1;
  files: readonly CharacterPackageFileMetadata[];
};

function packageError(code: string): Error {
  return new Error(code);
}

export function characterSourceFileName(
  source: CharacterSourceCatalogV1['sources'][number]
): string {
  return `${source.assetId}${source.mimeType === 'image/png' ? '.png' : '.webp'}`;
}

function expectedCompiledKind(fileName: string): {
  kind: 'json' | 'image';
  mime?: 'image/png' | 'image/webp';
} {
  const lowerName = fileName.toLocaleLowerCase('en-US');
  if (lowerName.endsWith('.json')) return { kind: 'json' };
  if (lowerName.endsWith('.png')) {
    return { kind: 'image', mime: 'image/png' };
  }
  if (lowerName.endsWith('.webp')) {
    return { kind: 'image', mime: 'image/webp' };
  }
  throw packageError('CHARACTER_PACKAGE_RESOURCE_INVALID');
}

function assertResource(
  actual: CharacterPackageFileMetadata | undefined,
  expected: {
    byteLength: number;
    sha256: string;
    kind: 'json' | 'image';
    mime?: 'image/png' | 'image/webp';
  }
): void {
  if (
    !actual
    || actual.byteLength !== expected.byteLength
    || actual.sha256 !== expected.sha256
    || actual.kind !== expected.kind
    || actual.mime !== expected.mime
  ) {
    throw packageError('CHARACTER_PACKAGE_RESOURCE_INVALID');
  }
}

/**
 * 统一校验桌面端导出包与网站共享包，避免两条导入链路规则漂移。
 */
export function validateCharacterPackageStructure(
  input: CharacterPackageStructureInput
): void {
  if (
    input.draftId !== input.manifest.id
    || input.draftId !== input.sourceCatalog.characterId
  ) {
    throw packageError('CHARACTER_PACKAGE_ID_MISMATCH');
  }

  const declaredFiles = [
    'draft/draft.json',
    'compiled/manifest.json',
    'source/catalog.json',
    ...input.manifest.resources.map(resource => (
      `compiled/${resource.fileName}`
    )),
    ...input.sourceCatalog.sources.map(source => (
      `source/${characterSourceFileName(source)}`
    ))
  ];
  const expectedFiles = new Set(declaredFiles);
  const actualFiles = new Map(
    input.files.map(file => [file.path, file])
  );
  if (
    expectedFiles.size !== declaredFiles.length
    || actualFiles.size !== input.files.length
    || actualFiles.size !== expectedFiles.size
    || [...actualFiles.keys()].some(path => !expectedFiles.has(path))
  ) {
    throw packageError('CHARACTER_PACKAGE_STRUCTURE_INVALID');
  }

  for (const resource of input.manifest.resources) {
    assertResource(
      actualFiles.get(`compiled/${resource.fileName}`),
      {
        ...resource,
        ...expectedCompiledKind(resource.fileName)
      }
    );
  }
  for (const source of input.sourceCatalog.sources) {
    assertResource(
      actualFiles.get(`source/${characterSourceFileName(source)}`),
      {
        byteLength: source.byteLength,
        sha256: source.sha256,
        kind: 'image',
        mime: source.mimeType
      }
    );
  }
}
