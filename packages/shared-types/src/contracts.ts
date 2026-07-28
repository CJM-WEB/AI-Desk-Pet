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

export const toolRequestSchema = z.object({
  requestId: z.string().min(1),
  toolName: toolNameSchema,
  arguments: z.record(z.string(), z.unknown())
}).strict();
export type ToolRequest = z.infer<typeof toolRequestSchema>;

export const pendingActionSchema = z.object({
  actionId: z.string().min(1),
  conversationId: z.string().min(1),
  risk: z.literal('write'),
  summary: z.string().min(1),
  sourceRelativePath: z.string().min(1).optional(),
  targetRelativePath: z.string().min(1),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime()
}).strict();
export type PendingAction = z.infer<typeof pendingActionSchema>;

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

export const providerProfileV2Schema = z.discriminatedUnion('mode', [
  providerProfileV2BaseSchema.extend({
    mode: z.literal('preset'),
    providerId: z.string().min(1)
  }).strict(),
  providerProfileV2BaseSchema.extend({
    mode: z.literal('custom'),
    protocol: providerProtocolSchema,
    baseUrl: providerBaseUrlSchema,
    additionalParameters: z.record(z.union([z.string(), z.number(), z.boolean()])),
    capabilities: z.array(z.enum([
      'chat',
      'tools',
      'vision',
      'streaming',
      'longContext'
    ])).min(1).optional()
  }).strict()
]);
export type ProviderProfileV2 = z.infer<typeof providerProfileV2Schema>;

export const storedProviderProfileV2Schema = z.discriminatedUnion('mode', [
  storedProviderProfileV2BaseSchema.extend({
    mode: z.literal('preset'),
    providerId: z.string().min(1)
  }).strict(),
  storedProviderProfileV2BaseSchema.extend({
    mode: z.literal('custom'),
    protocol: providerProtocolSchema,
    baseUrl: providerBaseUrlSchema,
    additionalParameters: z.record(z.union([z.string(), z.number(), z.boolean()])),
    capabilities: z.array(z.enum([
      'chat',
      'tools',
      'vision',
      'streaming',
      'longContext'
    ])).min(1).optional()
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
  petPosition: z.object({
    x: z.number(),
    y: z.number()
  }).strict().nullable(),
  fileDisclosureAccepted: z.boolean()
}).strict();
export type PublicSettings = z.infer<typeof publicSettingsSchema>;

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
  }).strict()
]);
export type TaskEvent = z.infer<typeof taskEventSchema>;
