import { expect, test, vi } from 'vitest';
import { PetInteractionController } from '../src/renderer/src/pet/pet-interaction-controller';

test('Renderer 像素命中只切换穿透且不再暴露拖拽会话', async () => {
  const setPetMousePassthrough = vi.fn().mockResolvedValue(undefined);
  let hit = false;
  const controller = new PetInteractionController({
    setPetMousePassthrough
  });
  controller.setHitTestPort({
    hitTest: () => hit,
    subscribe: () => () => undefined
  });

  hit = true;
  expect(controller.handlePointerMove({ x: 20, y: 30 })).toBe(true);
  await vi.waitFor(() => expect(setPetMousePassthrough).toHaveBeenLastCalledWith(false));

  hit = false;
  controller.handlePointerMove({ x: 21, y: 31 });
  await vi.waitFor(() => expect(setPetMousePassthrough).toHaveBeenLastCalledWith(true));
  expect('handlePointerDown' in controller).toBe(false);
});
