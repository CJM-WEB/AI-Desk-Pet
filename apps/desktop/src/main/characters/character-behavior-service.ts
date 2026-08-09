import { randomUUID } from 'node:crypto';
import {
  CharacterBehaviorEngine,
  type CharacterAgentBehaviorIntent,
  type CharacterBehaviorDecision,
  type CharacterBehaviorSignal,
  type CharacterHabitatPresentationFact,
  type CharacterManifestV1,
  type CharacterManifestV2,
  type CharacterPlaybackFeedback,
  resolveCharacterPresentation
} from '@myself/character-runtime';
import type { TaskEvent } from '@myself/shared-types';
import type { CharacterMotionSnapshot } from '../../shared/character-motion-ipc';
import type { CharacterMotionService } from './character-motion-service';
import type { CharacterStore } from './character-store';

export type CharacterBehaviorPlaybackEvent =
  | {
      type: 'behavior-authority';
      characterId: string;
      mode: 'legacy-v1';
    }
  | {
      type: 'behavior-action';
      revision: number;
      stateId: string;
      modifierStateIds: string[];
      actionId: string;
      playbackToken: string;
      commitFrameId?: string;
    }
  | {
      type: 'idle-action';
      revision: number;
      actionId: string;
      playbackToken: string;
    };

export type CharacterTaskCarryGrant = Readonly<{
  playbackToken: string;
  actionId: string;
  commitFrameId: string | null;
}>;

export type CharacterHabitatPresentationResult = Readonly<{
  status: 'completed' | 'failed' | 'interrupted' | 'timed-out' | 'unavailable';
}>;

type PendingHabitatPresentation = {
  playbackToken: string;
  actionId: string;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (result: CharacterHabitatPresentationResult) => void;
};

type CharacterBehaviorStorePort = Pick<
  CharacterStore,
  'getActiveManifestV2' | 'getActive'
>;

type CharacterBehaviorMotionPort = Pick<
  CharacterMotionService,
  | 'getSnapshot'
  | 'requestIntent'
  | 'applyTaskEvent'
  | 'pollIdle'
  | 'issueIdlePlayback'
  | 'confirmIdlePlayback'
>;

export type CharacterBehaviorServiceOptions = {
  store: CharacterBehaviorStorePort;
  motion: CharacterBehaviorMotionPort;
  now?: () => number;
  random?: () => number;
  createPlaybackToken?: () => string;
  idleIntervalMs?: number;
  playbackStartTimeoutMs?: number;
  reportError?: (code: 'CHARACTER_BEHAVIOR_V2_UNAVAILABLE') => void;
};

const DEFAULT_IDLE_INTERVAL_MS = 10_000;
const HABITAT_PRESENTATION_TIMEOUT_MS = 2_000;

/** Main 独占角色行为决策、调度令牌和运动意图的生产权。 */
export class CharacterBehaviorService {
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly createPlaybackToken: () => string;
  private readonly idleIntervalMs: number;
  private readonly listeners = new Set<(event: CharacterBehaviorPlaybackEvent) => void>();
  private readonly legacyTokens = new Map<string, { actionId: string; characterId: string }>();
  private pendingHabitatPresentation: PendingHabitatPresentation | null = null;
  private engine: CharacterBehaviorEngine | null = null;
  private manifest: CharacterManifestV2 | null = null;
  private legacyManifest: CharacterManifestV1 | null = null;
  private direction: 'left' | 'right' = 'right';
  private moving = false;
  private carrying = false;
  private taskIdleBlocked = false;
  private carryIdleBlocked = false;
  private transitioning = false;
  private activeTaskSignal: 'listening' | 'thinking' | null = null;
  private taskContextSignal: CharacterBehaviorSignal | null = null;
  private nextIdleAt: number;
  private closed = false;
  private loadRevision = 0;

  constructor(private readonly options: CharacterBehaviorServiceOptions) {
    this.now = options.now ?? performance.now.bind(performance);
    this.random = options.random ?? Math.random;
    this.createPlaybackToken = options.createPlaybackToken ?? randomUUID;
    this.idleIntervalMs = options.idleIntervalMs ?? DEFAULT_IDLE_INTERVAL_MS;
    this.nextIdleAt = this.now() + this.idleIntervalMs;
  }

