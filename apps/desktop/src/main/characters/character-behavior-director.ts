import type {
  CharacterBehaviorAuthorization,
  CharacterBehaviorPlan,
  CharacterAgentBehaviorIntent,
  CharacterPlaybackFeedback,
  MoveDirection,
  MoveDistance,
  PublicBehaviorCatalog,
  ScreenRegion
} from '@myself/character-runtime';
import type { TaskEvent } from '@myself/shared-types';
import {
  characterTaskRuntimeBlock,
  type CharacterBehaviorService
} from './character-behavior-service';
import type { CharacterMotionService } from './character-motion-service';
import { parseExplicitCharacterBehavior } from
  '../conversation/explicit-character-behavior-gate';

export type CharacterMotionIntent =
  | Readonly<{ kind: 'wander'; scope: 'short' | 'work_area' }>
  | Readonly<{ kind: 'relative'; direction: MoveDirection; distance: MoveDistance }>
  | Readonly<{ kind: 'region'; region: ScreenRegion }>
  | Readonly<{ kind: 'return-visible' }>;

export type ExplicitBehaviorDirective =
  | Readonly<{ kind: 'stop_movement' }>
  | Readonly<{ kind: 'resume_movement' }>
  | Readonly<{
      kind: 'move';
      motion: Exclude<CharacterMotionIntent, { kind: 'return-visible' }>;
    }>;

export type PreparedBehaviorPrompt = Readonly<{
  originalText: string;
  capabilityText: string;
  explicitDirective: ExplicitBehaviorDirective | null;
}>;

export type ConversationBehaviorContext = Readonly<{
  character: PublicBehaviorCatalog;
  runtime: Readonly<{
    moving: boolean;
    dragging: boolean;
    carrying: boolean;
    movementStopped: boolean;
  }>;
  proactivityMode: 'passive' | 'assistive' | 'autonomous';
  recentActions: readonly string[];
}>;

export interface ConversationBehaviorPort {
  prepareUserPrompt(text: string): Promise<PreparedBehaviorPrompt>;
  getChatContext(): ConversationBehaviorContext;
  completeUserPrompt(input: Readonly<{
    generation: string;
    explicitDirective: ExplicitBehaviorDirective | null;
    providerPlan: CharacterBehaviorPlan | null;
  }>): void;
  handleTaskEvent(event: TaskEvent): void;
  applyPlaybackFeedback(feedback: CharacterPlaybackFeedback): void;
  reset(generation: string): void;
  close(): Promise<void>;
}

export type CharacterBehaviorNotice = Readonly<{
  code: 'CHARACTER_ACTION_UNAVAILABLE';
  message: '当前角色没有可播放的对应动作。';
}>;

export type BehaviorPlanSource = 'explicit' | 'chat' | 'reflection' | 'local-idle';

type BehaviorServicePort = Pick<
  CharacterBehaviorService,
  | 'getPublicBehaviorCatalog'
  | 'getRecentPublicActions'
  | 'resolveBehaviorTarget'
  | 'isMovementBehaviorTarget'
  | 'isMovementAgentIntent'
  | 'requestDirectedBehavior'
  | 'handleAgentIntent'
  | 'handleTaskEvent'
  | 'applyPlaybackFeedback'
  | 'handleIdleDue'
  | 'handleActiveCharacterChanged'
  | 'close'
>;

type MotionServicePort = Pick<
  CharacterMotionService,
  'getSnapshot' | 'requestIntent' | 'stop'
>;

type CharacterBehaviorDirectorOptions = Readonly<{
  behavior: BehaviorServicePort;
  motion: MotionServicePort;
  initialGeneration: string;
  publishNotice?: (notice: CharacterBehaviorNotice) => void;
}>;

type ActiveBehaviorSource = BehaviorPlanSource | 'trusted-task';

