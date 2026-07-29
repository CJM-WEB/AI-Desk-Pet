// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  PetInteractionController,
  createElementBoundsHitTestPort,
  type CharacterHitTestPort
} from '../src/renderer/src/pet/pet-interaction-controller';
import type { PetWindowInteractionApi } from '../src/shared/pet-window-interaction';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function createFixture() {
  const api: PetWindowInteractionApi = {
    setPetMousePassthrough: vi.fn().mockResolvedValue(undefined),
    beginPetDrag: vi.fn().mockResolvedValue(undefined),
    endPetDrag: vi.fn().mockResolvedValue(undefined),
    openPetContextMenu: vi.fn().mockResolvedValue(undefined)
  };
  let hit = false;
  let notify = () => undefined;
  const unsubscribe = vi.fn();
  const port: CharacterHitTestPort = {
    hitTest: vi.fn(() => hit),
    subscribe: vi.fn(listener => {
      notify = listener;
      return unsubscribe;
    })
  };
  return {
    api,
    controller: new PetInteractionController(api),
    port,
    unsubscribe,
    setHit: (next: boolean) => {
      hit = next;
    },
    notifyFrame: () => notify()
  };
}

describe('Renderer 桌宠交互状态机', () => {
  test('旧 true 待确认时串行等待并在完成后发送最新 false', async () => {
    const initial = deferred<void>();
    const visible = deferred<void>();
    const setPetMousePassthrough = vi.fn()
      .mockImplementationOnce(() => initial.promise)
      .mockImplementationOnce(() => visible.promise);
    const api = {
      setPetMousePassthrough,
      beginPetDrag: vi.fn().mockResolvedValue(undefined),
      endPetDrag: vi.fn().mockResolvedValue(undefined),
      openPetContextMenu: vi.fn().mockResolvedValue(undefined)
    } satisfies PetWindowInteractionApi;
    const controller = new PetInteractionController(api);
    controller.setHitTestPort({
      hitTest: () => true,
      subscribe: () => () => undefined
    });
    controller.handlePointerMove({ x: 1, y: 1 });

    expect(setPetMousePassthrough).toHaveBeenCalledTimes(1);
    expect(setPetMousePassthrough).toHaveBeenNthCalledWith(1, true);
    initial.resolve();
    await flushPromises();
    expect(setPetMousePassthrough).toHaveBeenNthCalledWith(2, false);
    visible.resolve();
    await flushPromises();
    expect(setPetMousePassthrough).toHaveBeenCalledTimes(2);
  });

  test('旧 true 晚失败不得覆盖等待中的最新 false', async () => {
    const initial = deferred<void>();
    const visible = deferred<void>();
    const setPetMousePassthrough = vi.fn()
      .mockImplementationOnce(() => initial.promise)
      .mockImplementationOnce(() => visible.promise);
    const api = {
      setPetMousePassthrough,
      beginPetDrag: vi.fn().mockResolvedValue(undefined),
      endPetDrag: vi.fn().mockResolvedValue(undefined),
      openPetContextMenu: vi.fn().mockResolvedValue(undefined)
    } satisfies PetWindowInteractionApi;
    const controller = new PetInteractionController(api);
    controller.setHitTestPort({
      hitTest: () => true,
      subscribe: () => () => undefined
    });
    controller.handlePointerMove({ x: 2, y: 2 });

    initial.reject(new Error('LATE_FAILURE'));
    await flushPromises();
    expect(setPetMousePassthrough).toHaveBeenCalledTimes(2);
    expect(setPetMousePassthrough).toHaveBeenNthCalledWith(2, false);
    visible.resolve();
    await flushPromises();
    expect(setPetMousePassthrough).toHaveBeenCalledTimes(2);
  });

  test('快速 true 到 false 再回 true 时跳过已过时的中间状态', async () => {
    const initial = deferred<void>();
    const setPetMousePassthrough = vi.fn(() => initial.promise);
    let hit = true;
    let notify: () => void = () => undefined;
    const api = {
      setPetMousePassthrough,
      beginPetDrag: vi.fn().mockResolvedValue(undefined),
      endPetDrag: vi.fn().mockResolvedValue(undefined),
      openPetContextMenu: vi.fn().mockResolvedValue(undefined)
    } satisfies PetWindowInteractionApi;
    const controller = new PetInteractionController(api);
    controller.setHitTestPort({
      hitTest: () => hit,
      subscribe: listener => {
        notify = listener;
        return () => undefined;
      }
    });
    controller.handlePointerMove({ x: 3, y: 3 });
    hit = false;
    notify();

    expect(setPetMousePassthrough).toHaveBeenCalledTimes(1);
    initial.resolve();
    await flushPromises();
    expect(setPetMousePassthrough).toHaveBeenCalledTimes(1);
    expect(setPetMousePassthrough).toHaveBeenCalledWith(true);
  });

  test('默认穿透并按最新坐标与动画帧切换可见像素命中', async () => {
    const fixture = createFixture();
    expect(fixture.api.setPetMousePassthrough).toHaveBeenNthCalledWith(1, true);
    fixture.controller.setHitTestPort(fixture.port);
    fixture.controller.handlePointerMove({ x: 12, y: 18 });

    fixture.setHit(true);
    fixture.notifyFrame();
    expect(fixture.port.hitTest).toHaveBeenLastCalledWith({ x: 12, y: 18 });
    await flushPromises();
    expect(fixture.api.setPetMousePassthrough).toHaveBeenLastCalledWith(false);

    fixture.setHit(false);
    fixture.notifyFrame();
    await flushPromises();
    expect(fixture.api.setPetMousePassthrough).toHaveBeenLastCalledWith(true);
  });

  test('命中异常安全穿透且替换端口取消旧订阅', () => {
    const fixture = createFixture();
    fixture.controller.setHitTestPort(fixture.port);
    fixture.controller.handlePointerMove({ x: 1, y: 2 });
    fixture.controller.setHitTestPort({
      hitTest: () => {
        throw new Error('HIT_TEST_FAILED');
      },
      subscribe: () => () => undefined
    });

    expect(fixture.unsubscribe).toHaveBeenCalledOnce();
    expect(fixture.api.setPetMousePassthrough).toHaveBeenLastCalledWith(true);
  });

  test('仅当前可见像素上的左键开始拖拽并锁定到释放', async () => {
    const fixture = createFixture();
    fixture.setHit(true);
    fixture.controller.setHitTestPort(fixture.port);
    fixture.controller.handlePointerMove({ x: 20, y: 30 });
    await flushPromises();
    fixture.controller.handlePointerDown({ button: 1, pointerId: 4 });
    fixture.controller.handlePointerDown({ button: 0, pointerId: 5 });
    fixture.controller.handlePointerDown({ button: 0, pointerId: 5 });
    expect(fixture.api.beginPetDrag).toHaveBeenCalledOnce();

    fixture.setHit(false);
    fixture.controller.handlePointerMove({ x: 100, y: 110 });
    fixture.notifyFrame();
    fixture.controller.setHitTestPort(null);
    expect(fixture.api.setPetMousePassthrough).toHaveBeenLastCalledWith(false);

    fixture.controller.handlePointerUp();
    fixture.controller.handlePointerUp();
    await flushPromises();
    expect(fixture.api.endPetDrag).toHaveBeenCalledOnce();
    expect(fixture.api.setPetMousePassthrough).toHaveBeenLastCalledWith(true);
  });

  test('透明像素不拖拽且 cancel 幂等结束活动会话', () => {
    const fixture = createFixture();
    fixture.controller.setHitTestPort(fixture.port);
    fixture.controller.handlePointerMove({ x: 8, y: 9 });
    fixture.controller.handlePointerDown({ button: 0, pointerId: 1 });
    expect(fixture.api.beginPetDrag).not.toHaveBeenCalled();

    fixture.setHit(true);
    fixture.notifyFrame();
    fixture.controller.handlePointerDown({ button: 0, pointerId: 2 });
    fixture.setHit(false);
    fixture.controller.handlePointerCancel();
    fixture.controller.handlePointerCancel();
    expect(fixture.api.endPetDrag).toHaveBeenCalledOnce();
    expect(fixture.api.setPetMousePassthrough).toHaveBeenLastCalledWith(true);
  });

  test('右键只在可见像素命中时调用一次受限菜单入口', () => {
    const fixture = createFixture();
    fixture.controller.setHitTestPort(fixture.port);
    fixture.controller.handlePointerMove({ x: 6, y: 7 });
    fixture.controller.handleContextMenu();
    expect(fixture.api.openPetContextMenu).not.toHaveBeenCalled();

    fixture.setHit(true);
    fixture.controller.handleContextMenu();
    expect(fixture.api.openPetContextMenu).toHaveBeenCalledOnce();
  });

  test('异步关闭穿透失败后重试安全穿透且吞掉拒绝', async () => {
    const setPetMousePassthrough = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('IPC_FAILED'))
      .mockResolvedValue(undefined);
    const api: PetWindowInteractionApi = {
      setPetMousePassthrough,
      beginPetDrag: vi.fn().mockResolvedValue(undefined),
      endPetDrag: vi.fn().mockResolvedValue(undefined),
      openPetContextMenu: vi.fn().mockResolvedValue(undefined)
    };
    const controller = new PetInteractionController(api);
    controller.setHitTestPort({
      hitTest: () => true,
      subscribe: () => () => undefined
    });
    controller.handlePointerMove({ x: 1, y: 1 });

    await flushPromises();
    expect(setPetMousePassthrough).toHaveBeenLastCalledWith(true);
  });

  test('安全穿透请求自身失败时有界重试一次且不形成拒绝循环', async () => {
    const setPetMousePassthrough = vi.fn()
      .mockRejectedValueOnce(new Error('IPC_FAILED'))
      .mockResolvedValueOnce(undefined);
    const api: PetWindowInteractionApi = {
      setPetMousePassthrough,
      beginPetDrag: vi.fn().mockResolvedValue(undefined),
      endPetDrag: vi.fn().mockResolvedValue(undefined),
      openPetContextMenu: vi.fn().mockResolvedValue(undefined)
    };

    new PetInteractionController(api);
    await flushPromises();

    expect(setPetMousePassthrough).toHaveBeenCalledTimes(2);
    expect(setPetMousePassthrough).toHaveBeenNthCalledWith(1, true);
    expect(setPetMousePassthrough).toHaveBeenNthCalledWith(2, true);
  });

  test('安全穿透连续失败后由新的命中重算重新发起并恢复', async () => {
    const setPetMousePassthrough = vi.fn()
      .mockRejectedValueOnce(new Error('IPC_FAILED'))
      .mockRejectedValueOnce(new Error('IPC_FAILED'))
      .mockResolvedValueOnce(undefined);
    const api: PetWindowInteractionApi = {
      setPetMousePassthrough,
      beginPetDrag: vi.fn().mockResolvedValue(undefined),
      endPetDrag: vi.fn().mockResolvedValue(undefined),
      openPetContextMenu: vi.fn().mockResolvedValue(undefined)
    };
    const controller = new PetInteractionController(api);
    await flushPromises();
    expect(setPetMousePassthrough).toHaveBeenCalledTimes(2);

    controller.handlePointerMove({ x: 4, y: 5 });
    await flushPromises();

    expect(setPetMousePassthrough).toHaveBeenCalledTimes(3);
    expect(setPetMousePassthrough).toHaveBeenNthCalledWith(3, true);
  });

  test('安全穿透阻塞后 dispose 仍至少重新提交一次安全状态', async () => {
    const setPetMousePassthrough = vi.fn()
      .mockRejectedValueOnce(new Error('IPC_FAILED'))
      .mockRejectedValueOnce(new Error('IPC_FAILED'))
      .mockResolvedValueOnce(undefined);
    const api: PetWindowInteractionApi = {
      setPetMousePassthrough,
      beginPetDrag: vi.fn().mockResolvedValue(undefined),
      endPetDrag: vi.fn().mockResolvedValue(undefined),
      openPetContextMenu: vi.fn().mockResolvedValue(undefined)
    };
    const controller = new PetInteractionController(api);
    await flushPromises();
    expect(setPetMousePassthrough).toHaveBeenCalledTimes(2);

    controller.dispose();
    await flushPromises();

    expect(setPetMousePassthrough).toHaveBeenCalledTimes(3);
    expect(setPetMousePassthrough).toHaveBeenNthCalledWith(3, true);
  });

  test('持续失败时每次外部安全重算只开启一次有界重试', async () => {
    const setPetMousePassthrough = vi.fn().mockRejectedValue(
      new Error('IPC_FAILED')
    );
    const api: PetWindowInteractionApi = {
      setPetMousePassthrough,
      beginPetDrag: vi.fn().mockResolvedValue(undefined),
      endPetDrag: vi.fn().mockResolvedValue(undefined),
      openPetContextMenu: vi.fn().mockResolvedValue(undefined)
    };
    const controller = new PetInteractionController(api);
    await flushPromises();
    expect(setPetMousePassthrough).toHaveBeenCalledTimes(2);

    controller.handlePointerMove({ x: 6, y: 7 });
    await flushPromises();
    expect(setPetMousePassthrough).toHaveBeenCalledTimes(4);
    await flushPromises();
    expect(setPetMousePassthrough).toHaveBeenCalledTimes(4);

    controller.handlePointerMove({ x: 8, y: 9 });
    await flushPromises();
    expect(setPetMousePassthrough).toHaveBeenCalledTimes(6);
    await flushPromises();
    expect(setPetMousePassthrough).toHaveBeenCalledTimes(6);
  });

  test('dispose 取消订阅、结束拖拽并让后续事件无副作用', () => {
    const fixture = createFixture();
    fixture.setHit(true);
    fixture.controller.setHitTestPort(fixture.port);
    fixture.controller.handlePointerMove({ x: 10, y: 10 });
    fixture.controller.handlePointerDown({ button: 0, pointerId: 3 });
    fixture.controller.dispose();

    expect(fixture.unsubscribe).toHaveBeenCalledOnce();
    expect(fixture.api.endPetDrag).toHaveBeenCalledOnce();
    expect(fixture.api.setPetMousePassthrough).toHaveBeenLastCalledWith(true);
    vi.mocked(fixture.api.setPetMousePassthrough).mockClear();
    vi.mocked(fixture.api.beginPetDrag).mockClear();
    fixture.controller.handlePointerMove({ x: 20, y: 20 });
    fixture.controller.handlePointerDown({ button: 0, pointerId: 4 });
    fixture.notifyFrame();
    expect(fixture.api.setPetMousePassthrough).not.toHaveBeenCalled();
    expect(fixture.api.beginPetDrag).not.toHaveBeenCalled();
  });
});

