import { randomUUID } from 'node:crypto';
import {
  CharacterBehaviorEngine,
  type CharacterAgentBehaviorIntent,
  type CharacterBehaviorDecision,
  type CharacterBehaviorSignal,
  type CharacterManifestV1,
  type CharacterManifestV2,
  type CharacterPlaybackFeedback
} from '@myself/character-runtime';
import type { TaskEvent } from '@myself/shared-types';
import type { CharacterMotionSnapshot } from '../../shared/character-motion-ipc';
import type { CharacterMotionService } from './character-motion-service';
import type { CharacterStore } from './character-store';

export type CharacterBehaviorPlaybackEvent =
  | {
      type: 'behavior-action';
      revision: number;
      stateId: string;
      actionId: string;
      playbackToken: string;
    }
  | {
      type: 'idle-action';
      revision: number;
      actionId: string;
      playbackToken: string;
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
  reportError?: (code: 'CHARACTER_BEHAVIOR_V2_UNAVAILABLE') => void;
};

const DEFAULT_IDLE_INTERVAL_MS = 10_000;

/** Main 独占角色行为决策、调度令牌和运动意图的生产权。 */
export class CharacterBehaviorService {
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly createPlaybackToken: () => string;
  private readonly idleIntervalMs: number;
  private readonly listeners = new Set<(event: CharacterBehaviorPlaybackEvent) => void>();
  private readonly legacyTokens = new Map<string, { actionId: string; characterId: string }>();
  private engine: CharacterBehaviorEngine | null = null;
  private manifest: CharacterManifestV2 | null = null;
  private legacyManifest: CharacterManifestV1 | null = null;
  private direction: 'left' | 'right' = 'right';
  private moving = false;
  private idleBlocked = false;
  private transitioning = false;
  private activeTaskSignal: 'listening' | 'thinking' | null = null;
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

  handleTaskEvent(event: TaskEvent): void {
    if (this.closed) return;
    this.options.motion.applyTaskEvent(event);
    if (this.transitioning) return;
    if (event.type === 'pending_action') {
      this.idleBlocked = true;
      return;
    }
    if (event.type !== 'phase') return;

    const now = this.now();
    if (event.phase === 'idle' || event.phase === 'cancelled') {
      this.deactivateTaskSignal(now);
      this.idleBlocked = false;
      this.nextIdleAt = now + this.idleIntervalMs;
      this.restoreDefaultPlayback(now);
      return;
    }
    if (event.phase === 'awaiting_confirmation' || event.phase === 'acting') {
      this.deactivateTaskSignal(now);
      this.idleBlocked = true;
      return;
    }

    this.idleBlocked = event.phase === 'listening' || event.phase === 'thinking';
    this.nextIdleAt = now + this.idleIntervalMs;
    if (event.phase === 'listening' || event.phase === 'thinking') {
      this.deactivateTaskSignal(now);
      this.activeTaskSignal = event.phase;
      this.dispatch({ type: event.phase, active: true, occurredAtMs: now });
      return;
    }

    this.deactivateTaskSignal(now);
    this.dispatch({
      type: 'task',
      phase: event.phase === 'success' ? 'success' : 'failure',
      occurredAtMs: now
    });
  }

  handleAgentIntent(intent: CharacterAgentBehaviorIntent): void {
    if (this.closed || this.transitioning || !this.engine) return;
    this.dispatch({ type: 'task', phase: 'start', occurredAtMs: this.now() }, intent);
  }

  handleMovement(snapshot: CharacterMotionSnapshot): void {
    if (this.closed) return;
    this.direction = snapshot.direction;
    if (snapshot.moving === this.moving) return;
    this.moving = snapshot.moving;
    const now = this.now();
    this.nextIdleAt = now + this.idleIntervalMs;
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
    this.dispatch({ type: 'user-interaction', occurredAtMs: now });
  }

  handleIdleDue(): void {
    if (this.closed || this.transitioning || this.idleBlocked || this.moving) return;
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
      this.publish(this.engine.applyFeedback(feedback));
      return;
    }
    if (feedback.status !== 'started') return;
    const pending = this.legacyTokens.get(feedback.playbackToken);
    if (!pending || pending.actionId !== feedback.actionId) {
      throw new Error('CHARACTER_PLAYBACK_UNAUTHORIZED');
    }
    this.options.motion.confirmIdlePlayback({
      playbackToken: feedback.playbackToken,
      actionId: feedback.actionId,
      characterId: pending.characterId
    });
    this.legacyTokens.delete(feedback.playbackToken);
  }

  handleActiveCharacterChanged(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.loadActiveCharacter(true);
  }

  subscribe(listener: (event: CharacterBehaviorPlaybackEvent) => void): () => void {
    if (this.closed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.loadRevision += 1;
    this.engine = null;
    this.manifest = null;
    this.legacyManifest = null;
    this.transitioning = false;
    this.activeTaskSignal = null;
    this.legacyTokens.clear();
    this.listeners.clear();
  }

  /** 先完整读取候选清单，成功后才替换当前引擎和令牌。 */
  private async loadActiveCharacter(replacing: boolean): Promise<void> {
    const revision = ++this.loadRevision;
    this.transitioning = true;
    this.activeTaskSignal = null;
    try {
      const manifest = await this.options.store.getActiveManifestV2();
      if (this.closed || revision !== this.loadRevision) return;
      const previous = this.engine;
      let nextEngine: CharacterBehaviorEngine;
      let decision: CharacterBehaviorDecision;
      if (replacing && previous) {
        nextEngine = previous;
        decision = previous.replaceCharacter(manifest, manifest.defaultSkinId);
      } else {
        nextEngine = new CharacterBehaviorEngine({
          manifest,
          skinId: manifest.defaultSkinId,
          now: this.now,
          random: this.random,
          createPlaybackToken: this.createPlaybackToken
        });
        decision = nextEngine.dispatch({
          signal: { type: 'idle-due', occurredAtMs: this.now() },
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

  /** V2 不可用时仅恢复现有 V1 待机路径，不发出中断旧播放的事件。 */
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
    } catch {
      // 保留播放画面，但撤销旧角色的 Main 决策权，避免切换后继续生成旧动作。
      this.engine = null;
      this.manifest = null;
      this.legacyManifest = null;
      this.legacyTokens.clear();
      this.transitioning = false;
    }
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
    const defaultWasBlocked = current
      && current.stateId !== decision.snapshot.state.primaryStateId
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
  private publish(decision: CharacterBehaviorDecision): void {
    for (const effect of decision.effects) {
      if (effect.type !== 'play') continue;
      const event: CharacterBehaviorPlaybackEvent = {
        type: 'behavior-action',
        revision: decision.snapshot.schedule.revision,
        stateId: effect.action.stateId,
        actionId: effect.action.actionId,
        playbackToken: effect.action.playbackToken
      };
      const action = this.manifest?.actions.find(
        candidate => candidate.id === effect.action.actionId
      );
      if (action?.semantic === 'move') this.options.motion.requestIntent('wander');
      this.emit(event);
    }
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
