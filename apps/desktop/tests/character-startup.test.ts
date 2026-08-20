import { describe, expect, test, vi } from 'vitest';
import {
  prepareCharacterStartup,
  type CharacterStartupDependencies
} from '../src/main/characters/character-startup';

type StartupInput = Parameters<typeof prepareCharacterStartup>[0];

function startupInput(
  issues: StartupInput['packageRecoveryReport']['issues'] = [],
  indexRecovered = false
): StartupInput {
  return { indexRecovered, packageRecoveryReport: { issues } };
}

const EMPTY_INPUT = startupInput();

function recordingDependencies(
  order: string[],
  overrides: Partial<CharacterStartupDependencies> = {}
): CharacterStartupDependencies {
  return {
    validateActiveRuntime: async () => {
      order.push('runtime');
      return { activeCharacterId: 'active-pet' };
    },
    ensureOfficialDefaultCharacter: async () => {
      order.push('default');
      return { activeCharacterId: 'builtin-default' };
    },
    loadFinalIndex: async () => { order.push('final-index'); },
    getTransactionRecoveryReport: () => {
      order.push('b1-report');
      return { characters: [] };
    },
    ...overrides
  };
}

function start(
  overrides: Partial<CharacterStartupDependencies> = {},
  startupInputValue: StartupInput = EMPTY_INPUT
) {
  return prepareCharacterStartup(
    startupInputValue,
    recordingDependencies([], overrides)
  );
}

