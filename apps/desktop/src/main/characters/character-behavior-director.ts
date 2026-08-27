import type {
  BehaviorTarget,
  CharacterBehaviorAuthorization,
  CharacterBehaviorPlan,
  CharacterAgentBehaviorIntent,
  CharacterPlaybackFeedback,
  MoveDirection,
  MoveDistance,
  MovementControlPlan,
  PublicMotionTarget,
  PublicBehaviorCatalog,
  ScreenRegion
} from '@myself/character-runtime';
import { isPublicBehaviorTarget, selectPublicBehaviorTarget } from '@myself/character-runtime';
import type { TaskEvent } from '@myself/shared-types';
import {
  characterTaskRuntimeBlock,
  type CharacterBehaviorService
} from './character-behavior-service';
import type { CharacterMotionService } from './character-motion-service';
import { parseExplicitCharacterBehavior } from
  '../conversation/explicit-character-behavior-gate';
import type {
  CharacterBehaviorSettingsSnapshot,
  CharacterMovementMode
} from '../storage/settings-store';
import type { CharacterMotionSnapshot } from '../../shared/character-motion-ipc';

export type CharacterMotionIntent =
  | Readonly<{
      kind: 'wander';
      scope: 'short' | 'work_area';
      distance?: MoveDistance;
    }>
  | Readonly<{ kind: 'relative'; direction: MoveDirection; distance: MoveDistance }>
  | Readonly<{ kind: 'region'; region: ScreenRegion }>
  | Readonly<{ kind: 'return-visible' }>;

export type ExplicitBehaviorDirective =
  | Readonly<{ kind: 'stop_movement' }>
  | Readonly<{ kind: 'resume_movement' }>
  | Readonly<{ kind: 'continuous_movement' }>
  | Readonly<{
      kind: 'play';
      target: Readonly<{ kind: 'action_name'; name: string }>;
    }>
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
    movementMode: CharacterMovementMode;
  }>;
  proactivityMode: 'passive' | 'assistive' | 'autonomous';
  recentActions: readonly string[];
}>;

export type CharacterActivityBlockers = Readonly<{
  chatting: boolean;
  dragging: boolean;
  moving: boolean;
  capabilityTask: boolean;
  awaitingConfirmation: boolean;
  movementMode: CharacterMovementMode;
  closed: boolean;
}>;

export interface ConversationBehaviorPort {
  prepareUserPrompt(text: string): Promise<PreparedBehaviorPrompt>;
  getChatContext(): ConversationBehaviorContext;
  completeUserPrompt(input: Readonly<{
    generation: string;
    explicitDirective: ExplicitBehaviorDirective | null;
    providerPlan: CharacterBehaviorPlan | null;
    movementControl?: MovementControlPlan | null;
    activity?: string;
    status?: string;
  }>): Promise<void>;
  handleTaskEvent(event: TaskEvent): void;
  applyPlaybackFeedback(feedback: CharacterPlaybackFeedback): void;
  cancelActive(): void;
  reset(generation: string): void;
  close(): Promise<void>;
}

export type CharacterBehaviorNotice = Readonly<{
  code: 'CHARACTER_ACTION_UNAVAILABLE';
  message: '当前角色没有可播放的对应动作。';
}>;

/** 只读诊断只暴露状态标记与公开目标类型，不包含屏幕坐标或私有角色标识。 */
export type CharacterBehaviorDiagnosticSnapshot = Readonly<{
  movementMode: CharacterMovementMode;
  continuousTargetType: MotionTarget | null;
  moving: boolean;
  currentTargetType: MotionTarget | null;
}>;

export type BehaviorPlanSource = 'explicit' | 'chat' | 'local-idle';

type BehaviorServicePort = Pick<
  CharacterBehaviorService,
  | 'getPublicBehaviorCatalog'
  | 'getRecentPublicActions'
  | 'resolveBehaviorTarget'
  | 'resolveBehaviorStatePlan'
  | 'isMovementBehaviorTarget'
  | 'isMovementAgentIntent'
  | 'requestDirectedBehavior'
  | 'requestProactiveBehavior'
  | 'handleAgentIntent'
  | 'handleTaskEvent'
  | 'applyPlaybackFeedback'
  | 'cancelStateLifecycle'
  | 'advance'
  | 'handleActiveCharacterChanged'
  | 'close'
>;

