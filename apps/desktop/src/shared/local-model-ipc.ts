import { z } from 'zod';

/** Renderer 仅消费无敏感运行细节的本地模型状态。 */
export const localModelPublicStatusSchema = z.object({
  enabled: z.boolean(),
  phase: z.enum(['disabled', 'validating', 'loading', 'ready', 'faulted', 'stopping']),
  backend: z.enum(['vulkan', 'cpu']).nullable(),
  reasonCode: z.enum([
    'RESOURCE_MISSING', 'RESOURCE_HASH_MISMATCH', 'RUNTIME_INCOMPATIBLE',
    'VULKAN_UNAVAILABLE', 'CPU_START_FAILED', 'MODEL_LOAD_TIMEOUT',
    'PORT_CONFLICT', 'PROCESS_CRASHED', 'PROTOCOL_INCOMPATIBLE'
  ]).nullable()
}).strict();

export type LocalModelPublicStatus = z.infer<typeof localModelPublicStatusSchema>;

export interface LocalModelSettings {
  enabled: boolean;
}