describe('CSS 备用角色几何命中端口', () => {
  test('只命中可见非零元素的标准半开边界', () => {
    const element = document.createElement('span');
    document.body.appendChild(element);
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
      x: 10,
      y: 20,
      left: 10,
      top: 20,
      right: 40,
      bottom: 60,
      width: 30,
      height: 40,
      toJSON: () => ({})
    });
    const port = createElementBoundsHitTestPort(element);

    expect(port.hitTest({ x: 10, y: 20 })).toBe(true);
    expect(port.hitTest({ x: 39.99, y: 59.99 })).toBe(true);
    expect(port.hitTest({ x: 40, y: 30 })).toBe(false);
    expect(port.hitTest({ x: 20, y: 60 })).toBe(false);
    expect(port.hitTest({ x: Number.NaN, y: 30 })).toBe(false);
    element.hidden = true;
    expect(port.hitTest({ x: 20, y: 30 })).toBe(false);
    element.hidden = false;
    element.remove();
    expect(port.hitTest({ x: 20, y: 30 })).toBe(false);
  });

  test('ResizeObserver 通知布局变化且取消订阅后不再通知', () => {
    let resizeCallback: () => void = () => undefined;
    const disconnect = vi.fn();
    class ResizeObserverFake {
      constructor(callback: () => void) {
        resizeCallback = callback;
      }
      observe = vi.fn();
      disconnect = disconnect;
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverFake);
    const element = document.createElement('span');
    document.body.appendChild(element);
    let width = 20;
    vi.spyOn(element, 'getBoundingClientRect').mockImplementation(() => ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: width,
      bottom: 20,
      width,
      height: 20,
      toJSON: () => ({})
    }));
    const listener = vi.fn();
    const unsubscribe = createElementBoundsHitTestPort(element).subscribe(listener);

    width = 24;
    resizeCallback();
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    resizeCallback();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledOnce();
  });

  test('RAF 只在宽高不变但位置矩形变化时通知且取消后停止', () => {
    const frames: FrameRequestCallback[] = [];
    const cancelAnimationFrame = vi.fn();
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }));
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame);
    vi.stubGlobal('ResizeObserver', class {
      observe = vi.fn();
      disconnect = vi.fn();
    });
    let left = 10;
    let top = 20;
    const element = document.createElement('span');
    document.body.appendChild(element);
    vi.spyOn(element, 'getBoundingClientRect').mockImplementation(() => ({
      x: left,
      y: top,
      left,
      top,
      right: left + 30,
      bottom: top + 40,
      width: 30,
      height: 40,
      toJSON: () => ({})
    }));
    const listener = vi.fn();
    const unsubscribe = createElementBoundsHitTestPort(element).subscribe(listener);

    frames.shift()?.(0);
    expect(listener).not.toHaveBeenCalled();
    left = 14;
    top = 23;
    frames.shift()?.(16);
    expect(listener).toHaveBeenCalledOnce();
    frames.shift()?.(32);
    expect(listener).toHaveBeenCalledOnce();

    unsubscribe();
    frames.shift()?.(48);
    expect(cancelAnimationFrame).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledOnce();
  });
});
