import { describe, expect, test } from 'vitest';
import {
  type CharacterActionDefinitionV2,
  type CharacterActionHistoryEntry,
  type CharacterBehaviorActionSelection,
  type CharacterBehaviorSchedule,
  reduceCharacterActionSchedule
} from '../src';

/** 创建可按测试场景覆盖的动作定义。 */
function createAction(
  id: string,
  overrides: Partial<CharacterActionDefinitionV2> = {}
): CharacterActionDefinitionV2 {
  return {
    id,
    name: id,
    semantic: 'idle',
    tags: [],
    preference: 1,
    cooldownMs: 0,
    repeatSuppressionMs: 0,
    loopPolicy: 'never',
    interrupt: 'normal',
    allowedPrimaryStateIds: [],
    forbiddenPrimaryStateIds: [],
    requiredModifierStateIds: [],
    forbiddenModifierStateIds: [],
    direction: 'any',
    ...overrides
  };
}

/** 创建调度器所需的最小动作选择结果。 */
function createSelection(actionId: string, stateId = 'idle-state'): CharacterBehaviorActionSelection {
  return {
    actionId,
    stateId,
    reason: 'state-preference',
    presentation: {
      actionId,
      fps: 12,
      frames: [{ assetId: `${actionId}-frame`, x: 0, y: 0, width: 1, height: 1 }],
      anchors: { ground: { x: 0.5, y: 1 } }
    }
  };
}

/** 创建空调度快照。 */
function createSchedule(overrides: Partial<CharacterBehaviorSchedule> = {}): CharacterBehaviorSchedule {
  return { revision: 0, current: null, history: [], ...overrides };
}

/** 调度并返回新快照，简化后续反馈场景准备。 */
function scheduleAction(
  schedule: CharacterBehaviorSchedule,
  action: CharacterActionDefinitionV2,
  playbackToken: string,
  durationMs: number | null = 100
): CharacterBehaviorSchedule {
  return reduceCharacterActionSchedule(schedule, {
    type: 'schedule',
    selection: createSelection(action.id),
    playbackToken,
    nowMs: 10,
    startConfirmationTimeoutMs: 100,
    durationMs,
    urgency: 10,
    systemForced: false
  }, [action]).schedule;
}

/** 向当前动作发送开始反馈。 */
function startAction(
  schedule: CharacterBehaviorSchedule,
  action: CharacterActionDefinitionV2,
  playbackToken: string,
  occurredAtMs = 20
): CharacterBehaviorSchedule {
  return reduceCharacterActionSchedule(schedule, {
    type: 'feedback',
    feedback: { playbackToken, actionId: action.id, status: 'started', occurredAtMs },
    nowMs: occurredAtMs
  }, [action]).schedule;
}

