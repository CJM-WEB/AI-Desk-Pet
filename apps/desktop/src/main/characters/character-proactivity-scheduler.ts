import type { CharacterBehaviorPlan } from '@myself/character-runtime';
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
  | 'requestPersistentMovement'
>;

type CharacterProactivitySchedulerOptions = Readonly<{
  director: SchedulerDirectorPort;
  random?: () => number;
  now?: () => number;
}>;

type TimerSlot = {
  timer: ReturnType<typeof setTimeout> | null;
  deadline: number | null;
  remaining: number | null;
};

const LOCAL_MIN_MS = 10_000;
const LOCAL_MAX_MS = 30_000;

/** 唯一主动时钟只向 Director 提交到期候选，不保存角色或运动状态。 */
export class CharacterProactivityScheduler {
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly local: TimerSlot = { timer: null, deadline: null, remaining: null };
  private readonly unsubscribe: () => void;
  private mode: ConversationBehaviorContext['proactivityMode'];
  private lifecycleGeneration: number;
  private movementMode: ConversationBehaviorContext['runtime']['movementMode'];
  private requestingPersistentMovement = false;
  private started = false;
  private closed = false;

  constructor(private readonly options: CharacterProactivitySchedulerOptions) {
    this.random = options.random ?? Math.random;
    this.now = options.now ?? performance.now.bind(performance);
    this.mode = options.director.getChatContext().proactivityMode;
    this.lifecycleGeneration = options.director.getBehaviorLifecycleGeneration();
    this.movementMode = options.director.getActivityBlockers().movementMode;
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
  }

  private reconcile(): void {
    if (this.closed || !this.started) return;
    const nextMode = this.options.director.getChatContext().proactivityMode;
    const nextGeneration = this.options.director.getBehaviorLifecycleGeneration();
    if (nextMode !== this.mode || nextGeneration !== this.lifecycleGeneration) {
      this.mode = nextMode;
      this.lifecycleGeneration = nextGeneration;
      this.clear(this.local, false);
      this.local.remaining = null;
    }

    const blockers = this.options.director.getActivityBlockers();
    if (blockers.movementMode !== this.movementMode) {
      this.movementMode = blockers.movementMode;
      this.clear(this.local, false);
      this.local.remaining = null;
    }
    if (this.movementMode === 0) return;
    const blocked = hasBlocker(blockers);
    if (blocked) {
      this.clear(this.local, true);
      return;
    }
    if (this.movementMode === 1) {
      this.clear(this.local, false);
      this.local.remaining = null;
      // Director 会同步发布新的运动快照；重入期间仍由本次请求拥有续行决策。
      if (this.requestingPersistentMovement) return;
      this.requestingPersistentMovement = true;
      try {
        this.options.director.requestPersistentMovement();
      } finally {
        this.requestingPersistentMovement = false;
      }
      return;
    }
    if (this.mode === 'passive') {
      this.clear(this.local, false);
      this.local.remaining = null;
      return;
    }

    this.armLocal(this.local.remaining ?? this.randomDelay(LOCAL_MIN_MS, LOCAL_MAX_MS));
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

  private createLocalCandidate(): CharacterBehaviorPlan {
    // movementMode=2 是用户明确选择的间歇运动；主动性只决定是否启用时钟，不降级为 idle。
    return { kind: 'play', target: { kind: 'semantic', semantic: 'move' } };
  }

  private submitCandidate(
    plan: CharacterBehaviorPlan,
    source: 'local-idle'
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
  return Object.entries(blockers).some(([key, value]) => (
    key !== 'movementMode' && value
  ));
}
