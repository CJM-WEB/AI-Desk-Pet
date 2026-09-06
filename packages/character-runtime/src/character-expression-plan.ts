import { z } from 'zod';
import { safeIdentifierSchema } from './character-v2-schema';
const score = z.number().finite().min(0).max(1);
export const characterExplicitPlaybackSchema = z.object({
  stateId: safeIdentifierSchema, actionId: safeIdentifierSchema.optional()
}).strict();
export type CharacterExplicitPlayback = z.infer<typeof characterExplicitPlaybackSchema>;
export const characterExpressionPlanSchema = z.object({
  states: z.array(z.object({
    stateId: safeIdentifierSchema, score, minStrength: score, maxStrength: score,
    actions: z.array(z.object({ actionId: safeIdentifierSchema, score }).strict()).max(32)
  }).strict()).max(8),
  validForMs: z.number().finite().int().positive().max(1_800_000).default(1_200_000)
}).strict().superRefine((plan, context) => {
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
