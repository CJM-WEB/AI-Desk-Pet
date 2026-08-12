import { describe, expect, test } from 'vitest';
import type { VerifiedWriteAction } from '@myself/file-tools';
import {
  PendingActionStore,
  type PendingExecution
} from '../src/main/agent/pending-action-store';

function publicData(targetRelativePath = 'result.txt') {
  return {
    category: 'file' as const,
    conversationId: 'conversation-1',
    risk: 'write' as const,
    operation: 'create_file' as const,
    summary: `创建 ${targetRelativePath}`,
    targetRelativePath,
    contentCharacters: 0,
    contentPreview: null,
    previewTruncated: false
  };
}

function privateAction(targetRelativePath = 'result.txt'): VerifiedWriteAction {
  return Object.freeze({
    operation: 'create_file' as const,
    authorizationGeneration: 0,
    targetRelativePath,
    contentCharacters: 0,
    contentPreview: null,
    previewTruncated: false
  });
}

function pendingExecution(targetRelativePath = 'result.txt'): PendingExecution {
  return {
    verifiedAction: privateAction(targetRelativePath),
    continuationToken: `continue_${targetRelativePath}`
  };
}

describe('PendingActionStore', () => {
  test.each([
    ['缺少创建摘要字段', ({ contentPreview: _contentPreview, ...draft }: Record<string, unknown>) => draft],
    ['混入其他动作字段', (draft: Record<string, unknown>) => ({ ...draft, targetType: 'file' })],
    ['混入未声明字段', (draft: Record<string, unknown>) => ({ ...draft, privateExecution: '禁止公开' })]
  ])('签发时拒绝%s', (_name, mutate) => {
    const store = new PendingActionStore();
    const invalid = mutate(publicData()) as unknown as Parameters<PendingActionStore['issue']>[0];

    expect(() => store.issue(invalid, pendingExecution())).toThrow();
  });

  test('签发不可猜测且带短期有效期的动作 ID', () => {
    let now = Date.parse('2026-07-20T12:00:00.000Z');
    const store = new PendingActionStore({ now: () => now, ttlMilliseconds: 120_000 });

    const first = store.issue(publicData(), pendingExecution());
    const second = store.issue(publicData('second.txt'), pendingExecution('second.txt'));

    expect(first.actionId).toMatch(/^[A-Za-z0-9_-]{32}$/u);
    expect(second.actionId).toMatch(/^[A-Za-z0-9_-]{32}$/u);
    expect(second.actionId).not.toBe(first.actionId);
    expect(first.createdAt).toBe('2026-07-20T12:00:00.000Z');
    expect(first.expiresAt).toBe('2026-07-20T12:02:00.000Z');
    now += 1;
  });

  test('同时只保留最新的一个待确认动作', () => {
    const store = new PendingActionStore();
    const first = store.issue(publicData('first.txt'), pendingExecution('first.txt'));
    const secondPrivate = pendingExecution('second.txt');
    const second = store.issue(publicData('second.txt'), secondPrivate);

    expect(() => store.consume(first.actionId)).toThrow('ACTION_EXPIRED');
    expect(store.consume(second.actionId)).toBe(secondPrivate);
  });

  test('consume 只能成功一次', () => {
    const store = new PendingActionStore();
    const action = pendingExecution();
    const issued = store.issue(publicData(), action);

    expect(store.consume(issued.actionId)).toBe(action);
    expect(() => store.consume(issued.actionId)).toThrow('ACTION_EXPIRED');
  });

  test('过期动作不可执行', () => {
    let now = 1_000;
    const store = new PendingActionStore({ now: () => now, ttlMilliseconds: 100 });
    const issued = store.issue(publicData(), pendingExecution());
    now = 1_100;

    expect(() => store.consume(issued.actionId)).toThrow('ACTION_EXPIRED');
  });

  test.each(['root_changed', 'provider_changed'] as const)('%s 会清除动作并丢弃继续令牌', reason => {
    const discarded: Array<{ token: string; reason: string }> = [];
    const store = new PendingActionStore({
      onDiscard: (execution, discardReason) => discarded.push({
        token: execution.continuationToken,
        reason: discardReason
      })
    });
    const issued = store.issue(publicData(), pendingExecution());

    store.clear(reason);

    expect(() => store.consume(issued.actionId)).toThrow('ACTION_EXPIRED');
    expect(discarded).toEqual([{ token: 'continue_result.txt', reason }]);
  });

  test('取消动作后不能再确认', () => {
    const store = new PendingActionStore();
    const issued = store.issue(publicData(), pendingExecution());

    store.cancel(issued.actionId);

    expect(() => store.consume(issued.actionId)).toThrow('ACTION_EXPIRED');
  });

  test('篡改返回给 Renderer 的路径不会改变私有执行数据', () => {
    const store = new PendingActionStore();
    const verified = pendingExecution('safe.txt');
    const issued = store.issue(publicData('safe.txt'), verified);

    (issued as { targetRelativePath: string }).targetRelativePath = 'tampered.txt';

    expect(store.consume(issued.actionId)).toBe(verified);
    expect(verified.verifiedAction.targetRelativePath).toBe('safe.txt');
  });

  test('错误 ID 不会清除仍有效的动作', () => {
    const store = new PendingActionStore();
    const verified = pendingExecution();
    const issued = store.issue(publicData(), verified);

    expect(() => store.consume('wrong-id')).toThrow('ACTION_EXPIRED');
    expect(store.consume(issued.actionId)).toBe(verified);
  });

  test('替换、取消和过期动作都会丢弃对应继续令牌', () => {
    let now = 1_000;
    const discarded: Array<{ token: string; reason: string }> = [];
    const store = new PendingActionStore({
      now: () => now,
      ttlMilliseconds: 100,
      onDiscard: (execution, reason) => discarded.push({
        token: execution.continuationToken,
        reason
      })
    });
    store.issue(publicData('first.txt'), pendingExecution('first.txt'));
    const second = store.issue(publicData('second.txt'), pendingExecution('second.txt'));
    store.cancel(second.actionId);
    const third = store.issue(publicData('third.txt'), pendingExecution('third.txt'));
    now = 1_100;

    expect(() => store.consume(third.actionId)).toThrow('ACTION_EXPIRED');
    expect(discarded).toEqual([
      { token: 'continue_first.txt', reason: 'new_task' },
      { token: 'continue_second.txt', reason: 'action_cancelled' },
      { token: 'continue_third.txt', reason: 'expired' }
    ]);
  });
});
