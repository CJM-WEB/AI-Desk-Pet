import { z } from 'zod';

const finiteNumberSchema = z.number().finite();

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
    actionId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,119}$/u),
    playbackToken: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u)
  }).strict()
]);

export const characterMotionEmptyInputSchema = z.object({}).strict();
export const characterActionPlayedInputSchema = z.object({
  playbackToken: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u),
  actionId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,119}$/u)
}).strict();

export type CharacterMotionPoint = z.output<typeof characterMotionPointSchema>;
export type CharacterMotionSnapshot = z.output<typeof characterMotionSnapshotSchema>;
export type CharacterMotionEvent = z.output<typeof characterMotionEventSchema>;
