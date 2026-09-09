import {
  characterDraftV3Schema,
  characterPlaybackViewSchema,
  characterManifestV3Schema
} from '@myself/character-runtime';
import { z } from 'zod';

const SAFE_IDENTIFIER = /^[a-z0-9][a-z0-9_-]{0,119}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const STABLE_ERROR_CODE = /^CHARACTER_[A-Z0-9_]+$/u;

export const characterIdSchema = z.string().regex(SAFE_IDENTIFIER);
export const characterAssetIdSchema = z.string().regex(SAFE_IDENTIFIER);
export const characterSourceAssetIdSchema = z.string().regex(UUID_PATTERN);

export const characterEmptyInputSchema = z.object({}).strict();
export const characterIdInputSchema = z.object({
  characterId: characterIdSchema
}).strict();
export const characterActivateInputSchema = z.object({
  characterId: characterIdSchema,
  confirmIncomplete: z.boolean().optional()
}).strict();
export const characterCreateInputSchema = z.object({
  name: z.string().trim().min(1).max(120)
}).strict();
// 原规则由 Main 持久保存；客户端只能逐项提交处置。
export const characterMigrationResolutionSchema = z.object({
  issueId: z.string().regex(/^[a-f0-9]{64}$/u), decision: z.enum(['revised', 'discarded'])
}).strict();
export const characterMigrationReviewSchema = z.object({
  issues: z.array(z.object({
    issueId: z.string().regex(/^[a-f0-9]{64}$/u),
    code: z.enum(['idle-missing', 'idle-ambiguous', 'modifier-state', 'state-combination', 'unsupported-condition', 'action-constraint', 'presentation-fallback', 'presentation-budget', 'v1-trigger']),
    objectId: z.string().max(120), message: z.string().max(2000), originalRule: z.string().max(100000)
  }).strict()).max(20000),
  resolutions: z.array(characterMigrationResolutionSchema).max(20000)
}).strict();
export type CharacterMigrationReview = z.output<typeof characterMigrationReviewSchema>;
export type CharacterMigrationResolution = z.output<typeof characterMigrationResolutionSchema>;

export const characterDraftSaveInputSchema = z.object({
  characterId: characterIdSchema,
  draft: characterDraftV3Schema,
  draftRevision: z.string().regex(UUID_PATTERN),
  migrationResolutions: z.array(characterMigrationResolutionSchema).max(20000).optional()
}).strict();
export const characterSourceReadInputSchema = z.object({
  characterId: characterIdSchema,
  assetId: characterSourceAssetIdSchema
}).strict();
export const characterPublishInputSchema = z.object({
  characterId: characterIdSchema,
  draftRevision: z.string().regex(UUID_PATTERN),
  manifest: characterManifestV3Schema,
  resources: z.array(z.object({
    assetId: characterAssetIdSchema,
    bytes: z.instanceof(Uint8Array)
  }).strict()).max(2_000)
}).strict();
export const characterRuntimeAssetReadInputSchema = z.object({
  assetId: characterAssetIdSchema
}).strict();

export const characterSummarySchema = z.object({
  id: characterIdSchema,
  name: z.string().trim().min(1).max(120),
  thumbnailAssetId: characterAssetIdSchema.nullable(),
  active: z.boolean(),
  completeness: z.enum(['complete', 'incomplete', 'broken']),
  missingRequirements: z.array(z.enum([
    'default-state-action-missing',
    'default-presentation-unplayable'
  ])),
  migrationErrorCode: z.literal('CHARACTER_MIGRATION_FAILED').optional(),
  migrationRecoveryAvailable: z.boolean(),
  activationConfirmationRequired: z.boolean().optional()
}).strict();
export const characterSourceSchema = z.object({
  assetId: characterSourceAssetIdSchema,
  displayName: z.string().min(1).max(255),
  mimeType: z.enum(['image/png', 'image/webp']),
  byteLength: z.number().int().safe().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u)
}).strict();
export const characterWorkshopSourceSchema = characterSourceSchema.pick({
  assetId: true,
  displayName: true,
  mimeType: true
});
export const characterRuntimeSnapshotSchema = z.object({
  activeCharacterId: characterIdSchema,
  manifest: characterPlaybackViewSchema
}).strict();

