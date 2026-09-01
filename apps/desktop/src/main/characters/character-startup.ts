import type { CharacterPackageRecoveryReport } from './character-package-service';
import type { CharacterTransactionRecoveryReport } from './character-transaction-recovery';
import type {
  CharacterRecoveryFallbackErrorCode,
  CharacterRecoveryIssueDto,
  CharacterRecoveryIssueErrorCode,
  CharacterRecoverySnapshotDto
} from '../../shared/character-ipc';
import { characterRecoveryFallbackErrorCodeSchema } from '../../shared/character-ipc';

export type CharacterStartupInput = Readonly<{
  indexRecovered: boolean;
  packageRecoveryReport: CharacterPackageRecoveryReport;
}>;

export type ActiveRuntimeValidation =
  | Readonly<{ kind: 'ready'; activeCharacterId: string }>
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'unavailable' }>;

export interface CharacterStartupDependencies {
  validateActiveRuntime(): Promise<ActiveRuntimeValidation>;
  ensureOfficialDefaultCharacter(): Promise<{ activeCharacterId: string }>;
  loadFinalIndex(): Promise<unknown>;
  getTransactionRecoveryReport(): CharacterTransactionRecoveryReport;
}

export type CharacterStartupResult = Readonly<{
  activeCharacterId: string;
  recoverySnapshot: CharacterRecoverySnapshotDto;
}>;

const CHARACTER_RECOVERY_ISSUE_ORDER: readonly CharacterRecoveryIssueErrorCode[] = [
  'CHARACTER_DRAFT_RECOVERY_BLOCKED',
  'CHARACTER_PUBLISH_RECOVERY_BLOCKED',
  'CHARACTER_RECOVERY_DEFERRED',
  'CHARACTER_IMPORT_RECOVERY_BLOCKED',
  'CHARACTER_IMPORT_RECOVERY_DEFERRED'
];

/** Main 中唯一的启动恢复裁决点，只公开深冻结的稳定事实。 */
export async function prepareCharacterStartup(
  input: CharacterStartupInput,
  dependencies: CharacterStartupDependencies
): Promise<CharacterStartupResult> {
  let activeCharacterId = '';
  let fallbackErrorCode: CharacterRecoveryFallbackErrorCode | null = input.indexRecovered
    ? 'CHARACTER_INDEX_UNAVAILABLE'
    : null;
  let fallbackPrepared = false;
  let fallbackPreparationFailed = false;
  let shouldPrepareDefault = fallbackErrorCode !== null;
  try {
    const active = await dependencies.validateActiveRuntime();
    if (active.kind === 'ready') {
      activeCharacterId = active.activeCharacterId;
    } else {
      shouldPrepareDefault = true;
      if (active.kind === 'unavailable') {
        fallbackErrorCode ??= 'CHARACTER_RUNTIME_UNAVAILABLE';
      }
    }
  } catch (error) {
    fallbackErrorCode ??= publicFallbackCode(error);
    shouldPrepareDefault = true;
  }
  if (shouldPrepareDefault) {
    try {
      activeCharacterId = (await dependencies.ensureOfficialDefaultCharacter()).activeCharacterId;
      fallbackPrepared = true;
    } catch {
      fallbackErrorCode = null;
      fallbackPreparationFailed = true;
    }
  }
  let transactionReport: CharacterTransactionRecoveryReport = { characters: [] };
  try {
    await dependencies.loadFinalIndex();
    transactionReport = dependencies.getTransactionRecoveryReport();
  } catch (firstError) {
    fallbackErrorCode = publicFallbackCode(firstError);
    if (!fallbackPrepared && !fallbackPreparationFailed) {
      try {
        activeCharacterId = (await dependencies.ensureOfficialDefaultCharacter()).activeCharacterId;
        fallbackPrepared = true;
      } catch {
        fallbackErrorCode = null;
        fallbackPreparationFailed = true;
      }
    }
    try {
      await dependencies.loadFinalIndex();
      transactionReport = dependencies.getTransactionRecoveryReport();
    } catch (retryError) {
      // Store 持续不可用时不发布过期 B1 报告，但保留 B2 事实并让基础桌宠继续启动。
      fallbackErrorCode = publicFallbackCode(retryError);
    }
  }
  if (!fallbackPrepared && fallbackPreparationFailed) fallbackErrorCode = null;
  const issues = freezeIssues(transactionReport, input.packageRecoveryReport);
  return Object.freeze({
    activeCharacterId,
    recoverySnapshot: Object.freeze({ fallbackErrorCode, issues })
  });
}

function publicFallbackCode(error: unknown): CharacterRecoveryFallbackErrorCode {
  const message = error instanceof Error ? error.message : '';
  const parsed = characterRecoveryFallbackErrorCodeSchema.safeParse(message);
  return parsed.success ? parsed.data : 'CHARACTER_OPERATION_FAILED';
}

function freezeIssues(
  transactionReport: CharacterTransactionRecoveryReport,
  packageReport: CharacterPackageRecoveryReport
): readonly CharacterRecoveryIssueDto[] {
  const unique = new Map<string, CharacterRecoveryIssueDto>();
  const add = (characterId: string, errorCode: CharacterRecoveryIssueErrorCode): void => {
    unique.set(`${characterId}\0${errorCode}`, { characterId, errorCode });
  };
  for (const character of transactionReport.characters) {
    if (character.draftErrorCode) add(character.characterId, character.draftErrorCode);
    if (character.publishErrorCode) add(character.characterId, character.publishErrorCode);
  }
  for (const issue of packageReport.issues) add(issue.characterId, issue.errorCode);
  return Object.freeze([...unique.values()]
    .sort((left, right) => left.characterId.localeCompare(right.characterId, 'en')
      || CHARACTER_RECOVERY_ISSUE_ORDER.indexOf(left.errorCode)
      - CHARACTER_RECOVERY_ISSUE_ORDER.indexOf(right.errorCode))
    .map(issue => Object.freeze(issue)));
}
