import { describe, expect, test } from 'vitest';
import type { CharacterStateRequest, CharacterStateSnapshot } from '../src/state-arbiter';
import { reduceCharacterState } from '../src/state-arbiter';

describe('角色状态仲裁器', () => {
  test('核心任务状态中断扩展状态且任务取消后回到待机', () => {
    const initial: CharacterStateSnapshot = { stateId: 'idle', source: 'system' };
    const dancing = reduceCharacterState(
      initial,
      { type: 'extension', stateId: 'custom:跳舞' }
    );
    const thinking = reduceCharacterState(
      dancing,
      { type: 'task', phase: 'thinking' }
    );
    const completed = reduceCharacterState(
      thinking,
      { type: 'task', phase: 'cancelled' }
    );

    expect(dancing).toEqual({ stateId: 'custom:跳舞', source: 'extension' });
    expect(thinking).toEqual({ stateId: 'thinking', source: 'system' });
    expect(completed).toEqual({ stateId: 'idle', source: 'system' });
  });

  test('任务结束后不恢复此前被中断的扩展状态', () => {
    const interrupted = reduceCharacterState(
      { stateId: 'custom:玩耍', source: 'extension' },
      { type: 'task', phase: 'acting' }
    );

    expect(reduceCharacterState(
      interrupted,
      { type: 'task', phase: 'success' }
    )).toEqual({ stateId: 'success', source: 'system' });
    expect(reduceCharacterState(
      interrupted,
      { type: 'task', phase: 'idle' }
    )).toEqual({ stateId: 'idle', source: 'system' });
  });

  test('移动请求根据是否搬运选择移动或搬运状态', () => {
    const initial: CharacterStateSnapshot = { stateId: 'idle', source: 'system' };

    expect(reduceCharacterState(
      initial,
      { type: 'movement', carrying: false }
    )).toEqual({ stateId: 'moving', source: 'system' });
    expect(reduceCharacterState(
      initial,
      { type: 'movement', carrying: true }
    )).toEqual({ stateId: 'carrying', source: 'system' });
  });

  test('受保护的核心状态拒绝扩展状态覆盖', () => {
    const protectedStateIds = [
      'listening',
      'thinking',
      'moving',
      'acting',
      'carrying',
      'success',
      'error'
    ] as const;

    for (const stateId of protectedStateIds) {
      const snapshot: CharacterStateSnapshot = { stateId, source: 'system' };
      const result = reduceCharacterState(
        snapshot,
        { type: 'extension', stateId: 'custom:休息' }
      );

      expect(result).toBe(snapshot);
    }
  });

  test('扩展状态完成后回到待机且不会中断系统状态', () => {
    expect(reduceCharacterState(
      { stateId: 'custom:休息', source: 'extension' },
      { type: 'extension_complete' }
    )).toEqual({ stateId: 'idle', source: 'system' });

    const thinking: CharacterStateSnapshot = { stateId: 'thinking', source: 'system' };
    expect(reduceCharacterState(
      thinking,
      { type: 'extension_complete' }
    )).toBe(thinking);
  });

  test('重置请求始终清除当前状态并回到系统待机', () => {
    expect(reduceCharacterState(
      { stateId: 'custom:休息', source: 'extension' },
      { type: 'reset' }
    )).toEqual({ stateId: 'idle', source: 'system' });
    expect(reduceCharacterState(
      { stateId: 'error', source: 'system' },
      { type: 'reset' }
    )).toEqual({ stateId: 'idle', source: 'system' });
  });

  test.each([
    null,
    {},
    { type: 'unknown' },
    { type: 'task', phase: 'unknown' },
    { type: 'movement', carrying: 1 },
    { type: 'extension', stateId: 'idle' },
    { type: 'extension', stateId: 'custom:' },
    { type: 'extension', stateId: 'custom: 未规范化 ' }
  ])('拒绝非法状态请求 %#', (request) => {
    expect(() => reduceCharacterState(
      { stateId: 'idle', source: 'system' },
      request as CharacterStateRequest
    )).toThrowError('CHARACTER_STATE_REQUEST_INVALID');
  });

  test('不会修改输入快照或请求对象', () => {
    const snapshot = Object.freeze<CharacterStateSnapshot>({
      stateId: 'idle',
      source: 'system'
    });
    const request = Object.freeze<CharacterStateRequest>({
      type: 'extension',
      stateId: 'custom:阅读'
    });

    const result = reduceCharacterState(snapshot, request);

    expect(result).toEqual({ stateId: 'custom:阅读', source: 'extension' });
    expect(snapshot).toEqual({ stateId: 'idle', source: 'system' });
    expect(request).toEqual({ type: 'extension', stateId: 'custom:阅读' });
  });
});
