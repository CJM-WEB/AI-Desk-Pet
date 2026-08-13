import type {
  CharacterAgentBehaviorIntent,
  CharacterBehaviorSignal,
  CharacterBehaviorStateSnapshot,
  CharacterPlaybackFeedback,
  CharacterStandardSemantic
} from './behavior-contracts';
import {
  authorizeCharacterBehaviorAction,
  selectCharacterBehaviorAction,
  type CharacterActionRecency,
  type CharacterBehaviorActionSelection
} from './behavior-action-selector';
import {
  reduceCharacterActionSchedule,
  type CharacterBehaviorSchedule,
  type CharacterScheduleEffect
} from './behavior-scheduler';
import {
  createInitialBehaviorState,
  inferCharacterBehaviorState
} from './behavior-state-inference';
import type { CharacterManifestV2 } from './character-v2-schema';

export type CharacterBehaviorEngineSnapshot = {
  characterId: string;
  skinId: string;
  state: CharacterBehaviorStateSnapshot;
  schedule: CharacterBehaviorSchedule;
};

export type CharacterBehaviorDiagnosticCode =
  | 'CHARACTER_BEHAVIOR_ACTION_UNAVAILABLE'
  | 'CHARACTER_BEHAVIOR_CHARACTER_REPLACED';

export type CharacterBehaviorDecision = {
  snapshot: CharacterBehaviorEngineSnapshot;
  effects: CharacterBehaviorDecisionEffect[];
  diagnosticCodes: CharacterBehaviorDiagnosticCode[];
};

/** Main 决策中的中断效果额外携带旧动作身份，避免令牌碰撞误结算新动作。 */
export type CharacterBehaviorDecisionEffect = CharacterScheduleEffect & {
  actionId?: string;
};

type CharacterBehaviorEngineOptions = {
  manifest: CharacterManifestV2;
  skinId: string;
  now: () => number;
  random: () => number;
  createPlaybackToken: () => string;
  startConfirmationTimeoutMs?: number;
};

const NONE_EFFECT: CharacterScheduleEffect = { type: 'none' };
const DEFAULT_START_CONFIRMATION_TIMEOUT_MS = 30_000;
const EMPTY_SCHEDULE = (): CharacterBehaviorSchedule => ({ revision: 0, current: null, history: [] });

/** 只将动作选择器的稳定“无表现”错误转换为公开诊断。 */
function isActionUnavailable(error: unknown): boolean {
  return error instanceof Error && error.message === 'CHARACTER_BEHAVIOR_PRESENTATION_UNAVAILABLE';
}

/** 只有用户交互、任务结果与 Main 搬运事实可以强制替换抗中断动作。 */
function isSystemForced(signal: CharacterBehaviorSignal): boolean {
  return signal.type === 'user-interaction'
    || signal.type === 'carrying'
    || (signal.type === 'task' && signal.phase !== 'start');
}

/** 活动搬运事实只吸收低优先级上下文，不为其创建新的身体播放令牌。 */
function isCarryProtectedUpdate(
  state: CharacterBehaviorStateSnapshot,
  signal: CharacterBehaviorSignal
): boolean {
  if (!state.activeSignals.includes('carry-start')) return false;
  return signal.type === 'idle-due'
    || signal.type === 'movement'
    || (signal.type === 'task' && signal.phase === 'start');
}

/** 优先使用动作定义时长，否则累加解析后表现的一轮帧时长。 */
function selectionDuration(
  manifest: CharacterManifestV2,
  selection: CharacterBehaviorActionSelection
): number | null {
  const action = manifest.actions.find((candidate) => candidate.id === selection.actionId);
  if (action?.loopPolicy === 'until-interrupted') return null;
  if (action?.durationMs !== undefined) return action.durationMs;

  return selection.presentation.frames.reduce(
    (durationMs, frame) => durationMs + (frame.durationMs ?? 1_000 / selection.presentation.fps),
    0
  );
}

/** 复制公开效果，防止 play 效果与内部当前调度共享可变引用。 */
function cloneEffects(
  effects: readonly CharacterBehaviorDecisionEffect[]
): CharacterBehaviorDecisionEffect[] {
  return effects.map((effect) => effect.type === 'play'
    ? { type: 'play', action: { ...effect.action } }
    : { ...effect });
}

