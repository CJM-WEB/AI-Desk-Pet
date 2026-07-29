import { z } from 'zod';

/** Renderer 只能声明当前区域是否需要鼠标穿透。 */
export const petMousePassthroughInputSchema = z.object({
  ignore: z.boolean()
}).strict();

export interface PetWindowInteractionApi {
  setPetMousePassthrough(ignore: boolean): Promise<void>;
  beginPetDrag(): Promise<void>;
  endPetDrag(): Promise<void>;
  openPetContextMenu(): Promise<void>;
}
