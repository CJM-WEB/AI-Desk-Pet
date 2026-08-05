import { z } from 'zod';

const finiteNumberSchema = z.number().finite();
const characterMotionIdentifierSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,119}$/u);
const characterPlaybackTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u);

export const characterMotionPointSchema = z.object({
  x: finiteNumberSchema,
  y: finiteNumberSchema
}).strict();

export const characterMotionSnapshotSchema = z.object({
  revision: z.number().int().nonnegative(),
  timestampMs: finiteNumberSchema.nonnegative(),
  position: characterMotionPointSchema,
  target: characterMotionPointSchema,
  direction: z.enum(['left', 'right']),
  moving: z.boolean(),
  carrying: z.boolean()
}).strict();

export const characterMotionSnapshotResultSchema = z.object({
  snapshot: characterMotionSnapshotSchema
}).strict();

export const characterMotionEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('snapshot'),
    snapshot: characterMotionSnapshotSchema
  }).strict(),
  z.object({
    type: z.literal('idle-action'),
    revision: z.number().int().nonnegative(),
    actionId: characterMotionIdentifierSchema,
    playbackToken: characterPlaybackTokenSchema
  }).strict(),
  z.object({
    type: z.literal('behavior-action'),
    revision: z.number().int().nonnegative(),
    stateId: characterMotionIdentifierSchema,
    actionId: characterMotionIdentifierSchema,
    playbackToken: characterPlaybackTokenSchema
  }).strict()
]);

export const characterMotionEmptyInputSchema = z.object({}).strict();
export const characterActionPlayedInputSchema = z.object({
  playbackToken: characterPlaybackTokenSchema,
  actionId: characterMotionIdentifierSchema
}).strict();
export const characterActionFeedbackInputSchema = z.object({
  playbackToken: characterPlaybackTokenSchema,
  actionId: characterMotionIdentifierSchema,
  status: z.enum(['started', 'completed', 'interrupted', 'failed'])
}).strict();

export type CharacterMotionPoint = z.output<typeof characterMotionPointSchema>;
export type CharacterMotionSnapshot = z.output<typeof characterMotionSnapshotSchema>;
export type CharacterMotionEvent = z.output<typeof characterMotionEventSchema>;
export type CharacterActionFeedbackInput = z.output<
  typeof characterActionFeedbackInputSchema
>;
