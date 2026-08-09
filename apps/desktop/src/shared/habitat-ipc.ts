import { z } from 'zod';

export const habitatDirectoryIdSchema = z.string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u);

export const habitatEmptyInputSchema = z.object({}).strict();

export const habitatDirectoryIdInputSchema = z.object({
  directoryId: habitatDirectoryIdSchema
}).strict();

export const habitatDirectoryToggleInputSchema = z.object({
  directoryId: habitatDirectoryIdSchema,
  enabled: z.boolean()
}).strict();

export const habitatPreferencesInputSchema = z.object({
  enabled: z.boolean(),
  autoHideEnabled: z.boolean(),
  idleDelayMs: z.number().finite().int().min(1_000).max(86_400_000)
}).strict();

export const habitatErrorCodeSchema = z.enum([
  'HABITAT_CLOSED',
  'HABITAT_OPERATION_BUSY',
  'HABITAT_STATE_INVALID',
  'HABITAT_ENTRY_BLOCKED',
  'HABITAT_AUTOMATION_BLOCKED',
  'HABITAT_DIRECTORY_NOT_FOUND',
  'HABITAT_DIRECTORY_UNAVAILABLE',
  'HABITAT_STORAGE_CHANGED',
  'HABITAT_STORAGE_FAILED',
  'HABITAT_OBSERVER_FAILED',
  'HABITAT_SUMMON_FAILED',
  'HABITAT_WINDOW_FAILED',
  'HABITAT_OPERATION_FAILED',
  'HABITAT_DIRECTORY_INVALID',
  'HABITAT_DIRECTORY_UNSAFE',
  'HABITAT_DIRECTORY_PROTECTED',
  'HABITAT_DIRECTORY_UNSUPPORTED',
  'HABITAT_DIRECTORY_CHANGED',
  'HABITAT_DIRECTORY_DUPLICATE',
  'HABITAT_DIRECTORY_IDENTITY_CONFLICT',
  'HABITAT_DIRECTORY_DISABLED',
  'HABITAT_DIRECTORY_IN_USE',
  'HABITAT_DISABLED',
  'HABITAT_DIALOG_FAILED',
  'HABITAT_INPUT_INVALID',
  'HABITAT_RESPONSE_INVALID'
]);
export type HabitatPublicErrorCode = z.infer<typeof habitatErrorCodeSchema>;

export const habitatBusyReasonSchema = z.enum([
  'entering',
  'summoning',
  'recalling',
  'checking-availability'
]);
export type HabitatBusyReason = z.infer<typeof habitatBusyReasonSchema>;

const habitatDirectorySchema = z.object({
  id: habitatDirectoryIdSchema,
  displayName: z.string().min(1).max(160),
  pathHint: z.string().min(1).max(160),
  enabled: z.boolean(),
  availability: z.enum(['available', 'unavailable'])
}).strict();

const habitatCurrentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('desktop') }).strict(),
  z.object({
    kind: z.literal('folder'),
    directoryId: habitatDirectoryIdSchema,
    visibility: z.enum(['hidden', 'visible', 'lost'])
  }).strict()
]);

/** Renderer 仅消费脱敏目录提示和稳定状态，不接收 Main 私有身份。 */
export const habitatDashboardSchema = z.object({
  enabled: z.boolean(),
  autoHideEnabled: z.boolean(),
  idleDelayMs: z.number().finite().int().min(1_000).max(86_400_000),
  directories: z.array(habitatDirectorySchema).max(128),
  current: habitatCurrentSchema,
  busyReason: habitatBusyReasonSchema.nullable(),
  errorCode: habitatErrorCodeSchema.nullable()
}).strict();
export type HabitatDashboardDto = z.infer<typeof habitatDashboardSchema>;

export const habitatChooseResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('cancelled'),
    dashboard: habitatDashboardSchema
  }).strict(),
  z.object({
    kind: z.literal('added'),
    dashboard: habitatDashboardSchema
  }).strict()
]);
export type HabitatChooseResult = z.infer<typeof habitatChooseResultSchema>;
export type HabitatPreferencesInput = z.infer<typeof habitatPreferencesInputSchema>;