describe('角色行为动作调度器', () => {
  test('空调度只建立一个未开始的主动作并发出播放效果', () => {
    const action = createAction('idle-action');

    const result = reduceCharacterActionSchedule(createSchedule(), {
      type: 'schedule',
      selection: createSelection(action.id),
      playbackToken: 'token-1',
      nowMs: 10,
      startConfirmationTimeoutMs: 100,
      durationMs: 120,
      urgency: 10,
      systemForced: false
    }, [action]);

    expect(result).toEqual({
      schedule: {
        revision: 1,
        current: {
          actionId: 'idle-action',
          stateId: 'idle-state',
          playbackToken: 'token-1',
          durationMs: 120,
          scheduledAtMs: 10,
          startDeadlineAtMs: 110,
          startedAtMs: null,
          expectedEndAtMs: null
        },
        history: []
      },
      effects: [{
        type: 'play',
        action: {
          actionId: 'idle-action',
          stateId: 'idle-state',
          playbackToken: 'token-1',
          durationMs: 120,
          scheduledAtMs: 10,
          startDeadlineAtMs: 110,
          startedAtMs: null,
          expectedEndAtMs: null
        }
      }]
    });
  });

  test('普通新动作中断可中断主动作后再播放且只记录已开始的旧动作', () => {
    const oldAction = createAction('old-action', { interruptedFallbackActionId: 'recover-action' });
    const newAction = createAction('new-action');
    let schedule = scheduleAction(createSchedule(), oldAction, 'old-token');
    schedule = startAction(schedule, oldAction, 'old-token', 20);

    const result = reduceCharacterActionSchedule(schedule, {
      type: 'schedule',
      selection: createSelection(newAction.id, 'active-state'),
      playbackToken: 'new-token',
      nowMs: 50,
      startConfirmationTimeoutMs: 100,
      durationMs: 200,
      urgency: 20,
      systemForced: false
    }, [oldAction, newAction]);

    expect(result.schedule).toEqual({
      revision: 3,
      current: {
        actionId: 'new-action', stateId: 'active-state', playbackToken: 'new-token',
        durationMs: 200, scheduledAtMs: 50, startDeadlineAtMs: 150,
        startedAtMs: null, expectedEndAtMs: null
      },
      history: [{ actionId: 'old-action', startedAtMs: 20, finishedAtMs: 50, outcome: 'interrupted' }]
    });
    expect(result.effects).toEqual([
      { type: 'interrupt', playbackToken: 'old-token', fallbackActionId: 'recover-action' },
      { type: 'play', action: result.schedule.current }
    ]);
  });

  test('抗中断主动作拒绝普通调度且保持原快照和版本', () => {
    const resistant = createAction('resistant-action', { interrupt: 'resistant' });
    const next = createAction('next-action');
    const schedule = scheduleAction(createSchedule(), resistant, 'resistant-token');

    const result = reduceCharacterActionSchedule(schedule, {
      type: 'schedule',
      selection: createSelection(next.id),
      playbackToken: 'next-token',
      nowMs: 30,
      startConfirmationTimeoutMs: 100,
      durationMs: 100,
      urgency: 99,
      systemForced: false
    }, [resistant, next]);

    expect(result.schedule).toBe(schedule);
    expect(result.effects).toEqual([{ type: 'none' }]);
  });

  test('系统强制调度可以中断抗中断主动作并保留无回退语义', () => {
    const resistant = createAction('resistant-action', { interrupt: 'resistant' });
    const forced = createAction('forced-action');
    const schedule = scheduleAction(createSchedule(), resistant, 'resistant-token');

    const result = reduceCharacterActionSchedule(schedule, {
      type: 'schedule',
      selection: createSelection(forced.id),
      playbackToken: 'forced-token',
      nowMs: 30,
      startConfirmationTimeoutMs: 100,
      durationMs: 80,
      urgency: 100,
      systemForced: true
    }, [resistant, forced]);

    expect(result.schedule.revision).toBe(2);
    expect(result.schedule.history).toEqual([]);
    expect(result.effects).toEqual([
      { type: 'interrupt', playbackToken: 'resistant-token', fallbackActionId: null },
      { type: 'play', action: result.schedule.current }
    ]);
  });

  test('持续到中断的动作强制忽略命令时长且不设置自然结束时间', () => {
    const action = createAction('loop-action', { loopPolicy: 'until-interrupted' });
    let schedule = scheduleAction(createSchedule(), action, 'loop-token', 500);

    schedule = startAction(schedule, action, 'loop-token', 20);

    expect(schedule.current).toMatchObject({
      durationMs: null,
      startedAtMs: 20,
      expectedEndAtMs: null
    });
  });

  test('开始反馈以发生时间设置开始与预计结束时间', () => {
    const action = createAction('timed-action', { loopPolicy: 'presentation' });
    const schedule = scheduleAction(createSchedule(), action, 'timed-token', 250);

    const result = reduceCharacterActionSchedule(schedule, {
      type: 'feedback',
      feedback: { playbackToken: 'timed-token', actionId: 'timed-action', status: 'started', occurredAtMs: 1_000 },
      nowMs: 9_999
    }, [action]);

    expect(result.schedule).toEqual({
      revision: 2,
      current: {
        actionId: 'timed-action', stateId: 'idle-state', playbackToken: 'timed-token',
        durationMs: 250, scheduledAtMs: 10, startDeadlineAtMs: null,
        startedAtMs: 1_000, expectedEndAtMs: 1_250
      },
      history: []
    });
    expect(result.effects).toEqual([{ type: 'none' }]);
  });

  test('完成反馈清除当前动作并写入完成历史', () => {
    const action = createAction('complete-action');
    const started = startAction(scheduleAction(createSchedule(), action, 'complete-token'), action, 'complete-token', 100);

    const result = reduceCharacterActionSchedule(started, {
      type: 'feedback',
      feedback: { playbackToken: 'complete-token', actionId: 'complete-action', status: 'completed', occurredAtMs: 180 },
      nowMs: 999
    }, [action]);

    expect(result.schedule).toEqual({
      revision: 3,
      current: null,
      history: [{ actionId: 'complete-action', startedAtMs: 100, finishedAtMs: 180, outcome: 'completed' }]
    });
    expect(result.effects).toEqual([{ type: 'none' }]);
  });

  test('失败反馈使用失败回退并把早于开始的结束时间夹到开始时间', () => {
    const action = createAction('failed-action', { failureFallbackActionId: 'failure-fallback' });
    const started = startAction(scheduleAction(createSchedule(), action, 'failed-token'), action, 'failed-token', 100);

    const result = reduceCharacterActionSchedule(started, {
      type: 'feedback',
      feedback: { playbackToken: 'failed-token', actionId: 'failed-action', status: 'failed', occurredAtMs: 90 },
      nowMs: 150
    }, [action]);

    expect(result.schedule).toEqual({
      revision: 3,
      current: null,
      history: [{ actionId: 'failed-action', startedAtMs: 100, finishedAtMs: 100, outcome: 'failed' }]
    });
    expect(result.effects).toEqual([{ type: 'none' }]);
    expect(result.fallbackActionId).toBe('failure-fallback');
  });

  test('未开始的中断反馈使用中断回退但不写历史', () => {
    const action = createAction('interrupted-action', { interruptedFallbackActionId: 'interrupt-fallback' });
    const schedule = scheduleAction(createSchedule(), action, 'interrupted-token');

    const result = reduceCharacterActionSchedule(schedule, {
      type: 'feedback',
      feedback: { playbackToken: 'interrupted-token', actionId: 'interrupted-action', status: 'interrupted', occurredAtMs: 15 },
      nowMs: 20
    }, [action]);

    expect(result.schedule).toEqual({ revision: 2, current: null, history: [] });
    expect(result.effects).toEqual([{ type: 'none' }]);
    expect(result.fallbackActionId).toBe('interrupt-fallback');
  });

  test('未配置回退的失败反馈返回无效果', () => {
    const action = createAction('failed-action');
    const schedule = scheduleAction(createSchedule(), action, 'failed-token');

    const result = reduceCharacterActionSchedule(schedule, {
      type: 'feedback',
      feedback: { playbackToken: 'failed-token', actionId: 'failed-action', status: 'failed', occurredAtMs: 15 },
      nowMs: 20
    }, [action]);

    expect(result.schedule).toEqual({ revision: 2, current: null, history: [] });
    expect(result.effects).toEqual([{ type: 'none' }]);
  });

  test.each([
    ['当前动作尚未开始却报告完成', 'completed', 'active-token', 'active-action'],
    ['同一开始反馈重复确认', 'started', 'active-token', 'active-action'],
    ['反馈动作标识不匹配', 'failed', 'active-token', 'forged-action'],
    ['反馈令牌不是当前令牌', 'failed', 'old-token', 'active-action']
  ] as const)('%s 时拒绝反馈且调度状态零变化', (_name, status, playbackToken, actionId) => {
    const action = createAction('active-action');
    const scheduled = scheduleAction(createSchedule(), action, 'active-token');
    const schedule = status === 'started'
      ? startAction(scheduled, action, 'active-token', 20)
      : scheduled;

    expect(() => reduceCharacterActionSchedule(schedule, {
      type: 'feedback',
      feedback: { playbackToken, actionId, status, occurredAtMs: 30 },
      nowMs: 30
    }, [action])).toThrowError('CHARACTER_PLAYBACK_UNAUTHORIZED');
    expect(schedule.current?.playbackToken).toBe('active-token');
  });

  test('终态反馈清除动作后拒绝重放相同反馈', () => {
    const action = createAction('terminal-action');
    const schedule = startAction(scheduleAction(createSchedule(), action, 'terminal-token'), action, 'terminal-token', 20);
    const command = {
      type: 'feedback' as const,
      feedback: { playbackToken: 'terminal-token', actionId: 'terminal-action', status: 'completed' as const, occurredAtMs: 30 },
      nowMs: 30
    };
    const completed = reduceCharacterActionSchedule(schedule, command, [action]);

    expect(() => reduceCharacterActionSchedule(completed.schedule, command, [action]))
      .toThrowError('CHARACTER_PLAYBACK_UNAUTHORIZED');
    expect(completed.schedule.revision).toBe(3);
  });

  test('未到自然结束时间的过期检查保持原快照和版本', () => {
    const action = createAction('timed-action');
    const schedule = startAction(scheduleAction(createSchedule(), action, 'timed-token', 100), action, 'timed-token', 20);

    const result = reduceCharacterActionSchedule(schedule, { type: 'expire', nowMs: 119 }, [action]);

    expect(result.schedule).toBe(schedule);
    expect(result.effects).toEqual([{ type: 'none' }]);
  });

  test('未开始动作在启动确认截止前保持，截止点清除且拒绝迟到开始反馈', () => {
    const action = createAction('scheduled-action');
    const schedule = scheduleAction(createSchedule(), action, 'scheduled-token');

    const before = reduceCharacterActionSchedule(
      schedule,
      { type: 'expire', nowMs: 109 },
      [action]
    );
    const expired = reduceCharacterActionSchedule(
      schedule,
      { type: 'expire', nowMs: 110 },
      [action]
    );

    expect(before.schedule).toBe(schedule);
    expect(expired.schedule).toEqual({ revision: 2, current: null, history: [] });
    expect(() => reduceCharacterActionSchedule(expired.schedule, {
      type: 'feedback',
      feedback: {
        playbackToken: 'scheduled-token',
        actionId: action.id,
        status: 'started',
        occurredAtMs: 111
      },
      nowMs: 111
    }, [action])).toThrow('CHARACTER_PLAYBACK_UNAUTHORIZED');
  });

  test('到达自然结束时间的显式过期按完成归档并使旧反馈失效', () => {
    const action = createAction('timed-action');
    const schedule = startAction(scheduleAction(createSchedule(), action, 'timed-token', 100), action, 'timed-token', 20);

    const expired = reduceCharacterActionSchedule(schedule, { type: 'expire', nowMs: 120 }, [action]);

    expect(expired).toEqual({
      schedule: {
        revision: 3,
        current: null,
        history: [{ actionId: 'timed-action', startedAtMs: 20, finishedAtMs: 120, outcome: 'completed' }]
      },
      effects: [{ type: 'none' }]
    });
    expect(() => reduceCharacterActionSchedule(expired.schedule, {
      type: 'feedback',
      feedback: { playbackToken: 'timed-token', actionId: 'timed-action', status: 'completed', occurredAtMs: 120 },
      nowMs: 120
    }, [action])).toThrowError('CHARACTER_PLAYBACK_UNAUTHORIZED');
  });

  test('没有自然结束时间的动作不会被显式过期', () => {
    const action = createAction('loop-action', { loopPolicy: 'until-interrupted' });
    const schedule = startAction(scheduleAction(createSchedule(), action, 'loop-token', null), action, 'loop-token', 20);

    const result = reduceCharacterActionSchedule(schedule, { type: 'expire', nowMs: 1_000_000 }, [action]);

    expect(result.schedule).toBe(schedule);
    expect(result.effects).toEqual([{ type: 'none' }]);
  });

  test('动作历史只保留最新六十四条', () => {
    const action = createAction('latest-action');
    const history: CharacterActionHistoryEntry[] = Array.from({ length: 64 }, (_, index) => ({
      actionId: `old-${index}`,
      startedAtMs: index,
      finishedAtMs: index + 1,
      outcome: 'completed'
    }));
    const scheduled = scheduleAction(createSchedule({ history }), action, 'latest-token', 10);
    const started = startAction(scheduled, action, 'latest-token', 100);

    const result = reduceCharacterActionSchedule(started, { type: 'expire', nowMs: 110 }, [action]);

    expect(result.schedule.history).toHaveLength(64);
    expect(result.schedule.history[0]?.actionId).toBe('old-1');
    expect(result.schedule.history.at(-1)).toEqual({
      actionId: 'latest-action', startedAtMs: 100, finishedAtMs: 110, outcome: 'completed'
    });
  });
});