const NONE: CharacterBehaviorAuthorization = { kind: 'none' };
const SOURCE_PRIORITY: Readonly<Record<ActiveBehaviorSource, number>> = {
  explicit: 5,
  'trusted-task': 4,
  chat: 3,
  reflection: 2,
  'local-idle': 1
};
const SOURCE_OPTIONS: Readonly<Record<BehaviorPlanSource, {
  urgency: number;
  systemForced: boolean;
}>> = {
  explicit: { urgency: 100, systemForced: true },
  chat: { urgency: 80, systemForced: true },
  reflection: { urgency: 40, systemForced: false },
  'local-idle': { urgency: 10, systemForced: false }
};
const ACTION_UNAVAILABLE_NOTICE: CharacterBehaviorNotice = {
  code: 'CHARACTER_ACTION_UNAVAILABLE',
  message: '当前角色没有可播放的对应动作。'
};

/**
 * Main Director 只编排来源优先级、会话代次与待提交令牌；
 * 角色状态、动作约束和播放调度始终由现有 Service/Engine 独占。
 */
export class CharacterBehaviorDirector {
  private generation: string;
  private movementStopped = false;
  private trustedRuntimeBlocked = false;
  private dragging = false;
  private closed = false;
  private pendingChatPlan: CharacterBehaviorPlan | null = null;
  private pendingSuccessToken: string | null = null;
  private active: Readonly<{ source: ActiveBehaviorSource; playbackToken: string }> | null = null;

  constructor(private readonly options: CharacterBehaviorDirectorOptions) {
    this.generation = options.initialGeneration;
  }

  /** Gate 在能力路由与 Provider 前执行，本地明确移动仍须先通过动作授权。 */
  async prepareUserPrompt(text: string): Promise<PreparedBehaviorPrompt> {
    const originalText = text.trim();
    const parsed = parseExplicitCharacterBehavior(originalText);
    const prepared: PreparedBehaviorPrompt = {
      originalText,
      capabilityText: parsed?.capabilityText ?? originalText,
      explicitDirective: parsed?.explicitDirective ?? null
    };
    const directive = prepared.explicitDirective;
    if (directive?.kind === 'stop_movement') {
      this.applyExplicitMovementLock(true);
    } else if (directive?.kind === 'resume_movement') {
      this.applyExplicitMovementLock(false);
    } else if (directive?.kind === 'move') {
      this.requestMotionBehavior(directive.motion, 'explicit');
    }
    return prepared;
  }

