import { z } from 'zod';
import { providerProtocolSchema } from './provider-catalog';

export const toolNameSchema = z.string()
  .min(3)
  .max(128)
  .regex(/^(builtin|mcp)\.[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)+$/u);
export type ToolName = z.infer<typeof toolNameSchema>;

export const taskPhaseSchema = z.enum([
  'idle',
  'listening',
  'thinking',
  'awaiting_confirmation',
  'acting',
  'success',
  'error',
  'cancelled'
]);
export type TaskPhase = z.infer<typeof taskPhaseSchema>;

export const characterEmotionLabelSchema = z.enum([
  'happy',
  'sad',
  'angry',
  'surprised',
  'calm'
]);
export type CharacterEmotionLabel = z.infer<typeof characterEmotionLabelSchema>;

export const historyDisclosureDecisionSchema = z.enum([
  'share_once',
  'current_message_only'
]);
export type HistoryDisclosureDecision = z.infer<
  typeof historyDisclosureDecisionSchema
>;

export const historyDisclosureRequiredEventSchema = z.object({
  type: z.literal('history_disclosure_required'),
  requestId: z.string().min(1).max(128),
  targetProviderName: z.string().min(1).max(128),
  messageCount: z.number().int().min(0).max(40),
  characterCount: z.number().int().min(0).max(16_000)
}).strict();
export type HistoryDisclosureRequiredEvent = z.infer<
  typeof historyDisclosureRequiredEventSchema
>;

/** 模型补充识别的本地任务必须先经过独立授权，不能伪装成具体工具确认。 */
export const capabilityAuthorizationRequiredEventSchema = z.object({
  type: z.literal('capability_authorization_required'),
  requestId: z.string().min(1).max(128),
  capability: z.enum(['file', 'powershell']),
  requestSummary: z.string().trim().min(1).max(240),
  targetProviderName: z.string().min(1).max(128)
}).strict();
export type CapabilityAuthorizationRequiredEvent = z.infer<
  typeof capabilityAuthorizationRequiredEventSchema
>;

export const conversationResetEventSchema = z.object({
  type: z.literal('conversation_reset'),
  generation: z.string().min(1).max(128)
}).strict();
export type ConversationResetEvent = z.infer<typeof conversationResetEventSchema>;

export const toolRequestSchema = z.object({
  requestId: z.string().min(1),
  toolName: toolNameSchema,
  arguments: z.record(z.string(), z.unknown())
}).strict();
export type ToolRequest = z.infer<typeof toolRequestSchema>;

type PendingFileActionBase = Readonly<{
  category: 'file';
  actionId: string;
  conversationId: string;
  risk: 'write';
  summary: string;
  targetRelativePath: string;
  createdAt: string;
  expiresAt: string;
}>;

/** Renderer 仅接收经 Main 过滤后的文件写入摘要，不承载私有执行能力。 */
export type PendingAction =
  | Readonly<PendingFileActionBase & {
      operation: 'create_file';
      contentCharacters: number;
      contentPreview: string | null;
      contentPreviewSuppressedReason: 'sensitive' | 'too_long' | null;
      previewTruncated: boolean;
    }>
  | Readonly<PendingFileActionBase & {
      operation: 'create_directory';
    }>
  | Readonly<PendingFileActionBase & {
      operation: 'apply_patch';
      addedLines: number;
      removedLines: number;
      diffPreview: string;
      previewTruncated: boolean;
    }>
  | Readonly<PendingFileActionBase & {
      operation: 'delete_file';
      targetType: 'file' | 'empty_directory';
    }>
  | Readonly<PendingFileActionBase & {
      operation: 'move_file';
      sourceRelativePath: string;
    }>
  | Readonly<{
      category: 'powershell';
      actionId: string;
      conversationId: string;
      risk: 'shell';
      operation: 'powershell';
      summary: string;
      command: string;
      workingDirectoryLabel: string;
      runMode: 'foreground';
      createdAt: string;
      expiresAt: string;
    }>;

const pendingFileActionBaseSchema = z.object({
  category: z.literal('file'),
  actionId: z.string().min(1),
  conversationId: z.string().min(1),
  risk: z.literal('write'),
  summary: z.string().min(1),
  targetRelativePath: z.string().min(1),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime()
});

/** 确认卡只展示受控目录名称，绝不承载本机绝对、UNC 或设备路径。 */
const workingDirectoryLabelSchema = z.string().min(1).max(128).refine(
  value => !/^(?:[a-z]:[\\/]|[\\/]{1,2}|[\\/]{2}[?.][\\/])/iu.test(value),
  'WORKING_DIRECTORY_LABEL_INVALID'
);

export const pendingActionSchema: z.ZodType<PendingAction> = z.union([
  pendingFileActionBaseSchema.extend({
    operation: z.literal('create_file'),
    contentCharacters: z.number().int().min(0),
    contentPreview: z.string().nullable(),
    contentPreviewSuppressedReason: z.enum(['sensitive', 'too_long']).nullable(),
    previewTruncated: z.boolean()
  }).strict(),
  pendingFileActionBaseSchema.extend({
    operation: z.literal('create_directory')
  }).strict(),
  pendingFileActionBaseSchema.extend({
    operation: z.literal('apply_patch'),
    addedLines: z.number().int().min(0),
    removedLines: z.number().int().min(0),
    diffPreview: z.string(),
    previewTruncated: z.boolean()
  }).strict(),
  pendingFileActionBaseSchema.extend({
    operation: z.literal('delete_file'),
    targetType: z.enum(['file', 'empty_directory'])
  }).strict(),
  pendingFileActionBaseSchema.extend({
    operation: z.literal('move_file'),
    sourceRelativePath: z.string().min(1)
  }).strict(),
  z.object({
    category: z.literal('powershell'),
    actionId: z.string().min(1),
    conversationId: z.string().min(1),
    risk: z.literal('shell'),
    operation: z.literal('powershell'),
    summary: z.string().min(1),
    command: z.string().min(1).max(16_384),
    workingDirectoryLabel: workingDirectoryLabelSchema,
    runMode: z.literal('foreground'),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime()
  }).strict()
]);

