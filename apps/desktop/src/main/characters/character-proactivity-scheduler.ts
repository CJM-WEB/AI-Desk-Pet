import type { CharacterBehaviorPlan, MoveDirection } from '@myself/character-runtime';
import type { BehaviorReflectionAdapter } from './behavior-reflection-adapter';
import type {
  CharacterActivityBlockers,
  CharacterBehaviorDirector,
  ConversationBehaviorContext
} from './character-behavior-director';

type SchedulerDirectorPort = Pick<
  CharacterBehaviorDirector,
  | 'getChatContext'
  | 'getActivityBlockers'
  | 'getBehaviorLifecycleGeneration'
  | 'subscribeActivityBlockers'
  | 'requestBehaviorPlan'
>;

type CharacterProactivitySchedulerOptions = Readonly<{
  director: SchedulerDirectorPort;
  reflection: BehaviorReflectionAdapter;
  random?: () => number;
  now?: () => number;
}>;

type TimerSlot = {
  timer: ReturnType<typeof setTimeout> | null;
  deadline: number | null;
  remaining: number | null;
};

const LOCAL_MIN_MS = 20_000;
const LOCAL_MAX_MS = 60_000;
const REFLECTION_MIN_MS = 2 * 60_000;
const REFLECTION_MAX_MS = 5 * 60_000;
const REFLECTION_BACKOFF_MS = [2, 4, 8, 16, 30].map(minutes => minutes * 60_000);
const MOVE_DIRECTIONS: readonly MoveDirection[] = ['left', 'right', 'up', 'down'];

/** 唯一主动时钟只向 Director 提交到期候选，不保存角色或运动状态。 */
export class CharacterProactivityScheduler {
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly local: TimerSlot = { timer: null, deadline: null, remaining: null };
  private readonly reflectionTimer: TimerSlot = { timer: null, deadline: null, remaining: null };
  private readonly unsubscribe: () => void;
  private mode: ConversationBehaviorContext['proactivityMode'];
  private lifecycleGeneration: number;
  private reflectionFailures = 0;
  private reflectionAbort: AbortController | null = null;
  private started = false;
  private closed = false;

  constructor(private readonly options: CharacterProactivitySchedulerOptions) {
    this.random = options.random ?? Math.random;
    this.now = options.now ?? performance.now.bind(performance);
    this.mode = options.director.getChatContext().proactivityMode;
    this.lifecycleGeneration = options.director.getBehaviorLifecycleGeneration();
    this.unsubscribe = options.director.subscribeActivityBlockers(() => this.reconcile());
  }

  /** Behavior Service 初始化成功后才允许唯一主动时钟开始计时。 */
  start(): void {
    if (this.closed || this.started) return;
    this.started = true;
    this.mode = this.options.director.getChatContext().proactivityMode;
    this.lifecycleGeneration = this.options.director.getBehaviorLifecycleGeneration();
    this.reconcile();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    this.clear(this.local, false);
    this.clear(this.reflectionTimer, false);
    this.reflectionAbort?.abort();
    this.reflectionAbort = null;
    await this.options.reflection.close();
  }

  private reconcile(): void {
    if (this.closed || !this.started) return;
    const nextMode = this.options.director.getChatContext().proactivityMode;
    const nextGeneration = this.options.director.getBehaviorLifecycleGeneration();
    if (nextMode !== this.mode || nextGeneration !== this.lifecycleGeneration) {
      this.reflectionAbort?.abort();
      this.mode = nextMode;
      this.lifecycleGeneration = nextGeneration;
      this.clear(this.local, false);
      this.clear(this.reflectionTimer, false);
      this.local.remaining = null;
      this.reflectionTimer.remaining = null;
      this.reflectionFailures = 0;
    }

    const blocked = hasBlocker(this.options.director.getActivityBlockers());
    if (this.mode === 'passive') {
      this.clear(this.local, false);
      this.clear(this.reflectionTimer, false);
      this.local.remaining = null;
      this.reflectionTimer.remaining = null;
      return;
    }
    if (blocked) {
      this.clear(this.local, true);
      this.clear(this.reflectionTimer, true);
      this.reflectionAbort?.abort();
      return;
    }

    this.armLocal(this.local.remaining ?? this.randomDelay(LOCAL_MIN_MS, LOCAL_MAX_MS));
    if (this.mode === 'autonomous' && hasReflectableCatalog(this.options.director.getChatContext())) {
      this.armReflection(
        this.reflectionTimer.remaining
        ?? this.randomDelay(REFLECTION_MIN_MS, REFLECTION_MAX_MS)
      );
    } else {
      this.clear(this.reflectionTimer, false);
      this.reflectionTimer.remaining = null;
    }
  }

