import { z } from 'zod';
import { characterIdentitySchema, safeIdentifierSchema } from './character-v2-schema';
import { characterMoodUpdateSchema } from './character-mood';
import { characterExpressionPlanSchema, characterExplicitPlaybackSchema } from './character-expression-plan';

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

/** 聊天与自主共用 wire 字段：必须评估，null 在对象校验入口归一化为无更新。 */
export const characterExpressionWireShape = {
  moodUpdate: characterMoodUpdateSchema.nullable().transform(value => value ?? undefined),
  expressionPlan: characterExpressionPlanSchema.nullable().transform(value => value ?? undefined)
};
/** 表现引用由 Main 对照实际发送目录复核；没有更新不等于强制平静。 */
export const characterChatResponseSchema = z.object({
  ...characterExpressionWireShape, text: z.string().min(1).max(4000), explicitPlayback: characterExplicitPlaybackSchema.optional(),
  movementControl: movementControlPlanSchema
}).strict();
const identifier = { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,119}$' };
const score = { type: 'number', minimum: 0, maximum: 1 };
const factNames = ['moving', 'dragging', 'carrying', 'chatting', 'taskRunning', 'awaitingConfirmation'] as const;
const when = { type: 'object', additionalProperties: false,
  properties: Object.fromEntries(factNames.map(name => [name, { type: 'boolean' }])) };
/** JSON 协议与执行 Schema 对应；生命周期修订和保留令牌不能由模型提供。 */
export const characterChatResponseJsonSchema = {
  type: 'object', additionalProperties: false, required: ['text', 'moodUpdate', 'expressionPlan', 'movementControl'],
  properties: {
    text: { type: 'string', minLength: 1, maxLength: 4000 },
    moodUpdate: { anyOf: [{ type: 'object', additionalProperties: false, required: ['summary', 'strength'],
      properties: { summary: { type: 'string', minLength: 1, maxLength: 240 }, strength: score,
        fadeInMs: { type: 'integer', minimum: 0, maximum: 300000 }, halfLifeMs: { type: 'integer', minimum: 30000, maximum: 1800000 } } }, { type: 'null' }] },
    expressionPlan: { anyOf: [{ type: 'object', additionalProperties: false, required: ['states'],
      properties: { validForMs: { type: 'integer', minimum: 1, maximum: 1800000 },
        states: { type: 'array', maxItems: 8, items: { type: 'object', additionalProperties: false,
          required: ['stateId', 'score', 'minStrength', 'maxStrength', 'actions'],
          allOf: [{ if: { required: ['lifetime'], properties: { lifetime: { const: 'condition' } } },
            then: { required: ['when'], properties: { when: { anyOf: factNames.map(name => ({ required: [name], properties: { [name]: { const: true } } })) } } } }],
          properties: { stateId: identifier, score, minStrength: score, maxStrength: score,
            when, lifetime: { enum: ['episode', 'condition'] },
            actions: { type: 'array', maxItems: 32, items: { type: 'object', additionalProperties: false,
              required: ['actionId', 'score'], properties: { actionId: identifier, score, when } } } } } } } }, { type: 'null' }] },
    explicitPlayback: { type: 'object', additionalProperties: false, required: ['stateId'],
      properties: { stateId: identifier, actionId: identifier } },
    movementControl: { oneOf: [
      { type: 'object', additionalProperties: false, required: ['kind'], properties: { kind: { const: 'keep' } } },
      { type: 'object', additionalProperties: false, required: ['kind', 'mode'], properties: { kind: { const: 'set_mode' }, mode: { enum: [0, 1, 2] } } },
      { type: 'object', additionalProperties: false, required: ['kind', 'target', 'distance'],
        properties: { kind: { const: 'move_once' }, target: { enum: ['random_work_area', 'left', 'right', 'top', 'bottom', 'top_left', 'top_right', 'bottom_left', 'bottom_right'] },
          distance: { enum: ['near', 'medium', 'far'] } } }
    ] }
  }
} as const;
