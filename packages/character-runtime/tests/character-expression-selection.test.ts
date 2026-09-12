import { describe, expect, it } from 'vitest';
import {
  characterExpressionSelectionJsonSchema,
  characterExpressionSelectionSchema,
  toCharacterExpressionDecision
} from '../src';

const selection = {
  moodUpdate: { summary: '愉快', strength: .8 },
  expressionPlan: { states: [
    { stateId: 'feeling-custom', score: 1, activity: null, actions: [{ actionId: 'smile-custom', score: .9 }] },
    { stateId: 'motion-custom', score: .2, activity: 'moving' as const, actions: [{ actionId: 'walk-custom', score: .8 }] }
  ] },
  requestKind: 'action' as const,
  explicitPlayback: { stateId: 'motion-custom', actionId: 'walk-custom' },
  movementControl: { kind: 'move_once' as const, target: 'right' as const, distance: 'near' as const }
};

describe('精简表现选择契约', () => {
  it('长期选择独立转换，旧响应省略时保持空值，拒绝时间和重复动作', () => {
    const backgroundSelection = { stateId: 'feeling-custom', actions: [{ actionId: 'smile-custom', score: 1 }] };
    const parsed = characterExpressionSelectionSchema.safeParse({ ...selection, backgroundSelection });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(toCharacterExpressionDecision(parsed.data, 'autonomous').backgroundSelection).toEqual(backgroundSelection);
    expect(characterExpressionSelectionSchema.parse(selection).backgroundSelection).toBeNull();
    for (const invalid of [{ ...backgroundSelection, durationMs: 100 },
      { ...backgroundSelection, actions: [backgroundSelection.actions[0], backgroundSelection.actions[0]] }]) {
      expect(characterExpressionSelectionSchema.safeParse({ ...selection, backgroundSelection: invalid }).success).toBe(false);
    }
  });
  it('严格接收语义字段，并要求模型显式评估所有顶层字段', () => {
    expect(characterExpressionSelectionSchema.safeParse(selection).success).toBe(true);
    expect(characterExpressionSelectionJsonSchema.required).toEqual([
      'moodUpdate', 'expressionPlan', 'backgroundSelection', 'requestKind', 'explicitPlayback', 'movementControl'
    ]);
  });

  it('拒绝模型毫秒数、非法活动事实和重复 ID', () => {
    expect(characterExpressionSelectionSchema.safeParse({
      ...selection, moodUpdate: { ...selection.moodUpdate, fadeInMs: 100 }
    }).success).toBe(false);
    expect(characterExpressionSelectionSchema.safeParse({
      ...selection, expressionPlan: { states: [{ ...selection.expressionPlan.states[0], activity: 'walking' }] }
    }).success).toBe(false);
    expect(characterExpressionSelectionSchema.safeParse({
      ...selection, expressionPlan: { states: [selection.expressionPlan.states[0], selection.expressionPlan.states[0]] }
    }).success).toBe(false);
    expect(characterExpressionSelectionSchema.safeParse({
      ...selection, expressionPlan: { states: [{ ...selection.expressionPlan.states[0], actions: [
        selection.expressionPlan.states[0]!.actions[0], selection.expressionPlan.states[0]!.actions[0]
      ] }] }
    }).success).toBe(false);
  });

  it('聊天转换由宿主补齐时间与事实规则', () => {
    const decision = toCharacterExpressionDecision(characterExpressionSelectionSchema.parse(selection), 'chat');
    expect(decision).toMatchObject({
      moodUpdate: { summary: '愉快', strength: .8, fadeInMs: 0 },
      explicitPlayback: { stateId: 'motion-custom', actionId: 'walk-custom' },
      movementControl: { kind: 'move_once', target: 'right', distance: 'near' },
      requestKind: 'action'
    });
    expect(decision.expressionPlan?.states[0]).toMatchObject({
      stateId: 'feeling-custom', lifetime: 'episode', minStrength: .02, maxStrength: 1
    });
    expect(decision.expressionPlan?.states[0]).not.toHaveProperty('when');
    expect(decision.expressionPlan?.states[1]).toMatchObject({
      stateId: 'motion-custom', lifetime: 'condition', minStrength: 0, maxStrength: 1,
      when: { moving: true }
    });
  });

  it('自主转换沿用宿主渐入并移除明确播放与运动', () => {
    const decision = toCharacterExpressionDecision(characterExpressionSelectionSchema.parse(selection), 'autonomous');
    expect(decision.moodUpdate).toEqual({ summary: '愉快', strength: .8 });
    expect(decision).not.toHaveProperty('explicitPlayback');
    expect(decision.movementControl).toEqual({ kind: 'keep' });
    expect(decision.requestKind).toBe('action');
  });

  it('no_match 显式转换为空候选，字段省略仍留给调用方失败', () => {
    const noMatch = characterExpressionSelectionSchema.parse({
      ...selection, expressionPlan: null, requestKind: 'ambient', explicitPlayback: null,
      movementControl: { kind: 'keep' }
    });
    expect(toCharacterExpressionDecision(noMatch, 'chat').expressionPlan).toEqual({ states: [] });
  });

  it('聊天明确播放只接受 state/action，action 目标必须精确到 actionId', () => {
    for (const requestKind of ['ambient', 'movement'] as const) {
      const parsed = characterExpressionSelectionSchema.parse({ ...selection, requestKind });
      expect(toCharacterExpressionDecision(parsed, 'chat')).not.toHaveProperty('explicitPlayback');
    }
    expect(characterExpressionSelectionSchema.safeParse({
      ...selection, explicitPlayback: { stateId: 'motion-custom' }
    }).success).toBe(false);
    expect(characterExpressionSelectionSchema.safeParse({
      ...selection, explicitPlayback: null
    }).success).toBe(true);
    const state = characterExpressionSelectionSchema.parse({
      ...selection, requestKind: 'state', explicitPlayback: { stateId: 'motion-custom' }
    });
    expect(toCharacterExpressionDecision(state, 'chat').explicitPlayback).toEqual({ stateId: 'motion-custom' });
  });
});
