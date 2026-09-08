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
  requestKind: 'movement' as const,
  explicitPlayback: { stateId: 'motion-custom', actionId: 'walk-custom' },
  movementControl: { kind: 'move_once' as const, target: 'right' as const, distance: 'near' as const }
};

describe('精简表现选择契约', () => {
  it('严格接收语义字段，并要求模型显式评估所有顶层字段', () => {
    expect(characterExpressionSelectionSchema.safeParse(selection).success).toBe(true);
    expect(characterExpressionSelectionJsonSchema.required).toEqual([
      'moodUpdate', 'expressionPlan', 'requestKind', 'explicitPlayback', 'movementControl'
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
      requestKind: 'movement'
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
    expect(decision.requestKind).toBe('movement');
  });
});
