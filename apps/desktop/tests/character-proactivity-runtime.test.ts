import type { ModelProvider } from '@myself/agent-core';
import { describe, expect, test, vi } from 'vitest';
import { createCharacterProactivityRuntime } from
  '../src/main/characters/character-proactivity-runtime';

describe('生产主动性组合', () => {
  test('只创建一组端口并在 start 前不 arm，poll 与 shutdown 保持固定顺序', async () => {
    const order: string[] = [];
    const diagnostics = { subscribe: vi.fn(() => () => order.push('unsubscribe')), close: vi.fn(() => order.push('diagnostics-close')) };
    const reflection = { reflect: vi.fn(), close: vi.fn(async () => { order.push('reflection-close'); }) };
    const scheduler = { start: vi.fn(() => order.push('start')), close: vi.fn(async () => { order.push('scheduler-close'); }) };
    const createDiagnostics = vi.fn(() => diagnostics);
    const createReflection = vi.fn(() => reflection);
    const createScheduler = vi.fn(() => scheduler);
    const director = { invalidateBehaviorLifecycle: vi.fn(() => order.push('invalidate')) };
    const runtime = createCharacterProactivityRuntime({
      director: director as never,
      createProvider: vi.fn<() => Promise<ModelProvider>>(),
      publishDiagnostic: vi.fn(),
      advanceBehavior: () => order.push('behavior-advance'),
      advanceFileTaskTransaction: () => order.push('file-advance'),
      factories: { createDiagnostics, createReflection, createScheduler }
    });

    expect(scheduler.start).not.toHaveBeenCalled();
    expect(createDiagnostics).toHaveBeenCalledOnce();
    expect(createReflection).toHaveBeenCalledOnce();
    expect(createScheduler).toHaveBeenCalledOnce();
    runtime.start();
    runtime.invalidate();
    runtime.poll();
    await runtime.close();

    expect(order).toEqual([
      'start', 'invalidate', 'behavior-advance', 'file-advance',
      'scheduler-close', 'unsubscribe', 'diagnostics-close'
    ]);
    expect(director.invalidateBehaviorLifecycle).toHaveBeenCalledOnce();
  });
});
