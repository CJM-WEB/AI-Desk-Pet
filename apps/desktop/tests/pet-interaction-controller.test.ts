import { expect, test, vi } from 'vitest';
import { PetInteractionController } from '../src/renderer/src/pet/pet-interaction-controller';

test('Renderer 像素命中启动无坐标拖拽节拍并在真实终态释放', async () => {
  const setPetMousePassthrough = vi.fn().mockResolvedValue(undefined);
  const beginPetDrag = vi.fn();
  const updatePetDrag = vi.fn();
  const endPetDrag = vi.fn();
  let hit = false;
  const controller = new PetInteractionController({
    setPetMousePassthrough,
    beginPetDrag,
    updatePetDrag,
    endPetDrag
  });
  controller.setHitTestPort({
    hitTest: () => hit,
    subscribe: () => () => undefined
  });

  hit = true;
  expect(controller.handlePointerMove({ x: 20, y: 30 })).toBe(true);
  await vi.waitFor(() => expect(setPetMousePassthrough).toHaveBeenLastCalledWith(false));
  expect(controller.handlePointerDown({ x: 20, y: 30 })).toBe(true);
  controller.handlePointerMove({ x: 21, y: 31 });
  controller.handlePointerUp();
  expect(beginPetDrag).toHaveBeenCalledOnce();
  expect(updatePetDrag).toHaveBeenCalledOnce();
  expect(endPetDrag).toHaveBeenCalledOnce();

  hit = false;
  controller.handlePointerMove({ x: 22, y: 32 });
  await vi.waitFor(() => expect(setPetMousePassthrough).toHaveBeenLastCalledWith(true));
});
