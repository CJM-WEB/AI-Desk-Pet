import type { CharacterBehaviorDirector } from './character-behavior-director';
import { CharacterProactivityScheduler } from './character-proactivity-scheduler';
import type { CharacterAutonomousInput } from '../conversation/conversation-chat-adapter';

type AutonomousPurpose = 'bindings' | 'mood';
export type CharacterAutonomousRequest = Omit<CharacterAutonomousInput, 'behaviorContext'> & { purpose?: AutonomousPurpose };
const MINUTE = 60_000;

/** 同一逻辑时钟供心情、请求与播放反馈使用；墙钟仅在真实休眠边沿参与一次有界推进。 */
export function createCharacterRuntimeClock(options: {
  monotonicNow?: () => number; wallNow?: () => number;
} = {}) {
  const monotonic = options.monotonicNow ?? performance.now.bind(performance);
  const wall = options.wallNow ?? Date.now;
  let previous = monotonic();
  let logical = previous;
  let sleeping: { mono: number; wall: number } | null = null;
  const elapsed = (delta: number) => Number.isFinite(delta) ? Math.max(0, Math.min(delta, 24 * 60 * MINUTE)) : 0;
  const now = () => {
    if (!sleeping) {
      const current = monotonic();
      logical += elapsed(current - previous); previous = current;
    }
    return logical;
  };
  return { now,
    suspend(): void {
      if (sleeping) return;
      now(); sleeping = { mono: previous, wall: wall() };
    },
    resume(): void {
      if (!sleeping) return;
      const current = monotonic();
      logical += Math.max(elapsed(current - sleeping.mono), elapsed(wall() - sleeping.wall));
      previous = current; sleeping = null;
    }
  };
}

type RuntimeFactories = Readonly<{
  createScheduler(options: Readonly<{
    director: CharacterBehaviorDirector;
  }>): Pick<CharacterProactivityScheduler, 'start' | 'close'>;
}>;

type CharacterProactivityRuntimeOptions = Readonly<{
  director: CharacterBehaviorDirector;
  advanceBehavior(): void;
  now?: () => number;
  autonomousMoodEnabled?: boolean;
  requestAutonomousDecision?(input: CharacterAutonomousRequest): Promise<void>;
  factories?: Partial<RuntimeFactories>;
}>;

/** 运动时钟保持独立；用途准备与心情分别限额，只有真正调用 Provider 才消费。 */
export function createCharacterProactivityRuntime(options: CharacterProactivityRuntimeOptions) {
  const scheduler = (options.factories?.createScheduler ?? ((input) => (
    new CharacterProactivityScheduler(input)
  )))({ director: options.director });
  let closePromise: Promise<void> | null = null;
  const now = options.now ?? performance.now.bind(performance);
  const starts: Record<AutonomousPurpose, number[]> = { bindings: [], mood: [] };
  let lastInteraction = now();
  let nextEvaluation = -Infinity;
  const nextPreflight: Record<AutonomousPurpose, number> = { bindings: -Infinity, mood: -Infinity };
  let enabled = options.autonomousMoodEnabled ?? true;
  let started = false; let closed = false; let suspended = false;
  let generation = options.requestAutonomousDecision ? options.director.getBehaviorLifecycleGeneration() : 0;
  type Flight = { purpose: AutonomousPurpose; controller: AbortController; counted: boolean; timer: ReturnType<typeof setTimeout> | null };
  let flight: Flight | null = null;
  const abort = () => {
    const current = flight; flight = null;
    if (!current) return;
    if (current.timer !== null) clearTimeout(current.timer);
    current.controller.abort();
  };
  const blocked = () => {
    const b = options.director.getActivityBlockers();
    return b.closed || b.chatting || b.capabilityTask || b.awaitingConfirmation || b.dragging || b.movementModeTransition || b.singleEpisode;
  };
  const unsubscribe = options.requestAutonomousDecision ? options.director.subscribeActivityBlockers(() => {
    const next = options.director.getBehaviorLifecycleGeneration();
    if (next !== generation || blocked()) abort();
    generation = next;
  }) : () => undefined;
  const hasBudget = (purpose: AutonomousPurpose) => {
    const recent = starts[purpose];
    while (recent.length && recent[0]! <= now() - 60 * MINUTE) recent.shift();
    return recent.length < 4;
  };
  const available = () => started && !closed && !suspended && !blocked();
  const idleEligible = () => available() && enabled && now() - lastInteraction >= 5 * MINUTE;
  const eligible = () => idleEligible() && now() >= nextEvaluation && hasBudget('mood');
  const bindingsEligible = () => available() && hasBudget('bindings') && options.director.needsBehaviorBindings();
  const pollAutonomy = () => {
    // 五分钟是宿主情境事件，不等待模型可用、小时额度或旧推理结束才表现。
    if (idleEligible()) options.director.applyIdleBindings(Math.max(0, now() - lastInteraction));
    if (!options.requestAutonomousDecision || flight) return;
    const purpose: AutonomousPurpose = now() >= nextPreflight.bindings && bindingsEligible() ? 'bindings' : 'mood';
    if (now() < nextPreflight[purpose] || !(purpose === 'bindings' ? bindingsEligible() : eligible())) return;
    const current: Flight = { purpose, controller: new AbortController(), counted: false, timer: null };
    flight = current;
    // 预检不可无限占用在途槽；真正发起后重新给予完整六十秒。
    const armTimeout = () => {
      if (current.timer !== null) clearTimeout(current.timer);
      current.timer = setTimeout(() => { if (flight === current) abort(); }, MINUTE);
    };
    armTimeout(); nextPreflight[purpose] = now() + MINUTE;
    void Promise.resolve().then(() => options.requestAutonomousDecision!({
      purpose, idleForMs: Math.max(0, now() - lastInteraction), signal: current.controller.signal,
      beforeProviderCall: () => {
        if (flight !== current || current.counted || current.controller.signal.aborted || !(purpose === 'bindings' ? bindingsEligible() : eligible())) return false;
        // 失败、超时和配置切换不返还额度；准备不能推迟首次五分钟心情重评。
        current.counted = true; starts[purpose].push(now()); nextPreflight[purpose] = now() + MINUTE;
        if (purpose === 'mood') nextEvaluation = now() + 15 * MINUTE;
        armTimeout(); return true;
      }
    })).catch(() => {
      // 无模型、格式错误或取消均退回本地演进，原始上下文不进入公开事件或日志。
    }).finally(() => {
      if (current.timer !== null) clearTimeout(current.timer);
      if (flight === current) flight = null;
    });
  };

  return {
    start(): void {
      if (closed || started) return;
      started = true;
      scheduler.start();
      pollAutonomy();
    },
    invalidate(): void {
      abort();
      options.director.invalidateBehaviorLifecycle();
    },
    noteUserInteraction(): void { lastInteraction = now(); abort(); },
    setAutonomousMoodEnabled(value: boolean): void { enabled = value; if (!enabled && flight?.purpose === 'mood') abort(); },
    suspend(): void { suspended = true; abort(); },
    resume(): void { suspended = false; if (!closed) { options.advanceBehavior(); pollAutonomy(); } },
    poll(): void {
      if (closed) return;
      options.advanceBehavior();
      pollAutonomy();
    },
    close(): Promise<void> {
      closed = true; abort(); unsubscribe();
      closePromise ??= (async () => {
        await scheduler.close();
      })();
      return closePromise;
    }
  };
}