export class CharacterBehaviorEngine {
  private manifest: CharacterManifestV2;
  private skinId: string;
  private state: CharacterBehaviorStateSnapshot;
  private schedule: CharacterBehaviorSchedule = EMPTY_SCHEDULE();
  private lastDirection: 'left' | 'right' = 'right';
  private currentSelection: CharacterBehaviorActionSelection | null = null;
  private actionRecencyById: Record<string, CharacterActionRecency> = {};
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly createPlaybackToken: () => string;
  private readonly startConfirmationTimeoutMs: number;

  constructor(options: CharacterBehaviorEngineOptions) {
    this.manifest = options.manifest;
    this.skinId = options.skinId;
    this.state = createInitialBehaviorState(options.manifest);
    this.now = options.now;
    this.random = options.random;
    this.createPlaybackToken = options.createPlaybackToken;
    this.startConfirmationTimeoutMs = options.startConfirmationTimeoutMs
      ?? DEFAULT_START_CONFIRMATION_TIMEOUT_MS;
  }

  /** 组合状态推断、动作选择和调度归约，类内不重述各阶段规则。 */
  dispatch(input: {
    signal: CharacterBehaviorSignal;
    agentIntent?: CharacterAgentBehaviorIntent;
    direction: 'left' | 'right';
    requiredActionSemantic?: CharacterStandardSemantic;
  }): CharacterBehaviorDecision {
    this.lastDirection = input.direction;
    const carryProtectedUpdate = isCarryProtectedUpdate(this.state, input.signal);
    const previousState = this.state;
    this.applySignal(input.signal, input.agentIntent);
    if (carryProtectedUpdate) return this.decision([NONE_EFFECT], []);

    const systemForced = isSystemForced(input.signal);
    const decision = this.selectAndSchedule({
      direction: input.direction,
      nowMs: this.now(),
      urgency: systemForced ? 100 : input.agentIntent?.urgency ?? 0,
      systemForced,
      ...(input.requiredActionSemantic === undefined
        ? {}
        : { requiredActionSemantic: input.requiredActionSemantic })
    });
    if (
      input.requiredActionSemantic
      && decision.diagnosticCodes.includes('CHARACTER_BEHAVIOR_ACTION_UNAVAILABLE')
    ) {
      // 必需语义失败不应把未获授权的活动事实留在引擎内，也不能撤销原播放令牌。
      this.state = previousState;
      return this.decision(decision.effects, decision.diagnosticCodes);
    }
    return decision;
  }

  /** 原子重放最新可信上下文，全部状态事实应用完成后才产生首个播放动作。 */
  dispatchContext(input: {
    signals: readonly CharacterBehaviorSignal[];
    direction: 'left' | 'right';
  }): CharacterBehaviorDecision {
    this.lastDirection = input.direction;
    for (const signal of input.signals) this.applySignal(signal);
    const systemForced = input.signals.some(isSystemForced);
    return this.selectAndSchedule({
      direction: input.direction,
      nowMs: this.now(),
      urgency: systemForced ? 100 : 0,
      systemForced
    });
  }

  /** 只同步方向事实，不产生新动作或调度令牌。 */
  updateDirection(direction: 'left' | 'right'): void {
    this.lastDirection = direction;
  }

