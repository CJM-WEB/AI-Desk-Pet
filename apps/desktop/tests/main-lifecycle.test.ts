import { describe, expect, test, vi } from 'vitest';

import {
  createApplicationQuitCoordinator,
  createCharacterActivationCoordinator,
  createStartupCleanupStack,
  createTrayRefreshController
} from '../src/main/lifecycle/main-lifecycle';

describe('Main 通用生命周期', () => {
  test('启动清理严格逆序并汇总失败', async () => {
    const order: string[] = [];
    const cleanup = createStartupCleanupStack();
    cleanup.add(() => { order.push('first'); });
    cleanup.add(() => { order.push('second'); throw new Error('SECOND'); });
    cleanup.seal();

    await expect(cleanup.run()).rejects.toThrow('STARTUP_CLEANUP_INCOMPLETE');
    expect(order).toEqual(['second', 'first']);
  });

  test('退出协调器只执行一次正常关闭事务', async () => {
    const quit = vi.fn();
    const cleanupBootstrap = vi.fn(async () => undefined);
    const shutdown = vi.fn(async () => undefined);
    const coordinator = createApplicationQuitCoordinator({ cleanupBootstrap, quit });
    expect(coordinator.activateNormal(shutdown)).toBe(true);
    const event = { preventDefault: vi.fn() };

    await Promise.all([coordinator.handle(event), coordinator.handle(event)]);

    expect(shutdown).toHaveBeenCalledOnce();
    expect(cleanupBootstrap).not.toHaveBeenCalled();
    expect(quit).toHaveBeenCalledOnce();
  });

  test('角色切换期间保持活动标记并在失败后复位', async () => {
    let release = (): void => undefined;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const activation = createCharacterActivationCoordinator({
      activateInStore: async () => pending,
      reloadBehavior: async () => undefined
    });
    const running = activation.activate('character-1');
    expect(activation.current()).toBe(true);
    release();
    await running;
    expect(activation.current()).toBe(false);
  });

  test('托盘刷新串行发布最新菜单', async () => {
    const published: number[] = [];
    let value = 0;
    const refresh = createTrayRefreshController({
      build: async () => ++value,
      publish: next => published.push(next)
    });
    await Promise.all([refresh.refresh(), refresh.refresh()]);
    expect(published).toEqual([1, 2]);
  });
});
