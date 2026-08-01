import type { CharacterPlaybackFeedback } from './behavior-contracts';
import type {
  CharacterActionHistoryEntry,
  CharacterBehaviorActionSelection
} from './behavior-action-selector';
import type { CharacterActionDefinitionV2 } from './character-v2-schema';

export type CharacterScheduledAction = {
  actionId: string;
  stateId: string;
  playbackToken: string;
  durationMs: number | null;
  startedAtMs: number | null;
  expectedEndAtMs: number | null;
};

export type CharacterBehaviorSchedule = {
  revision: number;
  current: CharacterScheduledAction | null;
  history: CharacterActionHistoryEntry[];
};

export type CharacterScheduleCommand =
  | {
    type: 'schedule';
    selection: CharacterBehaviorActionSelection;
    playbackToken: string;
    nowMs: number;
    durationMs: number | null;
    urgency: number;
    systemForced: boolean;
  }
  | { type: 'feedback'; feedback: CharacterPlaybackFeedback; nowMs: number }
  | { type: 'expire'; nowMs: number };

export type CharacterScheduleEffect =
  | { type: 'play'; action: CharacterScheduledAction }
  | { type: 'interrupt'; playbackToken: string; fallbackActionId: string | null }
  | { type: 'fallback'; actionId: string }
  | { type: 'none' };

type CharacterScheduleResult = {
  schedule: CharacterBehaviorSchedule;
  effects: CharacterScheduleEffect[];
};

const MAX_HISTORY_ENTRIES = 64;
const NONE_EFFECT: CharacterScheduleEffect = { type: 'none' };

/** 将一条已结束动作追加到内存历史，并只保留最新六十四条。 */
function appendHistory(
  history: readonly CharacterActionHistoryEntry[],
  entry: CharacterActionHistoryEntry
): CharacterActionHistoryEntry[] {
  return [...history, entry].slice(-MAX_HISTORY_ENTRIES);
}

/** 查找当前逻辑动作定义，以读取中断策略和回退动作。 */
function actionById(
  actions: readonly CharacterActionDefinitionV2[],
  actionId: string
): CharacterActionDefinitionV2 | undefined {
  return actions.find((action) => action.id === actionId);
}

/** 只有真正开始过的动作才进入历史。 */
function finishStartedAction(
  schedule: CharacterBehaviorSchedule,
  finishedAtMs: number,
  outcome: NonNullable<CharacterActionHistoryEntry['outcome']>
): CharacterActionHistoryEntry[] {
  const current = schedule.current;
  if (!current || current.startedAtMs === null) return schedule.history;

  return appendHistory(schedule.history, {
    actionId: current.actionId,
    startedAtMs: current.startedAtMs,
    finishedAtMs: Math.max(current.startedAtMs, finishedAtMs),
    outcome
  });
}

/** 拒绝任何不属于当前播放实例或违反反馈顺序的反馈。 */
function authorizeFeedback(
  current: CharacterScheduledAction | null,
  feedback: CharacterPlaybackFeedback
): CharacterScheduledAction {
  const matchesCurrent = current
    && current.playbackToken === feedback.playbackToken
    && current.actionId === feedback.actionId;
  const invalidTransition = feedback.status === 'started'
    ? current?.startedAtMs !== null
    : feedback.status === 'completed' && current?.startedAtMs === null;

  if (!matchesCurrent || invalidTransition) {
    throw new Error('CHARACTER_PLAYBACK_UNAUTHORIZED');
  }

  return current;
}

/** 调度一个新的身体主动作，并按当前动作策略决定能否替换。 */
function reduceScheduleCommand(
  schedule: CharacterBehaviorSchedule,
  command: Extract<CharacterScheduleCommand, { type: 'schedule' }>,
  actions: readonly CharacterActionDefinitionV2[]
): CharacterScheduleResult {
  const currentDefinition = schedule.current
    ? actionById(actions, schedule.current.actionId)
    : undefined;
  if (schedule.current && currentDefinition?.interrupt === 'resistant' && !command.systemForced) {
    return { schedule, effects: [NONE_EFFECT] };
  }

  const selectedDefinition = actionById(actions, command.selection.actionId);
  const next: CharacterScheduledAction = {
    actionId: command.selection.actionId,
    stateId: command.selection.stateId,
    playbackToken: command.playbackToken,
    durationMs: selectedDefinition?.loopPolicy === 'until-interrupted' ? null : command.durationMs,
    startedAtMs: null,
    expectedEndAtMs: null
  };
  const effects: CharacterScheduleEffect[] = [];
  let history = schedule.history;

  if (schedule.current) {
    history = finishStartedAction(schedule, command.nowMs, 'interrupted');
    effects.push({
      type: 'interrupt',
      playbackToken: schedule.current.playbackToken,
      fallbackActionId: currentDefinition?.interruptedFallbackActionId ?? null
    });
  }
  effects.push({ type: 'play', action: next });

  return {
    schedule: { revision: schedule.revision + 1, current: next, history },
    effects
  };
}

/** 归约 Renderer 对当前播放实例的开始或终态反馈。 */
function reduceFeedbackCommand(
  schedule: CharacterBehaviorSchedule,
  feedback: CharacterPlaybackFeedback,
  actions: readonly CharacterActionDefinitionV2[]
): CharacterScheduleResult {
  const current = authorizeFeedback(schedule.current, feedback);
  if (feedback.status === 'started') {
    const started: CharacterScheduledAction = {
      ...current,
      startedAtMs: feedback.occurredAtMs,
      expectedEndAtMs: current.durationMs === null
        ? null
        : feedback.occurredAtMs + current.durationMs
    };
    return {
      schedule: { ...schedule, revision: schedule.revision + 1, current: started },
      effects: [NONE_EFFECT]
    };
  }

  const history = finishStartedAction(schedule, feedback.occurredAtMs, feedback.status);
  const definition = actionById(actions, current.actionId);
  const fallbackActionId = feedback.status === 'failed'
    ? definition?.failureFallbackActionId
    : feedback.status === 'interrupted'
      ? definition?.interruptedFallbackActionId
      : undefined;

  return {
    schedule: { revision: schedule.revision + 1, current: null, history },
    effects: fallbackActionId
      ? [{ type: 'fallback', actionId: fallbackActionId }]
      : [NONE_EFFECT]
  };
}

/** 仅在调用方显式检查且自然时限已到时结束当前动作。 */
function reduceExpireCommand(
  schedule: CharacterBehaviorSchedule,
  nowMs: number
): CharacterScheduleResult {
  const current = schedule.current;
  if (!current || current.expectedEndAtMs === null || nowMs < current.expectedEndAtMs) {
    return { schedule, effects: [NONE_EFFECT] };
  }

  return {
    schedule: {
      revision: schedule.revision + 1,
      current: null,
      history: finishStartedAction(schedule, nowMs, 'completed')
    },
    effects: [NONE_EFFECT]
  };
}

/** 纯归约单一身体主动作，不读取时钟或执行外部副作用。 */
export function reduceCharacterActionSchedule(
  schedule: CharacterBehaviorSchedule,
  command: CharacterScheduleCommand,
  actions: readonly CharacterActionDefinitionV2[]
): CharacterScheduleResult {
  if (command.type === 'schedule') {
    return reduceScheduleCommand(schedule, command, actions);
  }
  if (command.type === 'feedback') {
    return reduceFeedbackCommand(schedule, command.feedback, actions);
  }
  return reduceExpireCommand(schedule, command.nowMs);
}
