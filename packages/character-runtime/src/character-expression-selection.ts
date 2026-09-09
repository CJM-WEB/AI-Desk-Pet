import { z } from 'zod';
import {
  characterActivityFacts,
  movementControlPlanJsonSchema,
  movementControlPlanSchema,
  type MovementControlPlan
} from './character-behavior-plan';
import { MIN_ACTIVE_MOOD_STRENGTH, type CharacterMoodUpdate } from './character-mood';
import { characterExplicitPlaybackSchema, type CharacterExplicitPlayback, type CharacterExpressionPlanInput } from './character-expression-plan';
import { safeIdentifierSchema } from './character-v2-schema';

const scoreSchema = z.number().finite().min(0).max(1);
const selectionMoodSchema = z.object({
  summary: z.string().trim().min(1).max(240),
  strength: scoreSchema
}).strict();
const selectionActionSchema = z.object({
  actionId: safeIdentifierSchema,
  score: scoreSchema
}).strict();
const selectionStateSchema = z.object({
  stateId: safeIdentifierSchema,
  score: scoreSchema,
  activity: z.enum(characterActivityFacts).nullable(),
  actions: z.array(selectionActionSchema).max(32)
}).strict();
const selectionPlanSchema = z.object({
  states: z.array(selectionStateSchema).max(8)
}).strict().superRefine((plan, context) => {
  const stateIds = plan.states.map(state => state.stateId);
  const actionIds = plan.states.flatMap(state => state.actions.map(action => action.actionId));
  if (new Set(stateIds).size !== stateIds.length || new Set(actionIds).size !== actionIds.length
    || actionIds.length > 32) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: '状态和动作 ID 必须唯一，动作总数不能超过三十二。' });
  }
});

/** 模型只选择语义候选；所有时间、事实和生命周期均由宿主补齐。 */
export const characterExpressionSelectionShape = {
  moodUpdate: selectionMoodSchema.nullable(),
  expressionPlan: selectionPlanSchema.nullable(),
  requestKind: z.enum(['ambient', 'state', 'action', 'movement']),
  explicitPlayback: characterExplicitPlaybackSchema.nullable(),
  movementControl: movementControlPlanSchema
};
export const characterExpressionSelectionSchema = z.object(characterExpressionSelectionShape).strict()
  .superRefine((selection, context) => {
    if (selection.requestKind === 'action' && selection.explicitPlayback !== null
      && selection.explicitPlayback.actionId === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['explicitPlayback', 'actionId'],
        message: '明确动作目标必须包含 actionId。' });
    }
  });
export type CharacterExpressionSelection = Readonly<z.infer<typeof characterExpressionSelectionSchema>>;

const identifierJsonSchema = { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,119}$' } as const;
const scoreJsonSchema = { type: 'number', minimum: 0, maximum: 1 } as const;
/** 固定 llama.cpp 可消费的精简 JSON Schema；跨字段唯一性继续由同源 Zod Schema 强制。 */
export const characterExpressionSelectionJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['moodUpdate', 'expressionPlan', 'requestKind', 'explicitPlayback', 'movementControl'],
  properties: {
    moodUpdate: { anyOf: [
      { type: 'object', additionalProperties: false, required: ['summary', 'strength'], properties: {
        summary: { type: 'string', minLength: 1, maxLength: 240 }, strength: scoreJsonSchema
      } },
      { type: 'null' }
    ] },
    expressionPlan: { anyOf: [
      { type: 'object', additionalProperties: false, required: ['states'], properties: {
        states: { type: 'array', maxItems: 8, items: {
          type: 'object', additionalProperties: false, required: ['stateId', 'score', 'activity', 'actions'], properties: {
            stateId: identifierJsonSchema, score: scoreJsonSchema,
            activity: { anyOf: [{ enum: characterActivityFacts }, { type: 'null' }] },
            actions: { type: 'array', maxItems: 32, items: {
              type: 'object', additionalProperties: false, required: ['actionId', 'score'],
              properties: { actionId: identifierJsonSchema, score: scoreJsonSchema }
            } }
          }
        } }
      } },
      { type: 'null' }
    ] },
    requestKind: { enum: ['ambient', 'state', 'action', 'movement'] },
    explicitPlayback: { anyOf: [
      { type: 'object', additionalProperties: false, required: ['stateId'], properties: {
        stateId: identifierJsonSchema, actionId: identifierJsonSchema
      } },
      { type: 'null' }
    ] },
    movementControl: movementControlPlanJsonSchema
  }
} as const;

export type CharacterExpressionSelectionDecision = Readonly<{
  moodUpdate?: CharacterMoodUpdate;
  expressionPlan?: CharacterExpressionPlanInput;
  explicitPlayback?: CharacterExplicitPlayback;
  movementControl: MovementControlPlan;
  requestKind: CharacterExpressionSelection['requestKind'];
}>;

/** 纯转换只补宿主固定策略，不读取时钟、Provider 或运行事实。 */
export function toCharacterExpressionDecision(
  selection: CharacterExpressionSelection,
  source: 'chat' | 'autonomous'
): CharacterExpressionSelectionDecision {
  const moodUpdate = selection.moodUpdate === null
    ? undefined
    : source === 'chat' ? { ...selection.moodUpdate, fadeInMs: 0 } : { ...selection.moodUpdate };
  const expressionPlan = {
    states: (selection.expressionPlan?.states ?? []).map(state => ({
      stateId: state.stateId,
      score: state.score,
      minStrength: state.activity === null ? MIN_ACTIVE_MOOD_STRENGTH : 0,
      maxStrength: 1,
      ...(state.activity === null ? { lifetime: 'episode' as const } : {
        when: { [state.activity]: true }, lifetime: 'condition' as const
      }),
      actions: state.actions.map(action => ({ ...action }))
    }))
  };
  return {
    ...(moodUpdate === undefined ? {} : { moodUpdate }),
    expressionPlan,
    ...(source === 'chat' && (selection.requestKind === 'state' || selection.requestKind === 'action')
      && selection.explicitPlayback !== null
      && (selection.requestKind !== 'action' || selection.explicitPlayback.actionId !== undefined)
      ? { explicitPlayback: selection.explicitPlayback } : {}),
    movementControl: source === 'chat' ? selection.movementControl : { kind: 'keep' },
    requestKind: selection.requestKind
  };
}
