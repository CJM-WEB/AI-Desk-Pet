import { describe, expect, test } from 'vitest';
import { CapabilityTransactionStore } from
  '../src/main/conversation/capability-transaction';

const identity = Object.freeze({
  id: 'transaction-1',
  generation: 'generation-1',
  kind: 'file' as const,
  profileId: 'provider-1',
  capabilityRevision: 'root-1'
});

function createStore(now?: () => number): CapabilityTransactionStore {
  const Store = CapabilityTransactionStore as unknown as new (
    options?: { now?: () => number }
  ) => CapabilityTransactionStore;
  return new Store(now === undefined ? undefined : { now });
}

describe('CapabilityTransactionStore', () => {
  test('只有成功工具结果建立可信引用并允许进入完成终态', () => {
    const store = createStore();
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
    const store = createStore();
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
    const store = createStore();
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

  test('历史读取成功不能把后续编辑失败放大为整个任务成功', () => {
    const store = createStore();
    store.begin(identity);
    store.apply({
      toolName: 'builtin.files.read_file',
      ok: true,
      relativePaths: ['test.txt']
    });

    store.apply({
      type: 'error',
      code: 'ENTRY_CHANGED',
      message: '目标已变化。'
    });
    store.apply({ type: 'phase', phase: 'success' });

    expect(store.snapshot()).toMatchObject({
      phase: 'failed',
      references: [{ role: 'read', relativePath: 'test.txt' }]
    });
  });

  test('新一轮能力续接不能借用历史成功结果进入 completed', () => {
    const store = createStore();
    store.begin(identity);
    store.apply({
      toolName: 'builtin.files.read_file',
      ok: true,
      relativePaths: ['test.txt']
    });
    store.apply({ type: 'phase', phase: 'success' });

    store.beginTurn();
    store.apply({ type: 'phase', phase: 'success' });

    expect(store.snapshot()).toMatchObject({
      phase: 'planning',
      warningCodes: [],
      references: [{ role: 'read', relativePath: 'test.txt' }],
      toolTranscript: [{
        toolName: 'builtin.files.read_file',
        ok: true,
        resultCode: 'OK'
      }]
    });
  });

  test('真实写提交后的模型总结失败保持 completed 并记录稳定 warning', () => {
    const store = createStore();
    store.begin(identity);
    store.apply({
      toolName: 'builtin.files.create_file',
      ok: true,
      relativePaths: ['test.txt']
    });

    store.apply({
      type: 'error',
      code: 'PROVIDER_SUMMARY_FAILED_AFTER_WRITE',
      message: '本地文件操作已成功，但模型总结失败。'
    });
    store.apply({ type: 'phase', phase: 'error' });

    expect(store.snapshot()).toMatchObject({
      phase: 'completed',
      warningCodes: ['PROVIDER_SUMMARY_FAILED_AFTER_WRITE'],
      references: [{ role: 'created', relativePath: 'test.txt' }]
    });
  });

  test('等待确认时继续只分类为续接并保持原确认状态', () => {
    const store = createStore();
    store.begin(identity);
    store.apply({ type: 'phase', phase: 'awaiting_confirmation' });
    const before = store.snapshot();

    expect(store.classifyFollowUp('继续')).toBe('continue');
    expect(store.classifyFollowUp('继续执行')).toBe('continue');
    expect(store.snapshot()).toEqual(before);
  });

  test('结构化澄清结果进入等待澄清阶段且不伪造工具事实', () => {
    const store = createStore();
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
    const store = createStore();
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
    const store = createStore();
    store.begin(identity);

    store.invalidate(reason);

    expect(store.snapshot()).toBeNull();
  });

  test('可信引用最多 16 条且 transcript 只保留最近 32 条', () => {
    const store = createStore();
    store.begin(identity);

    for (let index = 0; index < 40; index += 1) {
      store.apply({
        toolName: `read_file_${index}`,
        ok: true,
        relativePaths: [`docs/file-${index}.txt`]
      });
    }

    const snapshot = store.snapshot();
    expect(snapshot?.references).toHaveLength(16);
    expect(snapshot?.toolTranscript).toHaveLength(32);
    expect(snapshot?.toolTranscript[0]?.toolName).toBe('read_file_8');
    expect(snapshot?.toolTranscript.at(-1)?.toolName).toBe('read_file_39');
  });

  test('引用满额后仍保留最新创建与移动路径并淘汰最旧路径', () => {
    const store = createStore();
    store.begin(identity);
    store.apply({
      toolName: 'builtin.files.list_files',
      ok: true,
      relativePaths: Array.from({ length: 16 }, (_, index) => `docs/file-${index}.txt`)
    });

    store.apply({
      toolName: 'builtin.files.create_file',
      ok: true,
      relativePaths: ['created.txt']
    });
    store.apply({
      toolName: 'builtin.files.move_file',
      ok: true,
      relativePaths: ['docs/file-15.txt', 'archive/file-15.txt']
    });

    const references = store.snapshot()?.references ?? [];
    expect(references).toHaveLength(16);
    expect(references.slice(-3)).toEqual([
      { role: 'created', relativePath: 'created.txt' },
      { role: 'moved_source', relativePath: 'docs/file-15.txt' },
      { role: 'moved_target', relativePath: 'archive/file-15.txt' }
    ]);
    expect(references.some(reference => reference.relativePath === 'docs/file-0.txt')).toBe(false);
  });

  test.each([
    '这个文件内容很好',
    '不要把这个文件内容发给模型',
    '“读取这个文件内容”只是引用',
    '```text\n读取这个文件内容\n```'
  ])('普通评论、否定、引用和代码块“%s”都不能续接事务', text => {
    const store = createStore();
    store.begin(identity);

    expect(store.classifyFollowUp(text)).toBe('none');
  });

  test('事务层 follow-up 只保留控制词，不再自行判定可信引用改写任务', () => {
    const store = createStore();
    store.begin(identity);
    store.apply({
      toolName: 'builtin.files.create_file',
      ok: true,
      relativePaths: ['test.txt']
    });
    store.apply({ type: 'phase', phase: 'success' });

    expect(store.classifyFollowUp('把刚创建的文件内容改为 hello')).toBe('none');
    expect(store.classifyFollowUp('读取 new.txt')).toBe('none');
  });

  test('同一路径的后续读取不会覆盖已有创建引用', () => {
    const store = createStore();
    store.begin(identity);
    store.apply({
      toolName: 'builtin.files.create_file',
      ok: true,
      relativePaths: ['test.txt']
    });
    store.apply({ type: 'phase', phase: 'success' });

    store.beginTurn();
    store.apply({
      toolName: 'builtin.files.read_file',
      ok: true,
      relativePaths: ['test.txt']
    });

    expect(store.snapshot()?.references).toEqual(expect.arrayContaining([
      { role: 'created', relativePath: 'test.txt' },
      { role: 'read', relativePath: 'test.txt' }
    ]));
  });

  test('写意图只读成功后口头完成仍保持失败，不得把事务记成 completed', () => {
    const store = createStore();
    store.begin(identity);
    (store.beginTurn as unknown as (input: { expectedOperation: 'move_file' }) => void)({
      expectedOperation: 'move_file'
    });

    store.apply({
      toolName: 'builtin.files.read_file',
      ok: true,
      relativePaths: ['order.txt']
    });
    store.apply({ type: 'phase', phase: 'success' });

    expect(store.snapshot()).toMatchObject({
      phase: 'failed',
      references: [{ role: 'read', relativePath: 'order.txt' }]
    });
  });

  test('事务超过 10 分钟滑动 TTL 后在 snapshot 与 follow-up 分类前统一失效', () => {
    let now = 0;
    const store = createStore(() => now);
    store.begin(identity);
    store.apply({
      toolName: 'builtin.files.read_file',
      ok: true,
      relativePaths: ['ttl.txt']
    });

    now = 9 * 60 * 1_000 + 59_999;
    expect(store.snapshot()).toMatchObject({
      profileId: 'provider-1',
      capabilityRevision: 'root-1'
    });

    now = 10 * 60 * 1_000 + 1;
    expect(store.snapshot()).toBeNull();
    expect(store.classifyFollowUp('把刚读取的文件内容改为 hello')).toBe('none');
  });

  test('失败终态只把 retry 识别为安全重开入口，completed 不把 retry 当作普通继续', () => {
    const store = createStore();
    store.begin(identity);
    store.apply({
      toolName: 'builtin.files.read_file',
      ok: false,
      relativePaths: []
    });

    expect(store.classifyFollowUp('retry')).toBe('retry');
    expect(store.classifyFollowUp('重试')).toBe('retry');
  });
});
