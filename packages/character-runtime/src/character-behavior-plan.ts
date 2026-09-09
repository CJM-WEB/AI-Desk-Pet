import { z } from 'zod';
import { characterIdentitySchema, safeIdentifierSchema } from './character-v2-schema';

export type BehaviorTarget =
  | Readonly<{ kind: 'state_name'; name: string }>
  | Readonly<{ kind: 'action_name'; name: string }>
  | Readonly<{ kind: 'tag'; tag: string }>;
export type MoveDirection = 'left' | 'right' | 'up' | 'down';
export type MoveDistance = 'near' | 'medium' | 'far';
export type ScreenRegion = 'left' | 'right' | 'top' | 'bottom' | 'top_left' | 'top_right' | 'bottom_left' | 'bottom_right';
export type PublicMotionTarget = 'random_work_area' | ScreenRegion;
export type MovementControlPlan =
  | Readonly<{ kind: 'keep' }>
  | Readonly<{ kind: 'set_mode'; mode: 0 | 1 | 2 }>
  | Readonly<{ kind: 'move_once'; target: PublicMotionTarget; distance: MoveDistance }>;
export const characterActivityFacts = [
  'moving', 'dragging', 'carrying', 'chatting', 'taskRunning', 'awaitingConfirmation'
] as const;
export type CharacterActivityFact = typeof characterActivityFacts[number];

/** 仅供 Main 已有明确目标/运动入口；不是模型输出协议。 */
export type CharacterBehaviorDuration = 'brief' | 'normal' | 'extended';
export type CharacterBehaviorPlan =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'play_state'; state: string; action?: string; duration?: CharacterBehaviorDuration }>
  | Readonly<{ kind: 'move'; direction: MoveDirection; distance: MoveDistance }>
  | Readonly<{ kind: 'move_region'; region: ScreenRegion }>;
const publicNameSchema = z.string().trim().min(1).max(120);
export const movementControlPlanSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('keep') }).strict(),
  z.object({ kind: z.literal('set_mode'), mode: z.union([z.literal(0), z.literal(1), z.literal(2)]) }).strict(),
  z.object({ kind: z.literal('move_once'), target: z.enum(['random_work_area', 'left', 'right', 'top', 'bottom', 'top_left', 'top_right', 'bottom_left', 'bottom_right']),
    distance: z.enum(['near', 'medium', 'far']) }).strict()
]);
export const movementControlPlanJsonSchema = { oneOf: [
  { type: 'object', additionalProperties: false, required: ['kind'], properties: { kind: { const: 'keep' } } },
  { type: 'object', additionalProperties: false, required: ['kind', 'mode'],
    properties: { kind: { const: 'set_mode' }, mode: { enum: [0, 1, 2] } } },
  { type: 'object', additionalProperties: false, required: ['kind', 'target', 'distance'], properties: {
    kind: { const: 'move_once' },
    target: { enum: ['random_work_area', 'left', 'right', 'top', 'bottom', 'top_left', 'top_right', 'bottom_left', 'bottom_right'] },
    distance: { enum: ['near', 'medium', 'far'] }
  } }
] } as const;
export const characterBehaviorPlanSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('play_state'), state: publicNameSchema, action: publicNameSchema.optional(),
    duration: z.enum(['brief', 'normal', 'extended']).optional() }).strict(),
  z.object({ kind: z.literal('move'), direction: z.enum(['left', 'right', 'up', 'down']), distance: z.enum(['near', 'medium', 'far']) }).strict(),
  z.object({ kind: z.literal('move_region'), region: z.enum(['left', 'right', 'top', 'bottom', 'top_left', 'top_right', 'bottom_left', 'bottom_right']) }).strict()
]);
const publicIdentitySchema = characterIdentitySchema.extend({ name: publicNameSchema });
const publicBehaviorActionSchema = z.object({
  actionId: safeIdentifierSchema, name: publicNameSchema, description: z.string().max(2000).optional(),
  tags: z.array(safeIdentifierSchema).max(32)
}).strict();
const publicBehaviorStateSchema = z.object({
  stateId: safeIdentifierSchema, name: publicNameSchema, description: z.string().max(2000).optional(),
  agentInferable: z.boolean(), tags: z.array(safeIdentifierSchema).max(32),
  actions: z.array(publicBehaviorActionSchema).max(128)
}).strict();
/** Main 保留完整公开作者资料；请求的候选覆盖范围由每次投影决定。 */
export const publicBehaviorCatalogSchema = z.object({
  idleStateId: safeIdentifierSchema, identity: publicIdentitySchema,
  states: z.array(publicBehaviorStateSchema).max(512)
}).strict();
export type PublicCharacterIdentity = Readonly<z.infer<typeof publicIdentitySchema>>;
export type PublicBehaviorAction = Readonly<z.infer<typeof publicBehaviorActionSchema>>;
export type PublicBehaviorState = Readonly<Omit<z.infer<typeof publicBehaviorStateSchema>, 'actions'>> & { readonly actions: readonly PublicBehaviorAction[] };
export type PublicBehaviorCatalog = Readonly<{ idleStateId: string; identity: PublicCharacterIdentity; states: readonly PublicBehaviorState[] }>;