  getChatContext(): ConversationBehaviorContext {
    const motion = this.options.motion.getSnapshot();
    let character: PublicBehaviorCatalog;
    let catalogAvailable = true;
    try {
      character = this.options.behavior.getPublicBehaviorCatalog();
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'CHARACTER_ACTION_UNAVAILABLE') throw error;
      // 角色切换与 V1 兼容态不得阻断普通聊天，也不向模型泄露旧私有清单。
      character = {
        characterName: '当前角色',
        semantics: [],
        stateNames: [],
        actionNames: [],
        tags: []
      };
      catalogAvailable = false;
    }
    return {
      character,
      runtime: {
        moving: motion.moving,
        dragging: this.dragging,
        carrying: motion.carrying,
        movementStopped: this.movementStopped
      },
      proactivityMode: 'assistive',
      recentActions: catalogAvailable ? this.options.behavior.getRecentPublicActions() : []
    };
  }

  completeUserPrompt(input: Readonly<{
    generation: string;
    explicitDirective: ExplicitBehaviorDirective | null;
    providerPlan: CharacterBehaviorPlan | null;
  }>): void {
    if (this.closed || input.generation !== this.generation) return;
    if (input.explicitDirective?.kind === 'stop_movement') this.applyExplicitMovementLock(true);
    if (input.explicitDirective?.kind === 'resume_movement') this.applyExplicitMovementLock(false);
    this.pendingChatPlan = input.providerPlan?.kind === 'none' ? null : input.providerPlan;
    this.pendingSuccessToken = null;
  }

  /** 可信任务事件先占用身体动作；聊天计划只在 success 动作结算后提交。 */
  handleTaskEvent(event: TaskEvent): void {
    if (this.closed) return;
    this.updateTrustedBlock(event);
    const explicitPlaybackActive = this.active?.source === 'explicit';
    // 新可信阶段已由 Service 原子处理，旧可信阶段令牌不能继续占用来源优先级。
    if (this.active?.source === 'trusted-task') this.active = null;
    const authorization = this.options.behavior.handleTaskEvent(event, {
      allowPlayback: !explicitPlaybackActive
    });
    if (authorization.kind === 'play') {
      this.active = { source: 'trusted-task', playbackToken: authorization.playbackToken };
    }

    if (event.type !== 'phase') return;
    if (event.phase === 'error' || event.phase === 'cancelled') {
      this.clearPendingChat();
      return;
    }
    if (event.phase !== 'success' || !this.pendingChatPlan) return;
    if (authorization.kind === 'play') {
      this.pendingSuccessToken = authorization.playbackToken;
      return;
    }
    if (this.active?.source === 'explicit') {
      this.pendingSuccessToken = this.active.playbackToken;
      return;
    }
    this.commitPendingChatPlan();
  }

  /** 兼容能力任务的高层意图仍先经过显式优先级与停止锁，再生成唯一运动意图。 */
  handleAgentBehaviorIntent(intent: CharacterAgentBehaviorIntent): CharacterBehaviorAuthorization {
    if (this.closed || this.active?.source === 'explicit') return NONE;
    if (this.movementStopped && this.options.behavior.isMovementAgentIntent(intent)) return NONE;
    const authorization = this.options.behavior.handleAgentIntent(intent);
    if (authorization.kind !== 'play') return authorization;
    this.active = { source: 'trusted-task', playbackToken: authorization.playbackToken };
    if (authorization.semantic === 'move') {
      this.options.motion.requestIntent({ kind: 'wander', scope: 'work_area' });
    }
    return authorization;
  }

  /** 只有 success 的真实终态令牌可以释放其后排队的聊天行为。 */
  applyPlaybackFeedback(feedback: CharacterPlaybackFeedback): void {
    if (this.closed) return;
    this.options.behavior.applyPlaybackFeedback(feedback);
    if (feedback.status === 'started') return;
    if (this.active?.playbackToken === feedback.playbackToken) this.active = null;
    if (this.pendingSuccessToken !== feedback.playbackToken) return;
    this.pendingSuccessToken = null;
    this.commitPendingChatPlan();
  }

  /** 供明确指令、聊天、反思和本地待机共用同一条已解析授权链。 */
  requestBehaviorPlan(
    plan: CharacterBehaviorPlan,
    source: BehaviorPlanSource
  ): CharacterBehaviorAuthorization {
    if (!this.canRequest(plan, source)) return NONE;
    if (plan.kind === 'stop_movement' || plan.kind === 'resume_movement') return NONE;

    const motion = plan.kind === 'move'
      ? { kind: 'relative', direction: plan.direction, distance: plan.distance } as const
      : plan.kind === 'move_region'
        ? { kind: 'region', region: plan.region } as const
        : null;
    const target = plan.kind === 'play'
      ? plan.target
      : motion
        ? { kind: 'semantic', semantic: 'move' } as const
        : null;
    if (!target) return NONE;

    try {
      const resolvedTarget = this.options.behavior.resolveBehaviorTarget(target);
      if (this.movementStopped && this.options.behavior.isMovementBehaviorTarget(resolvedTarget)) {
        return NONE;
      }
      const authorization = this.options.behavior.requestDirectedBehavior(
        resolvedTarget,
        SOURCE_OPTIONS[source]
      );
      if (authorization.kind === 'play') {
        this.active = { source, playbackToken: authorization.playbackToken };
        if (authorization.semantic === 'move') {
          this.options.motion.requestIntent(
            motion ?? { kind: 'wander', scope: 'short' }
          );
        }
      } else if (source === 'explicit' || source === 'chat') {
        this.publishUnavailableNotice();
      }
      return authorization;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'CHARACTER_ACTION_UNAVAILABLE') throw error;
      if (source === 'explicit' || source === 'chat') this.publishUnavailableNotice();
      return { kind: 'none', diagnosticCode: 'CHARACTER_ACTION_UNAVAILABLE' };
    }
  }

  /** 任务 4 先把原 500ms 主动入口纳入同一停止锁；任务 6 再替换候选时钟。 */
  handleIdleDue(): void {
    if (this.closed) return;
    const expiredTokens = this.options.behavior.handleIdleDue({
      allowCandidate: !this.movementStopped
    });
    for (const playbackToken of expiredTokens) this.releasePlaybackToken(playbackToken);
  }

  /** 拖拽事实只参与优先级阻塞，不在 Director 内复制运动或角色状态。 */
  setDragging(active: boolean): void {
    if (!this.closed) this.dragging = active;
  }

  async handleActiveCharacterChanged(): Promise<void> {
    if (this.closed) return;
    this.clearPendingChat();
    this.active = null;
    await this.options.behavior.handleActiveCharacterChanged();
  }

  reset(generation: string): void {
    if (this.closed) return;
    this.generation = generation;
    this.clearPendingChat();
    this.active = null;
    this.trustedRuntimeBlocked = false;
    this.dragging = false;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearPendingChat();
    this.active = null;
    this.options.behavior.close();
  }

  private canRequest(plan: CharacterBehaviorPlan, source: BehaviorPlanSource): boolean {
    if (this.closed) return false;
    if (this.movementStopped && (
      plan.kind === 'move' || plan.kind === 'move_region'
    )) return false;
    if (source !== 'explicit' && (this.trustedRuntimeBlocked || this.dragging)) return false;
    if ((source === 'reflection' || source === 'local-idle') && this.pendingChatPlan) return false;
    return !this.active || SOURCE_PRIORITY[source] > SOURCE_PRIORITY[this.active.source];
  }

  private updateTrustedBlock(event: TaskEvent): void {
    const runtimeBlock = characterTaskRuntimeBlock(event);
    if (runtimeBlock !== null) this.trustedRuntimeBlocked = runtimeBlock;
  }

  private commitPendingChatPlan(): void {
    const plan = this.pendingChatPlan;
    this.pendingChatPlan = null;
    if (plan) this.requestBehaviorPlan(plan, 'chat');
  }

  private clearPendingChat(): void {
    this.pendingChatPlan = null;
    this.pendingSuccessToken = null;
  }

  private releasePlaybackToken(playbackToken: string): void {
    if (this.active?.playbackToken === playbackToken) this.active = null;
    if (this.pendingSuccessToken !== playbackToken) return;
    this.pendingSuccessToken = null;
    this.commitPendingChatPlan();
  }

  private publishUnavailableNotice(): void {
    this.options.publishNotice?.(ACTION_UNAVAILABLE_NOTICE);
  }

  private requestMotionBehavior(
    motion: Exclude<CharacterMotionIntent, { kind: 'return-visible' }>,
    source: BehaviorPlanSource
  ): CharacterBehaviorAuthorization {
    const plan: CharacterBehaviorPlan = motion.kind === 'relative'
      ? { kind: 'move', direction: motion.direction, distance: motion.distance }
      : motion.kind === 'region'
        ? { kind: 'move_region', region: motion.region }
        : {
            kind: 'play',
            target: { kind: 'semantic', semantic: 'move' }
          };
    return this.requestBehaviorPlan(plan, source);
  }

  private applyExplicitMovementLock(stopped: boolean): void {
    if (this.movementStopped === stopped) return;
    this.movementStopped = stopped;
    if (stopped) this.options.motion.stop();
  }
}