describe('角色启动恢复', () => {
  test('以固定顺序产出深冻结快照', async () => {
    const order: string[] = [];
    const result = await prepareCharacterStartup(EMPTY_INPUT, recordingDependencies(order, {
      validateActiveRuntime: async () => {
        order.push('runtime');
        return { activeCharacterId: 'demo' };
      }
    }));

    expect(order).toEqual(['runtime', 'final-index', 'b1-report']);
    expect(result.activeCharacterId).toBe('demo');
    expect(result.recoverySnapshot).toEqual({ fallbackErrorCode: null, issues: [] });
    expect(Object.isFrozen(result.recoverySnapshot)).toBe(true);
    expect(Object.isFrozen(result.recoverySnapshot.issues)).toBe(true);
  });

  test('B1/B2 问题只投影、去重排序并深冻结，活动角色仍继续运行', async () => {
    const ensureDefault = vi.fn();
    const result = await start({
      ensureOfficialDefaultCharacter: ensureDefault,
      getTransactionRecoveryReport: () => ({ characters: [
        {
          characterId: 'a-pet',
          draftErrorCode: 'CHARACTER_DRAFT_RECOVERY_BLOCKED',
          publishErrorCode: 'CHARACTER_PUBLISH_RECOVERY_BLOCKED'
        },
        {
          characterId: 'a-pet',
          draftErrorCode: 'CHARACTER_RECOVERY_DEFERRED',
          publishErrorCode: 'CHARACTER_RECOVERY_DEFERRED'
        },
        {
          characterId: 'active-pet',
          draftErrorCode: 'CHARACTER_DRAFT_RECOVERY_BLOCKED',
          publishErrorCode: null
        }
      ] })
    }, startupInput([
      { characterId: 'a-pet', errorCode: 'CHARACTER_IMPORT_RECOVERY_BLOCKED' },
      { characterId: 'a-pet', errorCode: 'CHARACTER_IMPORT_RECOVERY_DEFERRED' },
      { characterId: 'b-pet', errorCode: 'CHARACTER_IMPORT_RECOVERY_BLOCKED' },
      { characterId: 'active-pet', errorCode: 'CHARACTER_IMPORT_RECOVERY_DEFERRED' }
    ]));

    expect(result.recoverySnapshot).toEqual({
      fallbackErrorCode: null,
      issues: [
        { characterId: 'a-pet', errorCode: 'CHARACTER_DRAFT_RECOVERY_BLOCKED' },
        { characterId: 'a-pet', errorCode: 'CHARACTER_PUBLISH_RECOVERY_BLOCKED' },
        { characterId: 'a-pet', errorCode: 'CHARACTER_RECOVERY_DEFERRED' },
        { characterId: 'a-pet', errorCode: 'CHARACTER_IMPORT_RECOVERY_BLOCKED' },
        { characterId: 'a-pet', errorCode: 'CHARACTER_IMPORT_RECOVERY_DEFERRED' },
        { characterId: 'active-pet', errorCode: 'CHARACTER_DRAFT_RECOVERY_BLOCKED' },
        { characterId: 'active-pet', errorCode: 'CHARACTER_IMPORT_RECOVERY_DEFERRED' },
        { characterId: 'b-pet', errorCode: 'CHARACTER_IMPORT_RECOVERY_BLOCKED' }
      ]
    });
    expect(result.recoverySnapshot.issues.every(Object.isFrozen)).toBe(true);
    expect(ensureDefault).not.toHaveBeenCalled();
  });

  test('索引已恢复时仍先校验 runtime，再准备默认角色', async () => {
    const order: string[] = [];
    const result = await prepareCharacterStartup(startupInput([], true), recordingDependencies(order, {
      validateActiveRuntime: async () => {
        order.push('runtime');
        return { activeCharacterId: 'demo' };
      }
    }));

    expect(order).toEqual(['runtime', 'default', 'final-index', 'b1-report']);
    expect(result.recoverySnapshot.fallbackErrorCode).toBe('CHARACTER_INDEX_UNAVAILABLE');
  });

  test('白名单外异常不对 Renderer 回显', async () => {
    const result = await start({
      validateActiveRuntime: async () => {
        throw new Error('C:\\private\\character.json');
      }
    });

    expect(result.recoverySnapshot.fallbackErrorCode).toBe('CHARACTER_OPERATION_FAILED');
  });

  test.each([
    'CHARACTER_PUBLISH_RECOVERY_BLOCKED',
    'CHARACTER_RECOVERY_DEFERRED',
    'CHARACTER_MANIFEST_INVALID',
    'CHARACTER_MIGRATION_FAILED',
    'CHARACTER_RESOURCE_INTEGRITY_FAILED',
    'CHARACTER_RESOURCE_NOT_FOUND',
    'CHARACTER_RUNTIME_UNAVAILABLE',
    'CHARACTER_VERSION_UNSUPPORTED'
  ] as const)('活动 runtime 错误 %s 触发对应 fallback', async errorCode => {
    const ensureDefault = vi.fn(async () => ({ activeCharacterId: 'builtin-default' }));
    const result = await start({
      validateActiveRuntime: async () => { throw new Error(errorCode); },
      ensureOfficialDefaultCharacter: ensureDefault
    });

    expect(result.recoverySnapshot.fallbackErrorCode).toBe(errorCode);
    expect(result.activeCharacterId).toBe('builtin-default');
    expect(ensureDefault).toHaveBeenCalledOnce();
  });

  test('最后 Store load 瞬时失败时先完成 fallback 再重读一次', async () => {
    const order: string[] = [];
    let loadCount = 0;
    const result = await prepareCharacterStartup(EMPTY_INPUT, recordingDependencies(order, {
      loadFinalIndex: async () => {
        order.push('final-index');
        loadCount += 1;
        if (loadCount === 1) throw new Error('C:\\private\\index.json');
      }
    }));

    expect(order).toEqual(['runtime', 'final-index', 'default', 'final-index', 'b1-report']);
    expect(result.recoverySnapshot.fallbackErrorCode).toBe('CHARACTER_OPERATION_FAILED');
  });

  test('最后 Store load 持续失败时不发布过期 B1 且不阻断启动', async () => {
    const getReport = vi.fn();
    const result = await start({
      loadFinalIndex: async () => { throw new Error('EIO'); },
      getTransactionRecoveryReport: getReport
    }, startupInput([{
      characterId: 'other-pet',
      errorCode: 'CHARACTER_IMPORT_RECOVERY_BLOCKED'
    }]));

    expect(result).toMatchObject({
      activeCharacterId: 'builtin-default',
      recoverySnapshot: {
        fallbackErrorCode: 'CHARACTER_OPERATION_FAILED',
        issues: [{
          characterId: 'other-pet',
          errorCode: 'CHARACTER_IMPORT_RECOVERY_BLOCKED'
        }]
      }
    });
    expect(getReport).not.toHaveBeenCalled();
  });

  test('默认角色准备失败时不虚假声明 fallback 且不阻断启动', async () => {
    const result = await start({
      ensureOfficialDefaultCharacter: async () => {
        throw new Error('C:\\missing\\default');
      }
    }, startupInput([], true));

    expect(result.activeCharacterId).toBe('active-pet');
    expect(result.recoverySnapshot.fallbackErrorCode).toBeNull();
  });

});
