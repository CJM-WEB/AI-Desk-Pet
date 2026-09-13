import type {
  CharacterExpressionContext, CharacterMoodUpdate, CharacterExpressionPlanInput, CharacterExplicitPlayback, CharacterBackgroundSelection,
  BehaviorTarget,
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
import type { TaskEvent } from '@myself/shared-types';
import {
  characterTaskRuntimeBlock,
  type CharacterExpressionAuthorization,
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
import { CharacterSituation, type CharacterInteractionKind, type CharacterSituationSnapshot, type CharacterTaskPhase } from './character-situation';
import { characterBehaviorRoles, type CharacterBehaviorBindings, type CharacterBehaviorChoice } from './character-behavior-bindings';

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
      target: Extract<BehaviorTarget, { kind: 'action_name' | 'state_name' }>;
    }>
  | Readonly<{
      kind: 'move';
      motion: Exclude<CharacterMotionIntent, { kind: 'return-visible' }>;
    }>;

export type PreparedBehaviorPrompt = Readonly<{
  explicitPlaybackToken?: string;
  originalText: string;
  capabilityText: string;
  explicitDirective: ExplicitBehaviorDirective | null;
}>;

export type ConversationBehaviorContext = Readonly<{
  bindings?: CharacterBehaviorBindings;
  candidateSequence?: number;
  expression?: Readonly<{ stateId: string | null; actionId: string | null; backgroundStateId?: string | null; mood: { summary: string; strength: number } | null }>;
  situation?: CharacterSituationSnapshot;
  character: PublicBehaviorCatalog;
  runtime: Readonly<{
    moving: boolean;
    dragging: boolean;
    carrying: boolean;
    chatting: boolean;
    taskRunning: boolean;
    awaitingConfirmation: boolean;
    pendingMovement?: true;
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
  movementModeTransition: boolean;
  pendingMovement?: boolean;
  singleEpisode?: boolean;
  resting?: boolean;
  rendererUnready?: boolean;
  movementMode: CharacterMovementMode;
  closed: boolean;
}>;

export type CompletedCharacterPrompt = Readonly<{
  signal?: AbortSignal;
  generation: string; eventId: string; context: CharacterExpressionContext | null;
  explicitDirective: ExplicitBehaviorDirective | null; explicitPlaybackToken?: string;
  moodUpdate?: CharacterMoodUpdate; expressionPlan?: CharacterExpressionPlanInput; explicitPlayback?: CharacterExplicitPlayback;
  backgroundSelection?: CharacterBackgroundSelection;
  movementControl?: MovementControlPlan | null;
  expressionStatus?: 'ready' | 'no_match' | 'failed';
  requestKind?: 'ambient' | 'state' | 'action' | 'movement';
}>;
export type AutonomousCharacterDecision = Readonly<{
  lifecycle: number; eventId: string; context: CharacterExpressionContext;
  moodUpdate?: CharacterMoodUpdate; expressionPlan?: CharacterExpressionPlanInput;
  backgroundSelection?: CharacterBackgroundSelection;
}>;

export interface ConversationBehaviorPort {
  prepareUserPrompt(text: string): Promise<PreparedBehaviorPrompt>;
  getChatContext(): ConversationBehaviorContext;
  captureExpressionContext(): CharacterExpressionContext | null;
  completeUserPrompt(input: CompletedCharacterPrompt): Promise<void>;
  handleChatResponseFinished(): void;
  needsBehaviorBindings?(): boolean;
  applyBehaviorBindings?(input: { bindings: CharacterBehaviorBindings; context: CharacterExpressionContext; lifecycle: number }): boolean;
  applyIdleBindings?(idleForMs: number): boolean;
  handleTaskEvent(event: TaskEvent): void;
  handleCapabilityTaskPhase?(phase: CharacterTaskPhase): void;
  prepareTaskPresentation?(signal: AbortSignal): Promise<void>;
  cancelTaskPreparation?(): void;
  reportTaskPresentationFailure?(): void;
  subscribeActivityBlockers?(listener: () => void): () => void;
  getBehaviorLifecycleGeneration?(): number;
  applyPlaybackFeedback(feedback: CharacterPlaybackFeedback): void;
  cancelActive(): void;
  reset(generation: string): void;
  close(): Promise<void>;
}

export type CharacterBehaviorNotice = Readonly<{
  code: 'CHARACTER_ACTION_UNAVAILABLE' | 'CHARACTER_EXPRESSION_NOT_EXECUTED';
  message: string;
}>;

/** 只读诊断只暴露状态标记与公开目标类型，不包含屏幕坐标或私有角色标识。 */
export type CharacterBehaviorDiagnosticSnapshot = Readonly<{
  movementMode: CharacterMovementMode;
  continuousTargetType: MotionTarget | null;
  moving: boolean;
  currentTargetType: MotionTarget | 'relative' | null;
}>;

export type BehaviorPlanSource = 'explicit' | 'chat' | 'local-idle';

type BehaviorServicePort = Pick<
  CharacterBehaviorService,
  | 'context' | 'snapshot' | 'applyDecision' | 'invalidateContext' | 'recordTrustedEvent' | 'handleUserInteraction'
  | 'updateRuntimeFacts' | 'hasEligibleExpressionFor' | 'prepareActivity' | 'releasePreparedActivity' | 'releaseExplicitPlayback'
  | 'releaseBackgroundSelection' | 'cancelSingleEpisode' | 'hasActiveSingleEpisode' | 'hasStartedPlayback'
  | 'getPublicBehaviorCatalog'
  | 'getRecentPublicActions'
  | 'resolveBehaviorTarget'
  | 'resolveBehaviorStatePlan'
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
  ready?: Promise<void>;
  behavior: BehaviorServicePort;
  motion: MotionServicePort;
  initialGeneration: string;
  initialSettings: CharacterBehaviorSettingsSnapshot;
  now?: () => number;
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
}> | Readonly<{ mode: 'once'; target: 'relative'; direction: MoveDirection; distance: MoveDistance }>;

/** 唯一待执行槽保留准确请求和首帧截止；模型完成只提供候选，不直接授权位移。 */
type PendingMotion = Readonly<{
  request: MotionRequest; source: BehaviorPlanSource; generation: string; turnEpoch: number;
  behaviorLifecycleGeneration: number; lifecycle: 'activity-ready' | 'chat-success';
  deadlineAtMs: number;
  playbackToken?: string; actionId?: string; continuation?: boolean;
}>;

const NONE: CharacterExpressionAuthorization = { kind: 'none' };
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
  message: '请先配置对应状态和动作。'
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
  private currentMotionTarget: MotionTarget | 'relative' | null = null;
  private currentMotionSource: BehaviorPlanSource | null = null;
  private lastSpatialTarget: CharacterMotionSnapshot['target'] | null = null;
  private motionWasMoving = false;
  private proactivityMode: CharacterBehaviorSettingsSnapshot['proactivityMode'];
  private trustedRuntimeBlocked = false;
  private chatting = false;
  private capabilityTask = false;
  private awaitingConfirmation = false;
  private dragging = false;
  private closed = false;
  private readonly completedPrompts = new Set<string>();
  private candidateSequence = 0;
  private pendingMotion: PendingMotion | null = null;
  private movementPlaybackToken: string | null = null;
  private movementPlaybackCycle: { stateId: string; actionId: string; expectedEndAtMs: number | null; startDeadlineAtMs: number | null } | null = null;
  private committingMotion = false;
  private lastContinuousAttemptRevision = -1;
  private automaticMovementFailureLifecycle = -1;
  private readonly now: () => number;
  private active: Readonly<{
    source: ActiveBehaviorSource;
    playbackToken: string;
  }> | null = null;
  private readonly activityListeners = new Set<() => void>();
  private behaviorLifecycleGeneration = 0;
  private movementModeTransitionRevision = 0;
  private movementModeTransitionPending = false;
  private turnEpoch = 0;
  private successfulChatTurn: number | null = null;
  private readonly situation: CharacterSituation;
  private trustedTaskPhase: 'running' | 'waiting' | null = null;
  private preparedTaskToken: string | null = null;
  private pendingTaskStart: { token: string; finish(): void } | null = null;
  /** 用途独立于逐轮计划；只绑定当前角色实例，配置边界显式撤销。 */
  private behaviorBindings: { bindings: CharacterBehaviorBindings; instance: symbol } | null = null;
  private idleBackgroundStateId: string | null = null;
  private bindingSequence = 0;

  constructor(private readonly options: CharacterBehaviorDirectorOptions) {
    this.now = options.now ?? performance.now.bind(performance);
    this.situation = new CharacterSituation(this.now);
    this.generation = options.initialGeneration;
    this.movementMode = options.initialSettings.movementMode;
    this.proactivityMode = options.initialSettings.proactivityMode;
    this.syncRuntimeFacts();
  }

  /** Gate 在能力路由与 Provider 前执行，明确移动复用 Main 的运动与生命周期边界。 */
  async prepareUserPrompt(text: string): Promise<PreparedBehaviorPrompt> {
    this.clearPendingChat();
    const turnEpoch = ++this.turnEpoch;
    if (this.options.ready) await this.options.ready;
    // 首次大素材加载也属于当前会话轮次；等待期间取消、reset 或关闭后不执行旧指令。
    if (!this.isTurnCurrent(turnEpoch)) return { originalText: text.trim(), capabilityText: text.trim(), explicitDirective: null };
    this.clearIdleBackground();
    this.retireBoundReaction();
    this.options.behavior.handleUserInteraction();
    this.noteUserInteraction('chat');
    this.options.behavior.recordTrustedEvent('conversation-start');
    const originalText = text.trim();
    const parsed = parseExplicitCharacterBehavior(originalText);
    const directive = parsed?.explicitDirective ?? null;
    // 只有新轮明确播放替换旧明确来源；Engine 负责撤销旧令牌。
    if (directive?.kind === 'play' && this.active?.source === 'explicit') this.active = null;
    if (directive?.kind === 'move' && directive.motion.kind === 'relative') {
      // Main 已解析的相对方向和距离不能经区域协议降级为屏幕边缘。
      this.prepareExplicitMotion({ mode: 'once', target: 'relative', direction: directive.motion.direction, distance: directive.motion.distance });
    } else if (parsed?.movementControl.kind === 'move_once') {
      this.prepareExplicitMotion({ mode: 'once', target: parsed.movementControl.target, distance: parsed.movementControl.distance });
    } else {
      await this.applyMovementControl(parsed?.movementControl ?? { kind: 'keep' }, 'explicit', turnEpoch);
    }
    const authorization = directive?.kind === 'play' ? this.requestBehaviorTarget(directive.target, 'explicit', false) : NONE;
    return { originalText, capabilityText: parsed?.capabilityText ?? originalText, explicitDirective: directive,
      ...(authorization.kind === 'play' ? { explicitPlaybackToken: authorization.playbackToken } : {}) };
  }

  captureExpressionContext(): CharacterExpressionContext | null { return this.options.behavior.context(); }
  needsBehaviorBindings(): boolean { return !this.closed && !!this.options.behavior.context() && this.currentBindings() === null; }

  /** 角色就绪准备可在聊天期间完成；只接纳同实例、同上下文和同宿主生命周期的合法用途。 */
  applyBehaviorBindings(input: { bindings: CharacterBehaviorBindings; context: CharacterExpressionContext; lifecycle: number }): boolean {
    if (this.closed || input.lifecycle !== this.behaviorLifecycleGeneration || !this.isExpressionContextCurrent(input.context)) return false;
    let catalog: PublicBehaviorCatalog;
    try { catalog = this.options.behavior.getPublicBehaviorCatalog(); } catch { return false; }
    if (characterBehaviorRoles.some(role => {
      const choice = input.bindings[role];
      if (choice === null) return false;
      const state = choice && catalog.states.find(state => state.stateId === choice.stateId);
      return !state?.agentInferable || !state.actions.some(action => action.actionId === choice!.actionId);
    })) return false;
    this.behaviorBindings = { bindings: structuredClone(input.bindings), instance: input.context.instance };
    this.syncRuntimeFacts();
    if (this.restingBackgroundState()) this.pauseAutomaticMotionForPresentation();
    this.publishActivityChanged();
    return true;
  }

  /** 自主未陪伴背景只填补空位；重复轮询不续期，明确休息等既有长期选择保持优先。 */
  applyIdleBindings(idleForMs: number): boolean {
    if (this.closed || !Number.isFinite(idleForMs) || idleForMs < 300_000 || this.chatting || this.capabilityTask
      || this.awaitingConfirmation || this.dragging || this.options.motion.getSnapshot().moving || this.pendingMotion || this.active?.source === 'explicit') return false;
    const choice = this.currentBindings()?.boredom;
    const context = this.options.behavior.context();
    if (!choice || !context) return false;
    const background = this.options.behavior.snapshot()?.background;
    if (background) return this.idleBackgroundStateId === background.stateId;
    this.options.behavior.applyDecision({ context, eventId: `idle-binding-${++this.bindingSequence}`, source: 'autonomous',
      backgroundSelection: { stateId: choice.stateId, actions: [{ actionId: choice.actionId, score: 1 }] } });
    if (this.options.behavior.snapshot()?.background?.stateId !== choice.stateId) return false;
    this.idleBackgroundStateId = choice.stateId;
    return true;
  }
  /** 自主建议只进入表达引擎；保留请求前修订，绝不复用聊天的运动或任务提交。 */
  applyAutonomousDecision(input: AutonomousCharacterDecision): void {
    if (this.closed || input.lifecycle !== this.behaviorLifecycleGeneration || this.chatting
      || this.capabilityTask || this.awaitingConfirmation || this.dragging || !this.isExpressionContextCurrent(input.context)) return;
    const backgroundSelection = this.idleBackgroundStateId && input.backgroundSelection?.stateId === this.options.behavior.getPublicBehaviorCatalog().idleStateId
      ? undefined : input.backgroundSelection;
    const expressionPlan = this.preserveBoundActivities(input.expressionPlan);
    const singleEpisode = !!expressionPlan?.states.some(state => state.lifetime !== 'condition');
    const authorization = this.options.behavior.applyDecision({ context: input.context, eventId: input.eventId, source: 'autonomous',
      ...(singleEpisode ? { singleEpisode: true } : {}),
      ...(input.moodUpdate === undefined ? {} : { moodUpdate: input.moodUpdate }),
      ...(backgroundSelection === undefined ? {} : { backgroundSelection }),
      ...(expressionPlan === undefined ? {} : { expressionPlan }) });
    // 自主重选同一无聊背景仍属于未陪伴事件，只有真正换到其他背景才交接来源。
    if (backgroundSelection && this.options.behavior.snapshot()?.background?.stateId !== this.idleBackgroundStateId) this.idleBackgroundStateId = null;
    if (authorization.kind === 'play') this.active = { source: 'local-idle', playbackToken: authorization.playbackToken };
    if (singleEpisode || this.restingBackgroundState()) this.pauseAutomaticMotionForPresentation();
    this.publishActivityChanged();
  }
  handleChatResponseFinished(): void {
    this.options.behavior.recordTrustedEvent('response-finished');
    this.chatting = false; this.syncRuntimeFacts(); this.publishActivityChanged();
  }
  noteUserInteraction(kind: CharacterInteractionKind): void { this.clearIdleBackground(); this.situation.noteInteraction(kind); }

  /** 仅 Coordinator 的真实 Core 事件调用；普通聊天 phase 不能生成任务终态。 */
  handleCapabilityTaskPhase(phase: CharacterTaskPhase): void {
    if (this.closed) return;
    const previous = this.trustedTaskPhase;
    if (phase === 'running' || phase === 'waiting') {
      this.retireBoundReaction();
      this.trustedTaskPhase = phase;
      if (previous === null) this.options.behavior.recordTrustedEvent('task-start');
      if (phase === 'waiting' && previous !== phase) this.options.behavior.recordTrustedEvent('task-waiting');
    } else {
      this.trustedTaskPhase = null;
      if (previous !== null) this.options.behavior.recordTrustedEvent('task-finished');
    }
    this.situation.noteTaskPhase(phase);
    this.chatting = false; this.capabilityTask = this.trustedTaskPhase !== null;
    this.awaitingConfirmation = this.trustedTaskPhase === 'waiting';
    this.syncRuntimeFacts();
    this.cancelTaskPreparation();
    if (phase === 'success' || phase === 'error') this.applyBoundReaction(phase);
    this.publishActivityChanged();
  }

  /** 任务可复用活动首帧准备；准备不设置 taskRunning，失败不会永远阻塞任务。 */
  async prepareTaskPresentation(signal: AbortSignal): Promise<void> {
    this.cancelTaskPreparation();
    if (this.closed || signal.aborted) return;
    if (this.active?.source === 'explicit' && this.options.behavior.snapshot()?.schedule.current?.startedAtMs != null) return;
    this.installPreparedBinding('taskRunning');
    const authorization = this.options.behavior.prepareActivity('taskRunning');
    if (authorization.kind !== 'play') { this.publishUnavailableNotice(); return; }
    this.preparedTaskToken = authorization.playbackToken;
    if (this.options.behavior.snapshot()?.schedule.current?.startedAtMs != null) return;
    await new Promise<void>(resolve => {
      const finish = () => {
        clearTimeout(timer); signal.removeEventListener('abort', cancel);
        if (this.pendingTaskStart?.token === authorization.playbackToken) this.pendingTaskStart = null;
        resolve();
      };
      const cancel = () => this.cancelTaskPreparation();
      const timer = setTimeout(() => { this.publishNotExecutedNotice(); this.cancelTaskPreparation(); }, 1500);
      this.pendingTaskStart = { token: authorization.playbackToken, finish };
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
    });
  }
  cancelTaskPreparation(): void {
    const pending = this.pendingTaskStart;
    this.pendingTaskStart = null;
    pending?.finish();
    if (this.preparedTaskToken !== null) {
      this.preparedTaskToken = null;
      this.options.behavior.releasePreparedActivity();
      this.syncRuntimeFacts();
    }
  }

  reportTaskPresentationFailure(): void {
    this.options.publishNotice?.({ code: 'CHARACTER_EXPRESSION_NOT_EXECUTED', message: '任务表现未能开始，继续执行已授权任务。' });
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
        idleStateId: 'idle',
        identity: {
          name: '当前角色',
          description: '当前角色公开信息暂不可用。',
          background: '当前角色正在切换或兼容加载。',
          traits: [],
          languageStyle: '自然',
          likes: [], formsOfAddress: [], dislikes: [], boundaries: [], exampleLines: [],
          behavioralTendencies: []
        },
        states: []
      };
      catalogAvailable = false;
    }
    const snapshot = this.options.behavior.snapshot();
    return {
      ...(this.currentBindings() ? { bindings: structuredClone(this.currentBindings()!) } : {}),
      character,
      candidateSequence: this.candidateSequence++,
      expression: { stateId: snapshot?.stateId ?? null, actionId: snapshot?.schedule.current?.actionId ?? null,
        backgroundStateId: snapshot?.background?.stateId ?? null,
        mood: snapshot?.mood ? { summary: snapshot.mood.summary, strength: snapshot.mood.strength } : null },
      situation: this.situation.snapshot({ ...(snapshot?.stateEnteredAtMs === undefined ? {} : { stateEnteredAtMs: snapshot.stateEnteredAtMs }),
        ...(snapshot?.background ? { backgroundEnteredAtMs: snapshot.background.enteredAtMs } : {}) }),
      runtime: {
        moving: motion.moving,
        dragging: this.dragging,
        carrying: motion.carrying,
        chatting: this.chatting,
        taskRunning: this.capabilityTask,
        awaitingConfirmation: this.awaitingConfirmation,
        ...(this.pendingMotion ? { pendingMovement: true as const } : {}),
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
      movementModeTransition: this.movementModeTransitionPending,
      pendingMovement: this.pendingMotion !== null || this.committingMotion,
      ...(this.options.behavior.hasActiveSingleEpisode() ? { singleEpisode: true } : {}),
      ...(this.restingBackgroundState() ? { resting: true } : {}),
      ...(!this.options.behavior.hasStartedPlayback() ? { rendererUnready: true } : {}),
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
    if (this.currentBindings()) this.options.behavior.updateRuntimeFacts({}, { states: [] });
    this.behaviorBindings = null; this.clearIdleBackground(); this.retireBoundReaction();
    this.lastContinuousAttemptRevision = -1;
    this.cancelTaskPreparation();
    this.clearPendingChat();
    this.publishActivityChanged();
  }

  /** 请求前的原始修订只提交一次；模型分区已经由同一 Main Adapter 对照本轮目录校验。 */
  async completeUserPrompt(input: CompletedCharacterPrompt): Promise<void> {
    if (this.closed || input.signal?.aborted || input.generation !== this.generation || this.completedPrompts.has(input.eventId)) return;
    if (!this.isExpressionContextCurrent(input.context)) return;
    this.completedPrompts.add(input.eventId);
    if (this.completedPrompts.size > 512) this.completedPrompts.delete(this.completedPrompts.values().next().value!);
    const turnEpoch = this.turnEpoch;
    const movementControl = input.explicitDirective === null ? input.movementControl ?? { kind: 'keep' } : { kind: 'keep' } as const;
    const current = this.options.behavior.context();
    if (input.context && current && input.context.instance === current.instance
      && input.context.contextRevision === current.contextRevision && input.context.moodRevision === current.moodRevision) {
      // 状态请求复用作者驻留时长；动作请求仍需精确 actionId，不能随机替代。
      let explicit: CharacterExplicitPlayback | undefined;
      if (!input.explicitPlaybackToken && input.explicitPlayback && (input.requestKind === 'state' || input.requestKind === 'action' || input.explicitDirective?.kind === 'play')) {
        explicit = input.requestKind === 'state' || input.explicitDirective?.kind === 'play' && input.explicitDirective.target.kind === 'state_name'
          ? { stateId: input.explicitPlayback.stateId }
          : input.explicitPlayback.actionId !== undefined ? input.explicitPlayback : undefined;
      }
      if (explicit) { this.clearPendingChat(); this.clearContinuousMotion(); }
      if (input.backgroundSelection) this.idleBackgroundStateId = null;
      const expressionPlan = this.preserveBoundActivities(input.expressionPlan);
      const singleEpisode = !!expressionPlan?.states.some(state => state.lifetime !== 'condition');
      const authorization = this.options.behavior.applyDecision({
        context: input.context, eventId: input.eventId, source: 'chat',
        ...(singleEpisode ? { singleEpisode: true } : {}),
        ...(input.moodUpdate === undefined ? {} : { moodUpdate: input.moodUpdate }),
        ...(input.backgroundSelection === undefined ? {} : { backgroundSelection: input.backgroundSelection }),
        ...(expressionPlan === undefined ? {} : { expressionPlan }),
        ...(explicit === undefined ? {} : { explicitPlayback: explicit }),
        ...(input.explicitPlaybackToken === undefined ? {} : { preserveExplicitPlaybackToken: input.explicitPlaybackToken })
      });
      if (authorization.kind === 'play') this.active = { source: explicit ? 'explicit' : 'chat', playbackToken: authorization.playbackToken };
      if (singleEpisode && !explicit || this.restingBackgroundState()) this.pauseAutomaticMotionForPresentation();
      this.publishActivityChanged();
    }
    // 同份已验证回复的候选先同步接纳，避免自身模式落盘推进生命周期时丢失活动匹配。
    // 落盘等待后仍检查取消与接纳后的修订，外部切换不能提交迟到运动。
    if (movementControl.kind === 'set_mode') {
      const acceptedContext = this.options.behavior.context();
      await this.applyMovementControl(movementControl, 'chat', turnEpoch);
      if (input.signal?.aborted || !this.isTurnCurrent(turnEpoch) || input.generation !== this.generation
        || !this.isExpressionContextCurrent(acceptedContext)) return;
    }
    const explicitRequest = input.explicitDirective?.kind === 'play' || input.requestKind === 'state' || input.requestKind === 'action';
    if (input.expressionStatus === 'failed') {
      if (explicitRequest || this.pendingMotion || input.requestKind === 'movement' || input.explicitDirective?.kind === 'move') this.publishNotExecutedNotice();
      if (input.requestKind === 'movement' || input.explicitDirective?.kind === 'move') this.clearContinuousMotion();
      this.clearPendingChat(); return;
    }
    if (explicitRequest && input.expressionStatus === 'no_match' && !input.explicitPlaybackToken) this.publishUnavailableNotice();
    if (this.pendingMotion?.lifecycle === 'activity-ready') {
      if (!this.tryPrepareMotion()) { this.publishUnavailableNotice(); this.clearPendingChat(); }
    } else if (movementControl.kind === 'move_once' && !this.capabilityTask && !this.awaitingConfirmation && !this.dragging) {
      this.releaseRestingBackground();
      this.pendingMotion = this.createPendingMotion({ mode: 'once', target: movementControl.target, distance: movementControl.distance }, 'chat', 'chat-success');
      // 主正文可以先结束；同轮成功事实已到达时立即进入原有首帧准备，不等待第二次成功事件。
      if (this.successfulChatTurn === turnEpoch && !this.tryPrepareMotion()) { this.publishUnavailableNotice(); this.clearPendingChat(); }
    }
  }

  private isExpressionContextCurrent(context: CharacterExpressionContext | null): boolean {
    const current = this.options.behavior.context();
    return context === null ? current === null : !!current && context.instance === current.instance
      && context.contextRevision === current.contextRevision && context.moodRevision === current.moodRevision;
  }

  /** 真实任务只提供占用事实；普通聊天成功只提交独立的一次运动。 */
  handleTaskEvent(event: TaskEvent): void {
    if (this.closed) return;
    this.updateTrustedBlock(event);
    this.updateActivityFromTaskEvent(event);
    if (this.capabilityTask || this.awaitingConfirmation || event.type === 'capability_authorization_required'
      || event.type === 'history_disclosure_required') this.clearPendingChat();
    // 正文不是新的阻塞边沿，不能沿用 thinking 事实撤销本轮已接纳的明确运动。
    if (event.type === 'phase' && (this.trustedRuntimeBlocked || this.capabilityTask || this.awaitingConfirmation)) {
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
      };
    }

    if (event.type !== 'phase') return;
    this.successfulChatTurn = event.phase === 'success' ? this.turnEpoch : null;
    if (event.phase === 'error' || event.phase === 'cancelled') this.clearPendingChat();
    if (event.phase === 'success' && this.pendingMotion?.lifecycle === 'chat-success' && !this.tryPrepareMotion()) { this.publishUnavailableNotice(); this.clearPendingChat(); }
  }

  /** 兼容能力任务的高层意图仍先经过显式优先级与停止锁，再生成唯一运动意图。 */
  handleAgentBehaviorIntent(intent: CharacterAgentBehaviorIntent): CharacterExpressionAuthorization {
    if (this.closed || this.active?.source === 'explicit') return NONE;
    const authorization = this.options.behavior.handleAgentIntent(intent);
    if (authorization.kind !== 'play') return authorization;
    this.active = {
      source: 'trusted-task',
      playbackToken: authorization.playbackToken,
    };
    return authorization;
  }

  /** 播放反馈先由同一 Engine 验证，再据当前token决定提交或终止位移。 */
  applyPlaybackFeedback(feedback: CharacterPlaybackFeedback): void {
    if (this.closed) return;
    const reactionActive = this.options.behavior.hasActiveSingleEpisode();
    const rendererReady = this.options.behavior.hasStartedPlayback();
    this.options.behavior.applyPlaybackFeedback(feedback);
    if (reactionActive && !this.options.behavior.hasActiveSingleEpisode()) this.publishActivityChanged();
    if (this.preparedTaskToken === feedback.playbackToken) {
      const current = this.options.behavior.snapshot()?.schedule.current;
      // 首帧回报本身不构成播放证据，必须与服务核验后的当前快照一致。
      if (feedback.status === 'started' && current?.playbackToken === feedback.playbackToken
        && current.actionId === feedback.actionId && current.startedAtMs != null) this.pendingTaskStart?.finish();
      else if (feedback.status === 'failed' || feedback.status === 'interrupted') {
        this.publishNotExecutedNotice(); this.cancelTaskPreparation();
      }
    }
    if (feedback.status === 'started') {
      if (this.movementPlaybackToken === feedback.playbackToken && !this.refreshMovementPlayback()) {
        this.clearPendingChat(); this.stopContinuousMotion(); return;
      }
      this.commitPendingMotion();
    }
    else {
      // 同一合法行走的自然循环只交接令牌；真实目标继续由 Motion 持有。
      if (feedback.status === 'completed' && this.movementPlaybackToken === feedback.playbackToken) this.refreshMovementPlayback();
      if (this.pendingMotion?.playbackToken === feedback.playbackToken || this.movementPlaybackToken === feedback.playbackToken) {
        if (feedback.status !== 'completed') { this.automaticMovementFailureLifecycle = this.behaviorLifecycleGeneration; this.publishNotExecutedNotice(); }
        this.clearPendingChat(); this.stopContinuousMotion();
      }
      this.releasePlaybackToken(feedback.playbackToken);
    }
    if (!rendererReady && this.options.behavior.hasStartedPlayback()) this.publishActivityChanged();
  }

  /** 供明确指令、聊天和本地待机共用同一条已解析授权链。 */
  requestBehaviorPlan(
    plan: CharacterBehaviorPlan,
    source: BehaviorPlanSource
  ): CharacterExpressionAuthorization {
    if (!this.canRequest(source)) return NONE;

    if (plan.kind === 'move' || plan.kind === 'move_region') {
      // 相对位移与区域位移共用活动准备和首帧门控。
      this.requestMotion(plan.kind === 'move'
        ? { mode: 'once', target: 'relative', direction: plan.direction, distance: plan.distance }
        : { mode: 'once', target: plan.region, distance: 'none' }, source);
      return NONE;
    }
    if (plan.kind !== 'play_state') return NONE;
    try {
      const resolved = this.options.behavior.resolveBehaviorStatePlan(plan);
      if (source === 'explicit' || source === 'chat') { this.clearPendingChat(); this.clearContinuousMotion(); }
      const authorization = this.options.behavior.requestDirectedBehavior(resolved, SOURCE_OPTIONS[source]);
      if (authorization.kind === 'play') this.active = { source, playbackToken: authorization.playbackToken };
      else if (source === 'explicit' || source === 'chat') this.publishUnavailableNotice();
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
    source: Extract<BehaviorPlanSource, 'explicit'>,
    reportUnavailable = true
  ): CharacterExpressionAuthorization {
    if (!this.canRequest(source)) return NONE;
    try {
      const resolved = this.options.behavior.resolveBehaviorTarget(target);
      this.clearPendingChat(); this.clearContinuousMotion();
      const authorization = this.options.behavior.requestDirectedBehavior(resolved, SOURCE_OPTIONS[source]);
      if (authorization.kind === 'play') {
        this.clearPendingChat(); this.clearContinuousMotion();
        this.active = {
          source,
          playbackToken: authorization.playbackToken,
        };
      } else {
        if (reportUnavailable) this.publishUnavailableNotice();
      }
      return authorization;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'CHARACTER_ACTION_UNAVAILABLE') throw error;
      if (reportUnavailable) this.publishUnavailableNotice();
      return { kind: 'none', diagnosticCode: 'CHARACTER_ACTION_UNAVAILABLE' };
    }
  }

  /** 500ms 推进只更新本地心情与表现；模型重评和独立运动由宿主 Runtime 分别调度。 */
  advance(): void {
    if (this.closed) return;
    const reactionActive = this.options.behavior.hasActiveSingleEpisode();
    if (this.pendingMotion?.playbackToken && this.now() >= this.pendingMotion.deadlineAtMs) this.expirePendingMotion();
    const expiredTokens = this.options.behavior.advance();
    for (const playbackToken of expiredTokens) this.releasePlaybackToken(playbackToken);
    if (this.movementPlaybackToken && !this.refreshMovementPlayback()) this.stopContinuousMotion();
    if (reactionActive && !this.options.behavior.hasActiveSingleEpisode()) this.publishActivityChanged();
  }

  /** 拖拽事实只参与优先级阻塞，不在 Director 内复制运动或角色状态。 */
  setDragging(active: boolean): void {
    if (this.closed || this.dragging === active) return;
    this.dragging = active;
    if (active) {
      this.noteUserInteraction('drag');
      this.cancelTaskPreparation();
      this.clearPendingChat();
      this.clearContinuousMotion();
    }
    this.syncRuntimeFacts();
    this.publishActivityChanged();
  }

  /** Motion 仍独占运动状态；该通知只使 Scheduler 重新读取同一快照。 */
  refreshActivityBlockers(): void {
    if (!this.closed) { this.syncRuntimeFacts(); this.publishActivityChanged(); }
  }

  /** 持续模式在启动或阻塞解除后由唯一 Scheduler 请求恢复，不改写持久模式。 */
  requestPersistentMovement(): void {
    if (this.movementMode !== 1 || this.hasContinuousBlocker()
      || this.lastContinuousAttemptRevision === this.options.motion.getSnapshot().revision) return;
    this.requestMotion({
      mode: 'continuous',
      target: 'random_work_area',
      distance: 'medium'
    }, 'local-idle');
  }

  /** Provider 与本地 Gate 只通过这一入口改变持久模式或请求一次运动。 */
  async applyMovementControl(
    control: MovementControlPlan,
    source: Extract<BehaviorPlanSource, 'explicit' | 'chat'>,
    turnEpoch = this.turnEpoch
  ): Promise<void> {
    if (!this.isTurnCurrent(turnEpoch) || control.kind === 'keep') return;
    if (control.kind === 'set_mode') {
      const retrySameMode = control.mode !== 0 && control.mode === this.movementMode;
      const transitionRevision = this.beginMovementModeTransition(control.mode);
      try {
        await this.options.saveMovementMode(
          control.mode,
          () => this.isTurnCurrent(turnEpoch)
            && transitionRevision === this.movementModeTransitionRevision
        );
        if (!this.isTurnCurrent(turnEpoch) || transitionRevision !== this.movementModeTransitionRevision) return;
        if (control.mode !== 0) this.releaseRestingBackground();
        // 同值持久化仍代表用户明确重试；成功后开启新生命周期，自动tick不能自行解锁。
        if (retrySameMode) { this.behaviorLifecycleGeneration += 1; this.lastContinuousAttemptRevision = -1; }
      } finally {
        this.finishMovementModeTransition(transitionRevision);
      }
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
    this.situation.updateActivities({ moving: snapshot.moving, carrying: snapshot.carrying });
    if (snapshot.moving && this.movementPlaybackToken && !this.refreshMovementPlayback()) {
      this.stopContinuousMotion(); return;
    }
    const arrived = this.motionWasMoving && !snapshot.moving;
    this.motionWasMoving = snapshot.moving;
    // 已到达的空间段先释放旧令牌；迟到的中断确认不能撤销下一段首帧准备。
    if (arrived) { this.movementPlaybackToken = null; this.movementPlaybackCycle = null; }
    if (arrived && this.continuousTarget !== null) {
      if (this.hasContinuousBlocker()) this.stopContinuousMotion();
      else this.requestMotion({ mode: 'continuous', target: 'random_work_area', distance: this.continuousDistance }, 'local-idle', true);
    } else if (arrived) {
      // 运动到达只结束空间目标；表达由同一引擎自行续播。
      this.currentMotionTarget = null;
      this.currentMotionSource = null;
      this.options.behavior.releasePreparedActivity();
    }
    this.publishActivityChanged();
  }

  /** 只接收 Store 成功落盘后的完整快照，避免运行态与磁盘分叉。 */
  applyBehaviorSettings(snapshot: CharacterBehaviorSettingsSnapshot): void {
    if (this.closed) return;
    const movementModeChanged = this.movementMode !== snapshot.movementMode;
    const proactivityModeChanged = this.proactivityMode !== snapshot.proactivityMode;
    const transitionAlreadyInvalidated = this.movementModeTransitionPending;
    if (movementModeChanged || proactivityModeChanged) this.clearPendingChat();
    // 模式边界拥有旧目标：切换先终止旧 Motion/播放令牌，再让 Scheduler 启动新策略。
    if (movementModeChanged && !transitionAlreadyInvalidated) {
      if (snapshot.movementMode === 0) this.stopContinuousMotion();
      else this.clearContinuousMotion();
    }
    this.movementMode = snapshot.movementMode;
    if (movementModeChanged) this.lastContinuousAttemptRevision = -1;
    this.proactivityMode = snapshot.proactivityMode;
    if (movementModeChanged || proactivityModeChanged) this.behaviorLifecycleGeneration += 1;
    this.publishActivityChanged();
  }

  async handleActiveCharacterChanged(): Promise<void> {
    if (this.closed) return;
    this.cancelMovementModeTransition();
    this.invalidateBehaviorLifecycle();
    this.clearContinuousMotion();
    this.clearPendingChat();
    this.active = null;
    await this.options.behavior.handleActiveCharacterChanged();
    this.invalidateBehaviorLifecycle();
    this.syncRuntimeFacts();
  }

  reset(generation: string): void {
    if (this.closed) return;
    this.generation = generation;
    this.cancelTaskPreparation();
    this.trustedTaskPhase = null; this.situation.reset();
    this.behaviorBindings = null; this.idleBackgroundStateId = null;
    this.completedPrompts.clear();
    this.turnEpoch += 1;
    this.cancelMovementModeTransition();
    this.behaviorLifecycleGeneration += 1;
    this.lastContinuousAttemptRevision = -1;
    this.options.behavior.cancelStateLifecycle();
    this.clearContinuousMotion();
    this.clearPendingChat();
    this.active = null;
    this.trustedRuntimeBlocked = false;
    this.chatting = false;
    this.capabilityTask = false;
    this.awaitingConfirmation = false;
    this.dragging = false;
    this.syncRuntimeFacts();
    this.publishActivityChanged();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.behaviorBindings = null; this.idleBackgroundStateId = null;
    this.cancelTaskPreparation();
    this.turnEpoch += 1;
    this.cancelMovementModeTransition();
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
    return !this.active || SOURCE_PRIORITY[source] > SOURCE_PRIORITY[this.active.source];
  }

  /** 取消使当前轮次失效并清空待提交计划，不伪造可信任务终态。 */
  cancelActive(): void {
    if (this.closed) return;
    this.cancelTaskPreparation();
    this.turnEpoch += 1;
    this.cancelMovementModeTransition();
    this.options.behavior.invalidateContext();
    this.retireBoundReaction();
    this.chatting = false;
    if (this.trustedTaskPhase === null) this.awaitingConfirmation = false;
    this.syncRuntimeFacts();
    this.clearPendingChat(); this.clearContinuousMotion();
    this.publishActivityChanged();
  }

  private isTurnCurrent(turnEpoch: number): boolean {
    return !this.closed && turnEpoch === this.turnEpoch;
  }

  /** 落盘前先暂停旧策略；失败时仍保留旧持久模式并由 Scheduler 恢复其调度。 */
  private beginMovementModeTransition(mode: CharacterMovementMode): number {
    const revision = ++this.movementModeTransitionRevision;
    this.movementModeTransitionPending = true;
    this.lastContinuousAttemptRevision = -1;
    this.clearPendingChat();
    if (mode === 0) this.stopContinuousMotion();
    else this.clearContinuousMotion();
    this.publishActivityChanged();
    return revision;
  }

  private finishMovementModeTransition(revision: number): void {
    if (revision !== this.movementModeTransitionRevision) return;
    this.movementModeTransitionPending = false;
    this.publishActivityChanged();
  }

  private cancelMovementModeTransition(): void {
    this.movementModeTransitionRevision += 1;
    this.movementModeTransitionPending = false;
  }

  private updateTrustedBlock(event: TaskEvent): void {
    const runtimeBlock = characterTaskRuntimeBlock(event);
    if (runtimeBlock !== null) this.trustedRuntimeBlocked = runtimeBlock;
  }

  private updateActivityFromTaskEvent(event: TaskEvent): void {
    if (event.type === 'capability_authorization_required' || event.type === 'history_disclosure_required') {
      this.chatting = false; this.awaitingConfirmation = true; this.capabilityTask = this.trustedTaskPhase !== null;
      this.syncRuntimeFacts(); this.publishActivityChanged(); return;
    }
    if (event.type !== 'phase') return;
    if (this.trustedTaskPhase !== null) {
      this.chatting = false; this.capabilityTask = true;
      this.awaitingConfirmation = this.trustedTaskPhase === 'waiting';
      this.syncRuntimeFacts(); this.publishActivityChanged(); return;
    }
    this.chatting = event.phase === 'listening' || event.phase === 'thinking';
    this.awaitingConfirmation = event.phase === 'awaiting_confirmation';
    this.capabilityTask = this.awaitingConfirmation || event.phase === 'acting';
    this.syncRuntimeFacts();
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

  private syncRuntimeFacts(): void {
    const motion = this.options.motion.getSnapshot();
    this.situation.updateActivities({ moving: motion.moving, carrying: motion.carrying,
      dragging: this.dragging, chatting: this.chatting, taskRunning: this.capabilityTask, awaitingConfirmation: this.awaitingConfirmation });
    // 首帧准备仍沿用其独立用途，刷新真实事实不能把尚未 started 的工作或移动换回聊天。
    const role = this.preparedTaskToken && this.trustedTaskPhase === null ? 'taskRunning'
      : this.awaitingConfirmation ? 'awaitingConfirmation' : this.capabilityTask ? 'taskRunning'
        : this.pendingMotion?.playbackToken ? 'moving' : this.chatting ? 'chatting' : motion.moving ? 'moving' : null;
    this.options.behavior.updateRuntimeFacts({ dragging: this.dragging, chatting: this.chatting,
      taskRunning: this.capabilityTask, awaitingConfirmation: this.awaitingConfirmation }, this.boundActivityPlan(role));
  }

  private currentBindings(): CharacterBehaviorBindings | null {
    return this.behaviorBindings?.instance === this.options.behavior.context()?.instance ? this.behaviorBindings?.bindings ?? null : null;
  }
  private boundActivityPlan(role: 'chatting' | 'taskRunning' | 'awaitingConfirmation' | 'moving' | null): CharacterExpressionPlanInput | undefined {
    const bindings = this.currentBindings();
    if (!bindings) return undefined;
    const choice = role && bindings[role];
    return { states: choice ? [{ stateId: choice.stateId, score: 1, minStrength: 0, maxStrength: 1,
      when: { [role!]: true }, lifetime: 'condition', actions: [{ actionId: choice.actionId, score: 1 }] }] : [] };
  }
  private installPreparedBinding(role: 'taskRunning' | 'moving'): void {
    const plan = this.boundActivityPlan(role);
    if (plan) this.options.behavior.updateRuntimeFacts({}, plan);
  }
  private preserveBoundActivities(plan: CharacterExpressionPlanInput | undefined): CharacterExpressionPlanInput | undefined {
    if (!plan) return plan;
    const bound = !!this.currentBindings();
    const explicitMotion = this.pendingMotion !== null && this.pendingMotion.source !== 'local-idle'
      || this.currentMotionSource !== null && this.currentMotionSource !== 'local-idle';
    // 主动活动保留稳定用途；明确位移期间不让无关反应重签其首帧令牌。
    return { ...plan, states: plan.states.filter(state => (!bound || state.lifetime !== 'condition')
      && (!explicitMotion || state.lifetime === 'condition')) };
  }
  private clearIdleBackground(): void {
    const stateId = this.idleBackgroundStateId; this.idleBackgroundStateId = null;
    if (stateId) this.options.behavior.releaseBackgroundSelection(stateId);
  }
  private retireBoundReaction(): void {
    this.options.behavior.cancelSingleEpisode();
  }
  /** 休息是否仍有效只读 Engine 背景与作者用途，不保存第二份状态或改写运动档位。 */
  private restingBackgroundState(): string | null {
    const rest = this.currentBindings()?.rest;
    return rest && this.options.behavior.snapshot()?.background?.stateId === rest.stateId ? rest.stateId : null;
  }
  private releaseRestingBackground(): void {
    const stateId = this.restingBackgroundState();
    if (stateId) this.options.behavior.releaseBackgroundSelection(stateId);
  }
  /** 表现先进入唯一引擎，再释放自动移动；停止快照重入时已能看到短时或休息阻塞。 */
  private pauseAutomaticMotionForPresentation(): void {
    const committing = this.committingMotion;
    this.committingMotion = true;
    try {
      if (this.pendingMotion?.source === 'local-idle') this.clearPendingChat();
      if (this.currentMotionSource === 'local-idle') this.clearContinuousMotion();
    } finally { this.committingMotion = committing; }
  }
  private applyBoundReaction(role: 'success' | 'error'): void {
    const choice: CharacterBehaviorChoice | null | undefined = this.currentBindings()?.[role];
    const context = this.options.behavior.context();
    if (!choice || !context || this.active?.source === 'explicit') return;
    this.options.behavior.applyDecision({ context, eventId: `task-binding-${++this.bindingSequence}`, source: 'chat',
      singleEpisode: true,
      moodUpdate: { summary: role === 'success' ? '完成任务后的开心' : '任务失败后的沮丧', strength: 1, fadeInMs: 0 },
      expressionPlan: { states: [{ stateId: choice.stateId, score: 1, minStrength: 0, maxStrength: 1, lifetime: 'episode', actions: [{ actionId: choice.actionId, score: 1 }] }] } });
    this.pauseAutomaticMotionForPresentation();
  }

  private createPendingMotion(request: MotionRequest, source: BehaviorPlanSource, lifecycle: PendingMotion['lifecycle']): PendingMotion {
    return { request, source, generation: this.generation, turnEpoch: this.turnEpoch,
      behaviorLifecycleGeneration: this.behaviorLifecycleGeneration, lifecycle,
      deadlineAtMs: Infinity };
  }

  private prepareExplicitMotion(request: MotionRequest): void {
    if (this.closed || this.dragging || this.capabilityTask || this.awaitingConfirmation) return;
    this.releaseRestingBackground();
    this.automaticMovementFailureLifecycle = -1;
    this.clearContinuousMotion();
    this.options.behavior.releaseExplicitPlayback(); this.active = null;
    this.pendingMotion = this.createPendingMotion(request, 'explicit', 'activity-ready');
    this.tryPrepareMotion();
  }

  /** 唯一准备槽只接受 Engine 的活动授权；截止从取得 token 起计算，重复调用不续期。 */
  private tryPrepareMotion(): boolean {
    const pending = this.pendingMotion;
    if (!pending) return false;
    if (!pending.playbackToken) {
      this.installPreparedBinding('moving');
      const authorization = this.options.behavior.prepareActivity();
      if (authorization.kind !== 'play') return false;
      this.pendingMotion = { ...pending, playbackToken: authorization.playbackToken, actionId: authorization.actionId, deadlineAtMs: this.now() + 1500 };
    }
    this.commitPendingMotion(); this.publishActivityChanged(); return true;
  }

  /** Service 已校验回报；只以当前同 token 的 started 快照提交一次，先清槽再进入同步 Motion。 */
  private commitPendingMotion(): void {
    const pending = this.pendingMotion;
    const current = this.options.behavior.snapshot()?.schedule.current;
    if (!pending?.playbackToken || !current || current.playbackToken !== pending.playbackToken
      || current.actionId !== pending.actionId || current.startedAtMs === null) return;
    if (this.now() >= pending.deadlineAtMs) { this.expirePendingMotion(); return; }
    if (!this.isTurnCurrent(pending.turnEpoch) || pending.generation !== this.generation
      || pending.behaviorLifecycleGeneration !== this.behaviorLifecycleGeneration
      || this.dragging || this.capabilityTask || this.awaitingConfirmation) { this.clearPendingChat(); return; }
    this.pendingMotion = null; this.movementPlaybackToken = current.playbackToken;
    this.currentMotionSource = pending.source;
    this.movementPlaybackCycle = { stateId: current.stateId, actionId: current.actionId,
      expectedEndAtMs: current.expectedEndAtMs, startDeadlineAtMs: null };
    this.commitMotion(pending.request, pending.continuation);
  }

  /** 仅同状态、同动作的自然续播可复用已展示素材；新令牌首帧仍有独立上限。
   * 换动作、事实失效和失败不属于续播，继续走原有停止守卫，不重新采样空间目标。
   */
  private refreshMovementPlayback(): boolean {
    const snapshot = this.options.behavior.snapshot();
    const current = snapshot?.schedule.current;
    const cycle = this.movementPlaybackCycle;
    if (!current || !cycle || !this.movementPlaybackToken) return false;
    if (current.playbackToken !== this.movementPlaybackToken) {
      const previous = snapshot.schedule.history.at(-1);
      const naturallyCompleted = cycle.expectedEndAtMs !== null && this.now() >= cycle.expectedEndAtMs
        && previous?.actionId === cycle.actionId && previous.outcome === 'completed'
        && previous.finishedAtMs !== null && previous.finishedAtMs >= cycle.expectedEndAtMs;
      if (!naturallyCompleted || current.stateId !== cycle.stateId || current.actionId !== cycle.actionId
        || !this.options.behavior.hasEligibleExpressionFor({ moving: true }, 'moving')) return false;
      this.movementPlaybackToken = current.playbackToken;
      cycle.expectedEndAtMs = null;
      cycle.startDeadlineAtMs = this.now() + 1500;
    }
    if (cycle.startDeadlineAtMs !== null && this.now() >= cycle.startDeadlineAtMs) {
      this.automaticMovementFailureLifecycle = this.behaviorLifecycleGeneration;
      this.publishNotExecutedNotice();
      return false;
    }
    if (current.startedAtMs !== null) {
      cycle.expectedEndAtMs = current.expectedEndAtMs;
      cycle.startDeadlineAtMs = null;
    }
    return true;
  }

  /** poll与迟到started共用同一超时终态，不能因事件顺序绕过自动失败去重。 */
  private expirePendingMotion(): void {
    this.automaticMovementFailureLifecycle = this.behaviorLifecycleGeneration;
    this.publishNotExecutedNotice(); this.clearPendingChat();
  }

  private clearPendingChat(): void {
    const hadPending = this.pendingMotion !== null;
    this.pendingMotion = null;
    if (hadPending) this.options.behavior.releasePreparedActivity();
  }

  private releasePlaybackToken(playbackToken: string): void {
    if (this.active?.playbackToken !== playbackToken) return;
    this.active = null;
    this.publishActivityChanged();
  }

  private publishUnavailableNotice(): void { this.options.publishNotice?.(ACTION_UNAVAILABLE_NOTICE); }

  private publishNotExecutedNotice(): void {
    this.options.publishNotice?.({ code: 'CHARACTER_EXPRESSION_NOT_EXECUTED', message: '本次动作未执行。' });
  }

  /** 每个入口先准备活动，失败留在原位；Motion 提交集中在同 token 的首帧之后。 */
  private requestMotion(plan: MotionRequest, source: BehaviorPlanSource, continuation = false): void {
    if (this.pendingMotion || this.committingMotion || this.closed || this.dragging || this.capabilityTask || this.awaitingConfirmation || this.movementModeTransitionPending) return;
    // 冷加载不能提前消耗自动运动的首帧期限；用途预热与明确请求仍独立运行。
    if (source === 'local-idle' && (this.movementMode === 0 || this.restingBackgroundState() || !this.options.behavior.hasStartedPlayback())) return;
    // 自动活动遵守短时反应边界；明确播放和可信任务继续拥有更高优先级。
    if (source !== 'explicit' && (this.active?.source === 'explicit' || this.trustedRuntimeBlocked)) return;
    if (source !== 'local-idle') this.releaseRestingBackground();
    if (source === 'explicit') { this.options.behavior.releaseExplicitPlayback(); this.active = null; }
    if (!continuation) this.clearContinuousMotion();
    this.pendingMotion = { ...this.createPendingMotion(plan, source, 'activity-ready'), continuation };
    if (!this.tryPrepareMotion()) this.clearPendingChat();
  }

  private commitMotion(plan: MotionRequest, continuation = false): void {
    // Motion 同步广播到达快照；本轮提交持有重采样所有权，Scheduler 只能在后续复查重试。
    this.committingMotion = true;
    try {
      if (continuation) {
        if (!this.requestNextContinuousIntent()) this.stopContinuousMotion();
        this.publishActivityChanged(); return;
      }
      const snapshot = this.options.motion.requestIntent(plan.target === 'relative'
        ? { kind: 'relative', direction: plan.direction, distance: plan.distance }
        : this.motionIntentFor(plan.target, plan.distance));
      if (!snapshot) { this.stopContinuousMotion(); this.publishNotExecutedNotice(); return; }
      this.currentMotionTarget = plan.target;
      this.lastSpatialTarget = { ...snapshot.target };
      this.motionWasMoving = snapshot.moving;
      if (plan.mode === 'continuous') {
        this.continuousTarget = 'random_work_area';
        this.continuousDistance = plan.distance;
        // 初次目标已经消耗一次，本轮合计最多取三个目标。
        if (!snapshot.moving && !this.requestNextContinuousIntent(2)) this.stopContinuousMotion();
      } else {
        this.continuousTarget = null;
        if (!snapshot.moving) { this.currentMotionTarget = null; this.currentMotionSource = null; }
      }
      this.publishActivityChanged();
    } finally {
      // 同步回调会推进墙钟；以实际 Motion 修订收口本轮，下一真实 tick 才开启新尝试。
      this.lastContinuousAttemptRevision = plan.mode === 'continuous' ? this.options.motion.getSnapshot().revision : -1;
      this.committingMotion = false;
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
    this.continuousTarget = null;
    this.continuousDistance = 'none';
    this.currentMotionTarget = null;
    this.currentMotionSource = null;
    this.lastSpatialTarget = null;
    this.motionWasMoving = false;
    this.movementPlaybackToken = null;
    this.movementPlaybackCycle = null;
    this.options.motion.stop();
    this.options.behavior.releasePreparedActivity();
  }

  /** 生命周期仅撤销本 Director 发起的连续计划，不打断无关的用户位置。 */
  private clearContinuousMotion(): void {
    if (
      this.continuousTarget !== null
      || this.currentMotionTarget !== null
    ) {
      this.stopContinuousMotion();
    }
  }

  /** 连续到达不得穿透拖拽、可信任务、确认或更高优先级播放。 */
  private hasContinuousBlocker(): boolean {
    return this.closed
      || this.automaticMovementFailureLifecycle === this.behaviorLifecycleGeneration
      || this.pendingMotion !== null
      || this.committingMotion
      || this.movementModeTransitionPending
      || this.dragging
      || this.trustedRuntimeBlocked
      || this.capabilityTask
      || this.awaitingConfirmation
      || this.options.behavior.hasActiveSingleEpisode()
      || this.restingBackgroundState() !== null
      || this.active?.source === 'explicit';
  }

  private hasIntermittentBlocker(): boolean {
    return this.closed
      || this.automaticMovementFailureLifecycle === this.behaviorLifecycleGeneration
      || this.pendingMotion !== null
      || this.movementModeTransitionPending
      || this.dragging
      || this.trustedRuntimeBlocked
      || this.capabilityTask
      || this.awaitingConfirmation
      || this.options.behavior.hasActiveSingleEpisode()
      || this.restingBackgroundState() !== null
      || this.options.motion.getSnapshot().moving
      || this.active?.source === 'explicit';
  }

  /** 最多重采样三次；只有新目标形成有效运动才等待下一到达边沿。 */
  private requestNextContinuousIntent(attempts = 3): boolean {
    if (this.continuousTarget === null) return false;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (this.continuousTarget === null) return false;
      const motionSnapshot = this.options.motion.requestIntent(
        this.motionIntentFor(this.continuousTarget, this.continuousDistance)
      );
      if (motionSnapshot === null || this.continuousTarget === null) return false;
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