  async initialize(): Promise<void> {
    if (this.closed) return;
    const snapshot = this.options.motion.getSnapshot();
    this.direction = snapshot.direction;
    this.moving = snapshot.moving;
    await this.loadActiveCharacter(false);
  }

  /**
   * 同步取得并发布同一个 Main 调度结果；调用方须在返回后的同一调用栈立即绑定事务。
   * 生产订阅者只会调用 webContents.send，Renderer 的反馈必须跨事件循环返回，因而不会早于绑定。
   */
  beginTaskCarry(): CharacterTaskCarryGrant {
    if (this.closed || this.transitioning || !this.engine || !this.manifest || this.carrying) {
      throw new Error('CHARACTER_BEHAVIOR_CARRY_UNAVAILABLE');
    }
    const decision = this.engine.dispatch({
      signal: { type: 'carrying', active: true, occurredAtMs: this.now() },
      direction: this.direction,
      requiredActionSemantic: 'carry'
    });
    const play = decision.effects.find((effect) => effect.type === 'play');
    if (play?.type !== 'play') throw new Error('CHARACTER_BEHAVIOR_CARRY_UNAVAILABLE');

    const resolved = resolveCharacterPresentation(
      this.manifest,
      decision.snapshot.skinId,
      play.action.actionId
    );
    if (!resolved) throw new Error('CHARACTER_BEHAVIOR_CARRY_UNAVAILABLE');

    const grant: CharacterTaskCarryGrant = {
      playbackToken: play.action.playbackToken,
      actionId: play.action.actionId,
      commitFrameId: resolved.presentation.commitFrameId ?? null
    };
    this.carrying = true;
    this.carryIdleBlocked = true;
    this.publish(decision, grant.commitFrameId);
    return grant;
  }

  /** 结束本地搬运事实；结果语义由后续可信任务事件决定。 */
  endTaskCarry(): void {
    if (this.closed || this.transitioning || !this.engine || !this.carrying) return;
    this.carrying = false;
    this.carryIdleBlocked = false;
    const now = this.now();
    this.nextIdleAt = now + this.idleIntervalMs;
    this.publish(this.engine.dispatch({
      signal: { type: 'carrying', active: false, occurredAtMs: now },
      direction: this.direction
    }));
  }

  /**
   * 将 Main 内部空间事实转为纯表现请求。结果只结算该次播放，
   * 不承载目录、窗口或持久化状态。
   */
  requestHabitatPresentation(
    fact: CharacterHabitatPresentationFact
  ): Promise<CharacterHabitatPresentationResult> {
    if (
      this.closed
      || this.transitioning
      || !this.engine
      || (fact !== 'enter' && fact !== 'found' && fact !== 'lost')
    ) {
      return Promise.resolve({ status: 'unavailable' });
    }

    const decision = this.engine.dispatchHabitatPresentation({
      fact,
      occurredAtMs: this.now(),
      direction: this.direction
    });
    const play = decision.effects.find((effect) => effect.type === 'play');
    if (play?.type !== 'play') {
      this.publish(decision, null, false);
      return Promise.resolve({ status: 'unavailable' });
    }

    // 新的空间表现可替换旧请求，但两者的令牌和结算必须完全隔离。
    this.settleInterruptedEffects(decision);
    return new Promise<CharacterHabitatPresentationResult>((resolve) => {
      const pending: PendingHabitatPresentation = {
        playbackToken: play.action.playbackToken,
        actionId: play.action.actionId,
        timeout: setTimeout(() => {
          if (this.pendingHabitatPresentation === pending && this.engine) {
            // 先在引擎撤销精确令牌，再结算等待；迟到反馈不得重新启动表现。
            try {
              this.engine.cancelPresentation({
                playbackToken: pending.playbackToken,
                actionId: pending.actionId,
                occurredAtMs: this.now()
              });
            } catch {
              // 令牌若已被其他本地事件撤销，同样按超时结算本次等待。
            }
          }
          this.settleHabitatPresentation('timed-out', pending);
        }, HABITAT_PRESENTATION_TIMEOUT_MS),
        resolve
      };
      this.pendingHabitatPresentation = pending;
      // move 只是 hide 的受控表现回退，不得因此请求桌面漫步。
      this.publish(decision, null, false);
    });
  }

