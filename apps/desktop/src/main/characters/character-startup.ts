const STABLE_CHARACTER_ERROR = /^CHARACTER_[A-Z0-9_]+$/u;
export { characterRecoveryMessage } from '../../shared/character-recovery';

export type CharacterStartupResult =
  | { kind: 'active'; activeCharacterId: string }
  | { kind: 'fallback'; errorCode: string | null };

export interface CharacterStartupDependencies {
  loadIndex(): Promise<unknown>;
  validateActiveRuntime(): Promise<{ activeCharacterId: string } | null>;
  remove?: () => Promise<void>;
}

/**
 * 启动恢复只读索引和运行版本；任何校验失败都保留损坏角色与草稿供工作室修复。
 */
export async function prepareCharacterStartup(
  dependencies: CharacterStartupDependencies
): Promise<CharacterStartupResult> {
  try {
    await dependencies.loadIndex();
    const active = await dependencies.validateActiveRuntime();
    return active
      ? { kind: 'active', activeCharacterId: active.activeCharacterId }
      : { kind: 'fallback', errorCode: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return {
      kind: 'fallback',
      errorCode: STABLE_CHARACTER_ERROR.test(message)
        ? message
        : 'CHARACTER_OPERATION_FAILED'
    };
  }
}
