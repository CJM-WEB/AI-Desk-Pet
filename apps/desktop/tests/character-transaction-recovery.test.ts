import { describe, expect, test, vi } from 'vitest';
import {
  CharacterTransactionRecovery,
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
});