  /** 只向引擎提交已隐藏事实，不等待或完成任何表现。 */
  handleHabitatHidden(): void {
    if (this.closed || this.transitioning || !this.engine) return;
    this.publish(this.engine.recordHabitatHidden(this.now()), null, false);
  }

  handleTaskEvent(event: TaskEvent): void {
    if (this.closed) return;
    this.options.motion.applyTaskEvent(event);
    const now = this.now();
    if (
      event.type === 'pending_action'
      || (event.type === 'phase' && (
        event.phase === 'listening'
        || event.phase === 'thinking'
        || event.phase === 'awaiting_confirmation'
        || event.phase === 'acting'
      ))
    ) {
      this.interruptHabitatPresentation();
    }
    if (this.transitioning) {
      this.captureTaskContext(event, now);
      return;
    }
    if (event.type === 'pending_action') {
      this.taskIdleBlocked = true;
      return;
    }
    if (event.type !== 'phase') return;

    if (event.phase === 'idle' || event.phase === 'cancelled') {
      this.taskContextSignal = null;
      this.deactivateTaskSignal(now);
      this.taskIdleBlocked = false;
      this.nextIdleAt = now + this.idleIntervalMs;
      this.restoreDefaultPlayback(now);
      return;
    }
    if (event.phase === 'awaiting_confirmation' || event.phase === 'acting') {
      this.taskContextSignal = null;
      this.deactivateTaskSignal(now);
      this.taskIdleBlocked = true;
      return;
    }

    this.taskIdleBlocked = event.phase === 'listening' || event.phase === 'thinking';
    this.nextIdleAt = now + this.idleIntervalMs;
    if (event.phase === 'listening' || event.phase === 'thinking') {
      this.deactivateTaskSignal(now);
      this.activeTaskSignal = event.phase;
      this.taskContextSignal = {
        type: event.phase,
        active: true,
        occurredAtMs: now
      };
      this.dispatch({ type: event.phase, active: true, occurredAtMs: now });
      return;
    }

    this.deactivateTaskSignal(now);
    this.taskContextSignal = {
      type: 'task',
      phase: event.phase === 'success' ? 'success' : 'failure',
      occurredAtMs: now
    };
    this.dispatch(this.taskContextSignal);
  }

  handleAgentIntent(intent: CharacterAgentBehaviorIntent): void {
    if (this.closed || this.transitioning || !this.engine) return;
    const now = this.now();
    this.interruptHabitatPresentation();
    // Agent 意图在思考结束后参与决策；先撤销本地思考事实，仍由引擎校验可推断状态。
    this.deactivateTaskSignal(now);
    this.taskContextSignal = null;
    this.dispatch({ type: 'task', phase: 'start', occurredAtMs: now }, intent);
  }

  handleMovement(snapshot: CharacterMotionSnapshot): void {
    if (this.closed) return;
    this.direction = snapshot.direction;
    if (!this.transitioning) this.engine?.updateDirection(snapshot.direction);
    if (snapshot.moving === this.moving) return;
    this.moving = snapshot.moving;
    const now = this.now();
    this.nextIdleAt = now + this.idleIntervalMs;
    if (this.transitioning) return;
    this.dispatch({
      type: 'movement',
      active: snapshot.moving,
      occurredAtMs: now
    });
  }

  handleUserInteraction(): void {
    if (this.closed) return;
    const now = this.now();
    this.nextIdleAt = now + this.idleIntervalMs;
    this.interruptHabitatPresentation();
    this.dispatch({ type: 'user-interaction', occurredAtMs: now });
  }

