import { z } from 'zod';
import type { PetGeometryRenderView } from './character-motion-ipc';

/** Main 与 Renderer 共用同一拖拽兜底时限，避免任一侧永久持有会话。 */
export const PET_DRAG_TIMEOUT_MS = 30_000;

/** Renderer 只能声明当前区域是否需要鼠标穿透。 */
export const petMousePassthroughInputSchema = z.object({
  ignore: z.boolean()
}).strict();

const finiteIntegerSchema = z.number().int().safe();
export const petViewportCommitInputSchema = z.object({
  viewportInWindowDip: z.object({
    x: finiteIntegerSchema.nonnegative(),
    y: finiteIntegerSchema.nonnegative(),
    width: finiteIntegerSchema.positive(),
    height: finiteIntegerSchema.positive()
  }).strict()
}).strict().refine(input => (
  Number.isSafeInteger(input.viewportInWindowDip.x + input.viewportInWindowDip.width)
  && Number.isSafeInteger(input.viewportInWindowDip.y + input.viewportInWindowDip.height)
), { message: 'viewport 边界必须是安全整数' });

export const petScaleStepInputSchema = z.object({
  step: z.union([z.literal(-1), z.literal(1)])
}).strict();

export type PetViewportCommitInput = z.output<typeof petViewportCommitInputSchema>;
export type PetScaleStepInput = z.output<typeof petScaleStepInputSchema>;

export interface PetWindowInteractionApi {
  setPetMousePassthrough(ignore: boolean): Promise<void>;
  beginPetDrag(): Promise<void>;
  endPetDrag(): Promise<void>;
  openPetContextMenu(): Promise<void>;
  commitPetViewport?(input: PetViewportCommitInput): Promise<void>;
  stepPetScale?(input: PetScaleStepInput): Promise<void>;
  onPetGeometryRender?(listener: (view: PetGeometryRenderView) => void): () => void;
  getPetInteractionProbe?(): Promise<PetInteractionProbe>;
}

/** E2E 只读探针不携带坐标、窗口对象或本地路径。 */
export type PetInteractionProbe = {
  passthrough: boolean;
  dragging: boolean;
};
