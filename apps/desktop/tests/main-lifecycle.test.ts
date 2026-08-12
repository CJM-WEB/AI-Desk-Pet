import { readFile } from 'node:fs/promises';
import { describe, expect, test, vi } from 'vitest';

import {
  createApplicationQuitCoordinator,
  createDetachedCloseController,
  createCharacterActivationCoordinator,
  createMainShutdownTransaction,
  createStartupCleanupStack,
  createTrayRefreshController
} from '../src/main/lifecycle/main-lifecycle';

describe('Main 通用生命周期', () => {
  test('生产组合根以会话协调器作为唯一聊天入口并先关闭会话', async () => {
    const source = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    const beforeQuit = source.slice(source.indexOf("app.on('before-quit'"));

    expect(source).toContain('createMainConversationComposition({');
    expect(source).toContain('registerAgentIpc(ipcMain, conversationIpcService)');
    expect(source).not.toContain('registerAgentIpc(ipcMain, agentService)');
    expect(source).not.toContain('activeAgentService');
    expect(source).toMatch(
      /beforeExplorerClose:\s*async \(\) => \{[\s\S]*await conversationComposition\.close\(\);[\s\S]*freezeAndFlushPetAlwaysOnTop/u
    );
    expect(beforeQuit).not.toContain('cancelActive()');
    expect(source).toContain('conversationClose.close();');
    expect(source).toMatch(
      /const releaseCharacterRuntime = \(\): void => \{[\s\S]*conversationClose\.close\(\);[\s\S]*activeCapabilityTaskAdapter = null;/u
    );
  });

  test('窗口关闭同步触发会话封口且异步失败只稳定报告一次', async () => {
    let rejectClose!: (error: Error) => void;
    const pendingClose = new Promise<void>((_resolve, reject) => { rejectClose = reject; });
    const close = vi.fn(() => pendingClose);
    const report = vi.fn();
    const controller = createDetachedCloseController({ onError: report });
    expect(controller.activate(close)).toBe(true);

    controller.close();
    controller.close();
    expect(close).toHaveBeenCalledOnce();

    rejectClose(new Error('PRIVATE_CLOSE_FAILURE'));
    await vi.waitFor(() => expect(report).toHaveBeenCalledOnce());
    expect(report.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  test('窗口先关闭时迟到的会话能力在激活瞬间立即封口', () => {
    const close = vi.fn(async () => undefined);
    const controller = createDetachedCloseController({ onError: vi.fn() });

    controller.close();

    expect(controller.activate(close)).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect(controller.activate(close)).toBe(false);
  });

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

  test('关闭事务严格按图层、桥接、位置和既有服务顺序且保持幂等', async () => {
    const order: string[] = [];
    const shutdown = createMainShutdownTransaction({
      beforeExplorerClose: async () => { order.push('topmost-flush'); },
      coordinator: { close: async () => { order.push('coordinator'); } },
      bridge: { close: async () => { order.push('bridge'); } },
      position: { freezeAndFlush: async () => { order.push('position'); } },
      services: [
        async () => { order.push('workshop'); },
        async () => { order.push('settings'); },
        () => { order.push('runtime'); }
      ]
    });

    await Promise.all([shutdown(), shutdown()]);

    expect(order).toEqual([
      'topmost-flush', 'coordinator', 'bridge', 'position', 'workshop', 'settings', 'runtime'
    ]);
  });

  test('关闭单点失败仍释放全部资源并稳定聚合错误', async () => {
    const order: string[] = [];
    const shutdown = createMainShutdownTransaction({
      beforeExplorerClose: async () => { order.push('topmost-flush'); throw new Error('FLUSH'); },
      coordinator: { close: async () => { order.push('coordinator'); } },
      bridge: { close: async () => { order.push('bridge'); throw new Error('PRIVATE'); } },
      position: { freezeAndFlush: async () => { order.push('position'); } },
      services: [
        async () => { order.push('settings'); throw new Error('SETTINGS_PRIVATE'); },
        () => { order.push('runtime'); }
      ]
    });

    const failure = await shutdown().then(() => null, error => error as AggregateError);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure?.message).toBe('APPLICATION_SHUTDOWN_INCOMPLETE');
    expect(failure?.errors).toHaveLength(3);
    expect(order).toEqual(['topmost-flush', 'coordinator', 'bridge', 'position', 'settings', 'runtime']);

    const report = vi.fn();
    const quit = vi.fn();
    const application = createApplicationQuitCoordinator({
      cleanupBootstrap: async () => undefined,
      quit,
      onError: report
    });
    application.activateNormal(shutdown);
    await application.handle({ preventDefault: vi.fn() });
    expect(report).toHaveBeenCalledExactlyOnceWith(failure);
    expect(quit).toHaveBeenCalledOnce();
    expect(order).toEqual(['topmost-flush', 'coordinator', 'bridge', 'position', 'settings', 'runtime']);
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
