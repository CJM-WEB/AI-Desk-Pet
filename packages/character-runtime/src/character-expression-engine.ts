import { characterManifestV3Schema, type CharacterManifestV3, type CharacterStateDefinitionV3, type TrustedCharacterEventV3 } from './character-v3-schema';
import { resolveCharacterPresentationV3 } from './character-playback-view';
import { characterPlaybackFeedbackSchema, type CharacterPlaybackFeedback } from './behavior-contracts';
import { reduceCharacterActionSchedule, type CharacterBehaviorSchedule, type CharacterScheduleEffect } from './behavior-scheduler';
import { characterMoodUpdateSchema, sampleMood, type CharacterMood, type CharacterMoodSnapshot } from './character-mood';
import { characterExpressionPlanSchema, type CharacterExpressionPlan } from './character-expression-plan';

export type CharacterExpressionContext = Readonly<{ contextRevision: number; moodRevision: number; instance: symbol }>;
export type CharacterExpressionEffect = Exclude<CharacterScheduleEffect, { type: 'play' } | { type: 'none' }>
  | { type: 'play'; action: NonNullable<CharacterBehaviorSchedule['current']>; playback: { mode: 'once' | 'loop' | 'static'; durationMs: number | null } };
export type CharacterExpressionSnapshot = {
  stateId: string; skinId: string; mood: CharacterMoodSnapshot | null; contextRevision: number;
  moodRevision: number; schedule: CharacterBehaviorSchedule; nextEligibleAtMs: number | null;
};
export type CharacterExpressionResult = { snapshot: CharacterExpressionSnapshot; effects: CharacterExpressionEffect[] };
export type CharacterExpressionDecision = {
  context: CharacterExpressionContext; eventId: string; source: 'chat' | 'autonomous';
  moodUpdate?: unknown; expressionPlan?: unknown;
};
export type CharacterExpressionEvent = { id: string; type: TrustedCharacterEventV3; occurredAtMs: number };
export type CharacterExpressionEngineOptions = {
  manifest: CharacterManifestV3; skinId?: string; now: () => number; random?: () => number; createPlaybackToken?: () => string;
};
let nextEngineId = 0;

