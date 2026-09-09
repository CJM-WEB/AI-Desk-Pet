import { z } from 'zod';
import type { PetGeometryRenderView } from './character-motion-ipc';

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

/** Renderer 只上报无参数命中标记，不保存坐标或输入正文。 */
export const petInteractionProbeRecordEventSchema = z.literal('mouse_hit');

const probeCounterSchema = z.number().int().safe().nonnegative();
export const petInteractionProbeSchema = z.object({
  passthrough: z.boolean(),
  dragging: z.boolean(),
  mouseMoveHitCount: probeCounterSchema
}).strict();

export type PetViewportCommitInput = z.output<typeof petViewportCommitInputSchema>;
export type PetInteractionProbeRecordEvent = z.output<
  typeof petInteractionProbeRecordEventSchema
>;
export type PetInteractionProbeEvent = PetInteractionProbeRecordEvent;

export interface PetWindowInteractionApi {
  setPetMousePassthrough(ignore: boolean): Promise<void>;
  beginPetDrag(): void;
  updatePetDrag(): void;
  endPetDrag(): void;
  commitPetViewport?(input: PetViewportCommitInput): Promise<void>;
  onPetGeometryRender?(listener: (view: PetGeometryRenderView) => void): () => void;
  recordPetInteractionProbeEvent?(event: PetInteractionProbeRecordEvent): Promise<void>;
  getPetInteractionProbe?(): Promise<PetInteractionProbe>;
}

/** E2E 只读探针不携带坐标、窗口对象或本地路径。 */
export type PetInteractionProbe = z.output<typeof petInteractionProbeSchema>;
