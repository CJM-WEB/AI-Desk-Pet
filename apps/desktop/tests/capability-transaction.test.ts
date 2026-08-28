import { describe, expect, test } from 'vitest';
import { CapabilityTransactionStore } from
  '../src/main/conversation/capability-transaction';

const identity = Object.freeze({
  id: 'transaction-1',
  generation: 'generation-1',
  kind: 'file' as const,
  providerId: 'provider-1',
  authorizationRootId: 'root-1'
});

describe('CapabilityTransactionStore', () => {
  test('只有成功工具结果建立可信引用并允许进入完成终态', () => {
    const store = new CapabilityTransactionStore();
    store.begin(identity);

    store.apply({ type: 'message', role: 'assistant', text: '已经移动完成。' });
    store.apply({ type: 'phase', phase: 'success' });
    expect(store.snapshot()).toMatchObject({
      phase: 'planning',
      references: []
    });

    store.apply({
      toolName: 'builtin.files.move_file',
      ok: true,
      relativePaths: ['order.txt', 'a/order.txt']
    });
    store.apply({ type: 'phase', phase: 'success' });

    expect(store.snapshot()).toMatchObject({
      phase: 'completed',
      references: [
        { role: 'moved_source', relativePath: 'order.txt' },
        { role: 'moved_target', relativePath: 'a/order.txt' }
      ],
      toolTranscript: [{
        toolName: 'builtin.files.move_file',
        ok: true,
        resultCode: 'OK'
      }]
    });
  });

  test('失败工具结果不建立引用且真实失败不能被 assistant 文本改写', () => {
    const store = new CapabilityTransactionStore();
    store.begin(identity);

    store.apply({
      toolName: 'builtin.files.create_file',
      ok: false,
      relativePaths: ['test.txt']
    });
    store.apply({ type: 'message', role: 'assistant', text: '已经创建成功。' });
    store.apply({ type: 'phase', phase: 'success' });

    expect(store.snapshot()).toMatchObject({
      phase: 'failed',
      references: [],
      toolTranscript: [{
        toolName: 'builtin.files.create_file',
        ok: false,
        resultCode: 'FAILED'
      }]
    });
  });

  test('失败工具结果经过后续 thinking 与口头 success 仍保持真实失败终态', () => {
    const store = new CapabilityTransactionStore();
    store.begin(identity);
    store.apply({
      toolName: 'builtin.files.create_file',
      ok: false,
      relativePaths: []
    });

    store.apply({ type: 'phase', phase: 'thinking' });
    store.apply({ type: 'message', role: 'assistant', text: '现在已经成功。' });
    store.apply({ type: 'phase', phase: 'success' });

    expect(store.snapshot()?.phase).toBe('failed');
  });

  test('等待确认时继续只分类为续接并保持原确认状态', () => {
    const store = new CapabilityTransactionStore();
    store.begin(identity);
    store.apply({ type: 'phase', phase: 'awaiting_confirmation' });
    const before = store.snapshot();

    expect(store.classifyFollowUp('继续')).toBe('continue');
    expect(store.classifyFollowUp('继续执行')).toBe('continue');
    expect(store.snapshot()).toEqual(before);
  });

  test('结构化澄清结果进入等待澄清阶段且不伪造工具事实', () => {
    const store = new CapabilityTransactionStore();
    store.begin(identity);

    store.apply({ type: 'clarification' });

    expect(store.snapshot()).toMatchObject({
      phase: 'awaiting_clarification',
      toolTranscript: [],
      references: []
    });
  });

  test.each([
    ['completed', true],
    ['failed', false]
  ] as const)('%s 终态下成功询问只读取真实终态', (phase, ok) => {
    const store = new CapabilityTransactionStore();
    store.begin(identity);
    store.apply({
      toolName: 'builtin.files.read_file',
      ok,
      relativePaths: ['test.txt']
    });
    if (ok) store.apply({ type: 'phase', phase: 'success' });

    expect(store.classifyFollowUp('成功了吗')).toBe('status');
    expect(store.snapshot()?.phase).toBe(phase);
  });

  test.each([
    'new_task',
    'generation_changed',
    'provider_changed',
    'authorization_root_changed',
    'configuration_changed',
    'new_conversation',
    'closed'
  ] as const)('%s 立即清空事务', reason => {
    const store = new CapabilityTransactionStore();
    store.begin(identity);

    store.invalidate(reason);

    expect(store.snapshot()).toBeNull();
  });
});
