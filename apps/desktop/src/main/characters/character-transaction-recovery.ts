export type CharacterTransactionRecoveryKind =
  | 'healthy'
  | 'draft-recovery-blocked'
  | 'publish-recovery-blocked'
  | 'draft-and-publish-recovery-blocked';

export type CharacterTransactionRecoveryErrorCode =
  | 'CHARACTER_DRAFT_RECOVERY_BLOCKED'
  | 'CHARACTER_PUBLISH_RECOVERY_BLOCKED'
  | 'CHARACTER_RECOVERY_DEFERRED';

export type CharacterTransactionRecoveryResult = Readonly<{
  characterId: string;
  kind: CharacterTransactionRecoveryKind;
  draftErrorCode: CharacterTransactionRecoveryErrorCode | null;
  publishErrorCode: CharacterTransactionRecoveryErrorCode | null;
  deferred: boolean;
}>;

export type CharacterTransactionRecoveryReport = Readonly<{
  characters: readonly CharacterTransactionRecoveryResult[];
  budgetExceeded: boolean;
}>;

export type CharacterRecoveryCandidate = Readonly<{
  characterId: string;
  recoverDraft(): Promise<void>;
  recoverPublish(): Promise<void>;
}>;

export type CharacterTransactionRecoveryDependencies = Readonly<{
  activeCharacterId: () => string | null;
  now?: () => number;
}>;

/**
 * 仅协调角色的 draft 与 publish 恢复分面，不读取磁盘或拥有 Store。
 * 能力门对未恢复的角色默认拒绝，且只暴露稳定错误码，避免泄露底层恢复异常。
 */
export class CharacterTransactionRecovery {
  private readonly results = new Map<string, CharacterTransactionRecoveryResult>();

  // 预留给后续排序和预算任务；本任务不得据此改变恢复行为。
  private readonly activeCharacterId: () => string | null;
  private readonly now: () => number;

  constructor({
    activeCharacterId,
    now = Date.now
  }: CharacterTransactionRecoveryDependencies) {
    this.activeCharacterId = activeCharacterId;
    this.now = now;
  }

  async recoverAll(
    candidates: readonly CharacterRecoveryCandidate[]
  ): Promise<CharacterTransactionRecoveryReport> {
    const characters: CharacterTransactionRecoveryResult[] = [];

    for (const candidate of candidates) {
      const result = await this.recoverCandidate(candidate);
      this.results.set(candidate.characterId, result);
      characters.push(result);
    }

    return { characters, budgetExceeded: false };
  }

  resultFor(characterId: string): CharacterTransactionRecoveryResult {
    return this.results.get(characterId) ?? deferredResult(characterId);
  }

  assertDraftSaveAllowed(characterId: string): void {
    const result = this.resultFor(characterId);
    this.assertAllowed(result.draftErrorCode);
  }

  assertPublishAllowed(characterId: string): void {
    const result = this.resultFor(characterId);
    this.assertAllowed(result.draftErrorCode ?? result.publishErrorCode);
  }

  assertRuntimeAllowed(characterId: string): void {
    const result = this.resultFor(characterId);
    this.assertAllowed(result.publishErrorCode);
  }

  private async recoverCandidate(
    candidate: CharacterRecoveryCandidate
  ): Promise<CharacterTransactionRecoveryResult> {
    const draftErrorCode = await recoveryErrorCode(
      candidate.recoverDraft,
      'CHARACTER_DRAFT_RECOVERY_BLOCKED'
    );
    const publishErrorCode = await recoveryErrorCode(
      candidate.recoverPublish,
      'CHARACTER_PUBLISH_RECOVERY_BLOCKED'
    );

    return {
      characterId: candidate.characterId,
      kind: recoveryKind(draftErrorCode, publishErrorCode),
      draftErrorCode,
      publishErrorCode,
      deferred: false
    };
  }

  private assertAllowed(errorCode: CharacterTransactionRecoveryErrorCode | null): void {
    if (errorCode) {
      throw new Error(errorCode);
    }
  }
}

async function recoveryErrorCode(
  recover: () => Promise<void>,
  errorCode: CharacterTransactionRecoveryErrorCode
): Promise<CharacterTransactionRecoveryErrorCode | null> {
  try {
    await recover();
    return null;
  } catch {
    return errorCode;
  }
}

function recoveryKind(
  draftErrorCode: CharacterTransactionRecoveryErrorCode | null,
  publishErrorCode: CharacterTransactionRecoveryErrorCode | null
): CharacterTransactionRecoveryKind {
  if (draftErrorCode && publishErrorCode) {
    return 'draft-and-publish-recovery-blocked';
  }
  if (draftErrorCode) {
    return 'draft-recovery-blocked';
  }
  if (publishErrorCode) {
    return 'publish-recovery-blocked';
  }
  return 'healthy';
}

function deferredResult(characterId: string): CharacterTransactionRecoveryResult {
  return {
    characterId,
    kind: 'draft-and-publish-recovery-blocked',
    draftErrorCode: 'CHARACTER_RECOVERY_DEFERRED',
    publishErrorCode: 'CHARACTER_RECOVERY_DEFERRED',
    deferred: true
  };
}
