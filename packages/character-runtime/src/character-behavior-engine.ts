import type {
  CharacterAgentBehaviorIntent,
  CharacterBehaviorSignal,
  CharacterBehaviorStateSnapshot,
  CharacterPlaybackFeedback
} from './behavior-contracts';
import {
  selectCharacterBehaviorAction,
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
  effects: CharacterScheduleEffect[];
  diagnosticCodes: CharacterBehaviorDiagnosticCode[];
};

type CharacterBehaviorEngineOptions = {
  manifest: CharacterManifestV2;
  skinId: string;
  now: () => number;
  random: () => number;
  createPlaybackToken: () => string;
};

const NONE_EFFECT: CharacterScheduleEffect = { type: 'none' };
const EMPTY_SCHEDULE = (): CharacterBehaviorSchedule => ({ revision: 0, current: null, history: [] });

/** 只将动作选择器的稳定“无表现”错误转换为公开诊断。 */
function isActionUnavailable(error: unknown): boolean {
  return error instanceof Error && error.message === 'CHARACTER_BEHAVIOR_PRESENTATION_UNAVAILABLE';
}

/** 系统事实只在约定的三类边沿信号上强制替换抗中断动作。 */
function isSystemForced(signal: CharacterBehaviorSignal): boolean {
  return signal.type === 'user-interaction'
    || (signal.type === 'task' && signal.phase !== 'start');
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
function cloneEffects(effects: readonly CharacterScheduleEffect[]): CharacterScheduleEffect[] {
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
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly createPlaybackToken: () => string;

  constructor(options: CharacterBehaviorEngineOptions) {
    this.manifest = options.manifest;
    this.skinId = options.skinId;
    this.state = createInitialBehaviorState(options.manifest);
    this.now = options.now;
    this.random = options.random;
    this.createPlaybackToken = options.createPlaybackToken;
  }

  /** 组合状态推断、动作选择和调度归约，类内不重述各阶段规则。 */
  dispatch(input: {
    signal: CharacterBehaviorSignal;
    agentIntent?: CharacterAgentBehaviorIntent;
    direction: 'left' | 'right';
  }): CharacterBehaviorDecision {
    this.lastDirection = input.direction;
    this.state = inferCharacterBehaviorState({
      manifest: this.manifest,
      previous: this.state,
      signal: input.signal,
      ...(input.agentIntent === undefined ? {} : { agentIntent: input.agentIntent })
    });

    const systemForced = isSystemForced(input.signal);
    return this.selectAndSchedule({
      direction: input.direction,
      nowMs: this.now(),
      urgency: systemForced ? 100 : input.agentIntent?.urgency ?? 0,
      systemForced
    });
  }

  /** 将 Renderer 反馈原样交给调度器授权并归约。 */
  applyFeedback(feedback: CharacterPlaybackFeedback): CharacterBehaviorDecision {
    const result = reduceCharacterActionSchedule(this.schedule, {
      type: 'feedback',
      feedback,
      nowMs: this.now()
    }, this.manifest.actions);
    this.schedule = result.schedule;
    if (!this.schedule.current) this.currentSelection = null;
    return this.decision(result.effects, []);
  }

  /** 中断旧角色当前动作，重建快照后尝试播放新角色默认动作。 */
  replaceCharacter(manifest: CharacterManifestV2, skinId: string): CharacterBehaviorDecision {
    const effects: CharacterScheduleEffect[] = [];
    const current = this.schedule.current;
    if (current && this.currentSelection) {
      const interrupted = reduceCharacterActionSchedule(this.schedule, {
        type: 'schedule',
        selection: this.currentSelection,
        playbackToken: current.playbackToken,
        nowMs: this.now(),
        durationMs: current.durationMs,
        urgency: 100,
        systemForced: true
      }, this.manifest.actions);
      const interruptEffect = interrupted.effects.find((effect) => effect.type === 'interrupt');
      if (interruptEffect) effects.push(interruptEffect);
    }

    this.manifest = manifest;
    this.skinId = skinId;
    this.state = createInitialBehaviorState(manifest);
    this.schedule = EMPTY_SCHEDULE();
    this.currentSelection = null;

    const next = this.selectAndSchedule({
      direction: this.lastDirection,
      nowMs: this.now(),
      urgency: 0,
      systemForced: false
    }, ['CHARACTER_BEHAVIOR_CHARACTER_REPLACED']);
    return this.decision(
      [...effects, ...next.effects],
      next.diagnosticCodes
    );
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
        random: this.random
      });
    } catch (error) {
      if (!isActionUnavailable(error)) throw error;
      return this.decision(
        [NONE_EFFECT],
        [...diagnosticCodes, 'CHARACTER_BEHAVIOR_ACTION_UNAVAILABLE']
      );
    }

    const playbackToken = this.createPlaybackToken();
    const result = reduceCharacterActionSchedule(this.schedule, {
      type: 'schedule',
      selection,
      playbackToken,
      nowMs: input.nowMs,
      durationMs: selectionDuration(this.manifest, selection),
      urgency: input.urgency,
      systemForced: input.systemForced
    }, this.manifest.actions);
    this.schedule = result.schedule;
    if (this.schedule.current?.playbackToken === playbackToken) {
      this.currentSelection = selection;
    }
    return this.decision(result.effects, diagnosticCodes);
  }

  /** 统一创建不可反向修改内部状态的公开决策。 */
  private decision(
    effects: readonly CharacterScheduleEffect[],
    diagnosticCodes: readonly CharacterBehaviorDiagnosticCode[]
  ): CharacterBehaviorDecision {
    return {
      snapshot: this.snapshot(),
      effects: cloneEffects(effects),
      diagnosticCodes: [...diagnosticCodes]
    };
  }
}
