import { z } from 'zod';
import type { FilePlanningOperation } from './types';

/** 首轮规划工具只表达能力偏好，不携带路径、授权或执行结果。 */
export const AGENT_PLANNING_TOOLS = [
  'list_files',
  'read_file',
  'glob_files',
  'grep_files',
  'create_file',
  'create_directory',
  'apply_patch',
  'edit_file',
  'delete_file',
  'move_file',
  'powershell'
] as const satisfies readonly (FilePlanningOperation | 'powershell')[];

export const agentPlanningToolSchema = z.enum(AGENT_PLANNING_TOOLS);
export type AgentPlanningTool = z.infer<typeof agentPlanningToolSchema>;

/** 模型只能建议聊天或进入 Agent；Main 仍负责全部权限与执行裁决。 */
export const capabilityControlPlanSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('chat') }).strict(),
  z.object({
    kind: z.literal('agent_task'),
    preferredTool: agentPlanningToolSchema.nullable()
  }).strict()
]);

export type CapabilityControlPlan = z.infer<typeof capabilityControlPlanSchema>;
