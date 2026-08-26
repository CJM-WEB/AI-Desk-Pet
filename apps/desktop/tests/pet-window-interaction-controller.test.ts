import { expect, test, vi } from 'vitest';
import { PetWindowInteractionController } from
  '../src/main/windows/pet-window-interaction-controller';

test('Main 交互控制器只保留透明像素穿透并固定报告无自定义拖拽', () => {
  const setIgnoreMouseEvents = vi.fn();
  const controller = new PetWindowInteractionController({
    window: {
      setIgnoreMouseEvents,
      isDestroyed: () => false
    }
  });

  controller.setPassthrough(false);
  expect(setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);
  expect(controller.getProbe()).toEqual({
    passthrough: false,
    dragging: false,
    mouseMoveHitCount: 0
  });
  expect('beginDrag' in controller).toBe(false);
});
