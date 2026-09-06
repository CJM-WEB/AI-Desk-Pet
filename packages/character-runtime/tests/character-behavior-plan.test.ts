import { expect, test } from 'vitest';
import { characterChatResponseSchema, characterChatResponseJsonSchema, characterBehaviorPlanSchema, movementControlPlanSchema } from '../src';
const reply = { text: '你好', movementControl: { kind: 'keep' },
  moodUpdate: { summary: '喜悦', strength: .8 },
  expressionPlan: { states: [{ stateId: 'custom', score: 1, minStrength: .5, maxStrength: 1, actions: [{ actionId: 'wave', score: 1 }] }] } };
test('新聊天信封支持自由心情、两级计划和明确播放', () => {
  expect(characterChatResponseSchema.safeParse(reply).success).toBe(true);
  expect(characterChatResponseSchema.safeParse({ ...reply, explicitPlayback: { stateId: 'custom', actionId: 'wave' } }).success).toBe(true);
});
test('正式 wire 必须评估心情和计划，null 解码为无更新', () => {
  expect(characterChatResponseJsonSchema.required).toEqual(expect.arrayContaining(['moodUpdate', 'expressionPlan']));
  const parsed = characterChatResponseSchema.parse({ ...reply, moodUpdate: null, expressionPlan: null });
  expect(parsed.moodUpdate).toBeUndefined();
  expect(parsed.expressionPlan).toBeUndefined();
  for (const field of ['moodUpdate', 'expressionPlan']) {
    const omitted: Record<string, unknown> = { ...reply };
    delete omitted[field];
    expect(characterChatResponseSchema.safeParse(omitted).success).toBe(false);
  }
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

test('情境条件严格校验且 condition 必须有真实活动条件', () => {
  const state = reply.expressionPlan.states[0]!;
  const parse = (candidate: unknown) => characterChatResponseSchema.safeParse({ ...reply, expressionPlan: { states: [candidate] } }).success;
  expect(parse({ ...state, lifetime: 'condition', when: { moving: true, dragging: false }, actions: [{ actionId: 'wave', score: 1, when: { carrying: true } }] })).toBe(true);
  for (const when of [{}, { moving: false }, { moving: 'true' }, { arbitrary: true }]) {
    expect(parse({ ...state, lifetime: 'condition', when })).toBe(false);
  }
  expect(parse({ ...state, lifetime: 'condition' })).toBe(false);
  expect(parse({ ...state, when: { arbitrary: true } })).toBe(false);
  expect(parse({ ...state, actions: [{ actionId: 'wave', score: 1, when: { carrying: 1 } }] })).toBe(false);
});

test('提交给固定 llama.cpp 的 wire 不含未支持的关联语法', () => {
  // 检查实际导出的模型协议对象，防止上游静默忽略不支持的 Schema 约束。
  const unsupported: string[] = [];
  const inspect = (value: unknown, path = '$'): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach((item, index) => inspect(item, `${path}[${index}]`)); return; }
    const node = value as Record<string, unknown>;
    for (const keyword of ['if', 'then', 'else']) if (keyword in node) unsupported.push(`${path}.${keyword}`);
    if ('properties' in node && ('anyOf' in node || 'oneOf' in node)) unsupported.push(path);
    Object.entries(node).forEach(([key, child]) => inspect(child, `${path}.${key}`));
  };
  inspect(characterChatResponseJsonSchema);
  expect(unsupported).toEqual([]);
});
