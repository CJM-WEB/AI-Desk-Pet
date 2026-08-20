import { describe, expect, test, vi } from 'vitest';
import {
  prepareCharacterStartup,
  characterRecoveryMessage
} from '../src/main/characters/character-startup';

describe('角色启动恢复', () => {
  test('以固定顺序产出深冻结快照', async () => {
    const order: string[] = [];
    const result = await prepareCharacterStartup({
      indexRecovered: false,
      packageRecoveryReport: { issues: [] }
    }, {
      validateActiveRuntime: async () => {
        order.push('runtime');
        return { activeCharacterId: 'demo' };
      },
      ensureOfficialDefaultCharacter: async () => {
        order.push('default');
        return { activeCharacterId: 'builtin-default' };
      },
      loadFinalIndex: async () => { order.push('final-index'); },
      getTransactionRecoveryReport: () => {
        order.push('b1-report');
        return { characters: [] };
      }
    });

    expect(order).toEqual(['runtime', 'final-index', 'b1-report']);
    expect(result.activeCharacterId).toBe('demo');
    expect(result.recoverySnapshot).toEqual({ fallbackErrorCode: null, issues: [] });
    expect(Object.isFrozen(result.recoverySnapshot)).toBe(true);
    expect(Object.isFrozen(result.recoverySnapshot.issues)).toBe(true);
  });

  test('活动运行版本损坏时回退官方默认且不删除角色或草稿', async () => {
    const ensureDefault = vi.fn(async () => ({ activeCharacterId: 'builtin-default' }));
    const result = await prepareCharacterStartup({
      indexRecovered: false,
      packageRecoveryReport: { issues: [] }
    }, {
      validateActiveRuntime: async () => {
        throw new Error('CHARACTER_RESOURCE_INTEGRITY_FAILED');
      },
      ensureOfficialDefaultCharacter: ensureDefault,
      loadFinalIndex: async () => undefined,
      getTransactionRecoveryReport: () => ({ characters: [] })
    });

    expect(result.recoverySnapshot).toEqual({
      fallbackErrorCode: 'CHARACTER_RESOURCE_INTEGRITY_FAILED',
      issues: []
    });
    expect(ensureDefault).toHaveBeenCalledOnce();
  });

  test('非活动 B1/B2 问题只投影、去重排序并深冻结', async () => {
    const result = await prepareCharacterStartup({
      indexRecovered: false,
      packageRecoveryReport: { issues: [
        { characterId: 'a-pet', errorCode: 'CHARACTER_IMPORT_RECOVERY_BLOCKED' },
        { characterId: 'a-pet', errorCode: 'CHARACTER_IMPORT_RECOVERY_DEFERRED' }
      ] }
    }, {
      validateActiveRuntime: async () => ({ activeCharacterId: 'active-pet' }),
      ensureOfficialDefaultCharacter: vi.fn(),
      loadFinalIndex: async () => undefined,
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
        }
      ] })
    });

    expect(result.recoverySnapshot).toEqual({
      fallbackErrorCode: null,
      issues: [
        { characterId: 'a-pet', errorCode: 'CHARACTER_DRAFT_RECOVERY_BLOCKED' },
        { characterId: 'a-pet', errorCode: 'CHARACTER_PUBLISH_RECOVERY_BLOCKED' },
        { characterId: 'a-pet', errorCode: 'CHARACTER_RECOVERY_DEFERRED' },
        { characterId: 'a-pet', errorCode: 'CHARACTER_IMPORT_RECOVERY_BLOCKED' },
        { characterId: 'a-pet', errorCode: 'CHARACTER_IMPORT_RECOVERY_DEFERRED' }
      ]
    });
    expect(result.recoverySnapshot.issues.every(Object.isFrozen)).toBe(true);
  });

  test('索引已恢复时仍先校验 runtime，再准备默认角色', async () => {
    const order: string[] = [];
    const result = await prepareCharacterStartup({
      indexRecovered: true,
      packageRecoveryReport: { issues: [] }
    }, {
      validateActiveRuntime: async () => {
        order.push('runtime');
        return { activeCharacterId: 'demo' };
      },
      ensureOfficialDefaultCharacter: async () => {
        order.push('default');
        return { activeCharacterId: 'builtin-default' };
      },
      loadFinalIndex: async () => { order.push('final-index'); },
      getTransactionRecoveryReport: () => {
        order.push('b1-report');
        return { characters: [] };
      }
    });

    expect(order).toEqual(['runtime', 'default', 'final-index', 'b1-report']);
    expect(result.recoverySnapshot.fallbackErrorCode).toBe('CHARACTER_INDEX_UNAVAILABLE');
  });

  test('白名单外异常不对 Renderer 回显', async () => {
    const result = await prepareCharacterStartup({
      indexRecovered: false,
      packageRecoveryReport: { issues: [] }
    }, {
      validateActiveRuntime: async () => {
        throw new Error('C:\\private\\character.json');
      },
      ensureOfficialDefaultCharacter: async () => ({ activeCharacterId: 'builtin-default' }),
      loadFinalIndex: async () => undefined,
      getTransactionRecoveryReport: () => ({ characters: [] })
    });

    expect(result.recoverySnapshot.fallbackErrorCode).toBe('CHARACTER_OPERATION_FAILED');
  });

  test('活动角色只有 draft 或 B2 问题时继续运行', async () => {
    const ensureDefault = vi.fn();
    const result = await prepareCharacterStartup({
      indexRecovered: false,
      packageRecoveryReport: { issues: [{
        characterId: 'active-pet',
        errorCode: 'CHARACTER_IMPORT_RECOVERY_DEFERRED'
      }] }
    }, {
      validateActiveRuntime: async () => ({ activeCharacterId: 'active-pet' }),
      ensureOfficialDefaultCharacter: ensureDefault,
      loadFinalIndex: async () => undefined,
      getTransactionRecoveryReport: () => ({ characters: [{
        characterId: 'active-pet',
        draftErrorCode: 'CHARACTER_DRAFT_RECOVERY_BLOCKED',
        publishErrorCode: null
      }] })
    });

    expect(result.recoverySnapshot.fallbackErrorCode).toBeNull();
    expect(ensureDefault).not.toHaveBeenCalled();
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
    const result = await prepareCharacterStartup({
      indexRecovered: false,
      packageRecoveryReport: { issues: [] }
    }, {
      validateActiveRuntime: async () => { throw new Error(errorCode); },
      ensureOfficialDefaultCharacter: async () => ({ activeCharacterId: 'builtin-default' }),
      loadFinalIndex: async () => undefined,
      getTransactionRecoveryReport: () => ({ characters: [] })
    });

    expect(result.recoverySnapshot.fallbackErrorCode).toBe(errorCode);
  });

  test('最后 Store load 瞬时失败时先完成 fallback 再重读一次', async () => {
    const order: string[] = [];
    let loadCount = 0;
    const result = await prepareCharacterStartup({
      indexRecovered: false,
      packageRecoveryReport: { issues: [] }
    }, {
      validateActiveRuntime: async () => {
        order.push('runtime');
        return { activeCharacterId: 'active-pet' };
      },
      ensureOfficialDefaultCharacter: async () => {
        order.push('default');
        return { activeCharacterId: 'builtin-default' };
      },
      loadFinalIndex: async () => {
        order.push('final-index');
        loadCount += 1;
        if (loadCount === 1) throw new Error('C:\\private\\index.json');
      },
      getTransactionRecoveryReport: () => {
        order.push('b1-report');
        return { characters: [] };
      }
    });

    expect(order).toEqual(['runtime', 'final-index', 'default', 'final-index', 'b1-report']);
    expect(result.recoverySnapshot.fallbackErrorCode).toBe('CHARACTER_OPERATION_FAILED');
  });

  test('最后 Store load 持续失败时不发布过期 B1 且不阻断启动', async () => {
    const getReport = vi.fn();
    const result = await prepareCharacterStartup({
      indexRecovered: false,
      packageRecoveryReport: { issues: [{
        characterId: 'other-pet',
        errorCode: 'CHARACTER_IMPORT_RECOVERY_BLOCKED'
      }] }
    }, {
      validateActiveRuntime: async () => ({ activeCharacterId: 'active-pet' }),
      ensureOfficialDefaultCharacter: async () => ({ activeCharacterId: 'builtin-default' }),
      loadFinalIndex: async () => { throw new Error('EIO'); },
      getTransactionRecoveryReport: getReport
    });

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
    const result = await prepareCharacterStartup({
      indexRecovered: true,
      packageRecoveryReport: { issues: [] }
    }, {
      validateActiveRuntime: async () => ({ activeCharacterId: 'active-pet' }),
      ensureOfficialDefaultCharacter: async () => {
        throw new Error('C:\\missing\\default');
      },
      loadFinalIndex: async () => undefined,
      getTransactionRecoveryReport: () => ({ characters: [] })
    });

    expect(result.activeCharacterId).toBe('active-pet');
    expect(result.recoverySnapshot.fallbackErrorCode).toBeNull();
  });

  test('稳定错误码提供中文说明和角色工作室修复入口', () => {
    expect(characterRecoveryMessage('CHARACTER_RESOURCE_INTEGRITY_FAILED'))
      .toEqual({
        text: '当前角色资源校验失败，已切换到官方默认角色。',
        actionLabel: '打开角色工作室'
      });
    expect(characterRecoveryMessage('UNKNOWN'))
      .toEqual({
        text: '当前角色无法加载，已切换到官方默认角色。',
        actionLabel: '打开角色工作室'
      });
  });
});
