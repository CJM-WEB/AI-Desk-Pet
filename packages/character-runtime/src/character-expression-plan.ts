import { z } from 'zod';
import { safeIdentifierSchema } from './character-v2-schema';
const score = z.number().finite().min(0).max(1);
/** 长期语义选择不携带模型时间、心情门槛或宿主活动事实。 */
export const characterBackgroundSelectionSchema = z.object({
  stateId: safeIdentifierSchema,
  actions: z.array(z.object({ actionId: safeIdentifierSchema, score }).strict()).max(32)
}).strict().superRefine((selection, context) => {
  if (new Set(selection.actions.map(action => action.actionId)).size !== selection.actions.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: '长期选择的动作 ID 必须唯一。' });
  }
});
export type CharacterBackgroundSelection = z.infer<typeof characterBackgroundSelectionSchema>;
/** 条件只描述宿主事实，模型没有写入事实或扩展能力的入口。 */
export const characterRuntimeFactsSchema = z.object({
  moving: z.boolean(), dragging: z.boolean(), carrying: z.boolean(),
  chatting: z.boolean(), taskRunning: z.boolean(), awaitingConfirmation: z.boolean()
}).strict();
export type CharacterRuntimeFacts = z.infer<typeof characterRuntimeFactsSchema>;
const whenSchema = characterRuntimeFactsSchema.partial();
export const characterExplicitPlaybackSchema = z.object({
  stateId: safeIdentifierSchema, actionId: safeIdentifierSchema.optional()
}).strict();
export type CharacterExplicitPlayback = z.infer<typeof characterExplicitPlaybackSchema>;
export const characterExpressionPlanSchema = z.object({
  states: z.array(z.object({
    stateId: safeIdentifierSchema, score, minStrength: score, maxStrength: score,
    when: whenSchema.optional(), lifetime: z.enum(['episode', 'condition']).optional(),
    actions: z.array(z.object({ actionId: safeIdentifierSchema, score, when: whenSchema.optional() }).strict()).max(32)
  }).strict()).max(8),
  validForMs: z.number().finite().int().positive().max(1_800_000).default(1_200_000)
}).strict().superRefine((plan, context) => {
  plan.states.forEach((state, index) => {
    if (state.lifetime === 'condition' && !Object.values(state.when ?? {}).some(value => value === true)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['states', index, 'when'], message: '持续情境状态至少需要一个为真的活动条件。' });
    }
  });
  if (new Set(plan.states.map(state => state.stateId)).size !== plan.states.length
    || plan.states.reduce((sum, state) => sum + state.actions.length, 0) > 32
    || plan.states.some(state => state.minStrength > state.maxStrength
      || new Set(state.actions.map(action => action.actionId)).size !== state.actions.length)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: '候选必须唯一，强度区间有效且动作总数不超过三十二。' });
  }
});
export type CharacterExpressionPlanInput = z.input<typeof characterExpressionPlanSchema>;
export type CharacterExpressionPlan = z.output<typeof characterExpressionPlanSchema> & {
  contextRevision: number; moodRevision: number; expiresAtMs: number;
};
