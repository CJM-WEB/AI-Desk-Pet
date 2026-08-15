import { describe, expect, test, vi } from 'vitest';
import {
  CharacterTransactionRecovery,
  MAX_RECOVERY_CHARACTERS,
  RECOVERY_SOFT_BUDGET_MS,
  type CharacterRecoveryCandidate
} from '../src/main/characters/character-transaction-recovery';

function candidate(
  characterId: string,
  recoverDraft: () => Promise<void> = async () => undefined,
  recoverPublish: () => Promise<void> = async () => undefined
): CharacterRecoveryCandidate {
  return { characterId, recoverDraft, recoverPublish };
}

function createRecovery(): CharacterTransactionRecovery {
  return new CharacterTransactionRecovery({
    activeCharacterId: () => null,
    now: () => 1_000
  });
}

describe('CharacterTransactionRecovery', () => {
  test('隔离每个角色的 draft 与 publish 恢复失败，仍继续其余分面和角色', async () => {
    const firstDraft = vi.fn(async () => {
      throw new Error('C:\\private\\draft-marker.json');
    });
    const firstPublish = vi.fn(async () => undefined);
    const secondDraft = vi.fn(async () => undefined);
    const secondPublish = vi.fn(async () => {
      throw new Error('C:\\private\\publish-marker.json');
    });
    const thirdDraft = vi.fn(async () => undefined);
    const thirdPublish = vi.fn(async () => undefined);

    const report = await createRecovery().recoverAll([
      candidate('first', firstDraft, firstPublish),
      candidate('second', secondDraft, secondPublish),
      candidate('third', thirdDraft, thirdPublish)
    ]);

    expect(firstDraft).toHaveBeenCalledTimes(1);
    expect(firstPublish).toHaveBeenCalledTimes(1);
    expect(secondDraft).toHaveBeenCalledTimes(1);
    expect(secondPublish).toHaveBeenCalledTimes(1);
    expect(thirdDraft).toHaveBeenCalledTimes(1);
    expect(thirdPublish).toHaveBeenCalledTimes(1);
    expect(report).toEqual({
      characters: [
        {
          characterId: 'first',
          kind: 'draft-recovery-blocked',
          draftErrorCode: 'CHARACTER_DRAFT_RECOVERY_BLOCKED',
          publishErrorCode: null,
          deferred: false
        },
        {
          characterId: 'second',
          kind: 'publish-recovery-blocked',
          draftErrorCode: null,
          publishErrorCode: 'CHARACTER_PUBLISH_RECOVERY_BLOCKED',
          deferred: false
        },
        {
          characterId: 'third',
          kind: 'healthy',
          draftErrorCode: null,
          publishErrorCode: null,
          deferred: false
        }
      ],
      budgetExceeded: false
    });
    expect(JSON.stringify(report)).not.toContain('private');
  });

  test('双分面失败仍执行两个恢复 closure，并保存分面的稳定码', async () => {
    const recoverDraft = vi.fn(async () => {
      throw new Error('draft failure');
    });
    const recoverPublish = vi.fn(async () => {
      throw new Error('publish failure');
    });

    const report = await createRecovery().recoverAll([
      candidate('both-failed', recoverDraft, recoverPublish)
    ]);

    expect(recoverDraft).toHaveBeenCalledTimes(1);
    expect(recoverPublish).toHaveBeenCalledTimes(1);
    expect(report.characters).toEqual([{
      characterId: 'both-failed',
      kind: 'draft-and-publish-recovery-blocked',
      draftErrorCode: 'CHARACTER_DRAFT_RECOVERY_BLOCKED',
      publishErrorCode: 'CHARACTER_PUBLISH_RECOVERY_BLOCKED',
      deferred: false
    }]);
  });

  test('按恢复结果 fail-closed 地裁决 draft-save、publish 与 runtime 能力', async () => {
    const recovery = createRecovery();
    await recovery.recoverAll([
      candidate('draft-blocked', async () => {
        throw new Error('draft failure');
      }),
      candidate('publish-blocked', async () => undefined, async () => {
        throw new Error('publish failure');
      }),
      candidate('both-blocked', async () => {
        throw new Error('draft failure');
      }, async () => {
        throw new Error('publish failure');
      }),
      candidate('healthy')
    ]);

    expect(() => recovery.assertDraftSaveAllowed('draft-blocked'))
      .toThrow('CHARACTER_DRAFT_RECOVERY_BLOCKED');
    expect(() => recovery.assertPublishAllowed('draft-blocked'))
      .toThrow('CHARACTER_DRAFT_RECOVERY_BLOCKED');
    expect(() => recovery.assertRuntimeAllowed('draft-blocked')).not.toThrow();

    expect(() => recovery.assertDraftSaveAllowed('publish-blocked')).not.toThrow();
    expect(() => recovery.assertPublishAllowed('publish-blocked'))
      .toThrow('CHARACTER_PUBLISH_RECOVERY_BLOCKED');
    expect(() => recovery.assertRuntimeAllowed('publish-blocked'))
      .toThrow('CHARACTER_PUBLISH_RECOVERY_BLOCKED');

    expect(() => recovery.assertDraftSaveAllowed('both-blocked'))
      .toThrow('CHARACTER_DRAFT_RECOVERY_BLOCKED');
    expect(() => recovery.assertPublishAllowed('both-blocked'))
      .toThrow('CHARACTER_DRAFT_RECOVERY_BLOCKED');
    expect(() => recovery.assertRuntimeAllowed('both-blocked'))
      .toThrow('CHARACTER_PUBLISH_RECOVERY_BLOCKED');

    expect(() => recovery.assertDraftSaveAllowed('healthy')).not.toThrow();
    expect(() => recovery.assertPublishAllowed('healthy')).not.toThrow();
    expect(() => recovery.assertRuntimeAllowed('healthy')).not.toThrow();
  });

  test('尚未恢复或未知角色的结果与能力门均 fail closed', () => {
    const recovery = createRecovery();

    expect(recovery.resultFor('unknown')).toEqual({
      characterId: 'unknown',
      kind: 'draft-and-publish-recovery-blocked',
      draftErrorCode: 'CHARACTER_RECOVERY_DEFERRED',
      publishErrorCode: 'CHARACTER_RECOVERY_DEFERRED',
      deferred: true
    });
    expect(() => recovery.assertDraftSaveAllowed('unknown'))
      .toThrow('CHARACTER_RECOVERY_DEFERRED');
    expect(() => recovery.assertPublishAllowed('unknown'))
      .toThrow('CHARACTER_RECOVERY_DEFERRED');
    expect(() => recovery.assertRuntimeAllowed('unknown'))
      .toThrow('CHARACTER_RECOVERY_DEFERRED');
  });

  test('活动角色优先恢复，但报告保持输入顺序且不修改候选数组或对象', async () => {
    const calls: string[] = [];
    const otherA = Object.freeze(candidate(
      'other-a',
      async () => { calls.push('other-a:draft'); },
      async () => { calls.push('other-a:publish'); }
    ));
    const active = Object.freeze(candidate(
      'active',
      async () => { calls.push('active:draft'); },
      async () => { calls.push('active:publish'); }
    ));
    const otherB = Object.freeze(candidate(
      'other-b',
      async () => { calls.push('other-b:draft'); },
      async () => { calls.push('other-b:publish'); }
    ));
    const candidates = Object.freeze([otherA, active, otherB]);
    const originalCandidates = [...candidates];
    const recovery = new CharacterTransactionRecovery({
      activeCharacterId: () => 'active',
      now: () => 0
    });

    const report = await recovery.recoverAll(candidates);

    expect(calls).toEqual([
      'active:draft',
      'active:publish',
      'other-a:draft',
      'other-a:publish',
      'other-b:draft',
      'other-b:publish'
    ]);
    expect(candidates).toEqual(originalCandidates);
    expect(report.characters.map(({ characterId }) => characterId))
      .toEqual(['other-a', 'active', 'other-b']);
  });

  test('超过角色上限时仅完整恢复前 256 个角色，并将剩余角色标为 deferred', async () => {
    const draftIds: string[] = [];
    const publishIds: string[] = [];
    const candidates = Array.from(
      { length: MAX_RECOVERY_CHARACTERS + 1 },
      (_, index) => {
        const characterId = `character-${index}`;
        return candidate(
          characterId,
          async () => { draftIds.push(characterId); },
          async () => { publishIds.push(characterId); }
        );
      }
    );
    const recovery = new CharacterTransactionRecovery({
      activeCharacterId: () => null,
      now: () => 0
    });

    const report = await recovery.recoverAll(candidates);

    expect(MAX_RECOVERY_CHARACTERS).toBe(256);
    expect(draftIds).toEqual(Array.from(
      { length: MAX_RECOVERY_CHARACTERS },
      (_, index) => `character-${index}`
    ));
    expect(publishIds).toEqual(Array.from(
      { length: MAX_RECOVERY_CHARACTERS },
      (_, index) => `character-${index}`
    ));
    expect(report.budgetExceeded).toBe(true);
    expect(report.characters).toHaveLength(257);
    expect(report.characters.at(-1)).toEqual({
      characterId: 'character-256',
      kind: 'draft-and-publish-recovery-blocked',
      draftErrorCode: 'CHARACTER_RECOVERY_DEFERRED',
      publishErrorCode: 'CHARACTER_RECOVERY_DEFERRED',
      deferred: true
    });
  });

  test('软预算仅在完成第一个角色后阻止下一个角色开始', async () => {
    const firstDraft = vi.fn(async () => undefined);
    const firstPublish = vi.fn(async () => undefined);
    const secondDraft = vi.fn(async () => undefined);
    const secondPublish = vi.fn(async () => undefined);
    const now = vi.fn()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(RECOVERY_SOFT_BUDGET_MS);
    const recovery = new CharacterTransactionRecovery({
      activeCharacterId: () => null,
      now
    });

    const report = await recovery.recoverAll([
      candidate('first', firstDraft, firstPublish),
      candidate('second', secondDraft, secondPublish)
    ]);

    expect(RECOVERY_SOFT_BUDGET_MS).toBe(2_000);
    expect(firstDraft).toHaveBeenCalledTimes(1);
    expect(firstPublish).toHaveBeenCalledTimes(1);
    expect(secondDraft).not.toHaveBeenCalled();
    expect(secondPublish).not.toHaveBeenCalled();
    expect(now).toHaveBeenCalledTimes(2);
    expect(report).toEqual({
      characters: [
        {
          characterId: 'first',
          kind: 'healthy',
          draftErrorCode: null,
          publishErrorCode: null,
          deferred: false
        },
        {
          characterId: 'second',
          kind: 'draft-and-publish-recovery-blocked',
          draftErrorCode: 'CHARACTER_RECOVERY_DEFERRED',
          publishErrorCode: 'CHARACTER_RECOVERY_DEFERRED',
          deferred: true
        }
      ],
      budgetExceeded: true
    });
  });

  test('恰好 256 个候选时完整恢复所有角色且不超过预算', async () => {
    const draftIds: string[] = [];
    const publishIds: string[] = [];
    const candidates = Array.from(
      { length: MAX_RECOVERY_CHARACTERS },
      (_, index) => {
        const characterId = `character-${index}`;
        return candidate(
          characterId,
          async () => { draftIds.push(characterId); },
          async () => { publishIds.push(characterId); }
        );
      }
    );
    const recovery = new CharacterTransactionRecovery({
      activeCharacterId: () => null,
      now: () => 0
    });

    const report = await recovery.recoverAll(candidates);

    expect(draftIds).toEqual(candidates.map(({ characterId }) => characterId));
    expect(publishIds).toEqual(candidates.map(({ characterId }) => characterId));
    expect(report.budgetExceeded).toBe(false);
    expect(report.characters.every(({ deferred }) => !deferred)).toBe(true);
  });

  test('第 257 位活动角色优先进入恢复上限，报告仍为原输入顺序', async () => {
    const calls: string[] = [];
    const others = Array.from(
      { length: MAX_RECOVERY_CHARACTERS },
      (_, index) => {
        const characterId = `other-${index}`;
        return candidate(
          characterId,
          async () => { calls.push(`${characterId}:draft`); },
          async () => { calls.push(`${characterId}:publish`); }
        );
      }
    );
    const candidates = [
      ...others,
      candidate(
        'active',
        async () => { calls.push('active:draft'); },
        async () => { calls.push('active:publish'); }
      )
    ];
    const recovery = new CharacterTransactionRecovery({
      activeCharacterId: () => 'active',
      now: () => 0
    });

    const report = await recovery.recoverAll(candidates);

    expect(calls).toEqual([
      'active:draft',
      'active:publish',
      ...Array.from(
        { length: MAX_RECOVERY_CHARACTERS - 1 },
        (_, index) => [`other-${index}:draft`, `other-${index}:publish`]
      ).flat()
    ]);
    expect(report.characters.map(({ characterId }) => characterId))
      .toEqual(candidates.map(({ characterId }) => characterId));
    expect(report.characters.filter(({ deferred }) => deferred)).toEqual([{
      characterId: 'other-255',
      kind: 'draft-and-publish-recovery-blocked',
      draftErrorCode: 'CHARACTER_RECOVERY_DEFERRED',
      publishErrorCode: 'CHARACTER_RECOVERY_DEFERRED',
      deferred: true
    }]);
  });

  test('空候选、空活动角色和未命中活动角色保持输入顺序与未超预算状态', async () => {
    const calls: string[] = [];
    const candidates = [
      candidate('first', async () => { calls.push('first'); }),
      candidate('second', async () => { calls.push('second'); })
    ];
    const missingActive = new CharacterTransactionRecovery({
      activeCharacterId: () => 'missing',
      now: () => 0
    });
    const noActive = new CharacterTransactionRecovery({
      activeCharacterId: () => null,
      now: () => 0
    });

    const missingActiveReport = await missingActive.recoverAll(candidates);
    const noActiveReport = await noActive.recoverAll(candidates);
    const emptyReport = await noActive.recoverAll([]);

    expect(calls).toEqual(['first', 'second', 'first', 'second']);
    expect(missingActiveReport.characters.map(({ characterId }) => characterId))
      .toEqual(['first', 'second']);
    expect(noActiveReport.characters.map(({ characterId }) => characterId))
      .toEqual(['first', 'second']);
    expect(missingActiveReport.budgetExceeded).toBe(false);
    expect(noActiveReport.budgetExceeded).toBe(false);
    expect(emptyReport).toEqual({ characters: [], budgetExceeded: false });
  });
});
