import { expect, test } from 'vitest';
import { characterExpressionPlanSchema, characterBehaviorPlanSchema, movementControlPlanSchema } from '../src';
test('运动契约独立且Main明确入口不接收情绪标签', () => {
  expect(movementControlPlanSchema.safeParse({ kind: 'set_mode', mode: 2 }).success).toBe(true);
  expect(movementControlPlanSchema.safeParse({ kind: 'set_mode', mode: 3 }).success).toBe(false);
  expect(characterBehaviorPlanSchema.safeParse({ kind: 'play_state', state: 'joy', emotion: 'happy' }).success).toBe(false);
});

test('情境条件严格校验且 condition 必须有真实活动条件', () => {
  const state = { stateId: 'custom', score: 1, minStrength: 0, maxStrength: 1, actions: [{ actionId: 'wave', score: 1 }] };
  const parse = (candidate: unknown) => characterExpressionPlanSchema.safeParse({ states: [candidate] }).success;
  expect(parse({ ...state, lifetime: 'condition', when: { moving: true, dragging: false }, actions: [{ actionId: 'wave', score: 1, when: { carrying: true } }] })).toBe(true);
  for (const when of [{}, { moving: false }, { moving: 'true' }, { arbitrary: true }]) {
    expect(parse({ ...state, lifetime: 'condition', when })).toBe(false);
  }
  expect(parse({ ...state, lifetime: 'condition' })).toBe(false);
  expect(parse({ ...state, when: { arbitrary: true } })).toBe(false);
  expect(parse({ ...state, actions: [{ actionId: 'wave', score: 1, when: { carrying: 1 } }] })).toBe(false);
});