  handleIdleDue(): void {
    if (this.closed) return;
    if (!this.transitioning && this.engine) this.publish(this.engine.advance());
    if (this.transitioning || this.taskIdleBlocked || this.carryIdleBlocked || this.moving) return;
    const now = this.now();
    if (now < this.nextIdleAt) return;
    this.nextIdleAt = now + this.idleIntervalMs;

    if (this.engine) {
      this.dispatch({ type: 'idle-due', occurredAtMs: now });
      return;
    }
    this.pollLegacyIdle();
  }

  applyPlaybackFeedback(feedback: CharacterPlaybackFeedback): void {
    if (this.closed) return;
    if (this.transitioning) throw new Error('CHARACTER_PLAYBACK_UNAUTHORIZED');
    if (this.engine) {
      const pending = this.pendingHabitatPresentation;
      const decision = this.engine.applyFeedback(feedback);
      this.publish(decision);
      if (
        pending
        && pending.playbackToken === feedback.playbackToken
        && pending.actionId === feedback.actionId
        && feedback.status !== 'started'
      ) {
        this.settleHabitatPresentation(feedback.status, pending);
      }
      return;
    }
    const pending = this.legacyTokens.get(feedback.playbackToken);
    if (!pending || pending.actionId !== feedback.actionId) {
      throw new Error('CHARACTER_PLAYBACK_UNAUTHORIZED');
    }
    if (feedback.status !== 'started') return;
    this.options.motion.confirmIdlePlayback({
      playbackToken: feedback.playbackToken,
      actionId: feedback.actionId,
      characterId: pending.characterId
    });
    this.legacyTokens.delete(feedback.playbackToken);
  }

  handleActiveCharacterChanged(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.interruptHabitatPresentation();
    return this.loadActiveCharacter(true);
  }

