import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { CodingSessionEvent } from '../src/index';
import { fixture, type Step } from './fixture';

type Permission = Extract<CodingSessionEvent, { type: 'permission' }>;
const loops = (events: CodingSessionEvent[]) => events.filter((event): event is Permission => event.type === 'permission' && event.action === 'doom_loop');
const completed = (events: CodingSessionEvent[]) => events.filter(event => event.type === 'tool' && event.status === 'completed');
const repeated = (count: number, path = 'note.txt') => Array.from({ length: count }, (_, i) => ({ name: 'read', args: { path }, id: `repeat_${i + 1}` }));

test('跨模型轮第三次重复在执行前等待，每次继续仅放行一个调用', async () => {
  const steps: Step[] = [...repeated(4).map(call => [call]), '结束'];
  const f = await fixture(steps);
  const controller = new AbortController();
  let execution: ReturnType<typeof f.session.run> | undefined;
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    await writeFile(join(f.directory, 'note.txt'), '固定测试正文');
    execution = f.session.run('检查本轮文件', controller.signal);
    void execution.catch(() => undefined);
    await expect.poll(() => loops(f.events).length > 0 || f.requests.length >= 4, { timeout: 5_000 }).toBe(true);
    expect(loops(f.events)).toHaveLength(1);
    expect(f.requests).toHaveLength(3);
    expect(completed(f.events)).toHaveLength(2);
    const third = loops(f.events)[0]!;
    expect(third).toMatchObject({ resources: ['read'], metadata: { repeatCount: 3 } });
    await f.session.replyPermission(third.id, 'once');
    await expect.poll(() => loops(f.events).length).toBe(2);
    expect(completed(f.events)).toHaveLength(3);
    const fourth = loops(f.events)[1]!;
    expect(fourth.id).not.toBe(third.id);
    expect(fourth.metadata).toEqual({ repeatCount: 4 });
    await expect(f.session.replyPermission(third.id, 'once')).rejects.toBeDefined();
    await f.session.replyPermission(fourth.id, 'once');
    await expect(execution).resolves.toMatchObject({ toolCalls: 4 });
  } finally {
    clearTimeout(timer);
    controller.abort();
    await execution?.catch(() => undefined);
    await f.close();
  }
}, 10_000);

// 有限 HTTP 用例只拥有测试截止时间；实际取消、许可与结算仍走正式会话。
async function runBounded(f: Awaited<ReturnType<typeof fixture>>, check: (execution: ReturnType<typeof f.session.run>, controller: AbortController) => Promise<void>) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  const execution = f.session.run('检查本轮文件', controller.signal);
  void execution.catch(() => undefined);
  try { await check(execution, controller); }
  finally { clearTimeout(timer); controller.abort(); await execution.catch(() => undefined); await f.close(); }
}

test('同轮四次调用按事件顺序等待，普通许可未决也不阻止第三次循环卡', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'ai-pet-loop-external-'));
  const f = await fixture([repeated(4, join(outside, 'note.txt')), '结束']);
  try {
    await writeFile(join(outside, 'note.txt'), '外部正文');
    await runBounded(f, async () => {
      await expect.poll(() => loops(f.events).length).toBe(1);
      const external = () => f.events.filter((event): event is Permission => event.type === 'permission' && event.action === 'external_directory');
      await expect.poll(() => external().length).toBe(2);
      expect(completed(f.events)).toHaveLength(0);
      expect(f.events.filter(event => event.type === 'tool' && event.status === 'running')).toHaveLength(3);
      await f.session.replyPermission(loops(f.events)[0]!.id, 'once');
      await expect.poll(() => loops(f.events).length).toBe(2);
      expect(loops(f.events)[1]!.metadata).toEqual({ repeatCount: 4 });
      // 第三次循环 once 不授予外部目录访问，第四次仍未启动工具执行。
      await expect.poll(() => external().length).toBe(3);
      expect(completed(f.events)).toHaveLength(0);
      for (const permission of external()) await f.session.replyPermission(permission.id, 'reject');
      await expect.poll(() => f.events.filter(event => event.type === 'tool' && event.status === 'failed').length).toBe(3);
      expect(f.requests).toHaveLength(1);
    });
  } finally { await rm(outside, { recursive: true, force: true }); }
}, 10_000);

test('同轮四次授权内读取仍逐次确认第三和第四次', async () => {
  const f = await fixture([repeated(4), '结束']);
  await writeFile(join(f.directory, 'note.txt'), '固定正文');
  await runBounded(f, async execution => {
    await expect.poll(() => loops(f.events).length).toBe(1);
    await expect.poll(() => completed(f.events).length).toBe(2);
    await f.session.replyPermission(loops(f.events)[0]!.id, 'once');
    await expect.poll(() => loops(f.events).length).toBe(2);
    await expect.poll(() => completed(f.events).length).toBe(3);
    expect(f.requests).toHaveLength(1);
    await f.session.replyPermission(loops(f.events)[1]!.id, 'once');
    await expect(execution).resolves.toMatchObject({ toolCalls: 4 });
  });
}, 10_000);