/** 只管理角色时间、合法 ID 和播放生命周期；宿主独立注入真实事件与时钟。 */
export class CharacterExpressionEngine {
  private manifest: CharacterManifestV3;
  private skinId: string;
  private stateId: string;
  private enteredAtMs: number;
  private mood: CharacterMood | null = null;
  private moodRevision = 0;
  private contextRevision = 0;
  private readonly instance = Symbol('character-expression');
  private readonly engineId = ++nextEngineId;
  private plan: CharacterExpressionPlan | null = null;
  private schedule: CharacterBehaviorSchedule = { revision: 0, current: null, history: [] };
  private readonly events = new Map<string, CharacterExpressionEvent>();
  private readonly consumed = new Set<string>();
  private readonly decisions = new Set<string>();
  private readonly recency = new Map<string, number>();
  private readonly failed = new Set<string>();
  private lastActionId: string | null = null;
  private nextEligibleAtMs: number | null = null;
  private serial = 0;
  private explicit = false;
  private explicitSingleAction = false;
  private explicitDurationMs = 0;
  private explicitUntilMs: number | null = null;
  private staticPlayback = false;
  constructor(private readonly options: CharacterExpressionEngineOptions) {
    this.manifest = characterManifestV3Schema.parse(options.manifest);
    this.skinId = this.validSkin(options.skinId);
    this.stateId = this.manifest.idleStateId;
    this.enteredAtMs = this.now();
  }
  private now(): number { return this.options.now(); }
  private validSkin(skinId?: string): string {
    return this.manifest.skins.some(skin => skin.id === skinId) ? skinId! : this.manifest.defaultSkinId;
  }
  context(): CharacterExpressionContext {
    return Object.freeze({ contextRevision: this.contextRevision, moodRevision: this.moodRevision, instance: this.instance });
  }
  snapshot(): CharacterExpressionSnapshot {
    return { stateId: this.stateId, skinId: this.skinId, mood: sampleMood(this.mood, this.now()),
      contextRevision: this.contextRevision, moodRevision: this.moodRevision,
      schedule: structuredClone(this.schedule), nextEligibleAtMs: this.nextEligibleAtMs };
  }
  private result(effects: CharacterExpressionEffect[] = []): CharacterExpressionResult { return { snapshot: this.snapshot(), effects }; }
  private matches(context: CharacterExpressionContext): boolean {
    return context.instance === this.instance && context.contextRevision === this.contextRevision && context.moodRevision === this.moodRevision;
  }
  /** 合法心情独立接受；配套计划按新修订绑定，非法计划不能保留旧心情的循环。 */
  applyDecision(decision: CharacterExpressionDecision): CharacterExpressionResult {
    if (!this.matches(decision.context) || this.decisions.has(decision.eventId)) return this.result();
    const mood = decision.moodUpdate === undefined ? null : characterMoodUpdateSchema.safeParse(decision.moodUpdate);
    if (mood && !mood.success) return this.result();
    const parsed = decision.expressionPlan === undefined ? null : characterExpressionPlanSchema.safeParse(decision.expressionPlan);
    const legal = parsed?.success && parsed.data.states.every(candidate => {
      const state = this.manifest.states.find(state => state.id === candidate.stateId);
      return state?.agentInferable && candidate.actions.every(action => state.actionIds.includes(action.actionId));
    });
    this.decisions.add(decision.eventId);
    if (this.decisions.size > 1024) this.decisions.delete(this.decisions.values().next().value!);
    let effects: CharacterExpressionEffect[] = [];
    if (mood?.success) {
      this.moodRevision++;
      this.mood = { summary: mood.data.summary, targetStrength: mood.data.strength, startedAtMs: this.now(),
        fadeInMs: mood.data.fadeInMs ?? (decision.source === 'chat' ? 0 : 60_000), halfLifeMs: mood.data.halfLifeMs,
        revision: this.moodRevision, sourceEventId: decision.eventId };
      this.plan = null; this.explicit = false;
      effects = this.stop();
    }
    if (legal && parsed?.success) {
      this.plan = { ...parsed.data, contextRevision: this.contextRevision, moodRevision: this.moodRevision,
        expiresAtMs: this.now() + parsed.data.validForMs };
      this.explicit = false;
    }
    return this.advanceWith(effects, !!mood?.success || !!(legal && parsed?.success && !parsed.data.states.length));
  }
  invalidateContext(): CharacterExpressionResult {
    this.contextRevision++;
    return this.result();
  }
  recordEvent(event: CharacterExpressionEvent): CharacterExpressionResult {
    if (!Number.isFinite(event.occurredAtMs) || event.occurredAtMs > this.now() || this.now() - event.occurredAtMs >= 120_000
      || this.events.has(event.id)) return this.result();
    this.events.set(event.id, { ...event });
    if (this.events.size > 1024) {
      const oldest = this.events.keys().next().value!;
      this.events.delete(oldest); this.consumed.delete(oldest);
    }
    return this.advance();
  }
  private conditionEvents(state: CharacterStateDefinitionV3, exit = false): string[] | null {
    const conditions = exit ? state.exitConditions : state.enterConditions;
    if (!conditions.length) return exit ? null : [];
    const available = [...this.events.values()].filter(event => !this.consumed.has(event.id)
      && this.now() - event.occurredAtMs < 120_000 && (!exit || event.occurredAtMs > this.enteredAtMs));
    const ids: string[] = [];
    for (const condition of conditions) {
      const matches = condition.clauses.map(clause => available.find(event => event.type === clause.event));
      if (condition.mode === 'all' ? matches.some(event => !event) : matches.every(event => !event)) return null;
      ids.push(...matches.flatMap(event => event ? [event.id] : []));
    }
    return ids;
  }
  private stop(): CharacterExpressionEffect[] {
    const current = this.schedule.current;
    if (!current) return [];
    this.schedule = reduceCharacterActionSchedule(this.schedule, { type: 'feedback', nowMs: this.now(),
      feedback: { playbackToken: current.playbackToken, actionId: current.actionId, status: 'interrupted', occurredAtMs: this.now() } }, this.manifest.actions).schedule;
    return [{ type: 'interrupt', playbackToken: current.playbackToken, fallbackActionId: null }];
  }
  private chooseState(force: boolean): string {
    if (this.explicit) return this.stateId;
    const strength = sampleMood(this.mood, this.now())?.strength ?? 0;
    const current = this.manifest.states.find(state => state.id === this.stateId)!;
    const exit = this.conditionEvents(current, true);
    const candidates = this.plan?.states.filter(candidate => candidate.score > 0 && strength >= candidate.minStrength && strength <= candidate.maxStrength
      && !(exit && candidate.stateId === this.stateId)
      && (candidate.stateId === this.stateId || this.conditionEvents(this.manifest.states.find(state => state.id === candidate.stateId)!) !== null)
      && this.manifest.states.find(state => state.id === candidate.stateId)!.actionIds.some(id => this.resolve(candidate.stateId, id))) ?? [];
    if (!force && !exit && candidates.some(candidate => candidate.stateId === this.stateId) && this.now() - this.enteredAtMs < 2_000) return this.stateId;
    candidates.sort((a, b) => (b.score + (b.stateId === this.stateId ? .05 : 0)) - (a.score + (a.stateId === this.stateId ? .05 : 0)));
    return candidates[0]?.stateId ?? this.manifest.idleStateId;
  }
  private resolve(stateId: string, actionId: string) {
    return this.failed.has(actionId) ? null : resolveCharacterPresentationV3(this.manifest, this.skinId, stateId, actionId);
  }
  private chooseAction(stateId: string, explicitActionId?: string): string | null {
    const state = this.manifest.states.find(state => state.id === stateId);
    if (!state) return null;
    const suggestions = this.plan?.states.find(state => state.stateId === stateId)?.actions;
    let candidates = state.actionIds.flatMap(id => {
      const resolved = this.resolve(stateId, id);
      if (!resolved || (explicitActionId && explicitActionId !== id)) return [];
      const last = this.recency.get(id);
      const due = last === undefined ? 0 : last + resolved.action.cooldownMs;
      if (due > this.now()) {
        this.nextEligibleAtMs = Math.min(this.nextEligibleAtMs ?? Infinity, due); return [];
      }
      const score = explicitActionId || !suggestions?.length ? 1 : suggestions.find(action => action.actionId === id)?.score ?? 0;
      return score > 0 ? [{ id, weight: score * resolved.action.preference, suppressed: last !== undefined && this.now() < last + resolved.action.repeatSuppressionMs }] : [];
    });
    if (candidates.some(candidate => !candidate.suppressed)) candidates = candidates.filter(candidate => !candidate.suppressed);
    if (candidates.some(candidate => candidate.id !== this.lastActionId)) candidates = candidates.filter(candidate => candidate.id !== this.lastActionId);
    let pick = Math.max(0, Math.min(.999999, this.options.random?.() ?? .5)) * candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
    for (const candidate of candidates) { pick -= candidate.weight; if (pick < 0) return candidate.id; }
    return null;
  }
  private play(stateId: string, actionId: string, forced: boolean, mode?: 'static'): CharacterExpressionEffect[] {
    const resolved = this.resolve(stateId, actionId);
    if (!resolved) return [];
    const { action, presentation } = resolved;
    const duration = action.durationMs ?? presentation.frames.reduce((sum, frame) => sum + (frame.durationMs ?? 1000 / presentation.fps), 0) / (presentation.playbackRate ?? 1);
    const result = reduceCharacterActionSchedule(this.schedule, { type: 'schedule', selection: { stateId, actionId },
      playbackToken: `expression-${this.engineId}-${++this.serial}-${this.options.createPlaybackToken?.() ?? 'play'}`, nowMs: this.now(),
      startConfirmationTimeoutMs: 5_000, durationMs: duration, urgency: 0, systemForced: forced }, this.manifest.actions);
    if (result.schedule === this.schedule) return [];
    this.schedule = result.schedule;
    // 明确请求的寿命覆盖作者无限循环；反馈和 Main 时钟共用同一个有限时长。
    if (this.explicit && this.schedule.current) {
      this.schedule.current.durationMs = this.explicitUntilMs === null
        ? this.explicitDurationMs : Math.max(0, this.explicitUntilMs - this.now());
    }
    this.staticPlayback = mode === 'static';
    if (mode === 'static' && this.schedule.current) this.schedule.current.durationMs = null;
    if (stateId !== this.stateId) {
      // 只有切态真正提交后才消费退出边沿，等待保持时限或中断策略不会丢事件。
      this.conditionEvents(this.manifest.states.find(state => state.id === this.stateId)!, true)?.forEach(id => this.consumed.add(id));
      this.conditionEvents(this.manifest.states.find(state => state.id === stateId)!)?.forEach(id => this.consumed.add(id));
      this.stateId = stateId; this.enteredAtMs = this.now();
    }
    this.lastActionId = actionId;
    if (!this.staticPlayback) this.recency.set(actionId, this.now());
    return result.effects.flatMap<CharacterExpressionEffect>(effect => effect.type === 'none' ? [] : effect.type === 'play'
      ? [{ ...effect, action: { ...this.schedule.current! }, playback: { mode: mode ?? (this.explicitSingleAction && this.explicit || action.loopPolicy === 'never' ? 'once' : 'loop'), durationMs: this.schedule.current!.durationMs } }]
      : [effect]);
  }
  advance(): CharacterExpressionResult { return this.advanceWith([]); }
  private advanceWith(effects: CharacterExpressionEffect[], force = false): CharacterExpressionResult {
    const now = this.now();
    for (const [id, event] of this.events) if (now - event.occurredAtMs >= 120_000) { this.events.delete(id); this.consumed.delete(id); }
    if (this.mood && !sampleMood(this.mood, now)) { this.mood = null; this.moodRevision++; this.plan = null; force = true; }
    if (this.plan && (now >= this.plan.expiresAtMs || this.plan.moodRevision !== this.moodRevision)) { this.plan = null; force = true; }
    const before = this.schedule.current;
    this.schedule = reduceCharacterActionSchedule(this.schedule, { type: 'expire', nowMs: now }, this.manifest.actions).schedule;
    if (before && !this.schedule.current) effects.push({ type: 'interrupt', playbackToken: before.playbackToken, fallbackActionId: null });
    if (this.explicit && ((this.explicitUntilMs !== null && now >= this.explicitUntilMs)
      || (before && !this.schedule.current && (this.explicitSingleAction || before.startedAtMs === null)))) {
      this.explicit = false; this.explicitUntilMs = null; force = true;
      effects.push(...this.stop());
    }
    const target = this.chooseState(force);
    const staticDue = this.staticPlayback && this.nextEligibleAtMs !== null && now >= this.nextEligibleAtMs;
    const stateDuration = this.manifest.states.find(state => state.id === this.stateId)?.suggestedDurationMs;
    const stateDue = !this.explicit && stateDuration !== undefined && this.schedule.current !== null
      && now - this.schedule.current.scheduledAtMs >= Math.max(2000, stateDuration);
    if (this.schedule.current && target === this.stateId && !force && !staticDue && !stateDue) return this.result(effects);
    // 状态寿命独立于动作寿命；自然结束或完成反馈清空 current 也不能绕过保持时限。
    if (!force && target !== this.stateId && now - this.enteredAtMs < 2_000) return this.result(effects);
    this.nextEligibleAtMs = null;
    const actionId = this.chooseAction(target);
    if (actionId) effects.push(...this.play(target, actionId, force));
    else {
      const idle = this.manifest.idleStateId;
      const idleAction = this.chooseAction(idle);
      if (idleAction) effects.push(...this.play(idle, idleAction, force));
      else if (!this.schedule.current || this.stateId !== idle) {
        const staticAction = this.manifest.states.find(state => state.id === idle)!.actionIds.find(id => this.resolve(idle, id));
        if (staticAction) effects.push(...this.play(idle, staticAction, true, 'static'));
        else { effects.push(...this.stop()); this.stateId = idle; }
      }
    }
    return this.result(effects);
  }
  playExplicit(stateId: string, actionId?: string): CharacterExpressionResult {
    if (!this.manifest.states.some(state => state.id === stateId) || (actionId && !this.resolve(stateId, actionId))) return this.result();
    this.nextEligibleAtMs = null;
    const selected = this.chooseAction(stateId, actionId);
    if (!selected) return this.result();
    const resolved = this.resolve(stateId, selected)!;
    this.invalidateContext(); this.explicit = true; this.explicitSingleAction = actionId !== undefined;
    this.explicitUntilMs = null;
    this.explicitDurationMs = actionId !== undefined
      ? resolved.presentation.frames.reduce((sum, frame) => sum + (frame.durationMs ?? 1000 / resolved.presentation.fps), 0) / (resolved.presentation.playbackRate ?? 1)
      : this.manifest.states.find(state => state.id === stateId)!.suggestedDurationMs ?? 3000;
    return this.result(this.play(stateId, selected, true));
  }
  applyFeedback(feedback: CharacterPlaybackFeedback): CharacterExpressionResult {
    const parsed = characterPlaybackFeedbackSchema.safeParse(feedback);
    const current = this.schedule.current;
    if (!parsed.success || !current || feedback.playbackToken !== current.playbackToken || feedback.actionId !== current.actionId
      || feedback.occurredAtMs < current.scheduledAtMs || feedback.occurredAtMs > this.now()) return this.result();
    try {
      const reduced = reduceCharacterActionSchedule(this.schedule, { type: 'feedback', feedback, nowMs: this.now() }, this.manifest.actions);
      this.schedule = reduced.schedule;
      if (feedback.status === 'started') {
        if (this.explicit && this.explicitUntilMs === null) this.explicitUntilMs = feedback.occurredAtMs + this.explicitDurationMs;
        return this.result();
      }
      this.recency.set(feedback.actionId, this.now());
      if (feedback.status === 'failed') this.failed.add(feedback.actionId);
      if (this.explicit && this.explicitSingleAction && feedback.status === 'completed') {
        this.explicit = false; this.explicitUntilMs = null;
        return this.advanceWith([], true);
      }
      if (reduced.fallbackActionId && this.resolve(this.stateId, reduced.fallbackActionId)) {
        const selected = this.chooseAction(this.stateId, reduced.fallbackActionId);
        if (selected) return this.result(this.play(this.stateId, selected, true));
      }
      if (feedback.status === 'failed') {
        const selected = this.chooseAction(this.stateId);
        if (selected) return this.result(this.play(this.stateId, selected, true));
      }
      return this.result();
    } catch { return this.result(); }
  }
  reset(): CharacterExpressionResult {
    const effects = this.stop();
    this.contextRevision++; this.moodRevision++; this.mood = null; this.plan = null; this.explicit = false;
    this.explicitUntilMs = null; this.explicitDurationMs = 0; this.explicitSingleAction = false;
    this.events.clear(); this.consumed.clear(); this.decisions.clear(); this.recency.clear(); this.failed.clear();
    this.stateId = this.manifest.idleStateId; this.enteredAtMs = this.now(); this.lastActionId = null;
    this.schedule = { revision: this.schedule.revision + 1, current: null, history: [] };
    this.nextEligibleAtMs = null;
    return this.result(effects);
  }
  replaceCharacter(manifest: CharacterManifestV3, skinId?: string): CharacterExpressionResult {
    const parsed = characterManifestV3Schema.parse(manifest);
    const effects = this.reset().effects;
    this.manifest = parsed; this.skinId = this.validSkin(skinId); this.stateId = parsed.idleStateId;
    return this.result(effects);
  }
}

