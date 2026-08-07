import { beforeEach, describe, expect, test } from 'vitest';
import {
  characterAgentBehaviorIntentSchema,
  characterBehaviorSignalSchema,
  characterBehaviorStateSnapshotSchema,
  characterPlaybackFeedbackSchema
} from '../src';

describe('自主行为严格契约', () => {
  beforeEach(() => {
    expect(characterBehaviorSignalSchema).toBeDefined();
    expect(characterAgentBehaviorIntentSchema).toBeDefined();
    expect(characterBehaviorStateSnapshotSchema).toBeDefined();
    expect(characterPlaybackFeedbackSchema).toBeDefined();
  });

  test('接受合法的本地行为信号', () => {
    expect(characterBehaviorSignalSchema.parse({
      type: 'listening', active: true, occurredAtMs: 1_000
    })).toEqual({
      type: 'listening', active: true, occurredAtMs: 1_000
    });
  });

  test('接受由 Main 产生的搬运活动事实', () => {
    expect(characterBehaviorSignalSchema.parse({
      type: 'carrying', active: true, occurredAtMs: 1_001
    })).toEqual({
      type: 'carrying', active: true, occurredAtMs: 1_001
    });
  });

  test('接受合法的智能体行为意图', () => {
    expect(characterAgentBehaviorIntentSchema.parse({
      stateIntent: { semantic: 'think' },
      actionSemantic: 'think',
      urgency: 50,
      explanation: '整理当前任务。'
    })).toEqual({
      stateIntent: { semantic: 'think' },
      actionSemantic: 'think',
      urgency: 50,
      explanation: '整理当前任务。'
    });
  });

  test('接受合法的播放反馈', () => {
    expect(characterPlaybackFeedbackSchema.parse({
      playbackToken: 'playback-1',
      actionId: 'think-main',
      status: 'completed',
      occurredAtMs: 1_000
    })).toEqual({
      playbackToken: 'playback-1',
      actionId: 'think-main',
      status: 'completed',
      occurredAtMs: 1_000
    });
  });

  test('接受由可信信号组成的合法状态快照', () => {
    expect(characterBehaviorStateSnapshotSchema.parse({
      revision: 1,
      primaryStateId: 'thinking',
      modifierStateIds: ['focused'],
      activeSignals: ['thinking'],
      desiredActionSemantic: 'think'
    })).toEqual({
      revision: 1,
      primaryStateId: 'thinking',
      modifierStateIds: ['focused'],
      activeSignals: ['thinking'],
      desiredActionSemantic: 'think'
    });
  });

  test.each([
    ['未知字段', {
      revision: 1,
      primaryStateId: 'thinking',
      modifierStateIds: [],
      activeSignals: ['thinking'],
      desiredActionSemantic: 'think',
      unexpected: true
    }],
    ['未知可信信号', {
      revision: 1,
      primaryStateId: 'thinking',
      modifierStateIds: [],
      activeSignals: ['untrusted'],
      desiredActionSemantic: 'think'
    }]
  ])('状态快照拒绝%s', (_, value) => {
    expect(() => characterBehaviorStateSnapshotSchema.parse(value)).toThrow();
  });

  test.each([
    ['本地行为信号', characterBehaviorSignalSchema, {
      type: 'idle-due', occurredAtMs: 1, unexpected: true
    }],
    ['智能体行为意图', characterAgentBehaviorIntentSchema, {
      stateIntent: null, actionSemantic: null, urgency: 0, explanation: '保持待机。', unexpected: true
    }],
    ['播放反馈', characterPlaybackFeedbackSchema, {
      playbackToken: 'playback-1', actionId: 'idle-main', status: 'started', occurredAtMs: 1, unexpected: true
    }]
  ])('拒绝含未知字段的%s', (_, schema, value) => {
    expect(() => schema.parse(value)).toThrow();
  });

  test('拒绝未知标准语义', () => {
    expect(() => characterAgentBehaviorIntentSchema.parse({
      stateIntent: { semantic: 'dance' },
      actionSemantic: null,
      urgency: 0,
      explanation: '尝试未知动作。'
    })).toThrow();
  });

  test('拒绝非法状态标识符', () => {
    expect(() => characterAgentBehaviorIntentSchema.parse({
      stateIntent: { stateId: '状态 1' },
      actionSemantic: null,
      urgency: 0,
      explanation: '尝试非法状态。'
    })).toThrow();
  });

  test('拒绝超过长度上限的意图解释', () => {
    expect(() => characterAgentBehaviorIntentSchema.parse({
      stateIntent: null,
      actionSemantic: null,
      urgency: 0,
      explanation: '长'.repeat(241)
    })).toThrow();
  });

  test.each([
    ['非数值', Number.NaN],
    ['正无穷', Number.POSITIVE_INFINITY]
  ])('拒绝非有限发生时间：%s', (_, occurredAtMs) => {
    expect(() => characterBehaviorSignalSchema.parse({
      type: 'idle-due', occurredAtMs
    })).toThrow();
  });

  test.each([-1, 101])('拒绝越界紧急度：%i', (urgency) => {
    expect(() => characterAgentBehaviorIntentSchema.parse({
      stateIntent: null,
      actionSemantic: null,
      urgency,
      explanation: '紧急度非法。'
    })).toThrow();
  });
});
