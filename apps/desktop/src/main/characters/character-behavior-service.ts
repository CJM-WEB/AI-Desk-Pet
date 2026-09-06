import { randomUUID } from 'node:crypto';
import {
  CharacterExpressionEngine, createPublicBehaviorCatalog, resolveBehaviorTarget, resolveCharacterPresentationV3,
  type BehaviorTarget, type CharacterAgentBehaviorIntent, type CharacterBehaviorPlan,
  type CharacterExpressionContext, type CharacterExpressionDecision, type CharacterExpressionResult,
  type CharacterManifestV3, type CharacterPlaybackFeedback, type PublicBehaviorCatalog,
  type CharacterExpressionTarget, type TrustedCharacterEventV3
} from '@myself/character-runtime';
import type { TaskEvent } from '@myself/shared-types';
import type { CharacterMotionSnapshot } from '../../shared/character-motion-ipc';
import type { CharacterMotionService } from './character-motion-service';
import type { CharacterStore } from './character-store';

/** 展示授权仅证明已调度合法 ID 对，不赋予移动、文件或系统能力。 */
export type CharacterExpressionAuthorization =
  | Readonly<{ kind: 'play'; stateId: string; actionId: string; playbackToken: string }>
  | Readonly<{ kind: 'none'; diagnosticCode?: 'CHARACTER_ACTION_UNAVAILABLE' }>;
export type CharacterBehaviorPlaybackEvent =
  | { type: 'behavior-interrupt'; playbackToken: string }
  | { type: 'behavior-action'; revision: number; stateId: string; actionId: string; playbackToken: string;
      playback: { mode: 'once' | 'loop' | 'static'; durationMs: number | null }; commitFrameId?: string };
export type CharacterGeometryBinding = Readonly<{
  generation: number; manifest: CharacterManifestV3; skinId: string; actionId: string;
  actionRevision: number; resourceRevision: string; direction: 'left' | 'right';
}>;
export type CharacterBehaviorServiceOptions = {
  store: Pick<CharacterStore, 'getActiveManifestV3'>;
  motion: Pick<CharacterMotionService, 'getSnapshot' | 'requestIntent' | 'applyTaskEvent'>;
  now?: () => number; random?: () => number; createPlaybackToken?: () => string;
  reportError?: (code: 'CHARACTER_BEHAVIOR_V3_UNAVAILABLE') => void;
};
const NONE: CharacterExpressionAuthorization = { kind: 'none' };

/** 可信业务阶段仅用于运行阻塞，不把统一聊天 phase 猜成文件任务成功事实。 */
export function characterTaskRuntimeBlock(event: TaskEvent): boolean | null {
  if (event.type !== 'phase') return null;
  return ['listening', 'thinking', 'awaiting_confirmation', 'acting'].includes(event.phase);
}

/** Main 唯一表达引擎宿主：负责角色寿命、真实事件和播放令牌边界。 */
export class CharacterBehaviorService {
  private readonly now: () => number;
  private readonly listeners = new Set<(event: CharacterBehaviorPlaybackEvent) => void>();
  private readonly recentPublicActions: string[] = [];
  private engine: CharacterExpressionEngine | null = null;
  private manifest: CharacterManifestV3 | null = null;
  private direction: 'left' | 'right' = 'right';
  private moving = false;
  private closed = false;
  private transitioning = false;
  private loadRevision = 0;
  private serial = 0;
  private geometryBindingKey: string | null = null;
  private geometryBindingGeneration = 0;