  /** 授权 Renderer 反馈；配置回退必须再次通过选择器硬约束并生成新令牌。 */
  applyFeedback(feedback: CharacterPlaybackFeedback): CharacterBehaviorDecision {
    const nowMs = this.now();
    const previous = this.schedule.current;
    const result = reduceCharacterActionSchedule(this.schedule, {
      type: 'feedback',
      feedback,
      nowMs
    }, this.manifest.actions);
    this.schedule = result.schedule;
    if (feedback.status === 'started') {
      this.recordActionStarted(feedback.actionId, feedback.occurredAtMs);
    } else if (previous?.startedAtMs !== null && previous?.startedAtMs !== undefined) {
      this.recordActionFinished(
        feedback.actionId,
        Math.max(previous.startedAtMs, feedback.occurredAtMs)
      );
    }
    if (!this.schedule.current) this.currentSelection = null;
    if (result.fallbackActionId) {
      let selection: CharacterBehaviorActionSelection;
      try {
        selection = authorizeCharacterBehaviorAction({
          manifest: this.manifest,
          skinId: this.skinId,
          state: this.state,
          direction: this.lastDirection,
          nowMs,
          history: this.schedule.history,
          actionRecencyById: this.actionRecencyById,
          random: this.random
        }, result.fallbackActionId);
      } catch (error) {
        if (!isActionUnavailable(error)) throw error;
        return this.decision(
          [NONE_EFFECT],
          ['CHARACTER_BEHAVIOR_ACTION_UNAVAILABLE']
        );
      }

      const playbackToken = this.createPlaybackToken();
      const fallback = reduceCharacterActionSchedule(this.schedule, {
        type: 'schedule',
        selection,
        playbackToken,
        nowMs,
        startConfirmationTimeoutMs: this.startConfirmationTimeoutMs,
        durationMs: selectionDuration(this.manifest, selection),
        urgency: 100,
        systemForced: true
      }, this.manifest.actions);
      this.schedule = fallback.schedule;
      this.currentSelection = selection;
      return this.decision(fallback.effects, []);
    }
    return this.decision(result.effects, []);
  }

  /** 由 Main 现有轮询推进启动确认与自然播放截止时间，不创建额外定时器。 */
  advance(): CharacterBehaviorDecision {
    const previous = this.schedule.current;
    const result = reduceCharacterActionSchedule(this.schedule, {
      type: 'expire',
      nowMs: this.now()
    }, this.manifest.actions);
    this.schedule = result.schedule;
    if (previous?.startedAtMs !== null && previous && !this.schedule.current) {
      this.recordActionFinished(
        previous.actionId,
        previous.expectedEndAtMs ?? this.now()
      );
    }
    if (!this.schedule.current) this.currentSelection = null;
    return this.decision(result.effects, []);
  }

  /** 中断旧角色当前动作，重建快照后尝试播放新角色默认动作。 */
  replaceCharacter(
    manifest: CharacterManifestV2,
    skinId: string,
    contextSignals: readonly CharacterBehaviorSignal[] = [],
    direction: 'left' | 'right' = this.lastDirection
  ): CharacterBehaviorDecision {
    const effects: CharacterBehaviorDecisionEffect[] = [];
    const current = this.schedule.current;
    if (current && this.currentSelection) {
      const interrupted = reduceCharacterActionSchedule(this.schedule, {
        type: 'schedule',
        selection: this.currentSelection,
        playbackToken: current.playbackToken,
        nowMs: this.now(),
        startConfirmationTimeoutMs: this.startConfirmationTimeoutMs,
        durationMs: current.durationMs,
        urgency: 100,
        systemForced: true
      }, this.manifest.actions);
      const interruptEffect = interrupted.effects.find((effect) => effect.type === 'interrupt');
      if (interruptEffect) effects.push({ ...interruptEffect, actionId: current.actionId });
    }

    this.manifest = manifest;
    this.skinId = skinId;
    this.lastDirection = direction;
    this.state = createInitialBehaviorState(manifest);
    this.schedule = EMPTY_SCHEDULE();
    this.currentSelection = null;
    this.actionRecencyById = {};
    for (const signal of contextSignals) this.applySignal(signal);

    const next = this.selectAndSchedule({
      direction: this.lastDirection,
      nowMs: this.now(),
      urgency: contextSignals.some(isSystemForced) ? 100 : 0,
      systemForced: contextSignals.some(isSystemForced)
    }, ['CHARACTER_BEHAVIOR_CHARACTER_REPLACED']);
    return this.decision(
      [...effects, ...next.effects],
      next.diagnosticCodes
    );
  }

  /** 只推进状态推断，不在上下文重放中提前生成播放副作用。 */
  private applySignal(
    signal: CharacterBehaviorSignal,
    agentIntent?: CharacterAgentBehaviorIntent
  ): void {
    this.state = inferCharacterBehaviorState({
      manifest: this.manifest,
      previous: this.state,
      signal,
      ...(agentIntent === undefined ? {} : { agentIntent })
    });
  }

  /** 返回与内部对象断开引用的只含运行时状态的快照。 */
  snapshot(): CharacterBehaviorEngineSnapshot {
    return {
      characterId: this.manifest.id,
      skinId: this.skinId,
      state: {
        ...this.state,
        modifierStateIds: [...this.state.modifierStateIds],
        activeSignals: [...this.state.activeSignals]
      },
      schedule: {
        revision: this.schedule.revision,
        current: this.schedule.current ? { ...this.schedule.current } : null,
        history: this.schedule.history.map((entry) => ({ ...entry }))
      }
    };
  }

