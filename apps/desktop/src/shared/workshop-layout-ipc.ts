import { z } from 'zod';

export type WorkshopLayoutSettings = Readonly<{
  leftWidth: number;
  rightWidth: number;
  sidebarTopHeight: number;
  stageHeight: number;
}>;

const workshopLayoutDimensionSchema = z.number().int().finite().min(1).max(4_096);

/**
 * 工作台布局只持久化四个可复用像素值；窗口尺寸相关 clamp 留给 Renderer 内存态，
 * Main 端只负责拒绝非有限值、负值和超预算值。
 */
export const workshopLayoutSettingsSchema: z.ZodType<WorkshopLayoutSettings> = z.object({
  leftWidth: workshopLayoutDimensionSchema,
  rightWidth: workshopLayoutDimensionSchema,
  sidebarTopHeight: workshopLayoutDimensionSchema,
  stageHeight: workshopLayoutDimensionSchema
}).strict();

export const DEFAULT_WORKSHOP_LAYOUT: WorkshopLayoutSettings = Object.freeze({
  leftWidth: 300,
  rightWidth: 300,
  sidebarTopHeight: 290,
  stageHeight: 460
});
