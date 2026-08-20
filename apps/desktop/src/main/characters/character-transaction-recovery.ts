export const MAX_RECOVERY_CHARACTERS = 256;
export const RECOVERY_SOFT_BUDGET_MS = 2_000;

export type CharacterTransactionRecoveryResult = Readonly<{
  characterId: string;
  draftErrorCode:
    | 'CHARACTER_DRAFT_RECOVERY_BLOCKED'
    | 'CHARACTER_RECOVERY_DEFERRED'
    | null;
  publishErrorCode:
    | 'CHARACTER_PUBLISH_RECOVERY_BLOCKED'
    | 'CHARACTER_RECOVERY_DEFERRED'
    | null;
}>;

export type CharacterTransactionRecoveryReport = Readonly<{
  characters: readonly CharacterTransactionRecoveryResult[];
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

  // 仅用于恢复顺序和软预算判断；不将时钟或活动角色状态传递给候选项。
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
    // 每轮仅信任当前候选的恢复结果，防止 Store 索引变更后复用过期裁决。
    this.results.clear();
    const startedAt = this.now();
    const results = new Map<string, CharacterTransactionRecoveryResult>();
    const recoveryCandidates = [...candidates];
    const activeIndex = activeCandidateIndex(
      recoveryCandidates,
      this.activeCharacterId()
    );
    if (activeIndex > 0) {
      const activeCandidate = recoveryCandidates[activeIndex];
      if (activeCandidate) {
        recoveryCandidates.splice(activeIndex, 1);
        recoveryCandidates.unshift(activeCandidate);
      }
    }

    for (let index = 0; index < recoveryCandidates.length; index += 1) {
      if (
        index >= MAX_RECOVERY_CHARACTERS ||
        (index > 0 && this.now() - startedAt >= RECOVERY_SOFT_BUDGET_MS)
      ) {
        this.deferCandidates(recoveryCandidates.slice(index), results);
        break;
      }

      const candidate = recoveryCandidates[index]!;
      const result = await this.recoverCandidate(candidate);
      this.results.set(candidate.characterId, result);
      results.set(candidate.characterId, result);
    }

    return {
      characters: candidates.map((candidate) =>
        results.get(candidate.characterId) ?? deferredResult(candidate.characterId)
      )
    };
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
      draftErrorCode,
      publishErrorCode
    };
  }

  /**
   * 未获准启动的角色统一进入 fail-closed 状态，避免只恢复一半分面。
   */
  private deferCandidates(
    candidates: readonly CharacterRecoveryCandidate[],
    results: Map<string, CharacterTransactionRecoveryResult>
  ): void {
    for (const candidate of candidates) {
      const result = deferredResult(candidate.characterId);
      this.results.set(candidate.characterId, result);
      results.set(candidate.characterId, result);
    }
  }

  private assertAllowed(
    errorCode: CharacterTransactionRecoveryResult[
      'draftErrorCode' | 'publishErrorCode'
    ]
  ): void {
    if (errorCode) {
      throw new Error(errorCode);
    }
  }
}

function activeCandidateIndex(
  candidates: readonly CharacterRecoveryCandidate[],
  activeCharacterId: string | null
): number {
  if (activeCharacterId === null) {
    return -1;
  }
  return candidates.findIndex(
    (candidate) => candidate.characterId === activeCharacterId
  );
}

async function recoveryErrorCode<
  ErrorCode extends
    | 'CHARACTER_DRAFT_RECOVERY_BLOCKED'
    | 'CHARACTER_PUBLISH_RECOVERY_BLOCKED'
>(
  recover: () => Promise<void>,
  errorCode: ErrorCode
): Promise<ErrorCode | null> {
  try {
    await recover();
    return null;
  } catch (error) {
    const stableCharacterError = error instanceof Error
      && /^CHARACTER_[A-Z0-9_]+$/u.test(error.message);
    const systemError = typeof error === 'object'
      && error !== null
      && 'code' in error
      && typeof error.code === 'string'
      && /^E[A-Z0-9_]+$/u.test(error.code);
    if (!stableCharacterError && !systemError) {
      throw error;
    }
    return errorCode;
  }
}

function deferredResult(characterId: string): CharacterTransactionRecoveryResult {
  return {
    characterId,
    draftErrorCode: 'CHARACTER_RECOVERY_DEFERRED',
    publishErrorCode: 'CHARACTER_RECOVERY_DEFERRED'
  };
}
