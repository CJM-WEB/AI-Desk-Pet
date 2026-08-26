import { z } from 'zod';
import { characterEmotionLabelSchema } from '@myself/shared-types';
import { STANDARD_CHARACTER_SEMANTICS, safeIdentifierSchema } from './character-v2-schema';
import type { CharacterEmotionLabel } from '@myself/shared-types';
import type { CharacterStandardSemantic } from './behavior-contracts';

export type BehaviorTarget =
  | Readonly<{ kind: 'semantic'; semantic: CharacterStandardSemantic }>
  | Readonly<{ kind: 'state_name'; name: string }>
  | Readonly<{ kind: 'action_name'; name: string }>
  | Readonly<{ kind: 'tag'; tag: string }>;

export type MoveDirection = 'left' | 'right' | 'up' | 'down';
export type MoveDistance = 'near' | 'medium' | 'far';
export type ScreenRegion =
  | 'left' | 'right' | 'top' | 'bottom'
  | 'top_left' | 'top_right' | 'bottom_left' | 'bottom_right';
export type PublicMotionTarget = 'random_work_area' | ScreenRegion;

export type MovementControlPlan =
  | Readonly<{ kind: 'keep' }>
  | Readonly<{ kind: 'set_mode'; mode: 0 | 1 | 2 }>
  | Readonly<{
      kind: 'move_once';
      target: PublicMotionTarget;
      distance: MoveDistance;
    }>;

/** 隐藏运动建议只允许公开目标类别，Main 不接收像素坐标。 */
export type MotionPlan = Readonly<{
  mode: 'none' | 'stop' | 'once' | 'continuous';
  durationSeconds: number | null;
  target: 'current' | 'random_work_area' | ScreenRegion;
  distance: 'none' | 'near' | 'medium' | 'far';
}>;

export type CharacterBehaviorPlan =
  | Readonly<{ kind: 'none'; emotion?: CharacterEmotionLabel }>
  | Readonly<{ kind: 'play'; target: BehaviorTarget; emotion?: CharacterEmotionLabel }>
  | Readonly<{ kind: 'move'; direction: MoveDirection; distance: MoveDistance }>
  | Readonly<{ kind: 'move_region'; region: ScreenRegion }>;

/** 发送给模型的角色清单不包含私有 ID、文件位置或任何能力引用。 */
export type PublicBehaviorCatalog = Readonly<{
  characterName: string;
  semantics: readonly CharacterStandardSemantic[];
  stateNames: readonly string[];
  actionNames: readonly string[];
  tags: readonly string[];
  /** 当前皮肤可播放的公开候选，不包含私有状态、动作或资源标识。 */
  candidates?: readonly Readonly<{
    kind: 'state_name' | 'action_name';
    name: string;
    semantic: string;
    tags: readonly string[];
  }>[];
}>;

const publicNameSchema = z.string().trim().min(1).max(120).refine(
  value => !/[\\/]/u.test(value) && !/^(?:[a-z]:|\\\\|\\\\[?.]\\)/iu.test(value),
  'PUBLIC_BEHAVIOR_NAME_INVALID'
);
/** 模型的隐藏活动与状态只承载短语义，不得携带无界正文。 */
export const characterBehaviorDescriptorSchema = z.string().trim().min(1).max(120);
const behaviorTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('semantic'), semantic: z.enum(STANDARD_CHARACTER_SEMANTICS) }).strict(),
  z.object({ kind: z.literal('state_name'), name: publicNameSchema }).strict(),
  z.object({ kind: z.literal('action_name'), name: publicNameSchema }).strict(),
  z.object({ kind: z.literal('tag'), tag: safeIdentifierSchema }).strict()
]);

const noneBehaviorPlanSchema = z.object({
  kind: z.literal('none'), emotion: characterEmotionLabelSchema.optional()
}).strict();
const playBehaviorPlanSchema = z.object({
    kind: z.literal('play'),
    target: behaviorTargetSchema,
    emotion: characterEmotionLabelSchema.optional()
  }).strict();

/** 模型的 behaviorPlan 只选择动画候选，运动策略由 movementControl 独占。 */
export const characterChatBehaviorPlanSchema = z.discriminatedUnion('kind', [
  noneBehaviorPlanSchema,
  playBehaviorPlanSchema
]);

export const characterBehaviorPlanSchema = z.discriminatedUnion('kind', [
  noneBehaviorPlanSchema,
  playBehaviorPlanSchema,
  z.object({
    kind: z.literal('move'),
    direction: z.enum(['left', 'right', 'up', 'down']),
    distance: z.enum(['near', 'medium', 'far'])
  }).strict(),
  z.object({
    kind: z.literal('move_region'),
    region: z.enum([
      'left', 'right', 'top', 'bottom',
      'top_left', 'top_right', 'bottom_left', 'bottom_right'
    ])
  }).strict()
]);

const publicMotionTargetSchema = z.enum([
  'random_work_area',
  'left', 'right', 'top', 'bottom',
  'top_left', 'top_right', 'bottom_left', 'bottom_right'
]);

