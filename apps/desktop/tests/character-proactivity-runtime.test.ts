import { afterEach, describe, expect, test, vi } from 'vitest';
import { createCharacterProactivityRuntime } from
  '../src/main/characters/character-proactivity-runtime';
import type { CharacterAutonomousRequest } from '../src/main/characters/character-proactivity-runtime';

const MINUTE = 60_000;
const settle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
afterEach(() => vi.useRealTimers());

/** 隔离模型与角色端口，只观察真实 Runtime 的触发、预算和取消时序。 */
function schedulingFixture(options: { enabled?: boolean; respond?(input: CharacterAutonomousRequest): Promise<void> } = {}) {
  let now = 0; let generation = 0; let prepared = false;
  let blockers = { closed: false, chatting: false, capabilityTask: false, awaitingConfirmation: false, dragging: false, movementModeTransition: false, movementMode: 0, moving: false };
  const listeners = new Set<() => void>();
  const attempts: Array<{ purpose: string | undefined; at: number; signal: AbortSignal }> = [];
  const idleAt: number[] = [];
  const director = {
    getActivityBlockers: () => blockers, getBehaviorLifecycleGeneration: () => generation,
    subscribeActivityBlockers: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    invalidateBehaviorLifecycle: () => { generation++; prepared = false; listeners.forEach(listener => listener()); },
    needsBehaviorBindings: () => !prepared,
    applyIdleBindings: () => { idleAt.push(now); return prepared; }
  };
  const runtime = createCharacterProactivityRuntime({ director: director as never, advanceBehavior: () => undefined, now: () => now,
    autonomousMoodEnabled: options.enabled ?? true,
    factories: { createScheduler: () => ({ start: () => undefined, close: async () => undefined }) },
    requestAutonomousDecision: async input => {
      if (!input.beforeProviderCall()) return;
      attempts.push({ purpose: input.purpose, at: now, signal: input.signal });
      if (options.respond) await options.respond(input);
      else if (input.purpose === 'bindings') prepared = true;
    }
  });
  return { runtime, attempts, idleAt,
    start: async () => { runtime.start(); await settle(); },
    time: async (value: number) => { now = value; runtime.poll(); await settle(); },
    setBlocker: (key: 'chatting' | 'capabilityTask' | 'awaitingConfirmation' | 'dragging' | 'singleEpisode', value: boolean) => { blockers = { ...blockers, [key]: value }; listeners.forEach(listener => listener()); },
    invalidate: () => runtime.invalidate()
  };
}

describe('生产主动性组合', () => {
  test('只创建一组端口并在 start 前不 arm，poll 与 shutdown 保持固定顺序', async () => {
    const order: string[] = [];
    const scheduler = { start: vi.fn(() => order.push('start')), close: vi.fn(async () => { order.push('scheduler-close'); }) };
    const createScheduler = vi.fn(() => scheduler);
    const director = { invalidateBehaviorLifecycle: vi.fn(() => order.push('invalidate')),
      getActivityBlockers: () => ({ closed: false, chatting: false, capabilityTask: false, awaitingConfirmation: false, dragging: false, movementModeTransition: false }) };
    const runtime = createCharacterProactivityRuntime({
      director: director as never,
      advanceBehavior: () => order.push('behavior-advance'),
      factories: { createScheduler }
    });

    expect(scheduler.start).not.toHaveBeenCalled();
    expect(createScheduler).toHaveBeenCalledOnce();
    runtime.start();
    runtime.invalidate();
    runtime.poll();
    await runtime.close();

    expect(order).toEqual([
      'start', 'invalidate', 'behavior-advance',
      'scheduler-close'
    ]);
    expect(director.invalidateBehaviorLifecycle).toHaveBeenCalledOnce();
  });
});

describe('描述用途准备与空闲评估', () => {
  test('零档且关闭自主心情仍在启动准备一次，成功后不再重复', async () => {
    const f = schedulingFixture({ enabled: false });
    try { await f.start(); expect(f.attempts.map(item => item.purpose)).toEqual(['bindings']); await f.time(40 * MINUTE); expect(f.attempts).toHaveLength(1); expect(f.idleAt).toEqual([]); }
    finally { await f.runtime.close(); }
  });

  test('准备失败按一分钟恢复且每小时最多四次，生命周期变化不能清空预算', async () => {
    const f = schedulingFixture({ enabled: false, respond: async () => { throw new Error('匹配失败'); } });
    try {
      await f.start(); await f.time(MINUTE - 1); expect(f.attempts).toHaveLength(1);
      for (const time of [1, 2, 3]) await f.time(time * MINUTE);
      f.invalidate(); await f.time(4 * MINUTE); expect(f.attempts).toHaveLength(4);
      await f.time(60 * MINUTE); expect(f.attempts).toHaveLength(5);
      expect(f.attempts.every(item => item.purpose === 'bindings')).toBe(true);
    } finally { await f.runtime.close(); }
  });

  test('准备不推迟首次五分钟心情评估，先投递本地无聊用途再调用模型', async () => {
    const f = schedulingFixture();
    try {
      await f.start(); await f.time(5 * MINUTE - 1); expect(f.idleAt).toEqual([]);
      await f.time(5 * MINUTE); expect(f.idleAt).toEqual([5 * MINUTE]);
      expect(f.attempts.map(item => ({ purpose: item.purpose, at: item.at }))).toEqual([{ purpose: 'bindings', at: 0 }, { purpose: 'mood', at: 5 * MINUTE }]);
      await f.time(20 * MINUTE); expect(f.attempts.at(-1)).toMatchObject({ purpose: 'mood', at: 20 * MINUTE });
    } finally { await f.runtime.close(); }
  });

  test.each(['chatting', 'capabilityTask', 'awaitingConfirmation', 'dragging', 'singleEpisode'] as const)('%s 阻塞时暂停准备和无聊，解除后继续', async key => {
    const f = schedulingFixture();
    try {
      f.setBlocker(key, true); await f.start(); await f.time(5 * MINUTE); expect(f.attempts).toEqual([]); expect(f.idleAt).toEqual([]);
      f.setBlocker(key, false); await f.time(5 * MINUTE + 1); expect(f.attempts[0]?.purpose).toBe('bindings');
    } finally { await f.runtime.close(); }
  });

  test('用途准备超时取消，保持有限重试；关闭后不接续', async () => {
    vi.useFakeTimers();
    const f = schedulingFixture({ enabled: false, respond: async () => new Promise(() => undefined) });
    try {
      await f.start(); expect(f.attempts).toHaveLength(1); await vi.advanceTimersByTimeAsync(MINUTE);
      expect(f.attempts[0]!.signal.aborted).toBe(true); await f.time(MINUTE); expect(f.attempts).toHaveLength(2);
      await f.runtime.close(); expect(f.attempts[1]!.signal.aborted).toBe(true); await f.time(2 * MINUTE); expect(f.attempts).toHaveLength(2);
    } finally { await f.runtime.close(); }
  });
});