  private armLocal(delay: number): void {
    if (this.local.timer !== null || this.closed) return;
    this.local.remaining = null;
    this.local.deadline = this.now() + delay;
    this.local.timer = setTimeout(() => {
      this.local.timer = null;
      this.local.deadline = null;
      if (!this.closed && !hasBlocker(this.options.director.getActivityBlockers())) {
        this.submitCandidate(this.createLocalCandidate(), 'local-idle');
      }
      if (!this.closed && this.mode !== 'passive') {
        this.armLocal(this.randomDelay(LOCAL_MIN_MS, LOCAL_MAX_MS));
      }
    }, delay);
  }

  private armReflection(delay: number): void {
    if (this.reflectionTimer.timer !== null || this.closed || this.mode !== 'autonomous') return;
    this.reflectionTimer.remaining = null;
    this.reflectionTimer.deadline = this.now() + delay;
    this.reflectionTimer.timer = setTimeout(() => {
      this.reflectionTimer.timer = null;
      this.reflectionTimer.deadline = null;
      void this.runReflection();
    }, delay);
  }

  private async runReflection(): Promise<void> {
    if (this.closed || this.mode !== 'autonomous') return;
    const context = this.options.director.getChatContext();
    if (!hasReflectableCatalog(context)) return;
    if (hasBlocker(this.options.director.getActivityBlockers())) {
      this.reflectionTimer.remaining = this.randomDelay(REFLECTION_MIN_MS, REFLECTION_MAX_MS);
      return;
    }
    const abort = new AbortController();
    const reflectionGeneration = this.lifecycleGeneration;
    this.reflectionAbort = abort;
    try {
      const plan = await this.options.reflection.reflect({
        context,
        signal: abort.signal
      });
      if (
        this.closed
        || abort.signal.aborted
        || this.options.director.getChatContext().proactivityMode !== 'autonomous'
        || !hasReflectableCatalog(this.options.director.getChatContext())
        || this.options.director.getBehaviorLifecycleGeneration() !== reflectionGeneration
      ) return;
      this.reflectionFailures = 0;
      if (plan) this.submitCandidate(plan, 'reflection');
      this.armReflection(this.randomDelay(REFLECTION_MIN_MS, REFLECTION_MAX_MS));
    } catch {
      if (this.closed || abort.signal.aborted) return;
      const backoff = REFLECTION_BACKOFF_MS[
        Math.min(this.reflectionFailures, REFLECTION_BACKOFF_MS.length - 1)
      ]!;
      this.reflectionFailures += 1;
      this.armReflection(backoff);
    } finally {
      if (this.reflectionAbort === abort) this.reflectionAbort = null;
    }
  }

  private createLocalCandidate(): CharacterBehaviorPlan {
    if (this.mode === 'autonomous' && this.random() >= 0.5) {
      const direction = MOVE_DIRECTIONS[
        Math.min(MOVE_DIRECTIONS.length - 1, Math.floor(this.random() * MOVE_DIRECTIONS.length))
      ]!;
      return { kind: 'move', direction, distance: 'near' };
    }
    // assistive 永远只请求 idle 语义，避免公开 action name 隐含 move 时产生位移。
    return { kind: 'play', target: { kind: 'semantic', semantic: 'idle' } };
  }

  private submitCandidate(
    plan: CharacterBehaviorPlan,
    source: 'local-idle' | 'reflection'
  ): void {
    this.options.director.requestBehaviorPlan(plan, source);
  }

  private clear(slot: TimerSlot, preserveRemaining: boolean): void {
    if (slot.timer === null) return;
    clearTimeout(slot.timer);
    slot.timer = null;
    slot.remaining = preserveRemaining && slot.deadline !== null
      ? Math.max(1, slot.deadline - this.now())
      : null;
    slot.deadline = null;
  }

  private randomDelay(minimum: number, maximum: number): number {
    const unit = Math.min(1, Math.max(0, this.random()));
    return Math.round(minimum + (maximum - minimum) * unit);
  }
}

function hasBlocker(blockers: CharacterActivityBlockers): boolean {
  return Object.values(blockers).some(Boolean);
}

function hasReflectableCatalog(context: ConversationBehaviorContext): boolean {
  return context.character.semantics.length > 0
    || context.character.stateNames.length > 0
    || context.character.actionNames.length > 0;
}
