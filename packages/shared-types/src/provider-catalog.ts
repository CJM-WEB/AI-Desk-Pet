import { z } from 'zod';

export const modelCapabilitySchema = z.enum([
  'chat',
  'tools',
  'vision',
  'streaming',
  'longContext'
]);
export type ModelCapability = z.infer<typeof modelCapabilitySchema>;

export const providerProtocolSchema = z.enum([
  'openai-compatible',
  'anthropic',
  'gemini'
]);
export type ProviderProtocol = z.infer<typeof providerProtocolSchema>;

export const providerCatalogEntrySchema = z.object({
  catalogVersion: z.literal(1),
  providerId: z.string().min(1),
  displayName: z.string().min(1),
  protocol: providerProtocolSchema,
  baseUrl: z.string().url(),
  modelDiscoveryUrl: z.string().url().nullable(),
  models: z.array(z.object({
    modelId: z.string().min(1),
    displayName: z.string().min(1),
    capabilities: z.array(modelCapabilitySchema).min(1)
  }).strict()).min(1),
  apiKeyHelpUrl: z.string().url(),
  requestLimits: z.object({
    requestsPerMinute: z.number().positive().optional(),
    tokensPerMinute: z.number().positive().optional()
  }).strict(),
  compatibilityNotes: z.array(z.string())
}).strict();
export type ProviderCatalogEntry = z.infer<typeof providerCatalogEntrySchema>;

const conservativeCapabilities: ModelCapability[] = ['chat', 'streaming'];

function seedProvider(
  providerId: string,
  displayName: string,
  protocol: ProviderProtocol,
  baseUrl: string,
  modelId: string,
  apiKeyHelpUrl: string
): ProviderCatalogEntry {
  return {
    catalogVersion: 1,
    providerId,
    displayName,
    protocol,
    baseUrl,
    modelDiscoveryUrl: null,
    models: [{
      modelId,
      displayName: modelId,
      capabilities: [...conservativeCapabilities]
    }],
    apiKeyHelpUrl,
    requestLimits: {},
    compatibilityNotes: ['首版目录仅声明本地安全路由所需的保守能力。']
  };
}

export const providerCatalog: ProviderCatalogEntry[] = [
  seedProvider('openai', 'OpenAI', 'openai-compatible', 'https://api.openai.com/v1', 'gpt-5-mini', 'https://platform.openai.com/api-keys'),
  seedProvider('anthropic', 'Anthropic', 'anthropic', 'https://api.anthropic.com/v1', 'claude-sonnet-4-5', 'https://console.anthropic.com/settings/keys'),
  seedProvider('gemini', 'Gemini', 'gemini', 'https://generativelanguage.googleapis.com/v1beta', 'gemini-3.6-flash', 'https://aistudio.google.com/apikey'),
  seedProvider('deepseek', 'DeepSeek', 'openai-compatible', 'https://api.deepseek.com', 'deepseek-v4-flash', 'https://platform.deepseek.com/api_keys'),
  seedProvider('kimi', 'Kimi', 'openai-compatible', 'https://api.moonshot.cn/v1', 'kimi-k2.5', 'https://platform.moonshot.cn/console/api-keys'),
  seedProvider('qwen', '通义千问', 'openai-compatible', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen-plus', 'https://bailian.console.aliyun.com/?apiKey=1'),
  seedProvider('zhipu', '智谱', 'openai-compatible', 'https://open.bigmodel.cn/api/paas/v4', 'glm-4.5', 'https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys'),
  seedProvider('doubao', '豆包', 'openai-compatible', 'https://ark.cn-beijing.volces.com/api/v3', 'doubao-seed-1-6', 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey'),
  seedProvider('hunyuan', '腾讯混元', 'openai-compatible', 'https://api.hunyuan.cloud.tencent.com/v1', 'hunyuan-turbos-latest', 'https://console.cloud.tencent.com/cam/capi'),
  seedProvider('minimax', 'MiniMax', 'openai-compatible', 'https://api.minimax.io/v1', 'MiniMax-M2.1', 'https://platform.minimaxi.com/user-center/basic-information/interface-key')
];
