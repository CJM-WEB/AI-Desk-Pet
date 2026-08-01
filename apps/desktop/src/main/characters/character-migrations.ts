import {
  characterDraftV1Schema,
  characterDraftV2Schema,
  characterManifestV1Schema,
  characterManifestV2Schema,
  convertCharacterDraftV1ToV2,
  convertCharacterManifestV1ToV2,
  type CharacterDraftV2,
  type CharacterManifestV2
} from '@myself/character-runtime';
import { characterError } from './character-errors';

type CharacterMigrationResult<TDocument> = {
  document: TDocument;
  sourceVersion: 1 | 2;
};

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
export function migrateCharacterManifest(
  raw: unknown
): CharacterMigrationResult<CharacterManifestV2> {
  const version = sourceVersion(raw);
  if (version === 1) {
    const parsed = characterManifestV1Schema.safeParse(raw);
    if (!parsed.success) throw characterError('CHARACTER_MIGRATION_FAILED');
    return {
      sourceVersion: 1,
      document: convertCharacterManifestV1ToV2(parsed.data).document
    };
  }

  const parsed = characterManifestV2Schema.safeParse(raw);
  if (!parsed.success) throw characterError('CHARACTER_MIGRATION_FAILED');
  return { sourceVersion: 2, document: parsed.data };
}
