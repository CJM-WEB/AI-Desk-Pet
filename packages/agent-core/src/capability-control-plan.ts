import { z } from 'zod';

/** 模型只能建议聊天或进入 Agent；Main 仍负责全部权限与执行裁决。 */
export const capabilityControlPlanSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('chat') }).strict(),
  z.object({
    kind: z.literal('agent_task')
  }).strict()
]);

export type CapabilityControlPlan = z.infer<typeof capabilityControlPlanSchema>;