export const characterListResultSchema = z.object({
  characters: z.array(characterSummarySchema)
}).strict();
export const characterDraftResultSchema = z.object({
  draft: characterDraftV3Schema,
  migrationReview: characterMigrationReviewSchema.optional()
}).strict();
export const characterMutationResultSchema = z.object({
  ok: z.literal(true)
}).strict();
export const characterBytesResultSchema = z.object({
  bytes: z.instanceof(Uint8Array)
}).strict();
export const characterRuntimeSnapshotResultSchema = z.object({
  snapshot: characterRuntimeSnapshotSchema.nullable()
}).strict();
export const characterRecoveryIssueErrorCodeSchema = z.enum([
  'CHARACTER_DRAFT_RECOVERY_BLOCKED',
  'CHARACTER_PUBLISH_RECOVERY_BLOCKED',
  'CHARACTER_RECOVERY_DEFERRED',
  'CHARACTER_IMPORT_RECOVERY_BLOCKED',
  'CHARACTER_IMPORT_RECOVERY_DEFERRED'
]);
export const characterRecoveryFallbackErrorCodeSchema = z.enum([
  'CHARACTER_INDEX_UNAVAILABLE',
  'CHARACTER_PUBLISH_RECOVERY_BLOCKED',
  'CHARACTER_RECOVERY_DEFERRED',
  'CHARACTER_MANIFEST_INVALID',
  'CHARACTER_MIGRATION_FAILED',
  'CHARACTER_MIGRATION_REVIEW_REQUIRED',
  'CHARACTER_RESOURCE_INTEGRITY_FAILED',
  'CHARACTER_RESOURCE_NOT_FOUND',
  'CHARACTER_RUNTIME_UNAVAILABLE',
  'CHARACTER_VERSION_UNSUPPORTED',
  'CHARACTER_OPERATION_FAILED'
]);
export const characterRecoveryIssueSchema = z.object({
  characterId: characterIdSchema,
  errorCode: characterRecoveryIssueErrorCodeSchema
}).strict();
export const characterRecoverySnapshotResultSchema = z.object({
  fallbackErrorCode: characterRecoveryFallbackErrorCodeSchema.nullable(),
  issues: z.array(characterRecoveryIssueSchema)
}).strict();
export const characterSourceChoiceResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cancelled') }).strict(),
  z.object({
    kind: z.literal('selected'),
    sources: z.array(characterSourceSchema)
  }).strict()
]);
export const characterSourcesResultSchema = z.object({
  sources: z.array(characterWorkshopSourceSchema)
}).strict();
export const characterImportResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cancelled') }).strict(),
  z.object({
    kind: z.literal('imported'),
    characterId: characterIdSchema
  }).strict()
]);
export const characterExportResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cancelled') }).strict(),
  z.object({ kind: z.literal('exported') }).strict(),
  z.object({ kind: z.literal('recovery-exported') }).strict()
]);

// 事件对象使用封闭联合，Renderer 不能指定订阅通道或接收 Main 内部路径。
export const characterEventSchema = z.union([
  z.object({ type: z.literal('index-changed') }).strict(),
  z.object({
    type: z.literal('compile-result'),
    characterId: characterIdSchema,
    ok: z.literal(true)
  }).strict(),
  z.object({
    type: z.literal('compile-result'),
    characterId: characterIdSchema,
    ok: z.literal(false),
    errorCode: z.string().regex(STABLE_ERROR_CODE)
  }).strict(),
  z.object({
    type: z.literal('active-character-changed'),
    characterId: characterIdSchema
  }).strict()
]);

export type CharacterCreateInput = z.output<typeof characterCreateInputSchema>;
export type CharacterPublishInput = z.output<typeof characterPublishInputSchema>;
export type CharacterSummaryDto = z.output<typeof characterSummarySchema>;
export type CharacterSourceDto = z.output<typeof characterSourceSchema>;
export type CharacterWorkshopSourceDto = z.output<
  typeof characterWorkshopSourceSchema
>;
export type CharacterRuntimeSnapshot = z.output<typeof characterRuntimeSnapshotSchema>;
export type CharacterRecoveryIssueErrorCode = z.output<
  typeof characterRecoveryIssueErrorCodeSchema
>;
export type CharacterRecoveryFallbackErrorCode = z.output<
  typeof characterRecoveryFallbackErrorCodeSchema
>;
export type CharacterRecoveryIssueDto = Readonly<
  z.output<typeof characterRecoveryIssueSchema>
>;
export type CharacterRecoverySnapshotDto = Readonly<{
  fallbackErrorCode: CharacterRecoveryFallbackErrorCode | null;
  issues: readonly CharacterRecoveryIssueDto[];
}>;
export type CharacterSourceChoiceResult = z.output<typeof characterSourceChoiceResultSchema>;
export type CharacterImportResult = z.output<typeof characterImportResultSchema>;
export type CharacterExportResult = z.output<typeof characterExportResultSchema>;
export type CharacterEvent = z.output<typeof characterEventSchema>;