  /** 使用当前快照完成一次动作选择与调度，并只收敛稳定无动作错误。 */
  private selectAndSchedule(
    input: {
      direction: 'left' | 'right';
      nowMs: number;
      urgency: number;
      systemForced: boolean;
      requiredActionSemantic?: CharacterStandardSemantic;
    },
    diagnosticCodes: CharacterBehaviorDiagnosticCode[] = []
  ): CharacterBehaviorDecision {
    let selection: CharacterBehaviorActionSelection;
    try {
      selection = selectCharacterBehaviorAction({
        manifest: this.manifest,
        skinId: this.skinId,
        state: this.state,
        direction: input.direction,
        nowMs: input.nowMs,
        history: this.schedule.history,
        actionRecencyById: this.actionRecencyById,
        random: this.random
      });
    } catch (error) {
      if (!isActionUnavailable(error)) throw error;
      return this.decision(
        [NONE_EFFECT],
        [...diagnosticCodes, 'CHARACTER_BEHAVIOR_ACTION_UNAVAILABLE']
      );
    }

    if (
      input.requiredActionSemantic
      && this.manifest.actions.find((action) => action.id === selection.actionId)?.semantic
        !== input.requiredActionSemantic
    ) {
      return this.decision([NONE_EFFECT], [
        ...diagnosticCodes,
        'CHARACTER_BEHAVIOR_ACTION_UNAVAILABLE'
      ]);
    }

    const playbackToken = this.createPlaybackToken();
    const previous = this.schedule.current;
    const result = reduceCharacterActionSchedule(this.schedule, {
      type: 'schedule',
      selection,
      playbackToken,
      nowMs: input.nowMs,
      startConfirmationTimeoutMs: this.startConfirmationTimeoutMs,
      durationMs: selectionDuration(this.manifest, selection),
      urgency: input.urgency,
      systemForced: input.systemForced
    }, this.manifest.actions);
    this.schedule = result.schedule;
    if (
      previous?.startedAtMs !== null
      && previous?.startedAtMs !== undefined
      && this.schedule.current?.playbackToken !== previous.playbackToken
    ) {
      this.recordActionFinished(previous.actionId, input.nowMs);
    }
    if (this.schedule.current?.playbackToken === playbackToken) {
      this.currentSelection = selection;
    }
    const effects = result.effects.map((effect): CharacterBehaviorDecisionEffect => (
      effect.type === 'interrupt' && previous
        ? { ...effect, actionId: previous.actionId }
        : effect
    ));
    return this.decision(effects, diagnosticCodes);
  }

  /** 压缩最近时间只接受当前清单动作，容量由动作定义数量天然限制。 */
  private recordActionStarted(actionId: string, startedAtMs: number): void {
    if (!this.manifest.actions.some((action) => action.id === actionId)) return;
    const previous = this.actionRecencyById[actionId];
    this.actionRecencyById[actionId] = {
      latestStartedAtMs: Math.max(previous?.latestStartedAtMs ?? -Infinity, startedAtMs),
      latestFinishedAtMs: previous?.latestFinishedAtMs ?? null
    };
  }

  /** 合法终态或调度替换只更新已有开始记录，不从伪造事件扩张索引。 */
  private recordActionFinished(actionId: string, finishedAtMs: number): void {
    const previous = this.actionRecencyById[actionId];
    if (!previous) return;
    this.actionRecencyById[actionId] = {
      latestStartedAtMs: previous.latestStartedAtMs,
      latestFinishedAtMs: Math.max(previous.latestFinishedAtMs ?? -Infinity, finishedAtMs)
    };
  }

  /** 统一创建不可反向修改内部状态的公开决策。 */
  private decision(
    effects: readonly CharacterBehaviorDecisionEffect[],
    diagnosticCodes: readonly CharacterBehaviorDiagnosticCode[]
  ): CharacterBehaviorDecision {
    return {
      snapshot: this.snapshot(),
      effects: cloneEffects(effects),
      diagnosticCodes: [...diagnosticCodes]
    };
  }
}
