import type { CharacterBehaviorDirector } from './character-behavior-director';
import { CharacterProactivityScheduler } from './character-proactivity-scheduler';
import type { CharacterAutonomousInput } from '../conversation/conversation-chat-adapter';

export type CharacterAutonomousRequest = Omit<CharacterAutonomousInput, 'behaviorContext'>;
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

/** 运动时钟保持独立；应用本次运行的自主额度只在真正调用 Provider 前消费。 */
export function createCharacterProactivityRuntime(options: CharacterProactivityRuntimeOptions) {
  const scheduler = (options.factories?.createScheduler ?? ((input) => (
    new CharacterProactivityScheduler(input)
  )))({ director: options.director });
  let closePromise: Promise<void> | null = null;
  const now = options.now ?? performance.now.bind(performance);
  const starts: number[] = [];
  let lastInteraction = now();
  let lastStart = -Infinity;
  let nextEvaluation = -Infinity;
  let nextPreflight = -Infinity;
  let enabled = options.autonomousMoodEnabled ?? true;
  let started = false; let closed = false; let suspended = false;
  let generation = options.requestAutonomousDecision ? options.director.getBehaviorLifecycleGeneration() : 0;
  type Flight = { controller: AbortController; counted: boolean; timer: ReturnType<typeof setTimeout> | null };
  let flight: Flight | null = null;
  const abort = () => {
    const current = flight; flight = null;
    if (!current) return;
    if (current.timer !== null) clearTimeout(current.timer);
    current.controller.abort();
  };
  const blocked = () => {
    const b = options.director.getActivityBlockers();
    return b.closed || b.chatting || b.capabilityTask || b.awaitingConfirmation || b.dragging || b.movementModeTransition;
  };
  const unsubscribe = options.requestAutonomousDecision ? options.director.subscribeActivityBlockers(() => {
    const next = options.director.getBehaviorLifecycleGeneration();
    if (next !== generation || blocked()) abort();
    generation = next;
  }) : () => undefined;
  const eligible = () => {
    const time = now();
    while (starts.length && starts[0]! <= time - 60 * MINUTE) starts.shift();
    return started && !closed && !suspended && enabled && !blocked()
      && time - lastInteraction >= 5 * MINUTE && time - lastStart >= 5 * MINUTE
      && time >= nextEvaluation && starts.length < 4;
  };
  const pollAutonomy = () => {
    if (!options.requestAutonomousDecision || flight || now() < nextPreflight || !eligible()) return;
    const current: Flight = { controller: new AbortController(), counted: false, timer: null };
    flight = current;
    // 预检不可无限占用在途槽；真正发起后重新给予完整六十秒。
    const armTimeout = () => {
      if (current.timer !== null) clearTimeout(current.timer);
      current.timer = setTimeout(() => { if (flight === current) abort(); }, MINUTE);
    };
    armTimeout(); nextPreflight = now() + MINUTE;
    void Promise.resolve().then(() => options.requestAutonomousDecision!({
      idleForMs: Math.max(0, now() - lastInteraction), signal: current.controller.signal,
      beforeProviderCall: () => {
        if (flight !== current || current.counted || current.controller.signal.aborted || !eligible()) return false;
        current.counted = true; lastStart = now(); starts.push(lastStart); nextEvaluation = lastStart + 15 * MINUTE;
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
    },
    invalidate(): void {
      abort();
      options.director.invalidateBehaviorLifecycle();
    },
    noteUserInteraction(): void { lastInteraction = now(); abort(); },
    setAutonomousMoodEnabled(value: boolean): void { enabled = value; if (!enabled) abort(); },
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
