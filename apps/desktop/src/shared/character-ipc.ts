import {
  characterDraftV1Schema,
  characterManifestV1Schema,
  CORE_CHARACTER_STATES
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
export const characterCreateInputSchema = z.object({
  name: z.string().trim().min(1).max(120)
}).strict();
export const characterDraftSaveInputSchema = z.object({
  characterId: characterIdSchema,
  draft: characterDraftV1Schema
}).strict();
export const characterSourceReadInputSchema = z.object({
  characterId: characterIdSchema,
  assetId: characterSourceAssetIdSchema
}).strict();
export const characterPublishInputSchema = z.object({
  characterId: characterIdSchema,
  manifest: characterManifestV1Schema,
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
  missingCoreStates: z.array(z.enum(CORE_CHARACTER_STATES))
}).strict();
export const characterSourceSchema = z.object({
  assetId: characterSourceAssetIdSchema,
  displayName: z.string().min(1).max(255),
  mimeType: z.enum(['image/png', 'image/webp']),
  byteLength: z.number().int().safe().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u)
}).strict();
export const characterRuntimeSnapshotSchema = z.object({
  activeCharacterId: characterIdSchema,
  manifest: characterManifestV1Schema
}).strict();

export const characterListResultSchema = z.object({
  characters: z.array(characterSummarySchema)
}).strict();
export const characterDraftResultSchema = z.object({
  draft: characterDraftV1Schema
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
export const characterSourceChoiceResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cancelled') }).strict(),
  z.object({
    kind: z.literal('selected'),
    sources: z.array(characterSourceSchema)
  }).strict()
]);
export const characterImportResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cancelled') }).strict(),
  z.object({
    kind: z.literal('imported'),
    characterId: characterIdSchema
  }).strict()
]);
export const characterExportResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cancelled') }).strict(),
  z.object({ kind: z.literal('exported') }).strict()
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
export type CharacterRuntimeSnapshot = z.output<typeof characterRuntimeSnapshotSchema>;
export type CharacterSourceChoiceResult = z.output<typeof characterSourceChoiceResultSchema>;
export type CharacterImportResult = z.output<typeof characterImportResultSchema>;
export type CharacterExportResult = z.output<typeof characterExportResultSchema>;
export type CharacterEvent = z.output<typeof characterEventSchema>;
