import { z } from 'zod';
import {
  STANDARD_CHARACTER_SEMANTICS,
  TRUSTED_BEHAVIOR_SIGNALS,
  safeIdentifierSchema
} from './character-v2-schema';

export type CharacterStandardSemantic = typeof STANDARD_CHARACTER_SEMANTICS[number];
export type TrustedBehaviorSignal = typeof TRUSTED_BEHAVIOR_SIGNALS[number];

export type CharacterBehaviorSignal =
  | { type: 'idle-due'; occurredAtMs: number }
  | { type: 'user-interaction'; occurredAtMs: number }
  | { type: 'conversation-start'; occurredAtMs: number }
  | { type: 'listening'; active: boolean; occurredAtMs: number }
  | { type: 'thinking'; active: boolean; occurredAtMs: number }
  | { type: 'task'; phase: 'start' | 'success' | 'failure'; occurredAtMs: number }
  | { type: 'movement'; active: boolean; occurredAtMs: number }
  | { type: 'carrying'; active: boolean; occurredAtMs: number };

export type CharacterAgentBehaviorIntent = {
  stateIntent: { stateId: string } | { semantic: CharacterStandardSemantic } | null;
  actionSemantic: CharacterStandardSemantic | null;
  urgency: number;
  explanation: string;
};

export type CharacterBehaviorStateSnapshot = {
  revision: number;
  primaryStateId: string;
  modifierStateIds: string[];
  activeSignals: TrustedBehaviorSignal[];
  desiredActionSemantic: CharacterStandardSemantic | null;
};

export type CharacterPlaybackFeedback = {
  playbackToken: string;
  actionId: string;
  status: 'started' | 'completed' | 'interrupted' | 'failed';
  occurredAtMs: number;
};

const occurredAtMsSchema = z.number().finite().nonnegative();
const standardCharacterSemanticSchema = z.enum(STANDARD_CHARACTER_SEMANTICS);

export const characterBehaviorSignalSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('idle-due'), occurredAtMs: occurredAtMsSchema }).strict(),
  z.object({ type: z.literal('user-interaction'), occurredAtMs: occurredAtMsSchema }).strict(),
  z.object({ type: z.literal('conversation-start'), occurredAtMs: occurredAtMsSchema }).strict(),
  z.object({ type: z.literal('listening'), active: z.boolean(), occurredAtMs: occurredAtMsSchema }).strict(),
  z.object({ type: z.literal('thinking'), active: z.boolean(), occurredAtMs: occurredAtMsSchema }).strict(),
  z.object({
    type: z.literal('task'),
    phase: z.enum(['start', 'success', 'failure']),
    occurredAtMs: occurredAtMsSchema
  }).strict(),
  z.object({ type: z.literal('movement'), active: z.boolean(), occurredAtMs: occurredAtMsSchema }).strict(),
  z.object({ type: z.literal('carrying'), active: z.boolean(), occurredAtMs: occurredAtMsSchema }).strict()
]);

const stateIntentSchema = z.union([
  z.object({ stateId: safeIdentifierSchema }).strict(),
  z.object({ semantic: standardCharacterSemanticSchema }).strict()
]);

export const characterAgentBehaviorIntentSchema = z.object({
  stateIntent: stateIntentSchema.nullable(),
  actionSemantic: standardCharacterSemanticSchema.nullable(),
  urgency: z.number().finite().min(0).max(100),
  explanation: z.string().trim().min(1).max(240)
}).strict();

export const characterBehaviorStateSnapshotSchema = z.object({
  revision: z.number().finite(),
  primaryStateId: safeIdentifierSchema,
  modifierStateIds: z.array(safeIdentifierSchema),
  activeSignals: z.array(z.enum(TRUSTED_BEHAVIOR_SIGNALS)),
  desiredActionSemantic: standardCharacterSemanticSchema.nullable()
}).strict();

export const characterPlaybackFeedbackSchema = z.object({
  playbackToken: safeIdentifierSchema,
  actionId: safeIdentifierSchema,
  status: z.enum(['started', 'completed', 'interrupted', 'failed']),
  occurredAtMs: occurredAtMsSchema
}).strict();