type MotionServicePort = Pick<CharacterMotionService, 'getSnapshot' | 'stop'> & Readonly<{
  requestIntent(intent: CharacterMotionIntent): CharacterMotionSnapshot | null;
}>;

type CharacterBehaviorDirectorOptions = Readonly<{
  behavior: BehaviorServicePort;
  motion: MotionServicePort;
  initialGeneration: string;
  initialSettings: CharacterBehaviorSettingsSnapshot;
  saveMovementMode(
    mode: CharacterMovementMode,
    isCurrent?: () => boolean
  ): Promise<void>;
  publishNotice?: (notice: CharacterBehaviorNotice) => void;
}>;

type ActiveBehaviorSource = BehaviorPlanSource | 'trusted-task';

type MotionTarget = PublicMotionTarget | 'current';
type MotionDistance = MoveDistance | 'none';
type MotionRequest = Readonly<{
  mode: 'once' | 'continuous';
  target: MotionTarget;
  distance: MotionDistance;
}>;

const NONE: CharacterBehaviorAuthorization = { kind: 'none' };
const SOURCE_PRIORITY: Readonly<Record<ActiveBehaviorSource, number>> = {
  explicit: 5,
  'trusted-task': 4,
  chat: 3,
  'local-idle': 1
};
const SOURCE_OPTIONS: Readonly<Record<BehaviorPlanSource, {
  urgency: number;
  systemForced: boolean;
}>> = {
  explicit: { urgency: 100, systemForced: true },
  chat: { urgency: 80, systemForced: true },
  'local-idle': { urgency: 10, systemForced: false }
};
const ACTION_UNAVAILABLE_NOTICE: CharacterBehaviorNotice = {
  code: 'CHARACTER_ACTION_UNAVAILABLE',
  message: '当前角色没有可播放的对应动作。'
};

function samePoint(
  left: CharacterMotionSnapshot['target'],
  right: CharacterMotionSnapshot['target'] | null
): boolean {
  return right !== null && left.x === right.x && left.y === right.y;
}

/**
 * Main Director 只编排来源优先级、会话代次与待提交令牌；
 * 角色状态、动作约束和播放调度始终由现有 Service/Engine 独占。
 */
export class CharacterBehaviorDirector {
  private generation: string;
  private movementMode: CharacterMovementMode;
  private continuousTarget: MotionTarget | null = null;
  private continuousDistance: MotionDistance = 'none';
  private currentMotionTarget: MotionTarget | null = null;
  private continuousPlaybackToken: string | null = null;
  private lastSpatialTarget: CharacterMotionSnapshot['target'] | null = null;
  private motionWasMoving = false;
  private proactivityMode: CharacterBehaviorSettingsSnapshot['proactivityMode'];
  private trustedRuntimeBlocked = false;
  private chatting = false;
  private capabilityTask = false;
  private awaitingConfirmation = false;
  private dragging = false;
  private closed = false;
  private pendingChatPlan: CharacterBehaviorPlan | null = null;
  private pendingMovementControl: MovementControlPlan | null = null;
  private pendingSuccessToken: string | null = null;
  private active: Readonly<{
    source: ActiveBehaviorSource;
    playbackToken: string;
    semantic?: string;
  }> | null = null;
  private readonly activityListeners = new Set<() => void>();
  private behaviorLifecycleGeneration = 0;
  private turnEpoch = 0;

  constructor(private readonly options: CharacterBehaviorDirectorOptions) {
    this.generation = options.initialGeneration;
    this.movementMode = options.initialSettings.movementMode;
    this.proactivityMode = options.initialSettings.proactivityMode;
  }

