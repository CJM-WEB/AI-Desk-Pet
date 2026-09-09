import { describe, expect, test, vi } from 'vitest';
import { createCharacterProactivityRuntime } from
  '../src/main/characters/character-proactivity-runtime';

describe('生产主动性组合', () => {
  test('只创建一组端口并在 start 前不 arm，poll 与 shutdown 保持固定顺序', async () => {
    const order: string[] = [];
    const scheduler = { start: vi.fn(() => order.push('start')), close: vi.fn(async () => { order.push('scheduler-close'); }) };
    const createScheduler = vi.fn(() => scheduler);
    const director = { invalidateBehaviorLifecycle: vi.fn(() => order.push('invalidate')) };
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
