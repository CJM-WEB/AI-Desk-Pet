// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  PetInteractionController,
  createElementBoundsHitTestPort,
  type CharacterHitTestPort
} from '../src/renderer/src/pet/pet-interaction-controller';
import type { PetWindowInteractionApi } from '../src/shared/pet-window-interaction';

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
  test('默认穿透并按最新坐标与动画帧切换可见像素命中', () => {
    const fixture = createFixture();
    expect(fixture.api.setPetMousePassthrough).toHaveBeenNthCalledWith(1, true);
    fixture.controller.setHitTestPort(fixture.port);
    fixture.controller.handlePointerMove({ x: 12, y: 18 });

    fixture.setHit(true);
    fixture.notifyFrame();
    expect(fixture.port.hitTest).toHaveBeenLastCalledWith({ x: 12, y: 18 });
    expect(fixture.api.setPetMousePassthrough).toHaveBeenLastCalledWith(false);

    fixture.setHit(false);
    fixture.notifyFrame();
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

  test('仅当前可见像素上的左键开始拖拽并锁定到释放', () => {
    const fixture = createFixture();
    fixture.setHit(true);
    fixture.controller.setHitTestPort(fixture.port);
    fixture.controller.handlePointerMove({ x: 20, y: 30 });
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

    await Promise.resolve();
    await Promise.resolve();
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
    await Promise.resolve();
    await Promise.resolve();

    expect(setPetMousePassthrough).toHaveBeenCalledTimes(2);
    expect(setPetMousePassthrough).toHaveBeenNthCalledWith(1, true);
    expect(setPetMousePassthrough).toHaveBeenNthCalledWith(2, true);
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
    const listener = vi.fn();
    const unsubscribe = createElementBoundsHitTestPort(element).subscribe(listener);

    resizeCallback();
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    resizeCallback();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledOnce();
  });
});
