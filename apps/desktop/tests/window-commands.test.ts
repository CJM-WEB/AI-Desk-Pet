import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { describe, expect, test } from 'vitest';
import { registerWindowIpc } from '../src/main/ipc/register-ipc';
import { ipcChannels } from '../src/shared/ipc-channels';

type TestWindow = {
  isDestroyed(): boolean;
  hide(): void;
  show(): void;
  focus(): void;
};

type WindowCommandController = {
  showChat(): Promise<void>;
  hideChat(): void;
};

type WindowCommandsModule = {
  createWindowCommandController(options: {
    getChatWindow(): TestWindow;
    ensureChatWindow(): Promise<TestWindow>;
    positionChat(window: TestWindow): void;
  }): WindowCommandController;
};

async function loadWindowCommandsModule(): Promise<WindowCommandsModule | null> {
  try {
    return await import(new URL(
      '../src/main/windows/window-commands.ts',
      import.meta.url
    ).href) as WindowCommandsModule;
  } catch {
    return null;
  }
}

function testWindow(sequence: string[], destroyed = false): TestWindow {
  return {
    isDestroyed: () => destroyed,
    hide: () => sequence.push('hide'),
    show: () => sequence.push('show'),
    focus: () => sequence.push('focus')
  };
}

describe('Main 窗口命令控制器', () => {
  test('hideChat 只隐藏未销毁的聊天窗口', async () => {
    const module = await loadWindowCommandsModule();
    expect(module, '应提供独立的窗口命令控制器').not.toBeNull();
    if (!module) return;

    const visibleCalls: string[] = [];
    const destroyedCalls: string[] = [];
    let current = testWindow(visibleCalls);
    const controller = module.createWindowCommandController({
      getChatWindow: () => current,
      ensureChatWindow: async () => current,
      positionChat: () => undefined
    });

    controller.hideChat();
    current = testWindow(destroyedCalls, true);
    controller.hideChat();

    expect(visibleCalls).toEqual(['hide']);
    expect(destroyedCalls).toEqual([]);
  });

  test.each([
    ['现存窗口', false],
    ['重建窗口', true]
  ] as const)('showChat 对%s统一执行 position、show、focus', async (_label, recreate) => {
    const module = await loadWindowCommandsModule();
    expect(module, '应提供独立的窗口命令控制器').not.toBeNull();
    if (!module) return;

    const sequence: string[] = [];
    const original = testWindow(sequence, recreate);
    const ensured = recreate ? testWindow(sequence) : original;
    const controller = module.createWindowCommandController({
      getChatWindow: () => original,
      ensureChatWindow: async () => {
        sequence.push(recreate ? 'recreate' : 'reuse');
        return ensured;
      },
      positionChat: window => {
        expect(window).toBe(ensured);
        sequence.push('position');
      }
    });

    await controller.showChat();

    expect(sequence).toEqual([
      recreate ? 'recreate' : 'reuse',
      'position',
      'show',
      'focus'
    ]);
  });

  test('正式 IPC channel 绑定同一控制器的 showChat 与 hideChat', async () => {
    const module = await loadWindowCommandsModule();
    expect(module, '应提供独立的窗口命令控制器').not.toBeNull();
    if (!module) return;

    const sequence: string[] = [];
    const chat = testWindow(sequence);
    const controller = module.createWindowCommandController({
      getChatWindow: () => chat,
      ensureChatWindow: async () => chat,
      positionChat: () => sequence.push('position')
    });
    const handlers = new Map<string, (
      event: IpcMainInvokeEvent,
      ...args: unknown[]
    ) => unknown>();
    const ipcMain = {
      removeHandler: (channel: string) => handlers.delete(channel),
      handle: (channel: string, handler: (
        event: IpcMainInvokeEvent,
        ...args: unknown[]
      ) => unknown) => {
        handlers.set(channel, handler);
      }
    } as Pick<IpcMain, 'removeHandler' | 'handle'>;

    registerWindowIpc(ipcMain as IpcMain, '1.0.0', {
      openChat: () => controller.showChat(),
      hideChat: () => controller.hideChat(),
      openSettings: () => undefined,
      quit: () => undefined
    });
    const event = {} as IpcMainInvokeEvent;
    await handlers.get(ipcChannels.windowOpenChat)?.(event);
    await handlers.get(ipcChannels.windowHideChat)?.(event);

    expect(sequence).toEqual(['position', 'show', 'focus', 'hide']);
    expect(handlers.has(ipcChannels.windowOpenChat)).toBe(true);
    expect(handlers.has(ipcChannels.windowHideChat)).toBe(true);
  });
});
