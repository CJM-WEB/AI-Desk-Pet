import { expect, test } from 'vitest';
import { characterChatResponseSchema, characterBehaviorPlanSchema, movementControlPlanSchema } from '../src';
const reply = { text: '你好', movementControl: { kind: 'keep' },
  moodUpdate: { summary: '喜悦', strength: .8 },
  expressionPlan: { states: [{ stateId: 'custom', score: 1, minStrength: .5, maxStrength: 1, actions: [{ actionId: 'wave', score: 1 }] }] } };
test('新聊天信封支持自由心情、两级计划和明确播放', () => {
  expect(characterChatResponseSchema.safeParse(reply).success).toBe(true);
  expect(characterChatResponseSchema.safeParse({ ...reply, explicitPlayback: { stateId: 'custom', actionId: 'wave' } }).success).toBe(true);
});
test('旧正式选态字段、伪造宿主修订、重复状态和非法强度拒绝', () => {
  for (const field of ['activity', 'status', 'behaviorPlan', 'emotion', 'preserveExplicitPlaybackToken']) {
    expect(characterChatResponseSchema.safeParse({ ...reply, [field]: 'old' }).success).toBe(false);
  }
  expect(characterChatResponseSchema.safeParse({ ...reply, moodUpdate: { summary: '喜悦', strength: 2 } }).success).toBe(false);
  expect(characterChatResponseSchema.safeParse({ ...reply, expressionPlan: { states: [reply.expressionPlan.states[0], reply.expressionPlan.states[0]] } }).success).toBe(false);
});
test('运动契约独立且Main明确入口不接收情绪标签', () => {
  expect(movementControlPlanSchema.safeParse({ kind: 'set_mode', mode: 2 }).success).toBe(true);
  expect(movementControlPlanSchema.safeParse({ kind: 'set_mode', mode: 3 }).success).toBe(false);
  expect(characterBehaviorPlanSchema.safeParse({ kind: 'play_state', state: 'joy', emotion: 'happy' }).success).toBe(false);
});
