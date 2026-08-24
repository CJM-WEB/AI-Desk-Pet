import type { IpcMain } from 'electron';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ipcChannels } from '../src/shared/ipc-channels';
import { registerPetWindowInteractionIpc } from '../src/main/ipc/register-ipc';
import { PetWindowInteractionController } from
  '../src/main/windows/pet-window-interaction-controller';

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

function createIpcMain() {
  const handlers = new Map<string, IpcHandler>();
  return {
    handlers,
    ipcMain: {
      removeHandler: (channel: string) => handlers.delete(channel),
      handle: (channel: string, handler: IpcHandler) => handlers.set(channel, handler)
    } as unknown as IpcMain
  };
}

function createControllerFixture() {
  let destroyed = false;
  let cursor = { x: 100, y: 100 };
  let bounds = { x: 20, y: 30, width: 180, height: 220 };
  let workAreas = [
    { x: 0, y: 0, width: 400, height: 400 }
  ];
  const setIgnoreMouseEvents = vi.fn();
  const setPosition = vi.fn((x: number, y: number) => {
    bounds = { ...bounds, x, y };
  });
  const motion = {
    beginUserMove: vi.fn(),
    endUserMove: vi.fn()
  };
  const controller = new PetWindowInteractionController({
    window: {
      getBounds: () => bounds,
      setPosition,
      setIgnoreMouseEvents,
      isDestroyed: () => destroyed
    },
    screen: {
      getCursorScreenPoint: () => cursor,
      getDisplayNearestPoint: (point: { x: number; y: number }) => ({
        workArea: workAreas.find(candidate => (
          point.x >= candidate.x
          && point.x < candidate.x + candidate.width
          && point.y >= candidate.y
          && point.y < candidate.y + candidate.height
        )) ?? workAreas[0]!
      })
    },
    motion
  });
  return {
    controller,
    motion,
    setIgnoreMouseEvents,
    setPosition,
    setCursor: (next: { x: number; y: number }) => { cursor = next; },
    setWorkAreas: (next: typeof workAreas) => { workAreas = next; },
    destroyWindow: () => { destroyed = true; }
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Main 桌宠窗口交互控制器', () => {
  test('只读探针仅返回穿透和拖拽两个布尔状态', () => {
    vi.useFakeTimers();
    const fixture = createControllerFixture();

    expect(fixture.controller.getProbe()).toEqual({
      passthrough: true,
      dragging: false
    });
    fixture.controller.setPassthrough(false);
    fixture.controller.beginDrag();
    expect(fixture.controller.getProbe()).toEqual({
      passthrough: false,
      dragging: true
    });
    fixture.controller.endDrag('released');
    expect(Object.keys(fixture.controller.getProbe()).sort()).toEqual([
      'dragging',
      'passthrough'
    ]);
  });

  test('默认开启穿透并保留 Windows mousemove 转发，关闭时不携带 forward', () => {
    const fixture = createControllerFixture();

    expect(fixture.setIgnoreMouseEvents).toHaveBeenNthCalledWith(
      1,
      true,
      { forward: true }
    );
    fixture.controller.setPassthrough(false);
    expect(fixture.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);
  });

  test('拖拽只读取系统光标差值，横向越界时只钳制 x 轴且重复 begin 幂等', () => {
    vi.useFakeTimers();
    const fixture = createControllerFixture();

    fixture.controller.beginDrag();
    fixture.controller.beginDrag();
    fixture.setCursor({ x: 500, y: 120 });
    vi.advanceTimersByTime(16);

    expect(fixture.motion.beginUserMove).toHaveBeenCalledOnce();
    expect(fixture.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);
    expect(fixture.setPosition).toHaveBeenCalledWith(220, 50);
    fixture.controller.endDrag('released');
    expect(fixture.motion.endUserMove).toHaveBeenCalledOnce();
  });

  test('纵向越界时只钳制 y 轴，不把窗口跳到右下角', () => {
    vi.useFakeTimers();
    const fixture = createControllerFixture();
    fixture.controller.beginDrag();
    fixture.setCursor({ x: 120, y: 500 });

    vi.advanceTimersByTime(16);

    expect(fixture.setPosition).toHaveBeenCalledWith(40, 180);
  });

  test('跨到负坐标显示器时按光标最近工作区逐轴钳制', () => {
    vi.useFakeTimers();
    const fixture = createControllerFixture();
    fixture.setWorkAreas([
      { x: 0, y: 0, width: 400, height: 400 },
      { x: -500, y: -100, width: 500, height: 500 }
    ]);
    fixture.controller.beginDrag();
    fixture.setCursor({ x: -450, y: 50 });

    vi.advanceTimersByTime(16);

    expect(fixture.setPosition).toHaveBeenCalledWith(-500, -20);
  });

  test('拖拽结束恢复最后已知命中状态，期间命中更新不会打断拖拽', () => {
    vi.useFakeTimers();
    const fixture = createControllerFixture();
    fixture.controller.setPassthrough(false);
    fixture.controller.beginDrag();
    fixture.controller.setPassthrough(true);

    expect(fixture.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);
    fixture.controller.endDrag('released');
    expect(fixture.setIgnoreMouseEvents).toHaveBeenLastCalledWith(
      true,
      { forward: true }
    );
  });

  test.each(['released', 'cancelled', 'timeout', 'disposed'] as const)(
    '%s 结束会话时清理计时器且 motion 只结束一次',
    reason => {
      vi.useFakeTimers();
      const fixture = createControllerFixture();
      fixture.controller.beginDrag();

      fixture.controller.endDrag(reason);
      fixture.controller.endDrag(reason);
      vi.advanceTimersByTime(31_000);

      expect(fixture.motion.endUserMove).toHaveBeenCalledOnce();
      expect(fixture.setPosition).not.toHaveBeenCalled();
    }
  );

  test.each(['released', 'cancelled', 'timeout', 'disposed'] as const)(
    '无活动会话时 %s 直接返回且没有窗口、motion 或 timer 副作用',
    reason => {
      vi.useFakeTimers();
      const fixture = createControllerFixture();
      fixture.setIgnoreMouseEvents.mockClear();
      fixture.setPosition.mockClear();
      fixture.motion.beginUserMove.mockClear();
      fixture.motion.endUserMove.mockClear();

      fixture.controller.endDrag(reason);

      expect(fixture.setIgnoreMouseEvents).not.toHaveBeenCalled();
      expect(fixture.setPosition).not.toHaveBeenCalled();
      expect(fixture.motion.beginUserMove).not.toHaveBeenCalled();
      expect(fixture.motion.endUserMove).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  test('30 秒兜底自动结束，窗口销毁后的更新不抛出', () => {
    vi.useFakeTimers();
    const timedOut = createControllerFixture();
    timedOut.controller.setPassthrough(false);
    timedOut.controller.beginDrag();
    vi.advanceTimersByTime(30_000);
    expect(timedOut.motion.endUserMove).toHaveBeenCalledOnce();
    expect(timedOut.controller.getProbe()).toEqual({
      passthrough: true,
      dragging: false
    });
    expect(timedOut.setIgnoreMouseEvents).toHaveBeenLastCalledWith(
      true,
      { forward: true }
    );

    const destroyed = createControllerFixture();
    destroyed.controller.beginDrag();
    destroyed.destroyWindow();
    expect(() => vi.advanceTimersByTime(16)).not.toThrow();
    expect(destroyed.motion.endUserMove).toHaveBeenCalledOnce();
    expect(destroyed.setPosition).not.toHaveBeenCalled();
  });

  test('非正常取消不恢复拖拽前的非穿透状态', () => {
    vi.useFakeTimers();
    const fixture = createControllerFixture();
    fixture.controller.setPassthrough(false);
    fixture.controller.beginDrag();

    fixture.controller.endDrag('cancelled');

    expect(fixture.controller.getProbe()).toEqual({
      passthrough: true,
      dragging: false
    });
    expect(fixture.setIgnoreMouseEvents).toHaveBeenLastCalledWith(
      true,
      { forward: true }
    );
  });

  test('计时器创建中途失败时清理已启动会话并允许重新拖拽', () => {
    vi.useFakeTimers();
    const fixture = createControllerFixture();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
      .mockImplementationOnce(() => {
        throw new Error('TIMER_UNAVAILABLE');
      });

    fixture.controller.beginDrag();
    setTimeoutSpy.mockRestore();

    expect(fixture.motion.endUserMove).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    fixture.controller.beginDrag();
    expect(fixture.motion.beginUserMove).toHaveBeenCalledTimes(2);
  });

  test('异常回退为穿透，dispose 后不再操作窗口或重新开始拖拽', () => {
    vi.useFakeTimers();
    const fixture = createControllerFixture();
    fixture.controller.beginDrag();
    fixture.controller.dispose();
    fixture.setIgnoreMouseEvents.mockClear();
    fixture.motion.beginUserMove.mockClear();

    fixture.controller.setPassthrough(false);
    fixture.controller.beginDrag();

    expect(fixture.setIgnoreMouseEvents).not.toHaveBeenCalled();
    expect(fixture.motion.beginUserMove).not.toHaveBeenCalled();
  });
});

describe('受限桌宠窗口交互 IPC', () => {
  test('只接受 pet sender 与严格布尔穿透负载', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const petSender = { isDestroyed: () => false };
    const controller = {
      setPassthrough: vi.fn(),
      beginDrag: vi.fn(),
      endDrag: vi.fn(),
      dispose: vi.fn()
    };
    registerPetWindowInteractionIpc(
      ipcMain,
      controller,
      petSender as never,
      vi.fn()
    );
    const handler = handlers.get(ipcChannels.petMousePassthroughSet);

    await expect(handler?.({ sender: petSender }, { ignore: true })).resolves.toBeUndefined();
    expect(controller.setPassthrough).toHaveBeenCalledWith(true);
    for (const payload of [
      { ignore: 'true' },
      { ignore: {} },
      { ignore: true, command: 'app:quit' },
      'app:quit'
    ]) {
      await expect(handler?.({ sender: petSender }, payload)).rejects.toThrow(
        'PET_WINDOW_INTERACTION_INPUT_INVALID'
      );
    }
    await expect(
      handler?.({ sender: petSender }, { ignore: true }, 'app:quit')
    ).rejects.toThrow('PET_WINDOW_INTERACTION_INPUT_INVALID');
    await expect(
      handler?.({ sender: { isDestroyed: () => false } }, { ignore: true })
    ).rejects.toThrow('PET_WINDOW_INTERACTION_SENDER_INVALID');
  });

  test('begin/end/menu 不接收 Renderer 坐标或命令，且只调用固定 Main 动作', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const petSender = { isDestroyed: () => false };
    const controller = {
      setPassthrough: vi.fn(),
      beginDrag: vi.fn(),
      endDrag: vi.fn(),
      dispose: vi.fn()
    };
    const openContextMenu = vi.fn();
    registerPetWindowInteractionIpc(
      ipcMain,
      controller,
      petSender as never,
      openContextMenu
    );
    const begin = handlers.get(ipcChannels.petDragBegin);
    const end = handlers.get(ipcChannels.petDragEnd);
    const menu = handlers.get(ipcChannels.petContextMenuOpen);

    await expect(begin?.({ sender: petSender })).resolves.toBeUndefined();
    await expect(end?.({ sender: petSender })).resolves.toBeUndefined();
    await expect(menu?.({ sender: petSender })).resolves.toBeUndefined();
    expect(controller.beginDrag).toHaveBeenCalledOnce();
    expect(controller.endDrag).toHaveBeenCalledWith('released');
    expect(openContextMenu).toHaveBeenCalledOnce();

    for (const [handler, payload] of [
      [begin, { x: 10, y: 20 }],
      [end, 'cancelled'],
      [menu, 'app:quit']
    ] as const) {
      await expect(handler?.({ sender: petSender }, payload)).rejects.toThrow(
        'PET_WINDOW_INTERACTION_INPUT_INVALID'
      );
    }
  });

  test('viewport 与 scale 只接受 pet sender 的严格窗口局部矩形和单档输入', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const petSender = { isDestroyed: () => false };
    const geometry = {
      commitViewport: vi.fn().mockResolvedValue(undefined),
      stepScale: vi.fn().mockResolvedValue(undefined)
    };
    registerPetWindowInteractionIpc(
      ipcMain,
      { setPassthrough: vi.fn(), beginDrag: vi.fn(), endDrag: vi.fn(), dispose: vi.fn() },
      petSender as never,
      vi.fn(),
      { geometry }
    );
    const viewport = handlers.get(ipcChannels.petViewportCommit);
    const scale = handlers.get(ipcChannels.petScaleStep);
    const local = { viewportInWindowDip: { x: 20, y: 10, width: 100, height: 100 } };

    await expect(viewport?.({ sender: petSender }, local)).resolves.toBeUndefined();
    await expect(scale?.({ sender: petSender }, { step: 1 })).resolves.toBeUndefined();
    expect(geometry.commitViewport).toHaveBeenCalledWith(local);
    expect(geometry.stepScale).toHaveBeenCalledWith({ step: 1 });
    for (const payload of [
      { ...local, characterId: 'pet-a' },
      { ...local, globalX: 300 },
      { viewportInWindowDip: { ...local.viewportInWindowDip, width: 0 } },
      { viewportInWindowDip: { ...local.viewportInWindowDip, right: 120 } }
    ]) {
      await expect(viewport?.({ sender: petSender }, payload)).rejects.toThrow(
        'PET_WINDOW_INTERACTION_INPUT_INVALID'
      );
    }
    for (const payload of [{ step: 0 }, { step: 2 }, { step: 1, scale: 1.1 }]) {
      await expect(scale?.({ sender: petSender }, payload)).rejects.toThrow(
        'PET_WINDOW_INTERACTION_INPUT_INVALID'
      );
    }
    await expect(viewport?.({ sender: {} }, local)).rejects.toThrow(
      'PET_WINDOW_INTERACTION_SENDER_INVALID'
    );
  });

  test('E2E 探针仅在显式启用时注册，且拒绝输入和非桌宠 sender', async () => {
    const enabled = createIpcMain();
    const disabled = createIpcMain();
    const petSender = { isDestroyed: () => false };
    const controller = {
      setPassthrough: vi.fn(),
      beginDrag: vi.fn(),
      endDrag: vi.fn(),
      dispose: vi.fn(),
      getProbe: vi.fn(() => ({ passthrough: true, dragging: false }))
    };
    registerPetWindowInteractionIpc(
      enabled.ipcMain,
      controller,
      petSender as never,
      vi.fn(),
      { enableE2eProbe: true }
    );
    registerPetWindowInteractionIpc(
      disabled.ipcMain,
      controller,
      petSender as never,
      vi.fn()
    );

    const probe = enabled.handlers.get(ipcChannels.petInteractionProbeGet);
    await expect(probe?.({ sender: petSender })).resolves.toEqual({
      passthrough: true,
      dragging: false
    });
    await expect(probe?.({ sender: petSender }, { x: 1 })).rejects.toThrow(
      'PET_WINDOW_INTERACTION_INPUT_INVALID'
    );
    await expect(
      probe?.({ sender: { isDestroyed: () => false } })
    ).rejects.toThrow('PET_WINDOW_INTERACTION_SENDER_INVALID');
    expect(disabled.handlers.has(ipcChannels.petInteractionProbeGet)).toBe(false);
  });

  test('失效 pet sender 会被所有 handler 拒绝', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const petSender = { isDestroyed: () => true };
    registerPetWindowInteractionIpc(
      ipcMain,
      {
        setPassthrough: vi.fn(),
        beginDrag: vi.fn(),
        endDrag: vi.fn(),
        dispose: vi.fn()
      },
      petSender as never,
      vi.fn()
    );

    for (const [channel, args] of [
      [ipcChannels.petMousePassthroughSet, [{ ignore: true }]],
      [ipcChannels.petDragBegin, []],
      [ipcChannels.petDragEnd, []],
      [ipcChannels.petContextMenuOpen, []]
    ] as const) {
      await expect(
        handlers.get(channel)?.({ sender: petSender }, ...args)
      ).rejects.toThrow('PET_WINDOW_INTERACTION_SENDER_INVALID');
    }
  });
});