export const providerProfileSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  baseUrl: z.string().url(),
  model: z.string().min(1),
  hasStoredSecret: z.boolean()
}).strict();
export type ProviderProfile = z.infer<typeof providerProfileSchema>;

const providerProfileV2BaseSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  modelId: z.string().min(1),
  hasStoredSecret: z.boolean()
}).strict();

const storedProviderProfileV2BaseSchema = providerProfileV2BaseSchema.omit({
  hasStoredSecret: true
}).strict();

const providerBaseUrlSchema = z.string().url().refine(value => {
  const url = new URL(value);
  if (url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:'
    && new Set(['localhost', '127.0.0.1', '[::1]']).has(url.hostname);
}, 'PROVIDER_URL_UNSAFE');

const declaredModelCapabilitiesSchema = z.array(z.enum([
  'chat',
  'tools',
  'vision',
  'streaming',
  'longContext'
])).min(1).optional();

export const providerProfileV2Schema = z.discriminatedUnion('mode', [
  providerProfileV2BaseSchema.extend({
    mode: z.literal('preset'),
    providerId: z.string().min(1),
    capabilities: declaredModelCapabilitiesSchema
  }).strict(),
  providerProfileV2BaseSchema.extend({
    mode: z.literal('custom'),
    protocol: providerProtocolSchema,
    baseUrl: providerBaseUrlSchema,
    additionalParameters: z.record(z.union([z.string(), z.number(), z.boolean()])),
    capabilities: declaredModelCapabilitiesSchema
  }).strict()
]);
export type ProviderProfileV2 = z.infer<typeof providerProfileV2Schema>;

export const storedProviderProfileV2Schema = z.discriminatedUnion('mode', [
  storedProviderProfileV2BaseSchema.extend({
    mode: z.literal('preset'),
    providerId: z.string().min(1),
    capabilities: declaredModelCapabilitiesSchema
  }).strict(),
  storedProviderProfileV2BaseSchema.extend({
    mode: z.literal('custom'),
    protocol: providerProtocolSchema,
    baseUrl: providerBaseUrlSchema,
    additionalParameters: z.record(z.union([z.string(), z.number(), z.boolean()])),
    capabilities: declaredModelCapabilitiesSchema
  }).strict()
]);
export type StoredProviderProfileV2 = z.infer<typeof storedProviderProfileV2Schema>;

export const modelRouteConfigSchema = z.object({
  primaryProfileId: z.string().min(1).nullable(),
  chatProfileId: z.string().min(1).nullable(),
  agentProfileId: z.string().min(1).nullable(),
  visionProfileId: z.string().min(1).nullable(),
  fallbackProfileIds: z.array(z.string().min(1)),
  allowCrossProviderFallback: z.boolean()
}).strict();
export type ModelRouteConfig = z.infer<typeof modelRouteConfigSchema>;

export const publicSettingsSchema = z.object({
  version: z.literal(1),
  provider: providerProfileSchema.nullable(),
  authorizedRoot: z.object({
    id: z.string().min(1),
    displayName: z.string().min(1),
    pathHint: z.string().min(1)
  }).strict().nullable(),
  fileDisclosureAccepted: z.boolean()
}).strict();
export type PublicSettings = z.infer<typeof publicSettingsSchema>;

/** 流式事件只承载本地角色正文；固定预算阻止 IPC 小分片绕过累计输出上限。 */
export const ASSISTANT_STREAM_TURN_ID_MAX_CHARACTERS = 128;
export const ASSISTANT_STREAM_TEXT_MAX_CHARACTERS = 4_000;

export const taskEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('phase'),
    phase: taskPhaseSchema
  }).strict(),
  z.object({
    type: z.literal('message'),
    role: z.enum(['user', 'assistant']),
    text: z.string()
  }).strict(),
  z.object({
    type: z.literal('assistant_message_start'),
    turnId: z.string().min(1).max(ASSISTANT_STREAM_TURN_ID_MAX_CHARACTERS)
  }).strict(),
  z.object({
    type: z.literal('assistant_message_delta'),
    turnId: z.string().min(1).max(ASSISTANT_STREAM_TURN_ID_MAX_CHARACTERS),
    delta: z.string().min(1).max(ASSISTANT_STREAM_TEXT_MAX_CHARACTERS)
  }).strict(),
  z.object({
    type: z.literal('assistant_message_commit'),
    turnId: z.string().min(1).max(ASSISTANT_STREAM_TURN_ID_MAX_CHARACTERS),
    text: z.string().max(ASSISTANT_STREAM_TEXT_MAX_CHARACTERS)
  }).strict(),
  z.object({
    type: z.literal('pending_action'),
    action: pendingActionSchema
  }).strict(),
  z.object({
    type: z.literal('error'),
    code: z.string().min(1),
    message: z.string().min(1),
    nextAction: z.string().min(1).optional()
  }).strict(),
  z.object({
    type: z.literal('character_emotion'),
    label: characterEmotionLabelSchema
  }).strict(),
  z.object({
    type: z.literal('character_carrying'),
    carrying: z.boolean()
  }).strict(),
  historyDisclosureRequiredEventSchema,
  capabilityAuthorizationRequiredEventSchema,
  conversationResetEventSchema
]);
export type TaskEvent = z.infer<typeof taskEventSchema>;
