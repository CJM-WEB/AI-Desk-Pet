import {
  characterDraftV1Schema,
  characterDraftV2Schema,
  characterManifestV1Schema,
  characterManifestV2Schema,
  legacyPreparedCharacterManifestV2Schema,
  preparedCharacterManifestV2Schema,
  convertCharacterDraftV1ToV2,
  convertCharacterManifestV1ToV2,
  type CharacterDraftV2,
  type CharacterManifestV2,
  type PreparedCharacterManifestV2
} from '@myself/character-runtime';
import {
  createPresentationAlphaGeometryAccumulator,
  type CharacterImageMimeType
} from '@myself/character-assets';
import { characterError } from './character-errors';

type CharacterMigrationResult<TDocument> = {
  document: TDocument;
  sourceVersion: 1 | 2;
};

export type CharacterAlphaImage = Readonly<{
  width: number;
  height: number;
  alpha: Uint8Array;
}>;

export type CharacterGeometryMigrationDependencies = Readonly<{
  decodeAlpha(
    bytes: Uint8Array,
    mimeType: CharacterImageMimeType
  ): Promise<CharacterAlphaImage>;
  reportDiagnostic?(code: 'CHARACTER_RESOURCE_GEOMETRY_FALLBACK'): void;
}>;

/** 准备态以持久化标记区分；无需迁移的分支已经是可运行正式清单。 */
export type PreparedCharacterManifestMigration =
  | (CharacterMigrationResult<CharacterManifestV2> & { requiresPersistence: false })
  | (CharacterMigrationResult<PreparedCharacterManifestV2> & { requiresPersistence: true });

/** 资源校验与几何补齐完成后只允许返回正式清单。 */
export type FinalizedCharacterManifestMigration =
  CharacterMigrationResult<CharacterManifestV2> & { requiresPersistence: boolean };

function sourceVersion(raw: unknown): 1 | 2 {
  if (typeof raw !== 'object' || raw === null || !('version' in raw)) {
    throw characterError('CHARACTER_MIGRATION_FAILED');
  }
  if (raw.version !== 1 && raw.version !== 2) {
    throw characterError('CHARACTER_VERSION_UNSUPPORTED');
  }
  return raw.version;
}

/** 将本地草稿统一解析为 V2，并保留来源版本供存储层决定是否落盘。 */
export function migrateCharacterDocument(
  raw: unknown
): CharacterMigrationResult<CharacterDraftV2> {
  const version = sourceVersion(raw);
  if (version === 1) {
    const parsed = characterDraftV1Schema.safeParse(raw);
    if (!parsed.success) throw characterError('CHARACTER_MIGRATION_FAILED');
    return {
      sourceVersion: 1,
      document: convertCharacterDraftV1ToV2(parsed.data).document
    };
  }

  const parsed = characterDraftV2Schema.safeParse(raw);
  if (!parsed.success) throw characterError('CHARACTER_MIGRATION_FAILED');
  return { sourceVersion: 2, document: parsed.data };
}

/** 将本地发布清单统一解析为 V2，并保留来源版本供原子转换使用。 */
export function prepareCharacterManifestMigration(
  raw: unknown
): PreparedCharacterManifestMigration {
  const version = sourceVersion(raw);
  if (version === 1) {
    const parsed = characterManifestV1Schema.safeParse(raw);
    if (!parsed.success) throw characterError('CHARACTER_MIGRATION_FAILED');
    const converted = convertCharacterManifestV1ToV2(parsed.data).document;
    const prepared = preparedCharacterManifestV2Schema.safeParse(converted);
    if (!prepared.success) throw characterError('CHARACTER_MIGRATION_FAILED');
    return {
      sourceVersion: 1,
      document: prepared.data,
      requiresPersistence: true
    };
  }

  const strict = characterManifestV2Schema.safeParse(raw);
  if (strict.success) {
    return { sourceVersion: 2, document: strict.data, requiresPersistence: false };
  }
  const legacy = legacyPreparedCharacterManifestV2Schema.safeParse(raw);
  if (!legacy.success) throw characterError('CHARACTER_MIGRATION_FAILED');
  // 旧 V2 曾允许无播放意义的空表现；其余字段已由 legacy schema 完整验证。
  const candidate = structuredClone(legacy.data);
  for (const skin of candidate.skins) {
    skin.presentations = skin.presentations.filter(
      presentation => presentation.frames.length > 0
    );
  }
  const parsed = preparedCharacterManifestV2Schema.safeParse(candidate);
  if (!parsed.success) throw characterError('CHARACTER_MIGRATION_FAILED');
  return { sourceVersion: 2, document: parsed.data, requiresPersistence: true };
}

/** 兼容既有纯结构调用；其 document 在 finalize 前不得进入运行态。 */
export const migrateCharacterManifest = prepareCharacterManifestMigration;

function resourceRevision(
  presentation: PreparedCharacterManifestV2['skins'][number]['presentations'][number],
  manifest: PreparedCharacterManifestV2
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
  type Presentation = PreparedCharacterManifestV2['skins'][number]['presentations'][number];
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
      if (presentation.geometry) continue;
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
    document: characterManifestV2Schema.parse(document),
    requiresPersistence: true
  };
}