/** 持久模式和一次移动共享严格联合，禁止模型注入坐标或私有资源标识。 */
export const movementControlPlanSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('keep') }).strict(),
  z.object({ kind: z.literal('set_mode'), mode: z.union([
    z.literal(0), z.literal(1), z.literal(2)
  ]) }).strict(),
  z.object({
    kind: z.literal('move_once'),
    target: publicMotionTargetSchema,
    distance: z.enum(['near', 'medium', 'far'])
  }).strict()
]);

export const motionPlanSchema = z.object({
  mode: z.enum(['none', 'stop', 'once', 'continuous']),
  durationSeconds: z.number().int().min(1).max(600).nullable(),
  target: z.enum([
    'current', 'random_work_area',
    'left', 'right', 'top', 'bottom',
    'top_left', 'top_right', 'bottom_left', 'bottom_right'
  ]),
  distance: z.enum(['none', 'near', 'medium', 'far'])
}).strict();

export const publicBehaviorCatalogSchema = z.object({
  characterName: publicNameSchema,
  semantics: z.array(z.enum(STANDARD_CHARACTER_SEMANTICS)).max(STANDARD_CHARACTER_SEMANTICS.length),
  stateNames: z.array(publicNameSchema).max(512),
  actionNames: z.array(publicNameSchema).max(1_024),
  tags: z.array(safeIdentifierSchema).max(1_024),
  candidates: z.array(z.object({
    kind: z.enum(['state_name', 'action_name']),
    name: publicNameSchema,
    semantic: characterBehaviorDescriptorSchema,
    tags: z.array(safeIdentifierSchema).max(1_024)
  }).strict()).max(1_536).optional()
}).strict();

/** 可执行契约与发送给模型的 JSON Schema 成对维护，Main 以它复核模型真实输出。 */
export const characterChatResponseSchema = z.object({
  text: z.string().min(1).max(4_000),
  activity: characterBehaviorDescriptorSchema,
  status: characterBehaviorDescriptorSchema,
  movementControl: movementControlPlanSchema,
  behaviorPlan: characterChatBehaviorPlanSchema
}).strict();

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/** 该常量只声明聊天输出形状，不能被解释为工具或本地权限。 */
export const characterChatResponseJsonSchema = deepFreeze({
  type: 'object',
  additionalProperties: false,
  required: ['text', 'activity', 'status', 'movementControl', 'behaviorPlan'],
  properties: {
    text: { type: 'string', minLength: 1, maxLength: 4_000 },
    activity: { type: 'string', minLength: 1, maxLength: 120 },
    status: { type: 'string', minLength: 1, maxLength: 120 },
    movementControl: {
      oneOf: [
        {
          type: 'object', additionalProperties: false, required: ['kind'],
          properties: { kind: { const: 'keep' } }
        },
        {
          type: 'object', additionalProperties: false, required: ['kind', 'mode'],
          properties: { kind: { const: 'set_mode' }, mode: { enum: [0, 1, 2] } }
        },
        {
          type: 'object', additionalProperties: false,
          required: ['kind', 'target', 'distance'],
          properties: {
            kind: { const: 'move_once' },
            target: { enum: [
              'random_work_area',
              'left', 'right', 'top', 'bottom',
              'top_left', 'top_right', 'bottom_left', 'bottom_right'
            ] },
            distance: { enum: ['near', 'medium', 'far'] }
          }
        }
      ]
    },
    behaviorPlan: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['kind'],
          properties: {
            kind: { const: 'none' },
            emotion: { enum: ['happy', 'sad', 'angry', 'surprised', 'calm'] }
          }
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'target'],
          properties: {
            kind: { const: 'play' },
            emotion: { enum: ['happy', 'sad', 'angry', 'surprised', 'calm'] },
            target: {
              oneOf: [
                {
                  type: 'object',
                  additionalProperties: false,
                  required: ['kind', 'semantic'],
                  properties: {
                    kind: { const: 'semantic' },
                    semantic: { enum: STANDARD_CHARACTER_SEMANTICS }
                  }
                },
                {
                  type: 'object',
                  additionalProperties: false,
                  required: ['kind', 'name'],
                  properties: {
                    kind: { const: 'state_name' },
                    name: { type: 'string', minLength: 1, maxLength: 120, pattern: '^(?!\\s*$)(?!.*[\\\\/])(?![A-Za-z]:).+$' }
                  }
                },
                {
                  type: 'object',
                  additionalProperties: false,
                  required: ['kind', 'name'],
                  properties: {
                    kind: { const: 'action_name' },
                    name: { type: 'string', minLength: 1, maxLength: 120, pattern: '^(?!\\s*$)(?!.*[\\\\/])(?![A-Za-z]:).+$' }
                  }
                },
                {
                  type: 'object',
                  additionalProperties: false,
                  required: ['kind', 'tag'],
                  properties: {
                    kind: { const: 'tag' },
                    tag: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,119}$' }
                  }
                }
              ]
            }
          }
        }
      ]
    }
  }
});
