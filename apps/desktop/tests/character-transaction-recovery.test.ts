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
  test('分面矩阵隔离失败、双分面和后续角色继续执行且能力门 fail closed', async () => {
    const draftBlockedDraft = vi.fn(async () => {
      throw new Error('CHARACTER_TRANSACTION_INVALID');
    });
    const draftBlockedPublish = vi.fn(async () => undefined);
    const publishBlockedDraft = vi.fn(async () => undefined);
    const publishBlockedPublish = vi.fn(async () => {
      throw Object.assign(new Error('拒绝访问'), { code: 'EACCES' });
    });
    const bothBlockedDraft = vi.fn(async () => {
      throw new Error('CHARACTER_PATH_UNSAFE');
    });
    const bothBlockedPublish = vi.fn(async () => {
      throw Object.assign(new Error('系统错误'), { code: 'EPERM' });
    });
    const healthyDraft = vi.fn(async () => undefined);
    const healthyPublish = vi.fn(async () => undefined);
    const recovery = createRecovery();

    const report = await recovery.recoverAll([
      candidate('draft-blocked', draftBlockedDraft, draftBlockedPublish),
      candidate('publish-blocked', publishBlockedDraft, publishBlockedPublish),
      candidate('both-blocked', bothBlockedDraft, bothBlockedPublish),
      candidate('healthy', healthyDraft, healthyPublish)
    ]);

    for (const recover of [
      draftBlockedDraft,
      draftBlockedPublish,
      publishBlockedDraft,
      publishBlockedPublish,
      bothBlockedDraft,
      bothBlockedPublish,
      healthyDraft,
      healthyPublish
    ]) {
      expect(recover).toHaveBeenCalledTimes(1);
    }
    expect(report).toEqual({
      characters: [{
        characterId: 'draft-blocked',
        draftErrorCode: 'CHARACTER_DRAFT_RECOVERY_BLOCKED',
        publishErrorCode: null
      }, {
        characterId: 'publish-blocked',
        draftErrorCode: null,
        publishErrorCode: 'CHARACTER_PUBLISH_RECOVERY_BLOCKED'
      }, {
        characterId: 'both-blocked',
        draftErrorCode: 'CHARACTER_DRAFT_RECOVERY_BLOCKED',
        publishErrorCode: 'CHARACTER_PUBLISH_RECOVERY_BLOCKED'
      }, {
        characterId: 'healthy',
        draftErrorCode: null,
        publishErrorCode: null
      }]
    });
    expect(JSON.stringify(report)).not.toContain('拒绝访问');

    const capabilityMatrix = [{
      characterId: 'draft-blocked',
      draftSave: 'CHARACTER_DRAFT_RECOVERY_BLOCKED',
      publish: 'CHARACTER_DRAFT_RECOVERY_BLOCKED',
      runtime: null
    }, {
      characterId: 'publish-blocked',
      draftSave: null,
      publish: 'CHARACTER_PUBLISH_RECOVERY_BLOCKED',
      runtime: 'CHARACTER_PUBLISH_RECOVERY_BLOCKED'
    }, {
      characterId: 'both-blocked',
      draftSave: 'CHARACTER_DRAFT_RECOVERY_BLOCKED',
      publish: 'CHARACTER_DRAFT_RECOVERY_BLOCKED',
      runtime: 'CHARACTER_PUBLISH_RECOVERY_BLOCKED'
    }, {
      characterId: 'healthy',
      draftSave: null,
      publish: null,
      runtime: null
    }] as const;

    for (const expected of capabilityMatrix) {
      const gates = [{
        invoke: () => recovery.assertDraftSaveAllowed(expected.characterId),
        errorCode: expected.draftSave
      }, {
        invoke: () => recovery.assertPublishAllowed(expected.characterId),
        errorCode: expected.publish
      }, {
        invoke: () => recovery.assertRuntimeAllowed(expected.characterId),
        errorCode: expected.runtime
      }];
      for (const gate of gates) {
        if (gate.errorCode === null) {
          expect(gate.invoke).not.toThrow();
        } else {
          expect(gate.invoke).toThrow(gate.errorCode);
        }
      }
    }
  });

  test.each([
    new TypeError('恢复程序错误'),
    new Error('未分类普通错误'),
    { message: '非错误对象' }
  ])('未分类恢复异常必须原样重新抛出并停止本轮：%s', async (failure) => {
    const laterDraft = vi.fn(async () => undefined);
    const recovery = createRecovery();

    const caught = await recovery.recoverAll([
      candidate('broken-program', async () => { throw failure; }),
      candidate('later', laterDraft)
    ]).catch(error => error);

    expect(caught).toBe(failure);
    expect(laterDraft).not.toHaveBeenCalled();
  });

  test('第 257 位活动角色优先进入前 256 且报告保持输入顺序和输入不变', async () => {
    const calls: string[] = [];
    const others = Array.from({ length: 256 }, (_, index) => {
      const characterId = `other-${index}`;
      return Object.freeze(candidate(
        characterId,
        async () => { calls.push(`${characterId}:draft`); },
        async () => { calls.push(`${characterId}:publish`); }
      ));
    });
    const active = Object.freeze(candidate(
      'active',
      async () => { calls.push('active:draft'); },
      async () => { calls.push('active:publish'); }
    ));
    const candidates = Object.freeze([...others, active]);
    const originalCandidates = [...candidates];
    const recovery = new CharacterTransactionRecovery({
      activeCharacterId: () => 'active',
      now: () => 0
    });

    const report = await recovery.recoverAll(candidates);

    expect(calls).toEqual([
      'active:draft',
      'active:publish',
      ...Array.from(
        { length: 255 },
        (_, index) => [`other-${index}:draft`, `other-${index}:publish`]
      ).flat()
    ]);
    expect(candidates).toEqual(originalCandidates);
    expect(report.characters.map(({ characterId }) => characterId))
      .toEqual(candidates.map(({ characterId }) => characterId));
    expect(report.characters[255]).toEqual({
      characterId: 'other-255',
      draftErrorCode: 'CHARACTER_RECOVERY_DEFERRED',
      publishErrorCode: 'CHARACTER_RECOVERY_DEFERRED'
    });
    expect(report.characters[256]).toEqual({
      characterId: 'active',
      draftErrorCode: null,
      publishErrorCode: null
    });
  });

  test('2000ms 等号边界只在完整恢复首个角色后延后下一角色', async () => {
    const firstDraft = vi.fn(async () => undefined);
    const firstPublish = vi.fn(async () => undefined);
    const secondDraft = vi.fn(async () => undefined);
    const secondPublish = vi.fn(async () => undefined);
    const now = vi.fn()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(2_000);
    const recovery = new CharacterTransactionRecovery({
      activeCharacterId: () => null,
      now
    });

    const report = await recovery.recoverAll([
      candidate('first', firstDraft, firstPublish),
      candidate('second', secondDraft, secondPublish)
    ]);

    expect(firstDraft).toHaveBeenCalledTimes(1);
    expect(firstPublish).toHaveBeenCalledTimes(1);
    expect(secondDraft).not.toHaveBeenCalled();
    expect(secondPublish).not.toHaveBeenCalled();
    expect(now).toHaveBeenCalledTimes(2);
    expect(report).toEqual({
      characters: [{
        characterId: 'first',
        draftErrorCode: null,
        publishErrorCode: null
      }, {
        characterId: 'second',
        draftErrorCode: 'CHARACTER_RECOVERY_DEFERRED',
        publishErrorCode: 'CHARACTER_RECOVERY_DEFERRED'
      }]
    });
  });

  test('连续轮次与空轮次立即清除旧结果并对未知角色 fail closed', async () => {
    const recovery = createRecovery();

    expect(recovery.resultFor('unknown')).toEqual({
      characterId: 'unknown',
      draftErrorCode: 'CHARACTER_RECOVERY_DEFERRED',
      publishErrorCode: 'CHARACTER_RECOVERY_DEFERRED'
    });
    await recovery.recoverAll([candidate('A')]);
    await recovery.recoverAll([candidate('B', async () => {
      throw new Error('CHARACTER_TRANSACTION_INVALID');
    }, async () => {
      throw Object.assign(new Error('系统错误'), { code: 'EACCES' });
    })]);

    expect(recovery.resultFor('A')).toEqual({
      characterId: 'A',
      draftErrorCode: 'CHARACTER_RECOVERY_DEFERRED',
      publishErrorCode: 'CHARACTER_RECOVERY_DEFERRED'
    });
    expect(() => recovery.assertDraftSaveAllowed('A'))
      .toThrow('CHARACTER_RECOVERY_DEFERRED');
    expect(() => recovery.assertPublishAllowed('A'))
      .toThrow('CHARACTER_RECOVERY_DEFERRED');
    expect(() => recovery.assertRuntimeAllowed('A'))
      .toThrow('CHARACTER_RECOVERY_DEFERRED');
    expect(recovery.resultFor('B')).toEqual({
      characterId: 'B',
      draftErrorCode: 'CHARACTER_DRAFT_RECOVERY_BLOCKED',
      publishErrorCode: 'CHARACTER_PUBLISH_RECOVERY_BLOCKED'
    });

    await expect(recovery.recoverAll([])).resolves.toEqual({ characters: [] });
    expect(recovery.resultFor('B')).toEqual({
      characterId: 'B',
      draftErrorCode: 'CHARACTER_RECOVERY_DEFERRED',
      publishErrorCode: 'CHARACTER_RECOVERY_DEFERRED'
    });
  });
});
