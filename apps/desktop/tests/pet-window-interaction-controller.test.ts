import { expect, test, vi } from 'vitest';
import { PetWindowInteractionController } from
  '../src/main/windows/pet-window-interaction-controller';

test('Main 交互控制器按系统光标差值原子移动固定尺寸并在 end 前保持 owner', () => {
  const setIgnoreMouseEvents = vi.fn();
  const setBounds = vi.fn();
  const onDragStarted = vi.fn();
  const onDragEnded = vi.fn();
  let cursor = { x: 300, y: 200 };
  const controller = new PetWindowInteractionController({
    window: {
      setIgnoreMouseEvents,
      getBounds: () => ({ x: 100, y: 80, width: 180, height: 220 }),
      setBounds,
      isDestroyed: () => false
    },
    getCursorScreenPoint: () => cursor,
    onDragStarted,
    onDragEnded
  });

  controller.beginDrag();
  cursor = { x: 340, y: 260 };
  controller.updateDrag();
  expect(setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);
  expect(controller.getProbe()).toEqual({
    passthrough: false,
    dragging: true,
    mouseMoveHitCount: 0
  });
  expect(setBounds).toHaveBeenCalledWith({
    x: 140, y: 140, width: 180, height: 220
  });
  expect(onDragStarted).toHaveBeenCalledOnce();
  expect(onDragEnded).not.toHaveBeenCalled();
  controller.endDrag();
  expect(controller.getProbe().dragging).toBe(false);
  expect(onDragEnded).toHaveBeenCalledOnce();
});

test('后续拖拽即使系统返回漂移宽高也继续使用创建时固定尺寸', () => {
  const setBounds = vi.fn();
  let bounds = { x: 100, y: 80, width: 180, height: 220 };
  let cursor = { x: 300, y: 200 };
  const controller = new PetWindowInteractionController({
    window: {
      setIgnoreMouseEvents: vi.fn(),
      getBounds: () => bounds,
      setBounds,
      isDestroyed: () => false
    },
    getCursorScreenPoint: () => cursor
  });

  controller.beginDrag();
  cursor = { x: 310, y: 210 };
  controller.updateDrag();
  controller.endDrag();
  bounds = { x: 110, y: 90, width: 270, height: 330 };
  cursor = { x: 400, y: 300 };
  controller.beginDrag();
  cursor = { x: 420, y: 330 };
  controller.updateDrag();

  expect(setBounds).toHaveBeenLastCalledWith({
    x: 130,
    y: 120,
    width: 180,
    height: 220
  });
});

test('拖拽开始回调部分成功后抛错仍补偿 owner 并恢复安全穿透', () => {
  let owner = false;
  const setIgnoreMouseEvents = vi.fn();
  const controller = new PetWindowInteractionController({
    window: {
      setIgnoreMouseEvents,
      getBounds: () => ({ x: 100, y: 120, width: 180, height: 220 }),
      setBounds: vi.fn(),
      isDestroyed: () => false
    },
    getCursorScreenPoint: () => ({ x: 300, y: 240 }),
    onDragStarted: () => {
      owner = true;
      throw new Error('START_FAILED');
    },
    onDragEnded: () => { owner = false; }
  });

  controller.beginDrag();

  expect(owner).toBe(false);
  expect(controller.getProbe().dragging).toBe(false);
  expect(setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
});

test('拖拽 setBounds 失败时结束 owner 并恢复安全穿透', () => {
  let owner = false;
  const setIgnoreMouseEvents = vi.fn();
  const controller = new PetWindowInteractionController({
    window: {
      setIgnoreMouseEvents,
      getBounds: () => ({ x: 100, y: 120, width: 180, height: 220 }),
      setBounds: () => { throw new Error('SET_BOUNDS_FAILED'); },
      isDestroyed: () => false
    },
    getCursorScreenPoint: () => ({ x: 320, y: 260 }),
    onDragStarted: () => { owner = true; },
    onDragEnded: () => { owner = false; }
  });
  controller.beginDrag();

  controller.updateDrag();

  expect(owner).toBe(false);
  expect(controller.getProbe().dragging).toBe(false);
  expect(setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
});

test('拖拽结束回调清理后抛错仍完成控制器终态并恢复安全穿透', () => {
  let owner = false;
  const setIgnoreMouseEvents = vi.fn();
  const controller = new PetWindowInteractionController({
    window: {
      setIgnoreMouseEvents,
      getBounds: () => ({ x: 100, y: 120, width: 180, height: 220 }),
      setBounds: vi.fn(),
      isDestroyed: () => false
    },
    getCursorScreenPoint: () => ({ x: 320, y: 260 }),
    onDragStarted: () => { owner = true; },
    onDragEnded: () => {
      owner = false;
      throw new Error('END_FAILED');
    }
  });
  controller.beginDrag();

  expect(() => controller.endDrag()).not.toThrow();

  expect(owner).toBe(false);
  expect(controller.getProbe().dragging).toBe(false);
  expect(setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
});

test('拖拽更新发现窗口已销毁时立即释放 owner 并进入安全终态', () => {
  let owner = false;
  let destroyed = false;
  const controller = new PetWindowInteractionController({
    window: {
      setIgnoreMouseEvents: vi.fn(),
      getBounds: () => ({ x: 100, y: 120, width: 180, height: 220 }),
      setBounds: vi.fn(),
      isDestroyed: () => destroyed
    },
    getCursorScreenPoint: () => ({ x: 320, y: 260 }),
    onDragStarted: () => { owner = true; },
    onDragEnded: () => { owner = false; }
  });
  controller.beginDrag();
  destroyed = true;

  controller.updateDrag();

  expect(owner).toBe(false);
  expect(controller.getProbe()).toMatchObject({ dragging: false, passthrough: true });
});
