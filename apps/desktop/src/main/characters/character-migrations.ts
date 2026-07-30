import {
  characterDraftV1Schema,
  type CharacterDraftV1
} from '@myself/character-runtime';
import { characterError } from './character-errors';

export function migrateCharacterDocument(raw: unknown): CharacterDraftV1 {
  if (
    typeof raw === 'object'
    && raw !== null
    && 'version' in raw
    && raw.version !== 1
  ) {
    throw characterError('CHARACTER_VERSION_UNSUPPORTED');
  }

  const parsed = characterDraftV1Schema.safeParse(raw);
  if (!parsed.success) {
    throw characterError('CHARACTER_MIGRATION_FAILED');
  }
  return parsed.data;
}