  /** Gate 在能力路由与 Provider 前执行，本地明确移动仍须先通过动作授权。 */
  async prepareUserPrompt(text: string): Promise<PreparedBehaviorPrompt> {
    const turnEpoch = ++this.turnEpoch;
    const originalText = text.trim();
    const parsed = parseExplicitCharacterBehavior(originalText);
    const prepared: PreparedBehaviorPrompt = {
      originalText,
      capabilityText: parsed?.capabilityText ?? originalText,
      explicitDirective: parsed?.explicitDirective ?? null
    };
    await this.applyMovementControl(
      parsed?.movementControl ?? { kind: 'keep' }, 'explicit', turnEpoch
    );
    const directive = prepared.explicitDirective;
    if (directive?.kind === 'play') {
      this.requestBehaviorTarget(directive.target, 'explicit');
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
        identity: {
          name: '当前角色',
          description: '当前角色公开信息暂不可用。',
          background: '当前角色正在切换或兼容加载。',
          traits: [],
          languageStyle: '自然',
          likes: [],
          behavioralTendencies: []
        },
        states: []
      };
      catalogAvailable = false;
    }
    return {
      character,
      runtime: {
        moving: motion.moving,
        dragging: this.dragging,
        carrying: motion.carrying,
        movementMode: this.movementMode
      },
      proactivityMode: this.proactivityMode,
      recentActions: catalogAvailable ? this.options.behavior.getRecentPublicActions() : []
    };
  }

  /** Scheduler 只读取同一 Director 聚合的布尔事实，不获得正文、路径或私有角色标识。 */
  getActivityBlockers(): CharacterActivityBlockers {
    return {
      chatting: this.chatting,
      dragging: this.dragging,
      moving: this.options.motion.getSnapshot().moving,
      capabilityTask: this.capabilityTask,
      awaitingConfirmation: this.awaitingConfirmation,
      movementMode: this.movementMode,
      closed: this.closed
    };
  }

  subscribeActivityBlockers(listener: () => void): () => void {
    if (this.closed) return () => undefined;
    this.activityListeners.add(listener);
    return () => this.activityListeners.delete(listener);
  }

  getBehaviorLifecycleGeneration(): number {
    return this.behaviorLifecycleGeneration;
  }

  getDiagnosticSnapshot(): CharacterBehaviorDiagnosticSnapshot {
    return {
      movementMode: this.movementMode,
      continuousTargetType: this.continuousTarget,
      moving: this.options.motion.getSnapshot().moving,
      currentTargetType: this.currentMotionTarget
    };
  }

  /** Provider、授权根或高级配置切换会重置当前主动计时周期。 */
  invalidateBehaviorLifecycle(): void {
    if (this.closed) return;
    this.behaviorLifecycleGeneration += 1;
    this.publishActivityChanged();
  }

  async completeUserPrompt(input: Readonly<{
    generation: string;
    explicitDirective: ExplicitBehaviorDirective | null;
    providerPlan: CharacterBehaviorPlan | null;
    movementControl?: MovementControlPlan | null;
    activity?: string;
    status?: string;
  }>): Promise<void> {
    if (this.closed || input.generation !== this.generation) return;
    this.pendingSuccessToken = null;
    let catalog: PublicBehaviorCatalog | null = null;
    try {
      catalog = this.options.behavior.getPublicBehaviorCatalog();
    } catch {
      // 普通文字聊天不因角色目录暂不可用而失败；目录目标在此状态下不得进入私有解析。
    }
    const rejectedProviderTarget = input.providerPlan?.kind === 'play_state'
      && (!catalog || !isPublicBehaviorTarget(catalog, input.providerPlan));
    if (rejectedProviderTarget) this.publishUnavailableNotice();
    const providerPlan = input.providerPlan?.kind !== 'play_state'
      ? input.providerPlan
      : catalog && isPublicBehaviorTarget(catalog, input.providerPlan)
        ? input.providerPlan
        : null;
    const movementControl = input.explicitDirective === null
      ? input.movementControl ?? { kind: 'keep' }
      : { kind: 'keep' } as const;
    const fallbackPlan = input.explicitDirective !== null
      || !catalog
      || (input.activity === undefined && input.status === undefined)
      ? null
      : selectPublicBehaviorTarget(
          catalog, input.activity, input.status, movementControl
        );
    // none 只表示 Provider 没有精确目录目标，不能吞掉隐藏描述的最高相似匹配。
    const candidatePlan = providerPlan?.kind === 'none' ? fallbackPlan : providerPlan ?? fallbackPlan;
    // 持久运动策略只消费 MovementControlPlan；behaviorPlan 不具有写模式权限。
    if (movementControl.kind === 'set_mode') {
      const turnEpoch = this.turnEpoch;
      await this.applyMovementControl(movementControl, 'chat', turnEpoch);
      if (!this.isTurnCurrent(turnEpoch)) return;
    }
    // 持久化可能跨过 reset/close；旧轮完成后不得重新写入已清空的待提交槽。
    if (this.closed || input.generation !== this.generation) return;
    // mode 0/2 的移动动画只能伴随真实 Motion：静止时禁止，间歇时只由 Scheduler 发起。
    this.pendingChatPlan = movementControl.kind !== 'move_once'
      && this.movementMode !== 1
      && this.isMovementPlan(candidatePlan, catalog)
      ? null
      : candidatePlan;
    this.pendingMovementControl = movementControl.kind === 'move_once' ? movementControl : null;
  }

  /** 可信任务事件先占用身体动作；聊天计划只在 success 动作结算后提交。 */
  handleTaskEvent(event: TaskEvent): void {
    if (this.closed) return;
    this.updateTrustedBlock(event);
    this.updateActivityFromTaskEvent(event);
    if (this.trustedRuntimeBlocked || this.capabilityTask || this.awaitingConfirmation) {
      this.clearContinuousMotion();
    }
    const explicitPlaybackActive = this.active?.source === 'explicit';
    // 新可信阶段已由 Service 原子处理，旧可信阶段令牌不能继续占用来源优先级。
    if (this.active?.source === 'trusted-task') this.active = null;
    const authorization = this.options.behavior.handleTaskEvent(event, {
      allowPlayback: !explicitPlaybackActive
    });
    if (authorization.kind === 'play') {
      this.active = {
        source: 'trusted-task',
        playbackToken: authorization.playbackToken,
        semantic: authorization.semantic
      };
    }

    if (event.type !== 'phase') return;
    if (event.phase === 'error' || event.phase === 'cancelled') {
      this.clearPendingChat();
      return;
    }
    if (event.phase !== 'success') return;
    if (!this.pendingChatPlan) {
      this.commitPendingMovementControl();
      return;
    }
    if (authorization.kind === 'play') {
      this.pendingSuccessToken = authorization.playbackToken;
      return;
    }
    if (this.active?.source === 'explicit') {
      this.pendingSuccessToken = this.active.playbackToken;
      return;
    }
    const chatAuthorization = this.commitPendingChatPlan();
    this.commitPendingMovementControl(chatAuthorization);
  }

  /** 兼容能力任务的高层意图仍先经过显式优先级与停止锁，再生成唯一运动意图。 */
  handleAgentBehaviorIntent(intent: CharacterAgentBehaviorIntent): CharacterBehaviorAuthorization {
    if (this.closed || this.active?.source === 'explicit') return NONE;
    if (this.movementMode === 0 && this.options.behavior.isMovementAgentIntent(intent)) return NONE;
    const authorization = this.options.behavior.handleAgentIntent(intent);
    if (authorization.kind !== 'play') return authorization;
    this.active = {
      source: 'trusted-task',
      playbackToken: authorization.playbackToken,
      semantic: authorization.semantic
    };
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
    const releasedActive = this.active?.playbackToken === feedback.playbackToken;
    if (releasedActive) this.active = null;
    if (this.pendingSuccessToken !== feedback.playbackToken) {
      if (releasedActive) this.publishActivityChanged();
      return;
    }
    this.pendingSuccessToken = null;
    const chatAuthorization = this.commitPendingChatPlan();
    this.commitPendingMovementControl(chatAuthorization);
    this.publishActivityChanged();
  }

  /** 供明确指令、聊天和本地待机共用同一条已解析授权链。 */
  requestBehaviorPlan(
    plan: CharacterBehaviorPlan,
    source: BehaviorPlanSource
  ): CharacterBehaviorAuthorization {
    if (!this.canRequest(source)) return NONE;

    const motion = plan.kind === 'move'
      ? { kind: 'relative', direction: plan.direction, distance: plan.distance } as const
      : plan.kind === 'move_region'
        ? { kind: 'region', region: plan.region } as const
        : null;
    const publicTarget: BehaviorTarget | null = plan.kind === 'play_state'
      ? plan.action === undefined
        ? { kind: 'state_name', name: plan.state }
        : { kind: 'action_name', name: plan.action }
      : motion
        ? { kind: 'semantic', semantic: 'move' }
        : null;
    if (!publicTarget) return NONE;

    try {
      const resolvedTarget = plan.kind === 'play_state'
        ? this.options.behavior.resolveBehaviorStatePlan(plan)
        : this.options.behavior.resolveBehaviorTarget(publicTarget);
      if (source === 'local-idle') {
        if (plan.kind === 'move' && plan.distance !== 'near') return NONE;
        if (plan.kind !== 'play_state' && plan.kind !== 'move') return NONE;
        if (this.movementMode === 0
          && this.options.behavior.isMovementBehaviorTarget(resolvedTarget)) return NONE;
        const authorization = this.options.behavior.requestProactiveBehavior(publicTarget, {
          urgency: SOURCE_OPTIONS[source].urgency,
          allowMovement: motion !== null
        });
        if (authorization.kind === 'play') {
          this.active = {
            source,
            playbackToken: authorization.playbackToken,
            semantic: authorization.semantic
          };
          if (authorization.semantic === 'move' && motion !== null) {
            this.options.motion.requestIntent(motion);
          }
        }
        return authorization;
      }
      const authorization = this.options.behavior.requestDirectedBehavior(
        resolvedTarget,
        SOURCE_OPTIONS[source]
      );
      if (authorization.kind === 'play') {
        if (source === 'explicit') this.clearContinuousMotion();
        this.active = {
          source,
          playbackToken: authorization.playbackToken,
          semantic: authorization.semantic
        };
        if (authorization.semantic === 'move' && motion !== null && !(
          source === 'chat' && this.pendingMovementControl?.kind === 'move_once'
        )) {
          this.options.motion.requestIntent(motion);
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

  /** 本地明确动作仍使用公开动作名，但不恢复 Provider 的旧扁平计划。 */
  private requestBehaviorTarget(
    target: BehaviorTarget,
    source: Extract<BehaviorPlanSource, 'explicit'>
  ): CharacterBehaviorAuthorization {
    if (!this.canRequest(source)) return NONE;
    try {
      const authorization = this.options.behavior.requestDirectedBehavior(
        this.options.behavior.resolveBehaviorTarget(target),
        SOURCE_OPTIONS[source]
      );
      if (authorization.kind === 'play') {
        this.clearContinuousMotion();
        this.active = {
          source,
          playbackToken: authorization.playbackToken,
          semantic: authorization.semantic
        };
      } else {
        this.publishUnavailableNotice();
      }
      return authorization;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'CHARACTER_ACTION_UNAVAILABLE') throw error;
      this.publishUnavailableNotice();
      return { kind: 'none', diagnosticCode: 'CHARACTER_ACTION_UNAVAILABLE' };
    }
  }

  /** 原 500ms poll 只推进既有引擎超时，主动候选由唯一 Scheduler 负责。 */
  advance(): void {
    if (this.closed) return;
    const expiredTokens = this.options.behavior.advance();
    for (const playbackToken of expiredTokens) this.releasePlaybackToken(playbackToken);
  }

  /** 拖拽事实只参与优先级阻塞，不在 Director 内复制运动或角色状态。 */
  setDragging(active: boolean): void {
    if (this.closed || this.dragging === active) return;
    this.dragging = active;
    if (active) {
      this.options.behavior.cancelStateLifecycle();
      this.clearContinuousMotion();
    }
    this.publishActivityChanged();
  }

  /** Motion 仍独占运动状态；该通知只使 Scheduler 重新读取同一快照。 */
  refreshActivityBlockers(): void {
    if (!this.closed) this.publishActivityChanged();
  }

  /** 持续模式在启动或阻塞解除后由唯一 Scheduler 请求恢复，不改写持久模式。 */
  requestPersistentMovement(): void {
    if (this.movementMode !== 1 || this.hasContinuousBlocker()) return;
    this.requestMotion({
      mode: 'continuous',
      target: 'random_work_area',
      distance: 'medium'
    }, 'explicit');
  }

  /** Provider 与本地 Gate 只通过这一入口改变持久模式或请求一次运动。 */
  async applyMovementControl(
    control: MovementControlPlan,
    source: Extract<BehaviorPlanSource, 'explicit' | 'chat'>,
    turnEpoch = this.turnEpoch
  ): Promise<void> {
    if (!this.isTurnCurrent(turnEpoch) || control.kind === 'keep') return;
    if (control.kind === 'set_mode') {
      if (control.mode === 0) await this.persistMovementStop(turnEpoch);
      else await this.options.saveMovementMode(
        control.mode, () => this.isTurnCurrent(turnEpoch)
      );
      if (!this.isTurnCurrent(turnEpoch)) return;
      return;
    }
    this.requestMotion({
      mode: 'once',
      target: control.target,
      distance: control.distance
    }, source);
  }

  /** mode=2 到期后只发起一段真实运动；Scheduler 在运动结束后重新计时。 */
  requestIntermittentMovement(): void {
    if (this.movementMode !== 2 || this.hasIntermittentBlocker()) return;
    this.requestMotion({
      mode: 'once',
      target: 'random_work_area',
      distance: 'medium'
    }, 'local-idle');
  }

  /** MotionService 快照是到达的唯一事实；连续计划不创建额外计时器。 */
  handleMotionSnapshot(snapshot: CharacterMotionSnapshot): void {
    if (this.closed) return;
    const arrived = this.motionWasMoving && !snapshot.moving;
    this.motionWasMoving = snapshot.moving;
    if (arrived && this.continuousTarget !== null) {
      if (this.hasContinuousBlocker() || !this.requestNextContinuousIntent()) {
        this.stopContinuousMotion();
      }
    } else if (arrived) {
      // 一段运动的终态同时撤销旧 move 状态续播权；idle 由真实 movement=false 信号恢复。
      this.options.behavior.cancelStateLifecycle();
      this.currentMotionTarget = null;
      if (this.active?.semantic === 'move') {
        this.active = null;
      }
    }
    this.publishActivityChanged();
  }

  /** 只接收 Store 成功落盘后的完整快照，避免运行态与磁盘分叉。 */
  applyBehaviorSettings(snapshot: CharacterBehaviorSettingsSnapshot): void {
    if (this.closed) return;
    const movementModeChanged = this.movementMode !== snapshot.movementMode;
    if (snapshot.movementMode === 0 || movementModeChanged) {
      this.options.behavior.cancelStateLifecycle();
    }
    // 模式边界拥有旧目标：切换先终止旧 Motion/播放令牌，再让 Scheduler 启动新策略。
    if (movementModeChanged) {
      if (snapshot.movementMode === 0) this.stopContinuousMotion();
      else this.clearContinuousMotion();
    }
    this.movementMode = snapshot.movementMode;
    const proactivityModeChanged = this.proactivityMode !== snapshot.proactivityMode;
    this.proactivityMode = snapshot.proactivityMode;
    if (movementModeChanged || proactivityModeChanged) this.behaviorLifecycleGeneration += 1;
    if (movementModeChanged && this.active?.semantic === 'move') this.active = null;
    this.publishActivityChanged();
  }

  async handleActiveCharacterChanged(): Promise<void> {
    if (this.closed) return;
    this.invalidateBehaviorLifecycle();
    this.clearContinuousMotion();
    this.clearPendingChat();
    this.active = null;
    await this.options.behavior.handleActiveCharacterChanged();
    this.invalidateBehaviorLifecycle();
  }

  reset(generation: string): void {
    if (this.closed) return;
    this.generation = generation;
    this.turnEpoch += 1;
    this.behaviorLifecycleGeneration += 1;
    this.options.behavior.cancelStateLifecycle();
    this.clearContinuousMotion();
    this.clearPendingChat();
    this.active = null;
    this.trustedRuntimeBlocked = false;
    this.chatting = false;
    this.capabilityTask = false;
    this.awaitingConfirmation = false;
    this.dragging = false;
    this.publishActivityChanged();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.turnEpoch += 1;
    this.publishActivityChanged();
    this.activityListeners.clear();
    this.clearContinuousMotion();
    this.clearPendingChat();
    this.active = null;
    this.options.behavior.close();
  }

  private canRequest(source: BehaviorPlanSource): boolean {
    if (this.closed) return false;
    if (source !== 'explicit' && (this.trustedRuntimeBlocked || this.dragging)) return false;
    if (source === 'local-idle' && this.pendingChatPlan) return false;
    return !this.active || SOURCE_PRIORITY[source] > SOURCE_PRIORITY[this.active.source];
  }

  /** 取消使当前轮次失效并清空待提交计划，不伪造可信任务终态。 */
  cancelActive(): void {
    if (this.closed) return;
    this.turnEpoch += 1;
    this.options.behavior.cancelStateLifecycle();
    this.clearPendingChat();
    this.publishActivityChanged();
  }

  private isTurnCurrent(turnEpoch: number): boolean {
    return !this.closed && turnEpoch === this.turnEpoch;
  }

  private async persistMovementStop(turnEpoch: number): Promise<void> {
    const wasAlreadyStopped = this.movementMode === 0;
    this.options.behavior.cancelStateLifecycle();
    await this.options.saveMovementMode(0, () => this.isTurnCurrent(turnEpoch));
    if (!this.isTurnCurrent(turnEpoch)) return;
    if (!wasAlreadyStopped) return;
    this.stopContinuousMotion();
    if (this.active?.semantic === 'move') this.active = null;
  }

  private updateTrustedBlock(event: TaskEvent): void {
    const runtimeBlock = characterTaskRuntimeBlock(event);
    if (runtimeBlock !== null) this.trustedRuntimeBlocked = runtimeBlock;
  }

  private updateActivityFromTaskEvent(event: TaskEvent): void {
    if (event.type === 'pending_action') {
      this.chatting = false;
      this.capabilityTask = true;
      this.awaitingConfirmation = true;
      this.publishActivityChanged();
      return;
    }
    if (event.type !== 'phase') return;
    this.chatting = event.phase === 'listening' || event.phase === 'thinking';
    this.awaitingConfirmation = event.phase === 'awaiting_confirmation';
    this.capabilityTask = this.awaitingConfirmation || event.phase === 'acting';
    this.publishActivityChanged();
  }

  private publishActivityChanged(): void {
    for (const listener of [...this.activityListeners]) {
      try {
        listener();
      } catch {
        // Scheduler 观察失败不得改变可信任务或角色动作裁决。
      }
    }
  }

  private commitPendingChatPlan(): CharacterBehaviorAuthorization {
    const plan = this.pendingChatPlan;
    this.pendingChatPlan = null;
    return plan ? this.requestBehaviorPlan(plan, 'chat') : NONE;
  }

  private commitPendingMovementControl(
    chatAuthorization: CharacterBehaviorAuthorization = NONE
  ): void {
    const control = this.pendingMovementControl;
    this.pendingMovementControl = null;
    if (control?.kind === 'move_once') {
      this.requestMotion({
        mode: 'once', target: control.target, distance: control.distance
      }, 'chat', chatAuthorization);
    }
  }

  private clearPendingChat(): void {
    this.pendingChatPlan = null;
    this.pendingMovementControl = null;
    this.pendingSuccessToken = null;
  }

  /** 模型动作只能决定动画候选，持久模式为 0/2 时不得伪造正在移动。 */
  private isMovementPlan(
    plan: CharacterBehaviorPlan | null,
    catalog: PublicBehaviorCatalog | null
  ): boolean {
    if (!plan || plan.kind !== 'play_state' || !catalog) return false;
    const state = catalog.states.find(candidate => candidate.name === plan.state);
    if (!state) return false;
    if (plan.action !== undefined) {
      return state.actions.find(action => action.name === plan.action)?.semantic === 'move';
    }
    return state.semantic === 'move'
      || state.actions.some(action => action.semantic === 'move');
  }

  private releasePlaybackToken(playbackToken: string): void {
    const releasedActive = this.active?.playbackToken === playbackToken;
    if (releasedActive) this.active = null;
    if (this.pendingSuccessToken !== playbackToken) {
      if (releasedActive) this.publishActivityChanged();
      return;
    }
    this.pendingSuccessToken = null;
    const chatAuthorization = this.commitPendingChatPlan();
    this.commitPendingMovementControl(chatAuthorization);
    this.publishActivityChanged();
  }

  private publishUnavailableNotice(): void {
    this.options.publishNotice?.(ACTION_UNAVAILABLE_NOTICE);
  }

  /** 运动建议必须先取得现有 move 动画授权，再把公开目标交给唯一 MotionService。 */
  private requestMotion(
    plan: MotionRequest,
    source: BehaviorPlanSource,
    chatAuthorization: CharacterBehaviorAuthorization = NONE
  ): void {
    // 一次命令可临时替换持续目标，但不修改持久 mode；到达后 Scheduler 会恢复 mode=1。
    if (
      plan.mode === 'once'
      && this.continuousPlaybackToken !== null
      && this.active?.playbackToken === this.continuousPlaybackToken
    ) this.stopContinuousMotion();
    const reusesSameTurnMove = chatAuthorization.kind === 'play'
      && chatAuthorization.semantic === 'move';
    // 同轮相似动作已经通过完整授权，只跳过它与自身 active 的优先级竞争；可信阻塞仍失败关闭。
    if (reusesSameTurnMove) {
      if (this.closed || this.trustedRuntimeBlocked || this.dragging) return;
    } else if (!this.canRequest(source)) return;
    try {
      const authorization = reusesSameTurnMove
        ? chatAuthorization
        : source === 'local-idle'
          ? this.options.behavior.requestProactiveBehavior(
              { kind: 'semantic', semantic: 'move' },
              { urgency: SOURCE_OPTIONS[source].urgency, allowMovement: true }
            )
          : this.options.behavior.requestDirectedBehavior(
              this.options.behavior.resolveBehaviorTarget({ kind: 'semantic', semantic: 'move' }),
              SOURCE_OPTIONS[source]
            );
      if (authorization.kind !== 'play') {
        this.publishUnavailableNotice();
        return;
      }
      this.active = {
        source,
        playbackToken: authorization.playbackToken,
        semantic: authorization.semantic
      };
      const motionSnapshot = this.options.motion.requestIntent(
        this.motionIntentFor(plan.target, plan.distance)
      );
      if (motionSnapshot === null) {
        if (this.active?.playbackToken === authorization.playbackToken) this.active = null;
        this.publishUnavailableNotice();
        this.publishActivityChanged();
        return;
      }
      this.currentMotionTarget = plan.target;
      this.lastSpatialTarget = { ...motionSnapshot.target };
      this.motionWasMoving = motionSnapshot.moving;
      if (plan.mode === 'continuous') {
        this.continuousTarget = plan.target === 'random_work_area'
          ? plan.target
          : 'random_work_area';
        this.continuousDistance = plan.distance;
        this.continuousPlaybackToken = authorization.playbackToken;
        if (!motionSnapshot.moving && !this.requestNextContinuousIntent()) {
          this.stopContinuousMotion();
        }
      } else {
        this.continuousTarget = null;
        this.continuousPlaybackToken = null;
        if (!motionSnapshot.moving) {
          this.currentMotionTarget = null;
          if (this.active?.playbackToken === authorization.playbackToken) this.active = null;
        }
      }
      this.publishActivityChanged();
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'CHARACTER_ACTION_UNAVAILABLE') throw error;
      this.publishUnavailableNotice();
    }
  }

  private motionIntentFor(
    target: MotionTarget,
    distance: MotionDistance = 'none'
  ): CharacterMotionIntent {
    if (target === 'current') return { kind: 'return-visible' };
    if (target === 'random_work_area') {
      if (distance === 'near') return { kind: 'wander', scope: 'short', distance };
      return distance === 'none'
        ? { kind: 'wander', scope: 'work_area' }
        : { kind: 'wander', scope: 'work_area', distance };
    }
    return { kind: 'region', region: target };
  }

  private stopContinuousMotion(): void {
    const playbackToken = this.continuousPlaybackToken;
    this.continuousTarget = null;
    this.continuousDistance = 'none';
    this.currentMotionTarget = null;
    this.continuousPlaybackToken = null;
    this.lastSpatialTarget = null;
    this.motionWasMoving = false;
    this.options.motion.stop();
    if (playbackToken !== null && this.active?.playbackToken === playbackToken) this.active = null;
  }

  /** 生命周期仅撤销本 Director 发起的连续计划，不打断无关的用户位置。 */
  private clearContinuousMotion(): void {
    if (
      this.continuousTarget !== null
      || this.currentMotionTarget !== null
    ) {
      this.stopContinuousMotion();
      if (this.active?.semantic === 'move') this.active = null;
    }
  }

  /** 连续到达不得穿透拖拽、可信任务、确认或更高优先级播放。 */
  private hasContinuousBlocker(): boolean {
    return this.closed
      || this.dragging
      || this.trustedRuntimeBlocked
      || this.capabilityTask
      || this.awaitingConfirmation
      || this.active !== null && this.active.playbackToken !== this.continuousPlaybackToken;
  }

  private hasIntermittentBlocker(): boolean {
    return this.closed
      || this.dragging
      || this.trustedRuntimeBlocked
      || this.capabilityTask
      || this.awaitingConfirmation
      || this.options.motion.getSnapshot().moving
      || this.active !== null;
  }

  /** 最多重采样三次；只有新目标形成有效运动才等待下一到达边沿。 */
  private requestNextContinuousIntent(): boolean {
    if (this.continuousTarget === null) return false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const motionSnapshot = this.options.motion.requestIntent(
        this.motionIntentFor(this.continuousTarget, this.continuousDistance)
      );
      if (motionSnapshot === null) return false;
      const targetChanged = !samePoint(motionSnapshot.target, this.lastSpatialTarget);
      this.lastSpatialTarget = { ...motionSnapshot.target };
      this.currentMotionTarget = this.continuousTarget;
      if (targetChanged && motionSnapshot.moving) {
        this.motionWasMoving = true;
        return true;
      }
    }
    return false;
  }

}