  constructor(private readonly options: CharacterBehaviorServiceOptions) {
    this.now = options.now ?? performance.now.bind(performance);
  }
  async initialize(): Promise<void> {
    if (this.closed) return;
    const motion = this.options.motion.getSnapshot();
    this.direction = motion.direction; this.moving = motion.moving;
    await this.loadActiveCharacter();
  }
  getPublicBehaviorCatalog(): PublicBehaviorCatalog {
    if (this.closed || this.transitioning || !this.manifest || !this.engine) throw new Error('CHARACTER_ACTION_UNAVAILABLE');
    return createPublicBehaviorCatalog(this.manifest, this.engine.snapshot().skinId);
  }
  getRecentPublicActions(): readonly string[] { return [...this.recentPublicActions]; }
  getGeometryBinding(): CharacterGeometryBinding | null {
    if (this.closed || this.transitioning || !this.manifest || !this.engine) return null;
    const snapshot = this.engine.snapshot();
    const current = snapshot.schedule.current;
    if (!current) return null;
    const resolved = resolveCharacterPresentationV3(this.manifest, snapshot.skinId, current.stateId, current.actionId);
    if (!resolved) return null;
    const resourceRevision = resolved.presentation.geometry.resourceRevision;
    const key = JSON.stringify([this.loadRevision, resolved.skinId, current.actionId, snapshot.schedule.revision, resourceRevision, this.direction]);
    if (key !== this.geometryBindingKey) { this.geometryBindingKey = key; this.geometryBindingGeneration++; }
    return Object.freeze({ generation: this.geometryBindingGeneration, manifest: this.manifest,
      skinId: resolved.skinId, actionId: current.actionId, actionRevision: snapshot.schedule.revision, resourceRevision, direction: this.direction });
  }
  resolveBehaviorTarget(target: BehaviorTarget): CharacterExpressionTarget {
    if (this.closed || this.transitioning || !this.manifest || !this.engine) throw new Error('CHARACTER_ACTION_UNAVAILABLE');
    return resolveBehaviorTarget(this.manifest, this.engine.snapshot().skinId, target);
  }
  resolveBehaviorStatePlan(plan: Extract<CharacterBehaviorPlan, { kind: 'play_state' }>): CharacterExpressionTarget {
    if (this.closed || this.transitioning || !this.manifest || !this.engine) throw new Error('CHARACTER_ACTION_UNAVAILABLE');
    return resolveBehaviorTarget(this.manifest, this.engine.snapshot().skinId, plan);
  }
  requestDirectedBehavior(target: CharacterExpressionTarget, _options: Readonly<{ urgency?: number; systemForced?: boolean }> = {}): CharacterExpressionAuthorization {
    if (this.closed || this.transitioning || !this.engine) return NONE;
    if (target.kind === 'state') return this.publish(this.engine.playExplicit(target.stateId));
    if (target.kind === 'state_action') return this.publish(this.engine.playExplicit(target.stateId, target.actionId));
    return NONE;
  }
  requestProactiveBehavior(target: BehaviorTarget, options: Readonly<{ urgency?: number; allowMovement?: boolean }> = {}): CharacterExpressionAuthorization {
    try { return this.requestDirectedBehavior(this.resolveBehaviorTarget(target), options); }
    catch { return NONE; }
  }
  /** 旧能力意图只接纳明确状态 ID，旧 semantic 不能扩大或推断 V3 表达含义。 */
  handleAgentIntent(intent: CharacterAgentBehaviorIntent): CharacterExpressionAuthorization {
    const state = intent.stateIntent;
    return state && 'stateId' in state ? this.requestDirectedBehavior({ kind: 'state', stateId: state.stateId }) : NONE;
  }
  handleTaskEvent(event: TaskEvent, _options: Readonly<{ allowPlayback?: boolean }> = {}): CharacterExpressionAuthorization {
    if (this.closed) return NONE;
    this.options.motion.applyTaskEvent(event);
    // 来源区分将在普通聊天/文件任务接线补齐；此处不制造 task-finished 等边沿。
    return NONE;
  }
  handleMovement(snapshot: CharacterMotionSnapshot): void {
    if (this.closed) return;
    this.direction = snapshot.direction;
    if (snapshot.moving === this.moving) return;
    this.moving = snapshot.moving;
    this.recordTrustedEvent(snapshot.moving ? 'move-start' : 'move-stop');
  }
  handleUserInteraction(): void { this.recordTrustedEvent('user-interaction'); }
  recordTrustedEvent(type: TrustedCharacterEventV3): void {
    if (!this.closed && !this.transitioning && this.engine) this.publish(this.engine.recordEvent({ id: `host-${this.loadRevision}-${++this.serial}`, type, occurredAtMs: this.now() }));
  }
  context(): CharacterExpressionContext | null {
    return this.closed || this.transitioning ? null : this.engine?.context() ?? null;
  }
  applyDecision(decision: CharacterExpressionDecision): CharacterExpressionAuthorization {
    return this.closed || this.transitioning || !this.engine ? NONE : this.publish(this.engine.applyDecision(decision));
  }
  snapshot() { return this.closed || this.transitioning ? null : this.engine?.snapshot() ?? null; }
  cancelStateLifecycle(): void { if (this.engine) this.publish(this.engine.reset()); }
  advance(): readonly string[] {
    if (this.closed || this.transitioning || !this.engine) return [];
    const previous = this.engine.snapshot().schedule.current?.playbackToken;
    const result = this.engine.advance(); this.publish(result);
    return previous && previous !== result.snapshot.schedule.current?.playbackToken ? [previous] : [];
  }
  applyPlaybackFeedback(feedback: CharacterPlaybackFeedback): void {
    if (this.closed) return;
    const current = this.engine?.snapshot().schedule.current;
    if (this.transitioning || !this.engine || !current || current.playbackToken !== feedback.playbackToken
      || current.actionId !== feedback.actionId || feedback.occurredAtMs < current.scheduledAtMs || feedback.occurredAtMs > this.now()) {
      throw new Error('CHARACTER_PLAYBACK_UNAUTHORIZED');
    }
    this.publish(this.engine.applyFeedback(feedback));
    if (feedback.status === 'started') {
      const name = this.manifest?.actions.find(action => action.id === feedback.actionId)?.name;
      if (name && this.recentPublicActions.at(-1) !== name) this.recentPublicActions.push(name);
      if (this.recentPublicActions.length > 4) this.recentPublicActions.shift();
    }
  }
  handleActiveCharacterChanged(): Promise<void> { return this.closed ? Promise.resolve() : this.loadActiveCharacter(); }
  subscribe(listener: (event: CharacterBehaviorPlaybackEvent) => void): () => void {
    if (this.closed) return () => undefined;
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  close(): void {
    if (this.closed) return;
    if (this.engine) this.publish(this.engine.reset());
    this.closed = true; this.loadRevision++; this.engine = null; this.manifest = null;
    this.recentPublicActions.splice(0); this.listeners.clear();
  }
  /** 切换期间撤销旧令牌；候选严格解析成功才启用，不恢复第二套旧运行时。 */
  private async loadActiveCharacter(): Promise<void> {
    const revision = ++this.loadRevision;
    this.transitioning = true;
    if (this.engine) this.publish(this.engine.reset());
    this.engine = null; this.manifest = null; this.recentPublicActions.splice(0);
    try {
      const manifest = await this.options.store.getActiveManifestV3();
      if (this.closed || revision !== this.loadRevision) return;
      const engine = new CharacterExpressionEngine({ manifest, now: this.now,
        random: this.options.random ?? Math.random, createPlaybackToken: this.options.createPlaybackToken ?? randomUUID });
      this.manifest = manifest; this.engine = engine; this.transitioning = false;
      this.publish(engine.advance());
    } catch {
      if (this.closed || revision !== this.loadRevision) return;
      this.transitioning = false; this.options.reportError?.('CHARACTER_BEHAVIOR_V3_UNAVAILABLE');
    }
  }
  private publish(result: CharacterExpressionResult): CharacterExpressionAuthorization {
    let authorization = NONE;
    for (const effect of result.effects) {
      if (effect.type === 'interrupt') this.emit({ type: 'behavior-interrupt', playbackToken: effect.playbackToken });
      if (effect.type !== 'play') continue;
      authorization = { kind: 'play', stateId: effect.action.stateId, actionId: effect.action.actionId, playbackToken: effect.action.playbackToken };
      const presentation = this.manifest && resolveCharacterPresentationV3(this.manifest, result.snapshot.skinId, effect.action.stateId, effect.action.actionId)?.presentation;
      this.emit({ type: 'behavior-action', revision: result.snapshot.schedule.revision,
        stateId: effect.action.stateId, actionId: effect.action.actionId, playbackToken: effect.action.playbackToken,
        playback: effect.playback, ...(presentation?.commitFrameId ? { commitFrameId: presentation.commitFrameId } : {}) });
    }
    return authorization;
  }
  private emit(event: CharacterBehaviorPlaybackEvent): void {
    for (const listener of [...this.listeners]) { try { listener(event); } catch { /* 观察者失败不改变已提交播放事实。 */ } }
  }
}