  subscribe(listener: (event: CharacterBehaviorPlaybackEvent) => void): () => void {
    if (this.closed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.interruptHabitatPresentation();
    this.closed = true;
    this.loadRevision += 1;
    this.engine = null;
    this.manifest = null;
    this.legacyManifest = null;
    this.transitioning = false;
    this.activeTaskSignal = null;
    this.taskContextSignal = null;
    this.carrying = false;
    this.taskIdleBlocked = false;
    this.carryIdleBlocked = false;
    this.legacyTokens.clear();
    this.listeners.clear();
  }

  /** 先完整读取候选清单，成功后才替换当前引擎和令牌。 */
  private async loadActiveCharacter(replacing: boolean): Promise<void> {
    const revision = ++this.loadRevision;
    // 已结束任务的结果只属于旧角色；切换期间新到达的事件仍会由 captureTaskContext 接管。
    if (replacing) {
      this.carrying = false;
      this.carryIdleBlocked = false;
      if (this.taskContextSignal?.type === 'task') this.taskContextSignal = null;
    }
    this.transitioning = true;
    try {
      const manifest = await this.options.store.getActiveManifestV2();
      if (this.closed || revision !== this.loadRevision) return;
      const previous = this.engine;
      let nextEngine: CharacterBehaviorEngine;
      let decision: CharacterBehaviorDecision;
      const contextSignals = this.currentContextSignals();
      if (replacing && previous) {
        nextEngine = previous;
        decision = previous.replaceCharacter(
          manifest,
          manifest.defaultSkinId,
          contextSignals,
          this.direction
        );
      } else {
        nextEngine = new CharacterBehaviorEngine({
          manifest,
          skinId: manifest.defaultSkinId,
          now: this.now,
          random: this.random,
          createPlaybackToken: this.createPlaybackToken,
          ...(this.options.playbackStartTimeoutMs === undefined
            ? {}
            : { startConfirmationTimeoutMs: this.options.playbackStartTimeoutMs })
        });
        decision = nextEngine.dispatchContext({
          signals: contextSignals,
          direction: this.direction
        });
      }

      // 候选角色完整就绪后再一次性提交，切换窗口内旧引擎始终不可决策。
      this.manifest = manifest;
      this.legacyManifest = null;
      this.legacyTokens.clear();
      this.engine = nextEngine;
      this.transitioning = false;
      this.publish(decision);
      this.nextIdleAt = this.now() + this.idleIntervalMs;
    } catch {
      if (this.closed || revision !== this.loadRevision) return;
      this.options.reportError?.('CHARACTER_BEHAVIOR_V2_UNAVAILABLE');
      await this.activateLegacyFallback(revision);
    }
  }

  /** V2 不可用时显式交接 V1 权威，但不由 Main 伪造具体待机动作。 */
  private async activateLegacyFallback(revision: number): Promise<void> {
    try {
      const legacyManifest = await this.options.store.getActive();
      if (this.closed || revision !== this.loadRevision) return;
      this.engine = null;
      this.manifest = null;
      this.legacyManifest = legacyManifest;
      this.legacyTokens.clear();
      this.transitioning = false;
      this.nextIdleAt = this.now() + this.idleIntervalMs;
      this.emit({
        type: 'behavior-authority',
        characterId: legacyManifest.id,
        mode: 'legacy-v1'
      });
    } catch {
      // 保留播放画面，但撤销旧角色的 Main 决策权，避免切换后继续生成旧动作。
      this.engine = null;
      this.manifest = null;
      this.legacyManifest = null;
      this.legacyTokens.clear();
      this.transitioning = false;
    }
  }

  /** 切换窗口内只记录最新可信任务事实，不允许旧引擎消费任何边沿。 */
  private captureTaskContext(event: TaskEvent, occurredAtMs: number): void {
    if (event.type === 'pending_action') {
      this.taskIdleBlocked = true;
      return;
    }
    if (event.type !== 'phase') return;
    if (event.phase === 'idle' || event.phase === 'cancelled') {
      this.activeTaskSignal = null;
      this.taskContextSignal = null;
      this.taskIdleBlocked = false;
      this.nextIdleAt = occurredAtMs + this.idleIntervalMs;
      return;
    }
    if (event.phase === 'awaiting_confirmation' || event.phase === 'acting') {
      this.activeTaskSignal = null;
      this.taskContextSignal = null;
      this.taskIdleBlocked = true;
      return;
    }
    this.taskIdleBlocked = event.phase === 'listening' || event.phase === 'thinking';
    this.nextIdleAt = occurredAtMs + this.idleIntervalMs;
    if (event.phase === 'listening' || event.phase === 'thinking') {
      this.activeTaskSignal = event.phase;
      this.taskContextSignal = {
        type: event.phase,
        active: true,
        occurredAtMs
      };
      return;
    }
    this.activeTaskSignal = null;
    this.taskContextSignal = {
      type: 'task',
      phase: event.phase === 'success' ? 'success' : 'failure',
      occurredAtMs
    };
  }

  /** 新引擎一次性接收当前运动与任务上下文，之后才允许创建首个播放令牌。 */
  private currentContextSignals(): CharacterBehaviorSignal[] {
    const signals: CharacterBehaviorSignal[] = [];
    if (this.moving) {
      signals.push({ type: 'movement', active: true, occurredAtMs: this.now() });
    }
    if (this.taskContextSignal) signals.push({ ...this.taskContextSignal });
    return signals;
  }

  private deactivateTaskSignal(occurredAtMs: number): void {
    const activeTaskSignal = this.activeTaskSignal;
    this.activeTaskSignal = null;
    if (!activeTaskSignal || !this.engine || this.transitioning) return;

    // 停用也可能重排动作，必须同步发布，避免内部令牌领先于播放器。
    this.publish(this.engine.dispatch({
      signal: { type: activeTaskSignal, active: false, occurredAtMs },
      direction: this.direction
    }));
  }

  private restoreDefaultPlayback(occurredAtMs: number): void {
    if (!this.engine || this.transitioning) return;
    const decision = this.engine.dispatch({
      signal: { type: 'idle-due', occurredAtMs },
      direction: this.direction
    });
    this.publish(decision);

    const current = decision.snapshot.schedule.current;
    const currentAction = this.manifest?.actions.find((action) => action.id === current?.actionId);
    const defaultWasBlocked = current
      && currentAction?.semantic !== decision.snapshot.state.desiredActionSemantic
      && !decision.effects.some((effect) => effect.type === 'play');
    if (!defaultWasBlocked) return;

    // user-interaction 是既有的中性强制边沿；此时主状态已是默认态，只负责替换抗中断动作。
    this.publish(this.engine.dispatch({
      signal: { type: 'user-interaction', occurredAtMs },
      direction: this.direction
    }));
  }

  private dispatch(
    signal: CharacterBehaviorSignal,
    agentIntent?: CharacterAgentBehaviorIntent
  ): void {
    if (!this.engine || this.transitioning) return;
    this.publish(this.engine.dispatch({
      signal,
      direction: this.direction,
      ...(agentIntent === undefined ? {} : { agentIntent })
    }));
  }

  /** 只把已通过调度器的 play effect 转为 Main 播放事件。 */
  private publish(
    decision: CharacterBehaviorDecision,
    commitFrameId: string | null = null,
    requestMovementIntent = true
  ): void {
    this.settleInterruptedEffects(decision);
    for (const effect of decision.effects) {
      if (effect.type !== 'play') continue;
      const event: CharacterBehaviorPlaybackEvent = {
        type: 'behavior-action',
        revision: decision.snapshot.schedule.revision,
        stateId: effect.action.stateId,
        modifierStateIds: [...decision.snapshot.state.modifierStateIds],
        actionId: effect.action.actionId,
        playbackToken: effect.action.playbackToken,
        ...(commitFrameId === null ? {} : { commitFrameId })
      };
      const action = this.manifest?.actions.find(
        candidate => candidate.id === effect.action.actionId
      );
      if (requestMovementIntent && action?.semantic === 'move') {
        this.options.motion.requestIntent('wander');
      }
      this.emit(event);
    }
  }

  /** 任何可信本地事件替换了当前令牌时，只结算匹配的表现等待。 */
  private settleInterruptedEffects(decision: CharacterBehaviorDecision): void {
    const pending = this.pendingHabitatPresentation;
    if (!pending) return;
    if (decision.effects.some((effect) => (
      effect.type === 'interrupt' && effect.playbackToken === pending.playbackToken
    ))) {
      this.settleHabitatPresentation('interrupted', pending);
    }
  }

  /** 主动中断同时撤销引擎令牌，确保迟到反馈不能复活旧表现。 */
  private interruptHabitatPresentation(): void {
    const pending = this.pendingHabitatPresentation;
    if (!pending) return;
    if (this.engine) {
      try {
        this.engine.cancelPresentation({
          playbackToken: pending.playbackToken,
          actionId: pending.actionId,
          occurredAtMs: this.now()
        });
      } catch {
        // 当前调度若已更换，旧令牌已自然失效，只需结算本地等待。
      }
    }
    this.settleHabitatPresentation('interrupted', pending);
  }

  /** 带对象身份的一次性结算，迟到超时器不能结算后续请求。 */
  private settleHabitatPresentation(
    status: Exclude<CharacterHabitatPresentationResult['status'], 'unavailable'>,
    expected: PendingHabitatPresentation | null = this.pendingHabitatPresentation
  ): void {
    const pending = this.pendingHabitatPresentation;
    if (!pending || !expected || pending !== expected) return;
    this.pendingHabitatPresentation = null;
    clearTimeout(pending.timeout);
    pending.resolve({ status });
  }

  private pollLegacyIdle(): void {
    const manifest = this.legacyManifest;
    if (!manifest) return;
    const selection = this.options.motion.pollIdle(manifest, this.direction, this.random);
    if (!selection) return;
    this.options.motion.requestIntent('wander');
    const snapshot = this.options.motion.getSnapshot();
    const playbackToken = this.options.motion.issueIdlePlayback({
      actionId: selection.action.id,
      characterId: manifest.id,
      revision: snapshot.revision
    });
    this.legacyTokens.set(playbackToken, {
      actionId: selection.action.id,
      characterId: manifest.id
    });
    this.emit({
      type: 'idle-action',
      revision: snapshot.revision,
      actionId: selection.action.id,
      playbackToken
    });
  }

  private emit(event: CharacterBehaviorPlaybackEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // 单个播放观察者失败不得改变 Main 已提交的行为决策。
      }
    }
  }
}
