import {
  characterManifestV3Schema, preparedCharacterManifestV3Schema, characterMigrationManifestV3Schema,
  migrateCharacterDraftToV3, migrateCharacterManifestToV3,
  type CharacterDraftV3, type CharacterManifestV3, type CharacterMigrationManifestV3,
  type CharacterMigrationIssueV3
} from '@myself/character-runtime';
import { createPresentationAlphaGeometryAccumulator, type CharacterImageMimeType } from '@myself/character-assets';
import { characterError } from './character-errors';

type CharacterMigrationResult<T> = { document: T; sourceVersion: 1 | 2 | 3; issues: CharacterMigrationIssueV3[] };
export type CharacterAlphaImage = Readonly<{ width: number; height: number; alpha: Uint8Array }>;
export type CharacterGeometryMigrationDependencies = Readonly<{
  decodeAlpha(bytes: Uint8Array, mimeType: CharacterImageMimeType): Promise<CharacterAlphaImage>;
  reportDiagnostic?(code: 'CHARACTER_RESOURCE_GEOMETRY_FALLBACK'): void;
}>;
export type PreparedCharacterManifestMigration = CharacterMigrationResult<CharacterMigrationManifestV3> & { requiresPersistence: boolean };
export type FinalizedCharacterManifestMigration = PreparedCharacterManifestMigration;

/** 旧契约只在迁移边界解析，问题随草稿返回，由 Main 持久保留。 */
export function migrateCharacterDocument(raw: unknown): CharacterMigrationResult<CharacterDraftV3> {
  try { return migrateCharacterDraftToV3(raw); }
  catch { throw characterError('CHARACTER_MIGRATION_FAILED'); }
}

/** 准备阶段保留未决问题与完整资源目录，资源验证后才补几何；不得直接运行。 */
export function prepareCharacterManifestMigration(raw: unknown): PreparedCharacterManifestMigration {
  try {
    if (typeof raw === 'object' && raw !== null && 'version' in raw && raw.version === 3) {
      const strict = characterManifestV3Schema.safeParse(raw);
      if (strict.success) return { document: strict.data, sourceVersion: 3, issues: [], requiresPersistence: false };
      return { document: preparedCharacterManifestV3Schema.parse(raw), sourceVersion: 3, issues: [], requiresPersistence: true };
    }
    return { ...migrateCharacterManifestToV3(raw), requiresPersistence: true };
  } catch { throw characterError('CHARACTER_MIGRATION_FAILED'); }
}
export const migrateCharacterManifest = prepareCharacterManifestMigration;

/** 只有全部迁移问题已由作者处理且发布结构严格合法，才能进入正式运行链。 */
export function requirePublishedCharacterMigration(result: FinalizedCharacterManifestMigration): CharacterManifestV3 {
  if (result.issues.length) throw characterError('CHARACTER_MIGRATION_REVIEW_REQUIRED');
  const parsed = characterManifestV3Schema.safeParse(result.document);
  if (!parsed.success) throw characterError('CHARACTER_MIGRATION_FAILED');
  return parsed.data;
}

function resourceRevision(
  presentation: CharacterMigrationManifestV3['skins'][number]['presentations'][number],
  manifest: CharacterMigrationManifestV3
): string {
  const resources = new Map(manifest.resources.map(resource => [resource.assetId, resource]));
  return [...new Set(presentation.frames.map(frame => resources.get(frame.assetId)!.sha256))]
    .sort().join('.');
}

function resourceMimeType(fileName: string): CharacterImageMimeType {
  if (fileName.endsWith('.png')) return 'image/png';
  if (fileName.endsWith('.webp')) return 'image/webp';
  throw new Error('CHARACTER_IMAGE_STRUCTURE_INVALID');
}

/** 资源校验完成后补齐旧表现几何，并以严格 Schema 封闭迁移结果。 */
export async function finalizeCharacterManifestMigration(
  prepared: PreparedCharacterManifestMigration,
  assets: Readonly<Record<string, Uint8Array>>,
  dependencies: CharacterGeometryMigrationDependencies
): Promise<FinalizedCharacterManifestMigration> {
  if (!prepared.requiresPersistence) return prepared;
  const document = structuredClone(prepared.document);
  const resources = new Map(document.resources.map(resource => [resource.assetId, resource]));
  type Presentation = CharacterMigrationManifestV3['skins'][number]['presentations'][number];
  type Work = {
    presentation: Presentation;
    revision: string;
    accumulator: ReturnType<typeof createPresentationAlphaGeometryAccumulator>;
    failed: boolean;
  };
  const workItems: Work[] = [];
  const deliveriesByAsset = new Map<string, Array<{
    work: Work;
    frameIndex: number;
    frame: Presentation['frames'][number];
  }>>();

  for (const skin of document.skins) {
    for (const presentation of skin.presentations) {
      if (presentation.geometry) {
        if (presentation.geometry.resourceRevision !== resourceRevision(presentation, document)
          || presentation.geometry.groundAnchor.x !== presentation.anchors.ground.x
          || presentation.geometry.groundAnchor.y !== presentation.anchors.ground.y) throw characterError('CHARACTER_MIGRATION_FAILED');
        continue;
      }
      const work: Work = {
        presentation,
        revision: resourceRevision(presentation, document),
        accumulator: createPresentationAlphaGeometryAccumulator({
          groundAnchor: presentation.anchors.ground,
          frames: presentation.frames
        }),
        failed: false
      };
      workItems.push(work);
      presentation.frames.forEach((frame, frameIndex) => {
        const deliveries = deliveriesByAsset.get(frame.assetId) ?? [];
        deliveries.push({ work, frameIndex, frame });
        deliveriesByAsset.set(frame.assetId, deliveries);
      });
    }
  }

  // 文档级按资源分发：同一 atlas 只解码一次，完成全部表现扫描后立即释放。
  for (const [assetId, deliveries] of deliveriesByAsset) {
    const resource = resources.get(assetId)!;
    let image: CharacterAlphaImage;
    try {
      image = await dependencies.decodeAlpha(
        assets[resource.fileName]!,
        resourceMimeType(resource.fileName)
      );
    } catch (cause) {
      if (cause instanceof Error && cause.message === 'CHARACTER_IMAGE_STRUCTURE_INVALID') {
        throw cause;
      }
      deliveries.forEach(delivery => { delivery.work.failed = true; });
      continue;
    }
    for (const { work, frameIndex, frame } of deliveries) {
      if (work.failed) continue;
      try {
        work.accumulator.addFrame({
          frameIndex,
          sourceWidth: image.width,
          sourceHeight: image.height,
          sourceAlpha: image.alpha,
          sourceRect: {
            x: frame.x,
            y: frame.y,
            width: frame.width,
            height: frame.height
          }
        });
      } catch {
        work.failed = true;
      }
    }
  }

  for (const work of workItems) {
    let geometry;
    try {
      if (work.failed) throw new Error('CHARACTER_PRESENTATION_GEOMETRY_INVALID');
      geometry = work.accumulator.finish();
    } catch {
      dependencies.reportDiagnostic?.('CHARACTER_RESOURCE_GEOMETRY_FALLBACK');
      geometry = {
        visualBounds: { x: 0, y: 0, width: 1, height: 1 },
        groundAnchor: { ...work.presentation.anchors.ground }
      };
    }
    work.presentation.geometry = {
      ...geometry,
      resourceRevision: work.revision
    };
  }
  return {
    sourceVersion: prepared.sourceVersion,
    document: characterMigrationManifestV3Schema.parse(document),
    requiresPersistence: true,
    issues: prepared.issues
  };
}
