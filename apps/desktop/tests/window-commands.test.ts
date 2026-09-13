import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { describe, expect, test, vi } from 'vitest';
import { registerWindowIpc } from '../src/main/ipc/register-ipc';
import { ipcChannels } from '../src/shared/ipc-channels';

type Handler = (event: unknown, input?: unknown) => unknown;

type TestWindow = {
  isDestroyed(): boolean;
  destroy?(): void;
  hide(): void;
  show(): void;
  focus(): void;
};

type WindowCommandController = {
  showChat(): Promise<void>;
  hideChat(): void;
  showCharacterWorkshop(): Promise<void>;
};

type WindowCommandsModule = {
  createPetVisibilityCommand(pet: {
    isDestroyed(): boolean;
    isVisible(): boolean;
    hide(): void;
    show(): void;
  }): () => void;
  createWindowCommandController(options: {
    getChatWindow(): TestWindow;
    ensureChatWindow(): Promise<TestWindow>;
    openChat(window: TestWindow): void;
    closeChat(window: TestWindow): void;
    ensureCharacterWorkshopWindow(): Promise<TestWindow>;
  }): WindowCommandController;
  createLoadBeforePublishWindow<TWindow extends {
    isDestroyed(): boolean;
    destroy(): void;
  }>(options: {
    create(): TWindow;
    prepare(window: TWindow): void;
    load(window: TWindow): Promise<void>;
  }): {
    getCurrent(): TWindow | null;
    ensure(): Promise<TWindow>;
  };
  broadcastCharacterEvent(
    targets: Array<{
      isDestroyed(): boolean;
      webContents: {
        isDestroyed(): boolean;
        send(channel: string, payload: unknown): void;
      };
    } | null>,
    channel: string,
    payload: unknown
  ): void;
  createCharacterQuickSwitchCommand(
    characterId: string,
    activate: (characterId: string) => Promise<void>,
    reportError: (error: unknown) => void
  ): () => void;
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
  test.each([
    ['可见', true, ['hide']],
    ['隐藏', false, ['show']]
  ] as const)('托盘切换命令在桌宠%s时执行单一反向动作', async (_label, visible, expected) => {
    const module = await loadWindowCommandsModule();
    expect(module, '应提供普通桌宠显示隐藏命令').not.toBeNull();
    if (!module) return;
    const sequence: string[] = [];
    const toggle = module.createPetVisibilityCommand({
      isDestroyed: () => false,
      isVisible: () => visible,
      hide: () => sequence.push('hide'),
      show: () => sequence.push('show')
    });

    toggle();

    expect(sequence).toEqual(expected);
  });

  test('托盘切换命令忽略已销毁桌宠窗口', async () => {
    const module = await loadWindowCommandsModule();
    expect(module).not.toBeNull();
    if (!module) return;
    const hide = vi.fn();
    const show = vi.fn();

    module.createPetVisibilityCommand({
      isDestroyed: () => true,
      isVisible: () => true,
      hide,
      show
    })();

    expect(hide).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
  });

  test('hideChat 仅向未销毁聊天窗口请求收起动画', async () => {
    const module = await loadWindowCommandsModule();
    expect(module, '应提供独立的窗口命令控制器').not.toBeNull();
    if (!module) return;

    const visibleCalls: string[] = [];
    const destroyedCalls: string[] = [];
    let current = testWindow(visibleCalls);
    const controller = module.createWindowCommandController({
      getChatWindow: () => current,
      ensureChatWindow: async () => current,
      openChat: () => undefined,
      closeChat: () => visibleCalls.push('request-close'),
      ensureCharacterWorkshopWindow: async () => current
    });

    controller.hideChat();
    current = testWindow(destroyedCalls, true);
    controller.hideChat();

    expect(visibleCalls).toEqual(['request-close']);
    expect(destroyedCalls).toEqual([]);
  });

  test.each([
    ['现存窗口', false],
    ['重建窗口', true]
  ] as const)('showChat 对%s加载后仅请求顶部展开', async (_label, recreate) => {
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
      openChat: window => {
        expect(window).toBe(ensured);
        sequence.push('request-open');
      },
      closeChat: () => undefined,
      ensureCharacterWorkshopWindow: async () => ensured
    });

    await controller.showChat();

    expect(sequence).toEqual([
      recreate ? 'recreate' : 'reuse',
      'request-open'
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
      openChat: () => sequence.push('request-open'),
      closeChat: () => sequence.push('request-close'),
      ensureCharacterWorkshopWindow: async () => chat
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
      openCharacterWorkshop: () => undefined,
      quit: () => undefined
    });
    const event = {} as IpcMainInvokeEvent;
    await handlers.get(ipcChannels.windowOpenChat)?.(event);
    await handlers.get(ipcChannels.windowHideChat)?.(event);

    expect(sequence).toEqual(['request-open', 'request-close']);
    expect(handlers.has(ipcChannels.windowOpenChat)).toBe(true);
    expect(handlers.has(ipcChannels.windowHideChat)).toBe(true);
  });

  test('角色工作室命令复用现存窗口，并绑定固定 open IPC', async () => {
    const module = await loadWindowCommandsModule();
    expect(module, '应提供独立的窗口命令控制器').not.toBeNull();
    if (!module) return;

    const sequence: string[] = [];
    const chat = testWindow([]);
    const workshop = testWindow(sequence);
    const controller = module.createWindowCommandController({
      getChatWindow: () => chat,
      ensureChatWindow: async () => chat,
      openChat: () => undefined,
      closeChat: () => undefined,
      ensureCharacterWorkshopWindow: async () => {
        sequence.push('reuse');
        return workshop;
      }
    });
    const handlers = new Map<string, Handler>();
    const ipcMain = {
      removeHandler: (ipcChannel: string) => handlers.delete(ipcChannel),
      handle: (ipcChannel: string, handler: Handler) => handlers.set(ipcChannel, handler)
    } as unknown as IpcMain;
    const register = registerWindowIpc as unknown as (
      main: IpcMain,
      version: string,
      actions: {
        openChat(): unknown;
        openSettings(): unknown;
        openCharacterWorkshop(): unknown;
        hideChat(): unknown;
        quit(): unknown;
      }
    ) => void;
    const characterChannel = (
      ipcChannels as unknown as Record<string, string>
    )['windowOpenCharacterWorkshop'];

    register(ipcMain, '1.0.0', {
      openChat: () => undefined,
      openSettings: () => undefined,
      openCharacterWorkshop: () => controller.showCharacterWorkshop(),
      hideChat: () => undefined,
      quit: () => undefined
    });
    expect(characterChannel, '应声明角色工作室窗口 IPC').toBeTypeOf('string');
    if (!characterChannel) return;
    await expect(handlers.get(characterChannel)?.({}, {
      moveTo: { x: 100, y: 100 }
    })).rejects.toMatchObject({ code: 'CHARACTER_INPUT_INVALID' });
    expect(sequence).toEqual([]);

    await handlers.get(characterChannel)?.({}, {});

    expect(sequence).toEqual(['reuse', 'show', 'focus']);
  });

  test('角色工作室并发 ensure 共享同一创建 Promise 且加载成功后才发布', async () => {
    const module = await loadWindowCommandsModule();
    expect(module, '应提供加载成功后发布窗口的管理器').not.toBeNull();
    if (!module) return;

    let releaseLoad: (() => void) | undefined;
    const loaded = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const sequence: string[] = [];
    const candidate = {
      isDestroyed: () => false,
      destroy: () => sequence.push('destroy')
    };
    const manager = module.createLoadBeforePublishWindow({
      create: () => {
        sequence.push('create');
        return candidate;
      },
      prepare: () => sequence.push('prepare'),
      load: async () => {
        sequence.push('load');
        await loaded;
      }
    });

    const first = manager.ensure();
    const second = manager.ensure();

    expect(first).toBe(second);
    expect(manager.getCurrent()).toBeNull();
    expect(sequence).toEqual(['create', 'prepare', 'load']);

    releaseLoad?.();
    await expect(first).resolves.toBe(candidate);
    expect(manager.getCurrent()).toBe(candidate);
  });

  test('角色工作室加载失败会销毁候选并允许后续 ensure 重建', async () => {
    const module = await loadWindowCommandsModule();
    expect(module, '应提供加载失败可重试的窗口管理器').not.toBeNull();
    if (!module) return;

    const destroyed: number[] = [];
    let created = 0;
    const manager = module.createLoadBeforePublishWindow({
      create: () => {
        const index = created++;
        return {
          index,
          isDestroyed: () => destroyed.includes(index),
          destroy: () => destroyed.push(index)
        };
      },
      prepare: () => undefined,
      load: async (window) => {
        if (window.index === 0) throw new Error('LOAD_FAILED');
      }
    });

    await expect(manager.ensure()).rejects.toThrow('LOAD_FAILED');
    expect(manager.getCurrent()).toBeNull();
    expect(destroyed).toEqual([0]);

    await expect(manager.ensure()).resolves.toMatchObject({ index: 1 });
    expect(manager.getCurrent()).toMatchObject({ index: 1 });
    expect(created).toBe(2);
  });

  test('角色广播隔离销毁目标与 send 异常并继续发送其余窗口', async () => {
    const module = await loadWindowCommandsModule();
    expect(module, '应提供逐窗口隔离的角色广播').not.toBeNull();
    if (!module) return;

    const received: string[] = [];
    const target = (
      name: string,
      options: { windowDestroyed?: boolean; contentsDestroyed?: boolean; throws?: boolean } = {}
    ) => ({
      isDestroyed: () => options.windowDestroyed ?? false,
      webContents: {
        isDestroyed: () => options.contentsDestroyed ?? false,
        send: () => {
          received.push(name);
          if (options.throws) throw new Error('SEND_FAILED');
        }
      }
    });

    expect(() => module.broadcastCharacterEvent([
      target('first', { throws: true }),
      target('window-destroyed', { windowDestroyed: true }),
      target('contents-destroyed', { contentsDestroyed: true }),
      target('second')
    ], 'character:event', { type: 'index-changed' })).not.toThrow();

    expect(received).toEqual(['first', 'second']);
  });

  test('删除后触发旧快速切换回调会捕获拒绝且不产生悬空 Promise', async () => {
    const module = await loadWindowCommandsModule();
    expect(module, '应提供集中捕获错误的快速切换命令').not.toBeNull();
    if (!module) return;

    const reportError = vi.fn();
    const activate = vi.fn(async () => {
      throw new Error('CHARACTER_NOT_FOUND');
    });
    const staleClick = module.createCharacterQuickSwitchCommand(
      'deleted-character',
      activate,
      reportError
    );

    expect(staleClick()).toBeUndefined();
    await vi.waitFor(() => expect(reportError).toHaveBeenCalledOnce());
    expect(activate).toHaveBeenCalledWith('deleted-character');
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'CHARACTER_NOT_FOUND' })
    );
  });
});
