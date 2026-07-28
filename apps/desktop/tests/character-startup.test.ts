import { describe, expect, test, vi } from 'vitest';
import {
  prepareCharacterStartup,
  characterRecoveryMessage
} from '../src/main/characters/character-startup';

describe('角色启动恢复', () => {
  test('先加载索引并校验活动运行版本，再允许 Renderer 加载', async () => {
    const order: string[] = [];
    const result = await prepareCharacterStartup({
      loadIndex: async () => {
        order.push('index');
      },
      validateActiveRuntime: async () => {
        order.push('runtime');
        return { activeCharacterId: 'demo' };
      }
    });

    expect(order).toEqual(['index', 'runtime']);
    expect(result).toEqual({
      kind: 'active',
      activeCharacterId: 'demo'
    });
  });

  test('活动运行版本损坏时回退官方默认且不删除角色或草稿', async () => {
    const remove = vi.fn();
    const result = await prepareCharacterStartup({
      loadIndex: async () => undefined,
      validateActiveRuntime: async () => {
        throw new Error('CHARACTER_RESOURCE_INTEGRITY_FAILED');
      },
      remove
    });

    expect(result).toEqual({
      kind: 'fallback',
      errorCode: 'CHARACTER_RESOURCE_INTEGRITY_FAILED'
    });
    expect(remove).not.toHaveBeenCalled();
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