test.each(['失败', '普通拒绝'] as const)('%s 不清空连续调用窗口，第三次先等待循环许可', async kind => {
  const outside = kind === '普通拒绝' ? await mkdtemp(join(tmpdir(), 'ai-pet-loop-reject-')) : undefined;
  const f = await fixture([...repeated(3, outside ? join(outside, 'missing.txt') : 'missing.txt').map(call => [call]), '结束']);
  try {
    await runBounded(f, async execution => {
      if (outside) {
        for (let index = 1; index <= 2; index++) {
          const external = () => f.events.filter((event): event is Permission => event.type === 'permission' && event.action === 'external_directory');
          await expect.poll(() => external().length).toBe(index);
          await f.session.replyPermission(external()[index - 1]!.id, 'reject');
        }
      }
      await expect.poll(() => loops(f.events).length).toBe(1);
      expect(loops(f.events)[0]!.metadata).toEqual({ repeatCount: 3 });
      expect(f.events.filter(event => event.type === 'tool' && event.status === 'failed')).toHaveLength(2);
      await f.session.replyPermission(loops(f.events)[0]!.id, 'once');
      if (outside) {
        const external = () => f.events.filter((event): event is Permission => event.type === 'permission' && event.action === 'external_directory');
        await expect.poll(() => external().length).toBe(3);
        await f.session.replyPermission(external()[2]!.id, 'reject');
      }
      await execution;
      expect(f.events.filter(event => event.type === 'tool' && event.status === 'failed')).toHaveLength(3);
    });
  } finally { if (outside) await rm(outside, { recursive: true, force: true }); }
}, 10_000);

test.each(['参数变化', '工具变化'] as const)('%s 打断精确重复序列', async kind => {
  const calls = repeated(4);
  const interruption = kind === '参数变化' ? { name: 'read', args: { path: 'other.txt' } } : { name: 'write', args: { path: 'note.txt' } };
  const f = await fixture([[calls[0]!], [calls[1]!], [interruption], [calls[3]!], '结束']);
  await writeFile(join(f.directory, 'note.txt'), '固定正文');
  await runBounded(f, async execution => {
    await execution;
    expect(loops(f.events)).toEqual([]);
    expect(f.requests).toHaveLength(5);
  });
}, 10_000);

test('同一会话新 run 以及取消后新实例均不继承旧窗口', async () => {
  const f = await fixture([[...repeated(2)], '第一轮结束', [...repeated(2).map(call => ({ ...call, id: `new_${call.id}` }))], '第二轮结束']);
  await writeFile(join(f.directory, 'note.txt'), '正文');
  await runBounded(f, async execution => {
    await execution;
    await f.session.run('新的当前输入', new AbortController().signal);
    expect(loops(f.events)).toEqual([]);
    expect(completed(f.events)).toHaveLength(4);
  });
  const cancelled = await fixture([repeated(3)]);
  await writeFile(join(cancelled.directory, 'note.txt'), '正文');
  await runBounded(cancelled, async (execution, controller) => {
    await expect.poll(() => loops(cancelled.events).length).toBe(1);
    controller.abort(); await execution.catch(() => undefined);
    expect(completed(cancelled.events)).toHaveLength(2);
  });
  const fresh = await fixture([repeated(2), '结束']);
  await writeFile(join(fresh.directory, 'note.txt'), '正文');
  await runBounded(fresh, async execution => { await execution; expect(loops(fresh.events)).toEqual([]); });
}, 10_000);

test('两个重复结果触发原摘要后第三次仍等待循环许可', async () => {
  const f = await fixture([...repeated(3).map(call => [call]), '结束'], {
    model: { baseUrl: '', modelId: 'qwen-fixture', contextWindow: 8192, outputTokens: 2048, compaction: { buffer: 2048, keepTokens: 1 }, readCredential: async () => 'fixture' }
  }, (request, next) => JSON.stringify(request).includes('Create a new anchored summary') ? '已读取同一个文件两次，继续检查。' : next());
  // 原摘要序列化把 read 附件缩成引用；保留 1 token 才确保旧工具结果进入摘要头。
  await writeFile(join(f.directory, 'note.txt'), '测试正文\n'.repeat(1600));
  await runBounded(f, async () => {
    await expect.poll(() => loops(f.events).length).toBe(1);
    const summaryIndex = f.requests.findIndex(request => JSON.stringify(request).includes('Create a new anchored summary'));
    expect(summaryIndex).toBe(2);
    expect(loops(f.events)[0]!.metadata).toEqual({ repeatCount: 3 });
    expect(completed(f.events)).toHaveLength(2);
  });
}, 10_000);
