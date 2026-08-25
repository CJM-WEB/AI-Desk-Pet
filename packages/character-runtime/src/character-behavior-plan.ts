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
  | Readonly<{ kind: 'move_region'; region: ScreenRegion }>
  | Readonly<{ kind: 'stop_movement' }>
  | Readonly<{ kind: 'resume_movement' }>;

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

export const characterBehaviorPlanSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none'), emotion: characterEmotionLabelSchema.optional() }).strict(),
  z.object({
    kind: z.literal('play'),
    target: behaviorTargetSchema,
    emotion: characterEmotionLabelSchema.optional()
  }).strict(),
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
  }).strict(),
  z.object({ kind: z.literal('stop_movement') }).strict(),
  z.object({ kind: z.literal('resume_movement') }).strict()
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
  motionPlan: motionPlanSchema,
  behaviorPlan: characterBehaviorPlanSchema
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
  required: ['text', 'activity', 'status', 'motionPlan', 'behaviorPlan'],
  properties: {
    text: { type: 'string', minLength: 1, maxLength: 4_000 },
    activity: { type: 'string', minLength: 1, maxLength: 120 },
    status: { type: 'string', minLength: 1, maxLength: 120 },
    motionPlan: {
      type: 'object',
      additionalProperties: false,
      required: ['mode', 'durationSeconds', 'target', 'distance'],
      properties: {
        mode: { enum: ['none', 'stop', 'once', 'continuous'] },
        durationSeconds: {
          anyOf: [
            { type: 'null' },
            { type: 'integer', minimum: 1, maximum: 600 }
          ]
        },
        target: {
          enum: [
            'current', 'random_work_area',
            'left', 'right', 'top', 'bottom',
            'top_left', 'top_right', 'bottom_left', 'bottom_right'
          ]
        },
        distance: { enum: ['none', 'near', 'medium', 'far'] }
      }
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
        },
        { type: 'object', additionalProperties: false, required: ['kind', 'direction', 'distance'], properties: { kind: { const: 'move' }, direction: { enum: ['left', 'right', 'up', 'down'] }, distance: { enum: ['near', 'medium', 'far'] } } },
        { type: 'object', additionalProperties: false, required: ['kind', 'region'], properties: { kind: { const: 'move_region' }, region: { enum: ['left', 'right', 'top', 'bottom', 'top_left', 'top_right', 'bottom_left', 'bottom_right'] } } },
        { type: 'object', additionalProperties: false, required: ['kind'], properties: { kind: { const: 'stop_movement' } } },
        { type: 'object', additionalProperties: false, required: ['kind'], properties: { kind: { const: 'resume_movement' } } }
      ]
    }
  }
});
