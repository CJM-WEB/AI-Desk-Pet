import { characterManifestV3Schema, type CharacterManifestV3, type CharacterStateDefinitionV3, type TrustedCharacterEventV3 } from './character-v3-schema';
import { resolveCharacterPresentationV3 } from './character-playback-view';
import { characterPlaybackFeedbackSchema, type CharacterPlaybackFeedback } from './behavior-contracts';
import { reduceCharacterActionSchedule, type CharacterBehaviorSchedule, type CharacterScheduleEffect } from './behavior-scheduler';
import { characterMoodUpdateSchema, sampleMood, type CharacterMood, type CharacterMoodSnapshot } from './character-mood';
import { characterExpressionPlanSchema, characterExplicitPlaybackSchema, type CharacterExpressionPlan, type CharacterRuntimeFacts } from './character-expression-plan';

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
  explicitPlayback?: unknown;
  /** 仅宿主提供；同轮明确播放保留原 token 与截止时间，更新其后的心情计划。 */
  preserveExplicitPlaybackToken?: string;
};
export type CharacterExpressionEvent = { id: string; type: TrustedCharacterEventV3; occurredAtMs: number };
export type CharacterExpressionEngineOptions = {
  manifest: CharacterManifestV3; skinId?: string; now: () => number; random?: () => number; createPlaybackToken?: () => string;
};
let nextEngineId = 0;
const emptyFacts = (): CharacterRuntimeFacts => ({ moving: false, dragging: false, carrying: false,
  chatting: false, taskRunning: false, awaitingConfirmation: false });
type StateCandidate = CharacterExpressionPlan['states'][number];
type CandidateOwner = 'activity' | 'mood';
type CandidateEntry = Readonly<{ candidate: StateCandidate; plan: CharacterExpressionPlan; owner: CandidateOwner }>;
type ActiveCandidate = Readonly<{ entry: CandidateEntry; playbackToken: string }>;

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
  /** 活动与心情候选独立换代，但共享下面唯一的当前状态与动作调度器。 */
  private activityPlan: CharacterExpressionPlan | null = null;
  private moodPlan: CharacterExpressionPlan | null = null;
  private activeCandidate: ActiveCandidate | null = null;
  private facts = emptyFacts();
  private preparedActivity: keyof CharacterRuntimeFacts | null = null;
  /** 记录只属于当前计划；明确播放仅保留最近一次，允许同轮迟到响应识别已结束 token。 */
  private readonly restingUntil = new Map<string, number>();
  private lastExplicit: { token: string; stateId: string } | null = null;
  private blockedPlanState: string | null = null;
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
  updateRuntimeFacts(facts: Partial<CharacterRuntimeFacts>): CharacterExpressionResult {
    this.facts = { ...this.facts, ...facts };
    if (this.preparedActivity && facts[this.preparedActivity] === true) this.preparedActivity = null;
    return this.advanceWith([], false, true);
  }
  private effectiveFacts(): CharacterRuntimeFacts {
    return this.preparedActivity === null ? this.facts : { ...this.facts, [this.preparedActivity]: true };
  }
  private isActivityCandidate(candidate: StateCandidate): boolean {
    return candidate.lifetime === 'condition' && Object.values(candidate.when ?? {}).some(value => value === true);
  }
  /** 状态或动作候选都可明确声明事实；准备、择态和预检共用同一资格定义。 */
  private supportsFact(candidate: StateCandidate, actionId: string, fact: keyof CharacterRuntimeFacts): boolean {
    return candidate.when?.[fact] === true || candidate.actions.find(action => action.actionId === actionId)?.when?.[fact] === true;
  }
  private entries(): CandidateEntry[] {
    return [
      ...(this.activityPlan?.states.map(candidate => ({ candidate, plan: this.activityPlan!, owner: 'activity' as const })) ?? []),
      ...(this.moodPlan?.states.map(candidate => ({ candidate, plan: this.moodPlan!, owner: 'mood' as const })) ?? [])
    ];
  }
  private owns(entry: CandidateEntry): boolean {
    return entry.owner === 'activity' ? entry.plan === this.activityPlan : entry.plan === this.moodPlan;
  }
  private currentEntry(): CandidateEntry | null {
    const current = this.schedule.current;
    if (current && this.activeCandidate?.playbackToken === current.playbackToken) return this.activeCandidate.entry;
    return this.entries().find(entry => entry.candidate.stateId === this.stateId) ?? null;
  }
  private installPlan(plan: CharacterExpressionPlan): void {
    const activityStates = plan.states.filter(candidate => this.isActivityCandidate(candidate));
    const moodStates = plan.states.filter(candidate => !this.isActivityCandidate(candidate));
    if (!plan.states.length) {
      // 成功的空候选只退役旧心情所有权；当前 token 仍由 activeCandidate 走完原截止。
      this.moodPlan = null;
      return;
    }
    if (activityStates.length) {
      // 活动能力属于角色运行生命周期，不能被一次心情计划的默认 TTL 淘汰。
      this.activityPlan = { ...plan, states: activityStates, expiresAtMs: Number.POSITIVE_INFINITY };
      activityStates.forEach(candidate => this.restingUntil.delete(candidate.stateId));
    }
    if (moodStates.length) {
      this.moodPlan = { ...plan, states: moodStates };
      moodStates.forEach(candidate => this.restingUntil.delete(candidate.stateId));
    }
  }
  private canReusePreparedActivity(fact: keyof CharacterRuntimeFacts): boolean {
    const current = this.schedule.current;
    const active = this.activeCandidate;
    if (!current || !active || active.playbackToken !== current.playbackToken || active.entry.owner !== 'activity'
      || active.entry.plan !== this.activityPlan) return false;
    const deadline = current.startedAtMs === null ? current.startDeadlineAtMs : current.expectedEndAtMs;
    if (deadline !== null && this.now() >= deadline) return false;
    const facts = { ...this.facts, [fact]: true };
    const candidate = active.entry.candidate;
    return this.supportsFact(candidate, current.actionId, fact) && this.eligibleState(active.entry, facts)
      && this.actionCandidates(current.stateId, facts, current.actionId, false, active.entry).length > 0;
  }
  prepareActivity(fact: keyof CharacterRuntimeFacts): CharacterExpressionResult {
    let effects: CharacterExpressionEffect[] = [];
    if (this.preparedActivity !== null) {
      if (this.preparedActivity === fact && this.canReusePreparedActivity(fact)) return this.result();
      const current = this.schedule.current;
      const ownsCurrent = current && this.activeCandidate?.playbackToken === current.playbackToken
        && this.activeCandidate.entry.owner === 'activity';
      this.preparedActivity = null;
      if (ownsCurrent) effects = this.stop();
    }
    if (!this.hasEligibleExpressionFor({ [fact]: true }, fact)) return this.result(effects);
    this.preparedActivity = fact;
    return this.advanceWith(effects, false, true);
  }
  /** 新的明确移动可释放旧明确播放；心情、活动能力与失败记录继续由同一引擎持有。 */
  releaseExplicitPlayback(): CharacterExpressionResult {
    if (!this.explicit) return this.result();
    this.explicit = false; this.explicitUntilMs = null;
    return this.advanceWith(this.stop(), true, true);
  }
  releasePreparedActivity(): CharacterExpressionResult {
    if (this.preparedActivity === null) return this.result();
    this.preparedActivity = null;
    return this.advanceWith([], true, true);
  }
  /** 共用实际择态和抽样前筛选；只有所有可能播放均有事实依据才承诺同步，查询不修改运行记录。 */
  hasEligibleExpressionFor(facts: Partial<CharacterRuntimeFacts>, requiredFact?: keyof CharacterRuntimeFacts): boolean {
    const projected = { ...this.effectiveFacts(), ...facts };
    const currentEntry = this.currentEntry();
    // 截止与明确播放的释放由正式推进完成；纯查询不模拟休息期或消费生命周期。
    if (this.explicit) return false;
    const force = this.currentInvalid(projected) || !!currentEntry && this.episodeDue(currentEntry);
    const target = this.chooseState(force, projected);
    if (!target.entry || target.stateId === this.manifest.idleStateId
      || !this.eligibleState(target.entry, projected)) return false;
    const candidate = target.entry.candidate;
    const qualified = (id: string) => !requiredFact || this.supportsFact(candidate, id, requiredFact);
    const candidates = this.actionCandidates(target.stateId, projected, undefined, false, target.entry);
    const staticDue = this.staticPlayback && this.nextEligibleAtMs !== null && this.now() >= this.nextEligibleAtMs;
    if (this.schedule.current && target.stateId === this.stateId && !force && !staticDue) {
      // 冷却限制新调度，不否定已经开始且仍满足事实的同一动作。
      return candidates.some(action => action.id === this.schedule.current!.actionId && qualified(action.id));
    }
    const selectable = this.selectableActions(candidates).filter(action => action.weight > 0);
    return selectable.length > 0 && selectable.every(action => qualified(action.id));
  }
  /** 新心情只换代心情候选；活动候选和已开始播放保留各自原有所有权与截止。 */
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
    const preserveExplicit = this.explicit && decision.preserveExplicitPlaybackToken !== undefined
      && this.lastExplicit?.token === decision.preserveExplicitPlaybackToken;
    const sameExplicit = decision.preserveExplicitPlaybackToken !== undefined
      && this.lastExplicit?.token === decision.preserveExplicitPlaybackToken;
    if (mood?.success) {
      this.moodRevision++;
      this.mood = { summary: mood.data.summary, targetStrength: mood.data.strength, startedAtMs: this.now(),
        fadeInMs: mood.data.fadeInMs ?? (decision.source === 'chat' ? 0 : 60_000), halfLifeMs: mood.data.halfLifeMs,
        revision: this.moodRevision, sourceEventId: decision.eventId };
      this.moodPlan = null;
      this.blockedPlanState = null;
      if (!sameExplicit) this.lastExplicit = null;
      if (this.explicit && !preserveExplicit) { this.explicit = false; effects = this.stop(); }
    }
    if (legal && parsed?.success) {
      this.installPlan({ ...parsed.data, contextRevision: this.contextRevision, moodRevision: this.moodRevision,
        expiresAtMs: this.now() + parsed.data.validForMs });
      this.blockedPlanState = sameExplicit ? this.lastExplicit!.stateId : null;
      if (!sameExplicit) this.lastExplicit = null;
    }
    if (preserveExplicit) return this.result();
    if (decision.explicitPlayback !== undefined) {
      const explicit = characterExplicitPlaybackSchema.safeParse(decision.explicitPlayback);
      if (explicit.success) {
        const result = this.playExplicit(explicit.data.stateId, explicit.data.actionId);
        return { ...result, effects: [...effects, ...result.effects] };
      }
    }
    return this.advanceWith(effects);
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
    this.activeCandidate = null;
    if (!current) return [];
    this.schedule = reduceCharacterActionSchedule(this.schedule, { type: 'feedback', nowMs: this.now(),
      feedback: { playbackToken: current.playbackToken, actionId: current.actionId, status: 'interrupted', occurredAtMs: this.now() } }, this.manifest.actions).schedule;
    return [{ type: 'interrupt', playbackToken: current.playbackToken, fallbackActionId: null }];
  }
  private chooseState(force: boolean, facts = this.effectiveFacts()): Readonly<{ stateId: string; entry: CandidateEntry | null }> {
    if (this.explicit) return { stateId: this.stateId, entry: null };
    const current = this.manifest.states.find(state => state.id === this.stateId)!;
    const exit = this.conditionEvents(current, true);
    const eligible = this.entries().filter(entry => this.eligibleState(entry, facts)
      && !(exit && entry.candidate.stateId === this.stateId)
      // 实际或准备移动时，其他活动不能凭高分抢占；无合格候选由原有待机与零位移守卫兜底。
      && (!facts.moving || this.actionCandidates(entry.candidate.stateId, facts, undefined, false, entry)
        .every(action => this.supportsFact(entry.candidate, action.id, 'moving')))
      && this.actionCandidates(entry.candidate.stateId, facts, undefined, false, entry).some(action => action.due <= this.now()
        || entry.candidate.stateId === this.stateId && this.schedule.current?.actionId === action.id));
    const activities = eligible.filter(entry => entry.owner === 'activity');
    const currentEntry = this.currentEntry();
    if (!facts.moving && this.schedule.current && currentEntry && !this.owns(currentEntry) && !exit && !activities.length
      && this.eligibleState(currentEntry, facts, true)) {
      return { stateId: this.stateId, entry: currentEntry };
    }
    const candidates = activities.length ? activities : eligible;
    const activeOwner = currentEntry?.owner;
    const activityPreemptsMood = activities.length > 0 && activeOwner !== 'activity';
    const retained = candidates.find(entry => entry.candidate.stateId === this.stateId);
    if (!force && !exit && !activityPreemptsMood && retained && this.now() - this.enteredAtMs < 2_000) {
      return { stateId: this.stateId, entry: retained };
    }
    candidates.sort((a, b) => (b.candidate.score + (b.candidate.stateId === this.stateId ? .05 : 0))
      - (a.candidate.score + (a.candidate.stateId === this.stateId ? .05 : 0)));
    return candidates[0]
      ? { stateId: candidates[0].candidate.stateId, entry: candidates[0] }
      : { stateId: this.manifest.idleStateId, entry: null };
  }
  private resolve(stateId: string, actionId: string) {
    return this.failed.has(actionId) ? null : resolveCharacterPresentationV3(this.manifest, this.skinId, stateId, actionId);
  }
  private matchesFacts(when: StateCandidate['when'], facts: CharacterRuntimeFacts): boolean {
    return !when || (Object.keys(when) as (keyof CharacterRuntimeFacts)[]).every(key => when[key] === facts[key]);
  }
  private eligibleState(entry: CandidateEntry, facts: CharacterRuntimeFacts, detached = false): boolean {
    const { candidate, plan, owner } = entry;
    const strength = sampleMood(this.mood, this.now())?.strength ?? 0;
    const state = this.manifest.states.find(state => state.id === candidate.stateId);
    const moodEligible = owner === 'activity' || detached
      || plan.moodRevision === this.moodRevision
        && (!this.mood || sampleMood(this.mood, this.now()) !== null)
        && strength >= candidate.minStrength && strength <= candidate.maxStrength;
    return this.now() < plan.expiresAtMs && moodEligible && !!state?.agentInferable
      && candidate.stateId !== this.blockedPlanState && (this.restingUntil.get(candidate.stateId) ?? 0) <= this.now()
      && candidate.score > 0
      && this.matchesFacts(candidate.when, facts)
      && (candidate.stateId === this.stateId || this.conditionEvents(state) !== null);
  }
  private episodeDue(entry: CandidateEntry): boolean {
    const candidate = entry.candidate;
    return !this.explicit && candidate.stateId === this.stateId && this.stateId !== this.manifest.idleStateId
      && candidate.lifetime !== 'condition' && this.now() - this.enteredAtMs
        >= Math.max(2000, this.manifest.states.find(state => state.id === this.stateId)!.suggestedDurationMs ?? 3000);
  }
  /** 事实变化的强制撤销条件同时供预检与正式推进使用，避免两秒保持掩盖不适用动作。 */
  private currentInvalid(facts: CharacterRuntimeFacts): boolean {
    const entry = this.currentEntry();
    return !this.explicit && this.stateId !== this.manifest.idleStateId
      && (!entry || !this.eligibleState(entry, facts, !this.owns(entry))
        || facts.moving && this.schedule.current !== null && !this.supportsFact(entry.candidate, this.schedule.current.actionId, 'moving')
        || this.schedule.current !== null && !this.actionCandidates(this.stateId, facts, undefined, false, entry)
          .some(action => action.id === this.schedule.current!.actionId));
  }
  private actionCandidates(stateId: string, facts: CharacterRuntimeFacts, selectedActionId?: string, bypass = false, entry?: CandidateEntry | null) {
    const state = this.manifest.states.find(state => state.id === stateId);
    if (!state) return [];
    const suggestions = entry?.candidate.actions;
    return state.actionIds.flatMap(id => {
      const resolved = this.resolve(stateId, id);
      if (!resolved || (selectedActionId && selectedActionId !== id)) return [];
      const suggestion = suggestions?.find(action => action.actionId === id);
      if (!bypass && !this.matchesFacts(suggestion?.when, facts)) return [];
      const last = this.recency.get(id);
      const due = last === undefined ? 0 : last + resolved.action.cooldownMs;
      const score = bypass || !suggestions?.length ? 1 : suggestion?.score ?? 0;
      return score > 0 ? [{ id, due, weight: score * resolved.action.preference, suppressed: last !== undefined && this.now() < last + resolved.action.repeatSuppressionMs }] : [];
    });
  }
  /** 随机抽样前的唯一候选集合；纯筛选不改变冷却等待记录。 */
  private selectableActions(actions: ReturnType<CharacterExpressionEngine['actionCandidates']>) {
    let candidates = actions.filter(action => action.due <= this.now());
    if (candidates.some(candidate => !candidate.suppressed)) candidates = candidates.filter(candidate => !candidate.suppressed);
    if (candidates.some(candidate => candidate.id !== this.lastActionId)) candidates = candidates.filter(candidate => candidate.id !== this.lastActionId);
    return candidates;
  }
  private chooseAction(stateId: string, selectedActionId?: string,
    bypass = this.explicit || stateId === this.manifest.idleStateId, entry?: CandidateEntry | null,
    facts = this.effectiveFacts()): string | null {
    if (!bypass && (!entry || !this.eligibleState(entry, facts, !this.owns(entry)) || this.episodeDue(entry))) return null;
    const actions = this.actionCandidates(stateId, facts, selectedActionId, bypass, entry);
    for (const action of actions) if (action.due > this.now()) this.nextEligibleAtMs = Math.min(this.nextEligibleAtMs ?? Infinity, action.due);
    const candidates = this.selectableActions(actions);
    if (!candidates.length) return null;
    let pick = Math.max(0, Math.min(.999999, this.options.random?.() ?? .5)) * candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
    for (const candidate of candidates) { pick -= candidate.weight; if (pick < 0) return candidate.id; }
    return null;
  }
  private play(stateId: string, actionId: string, forced: boolean, mode?: 'static', entry?: CandidateEntry | null): CharacterExpressionEffect[] {
    const resolved = this.resolve(stateId, actionId);
    if (!resolved) return [];
    const { action, presentation } = resolved;
    const duration = action.durationMs ?? presentation.frames.reduce((sum, frame) => sum + (frame.durationMs ?? 1000 / presentation.fps), 0) / (presentation.playbackRate ?? 1);
    const result = reduceCharacterActionSchedule(this.schedule, { type: 'schedule', selection: { stateId, actionId },
      playbackToken: `expression-${this.engineId}-${++this.serial}-${this.options.createPlaybackToken?.() ?? 'play'}`, nowMs: this.now(),
      startConfirmationTimeoutMs: 5_000, durationMs: duration, urgency: 0, systemForced: forced }, this.manifest.actions);
    if (result.schedule === this.schedule) return [];
    this.schedule = result.schedule;
    this.activeCandidate = entry && this.schedule.current
      ? { entry, playbackToken: this.schedule.current.playbackToken } : null;
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
  private advanceWith(effects: CharacterExpressionEffect[], force = false, factsChanged = false, fallbackActionId?: string): CharacterExpressionResult {
    const now = this.now();
    for (const [id, event] of this.events) if (now - event.occurredAtMs >= 120_000) { this.events.delete(id); this.consumed.delete(id); }
    if (this.mood && !sampleMood(this.mood, now)) {
      this.mood = null; this.moodRevision++; this.moodPlan = null; force = true;
    }
    if (this.moodPlan && (now >= this.moodPlan.expiresAtMs || this.moodPlan.moodRevision !== this.moodRevision)) {
      this.moodPlan = null; force = true;
    }
    if (this.activityPlan && now >= this.activityPlan.expiresAtMs) { this.activityPlan = null; force = true; }
    if (!this.activityPlan && !this.moodPlan && !this.activeCandidate) {
      this.restingUntil.clear(); this.blockedPlanState = null;
    }
    const before = this.schedule.current;
    this.schedule = reduceCharacterActionSchedule(this.schedule, { type: 'expire', nowMs: now }, this.manifest.actions).schedule;
    if (before && !this.schedule.current) {
      this.activeCandidate = null;
      effects.push({ type: 'interrupt', playbackToken: before.playbackToken, fallbackActionId: null });
    }
    if (this.explicit && ((this.explicitUntilMs !== null && now >= this.explicitUntilMs)
      || (before && !this.schedule.current && (this.explicitSingleAction || before.startedAtMs === null)))) {
      this.explicit = false; this.explicitUntilMs = null; force = true;
      effects.push(...this.stop());
    }
    const currentEntry = this.currentEntry();
    // episode 从进入状态计时，动作轮换不续命；condition 则由实时条件持续性决定。
    if (currentEntry && this.episodeDue(currentEntry)) {
      this.restingUntil.set(this.stateId, now + 10_000); force = true;
    }
    // 已失去事实资格的播放立即撤销，不等待两秒保持或作者抗中断策略。
    const facts = this.effectiveFacts();
    if (this.currentInvalid(facts)) { effects.push(...this.stop()); force = true; }
    const target = this.chooseState(force, facts);
    const staticDue = this.staticPlayback && this.nextEligibleAtMs !== null && now >= this.nextEligibleAtMs;
    if (this.schedule.current && target.stateId === this.stateId && target.entry
      && this.activeCandidate?.entry !== target.entry) {
      const reusable = this.actionCandidates(target.stateId, facts, undefined, false, target.entry)
        .some(action => action.id === this.schedule.current!.actionId);
      if (reusable) {
        this.activeCandidate = { entry: target.entry, playbackToken: this.schedule.current.playbackToken };
      } else force = true;
    }
    if (this.schedule.current && target.stateId === this.stateId && !force && !staticDue) return this.result(effects);
    // 已进入的普通状态仍遵守两秒保持；真实活动和事实结束可以立即越过。
    if (this.schedule.current && this.stateId !== this.manifest.idleStateId && !force && !factsChanged
      && target.stateId !== this.stateId && target.entry?.owner !== 'activity' && now - this.enteredAtMs < 2_000) {
      return this.result(effects);
    }
    this.nextEligibleAtMs = null;
    // 回退只是已裁决状态内的优先动作，不能绕过明确截止、退出事件或普通候选资格。
    const fallback = target.stateId === this.stateId && fallbackActionId
      ? this.chooseAction(target.stateId, fallbackActionId, false, target.entry, facts) : null;
    const actionId = fallback ?? this.chooseAction(target.stateId, undefined,
      this.explicit || target.stateId === this.manifest.idleStateId, target.entry, facts);
    if (actionId) effects.push(...this.play(target.stateId, actionId, force || factsChanged, undefined, target.entry));
    else {
      const idle = this.manifest.idleStateId;
      const idleAction = this.chooseAction(idle, undefined, true, null, facts);
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
    const selected = this.chooseAction(stateId, actionId, true);
    if (!selected) return this.result();
    const resolved = this.resolve(stateId, selected)!;
    this.invalidateContext(); this.explicit = true; this.explicitSingleAction = actionId !== undefined;
    this.explicitUntilMs = null;
    this.enteredAtMs = this.now();
    this.explicitDurationMs = actionId !== undefined
      ? resolved.presentation.frames.reduce((sum, frame) => sum + (frame.durationMs ?? 1000 / resolved.presentation.fps), 0) / (resolved.presentation.playbackRate ?? 1)
      : this.manifest.states.find(state => state.id === stateId)!.suggestedDurationMs ?? 3000;
    const effects = this.play(stateId, selected, true);
    this.lastExplicit = { token: this.schedule.current!.playbackToken, stateId };
    return this.result(effects);
  }
  applyFeedback(feedback: CharacterPlaybackFeedback): CharacterExpressionResult {
    const parsed = characterPlaybackFeedbackSchema.safeParse(feedback);
    const current = this.schedule.current;
    if (!parsed.success || !current || feedback.playbackToken !== current.playbackToken || feedback.actionId !== current.actionId
      || feedback.occurredAtMs < current.scheduledAtMs || feedback.occurredAtMs > this.now()) return this.result();
    try {
      const preparedToken = this.preparedActivity !== null && this.activeCandidate?.playbackToken === current.playbackToken;
      const reduced = reduceCharacterActionSchedule(this.schedule, { type: 'feedback', feedback, nowMs: this.now() }, this.manifest.actions);
      this.schedule = reduced.schedule;
      if (feedback.status === 'started') {
        if (this.explicit && this.explicitUntilMs === null) this.explicitUntilMs = feedback.occurredAtMs + this.explicitDurationMs;
        return this.result();
      }
      if (preparedToken) this.preparedActivity = null;
      this.activeCandidate = null;
      this.recency.set(feedback.actionId, this.now());
      if (feedback.status === 'failed') this.failed.add(feedback.actionId);
      if (this.explicit && this.explicitSingleAction && feedback.status === 'completed') {
        this.explicit = false; this.explicitUntilMs = null;
        return this.advanceWith([], true);
      }
      if (reduced.fallbackActionId || feedback.status === 'failed') {
        return this.advanceWith([], feedback.status === 'failed', false, reduced.fallbackActionId);
      }
      if (feedback.status === 'completed' && !this.explicit && this.stateId !== this.manifest.idleStateId) return this.advanceWith([]);
      return this.result();
    } catch { return this.result(); }
  }
  reset(): CharacterExpressionResult {
    const effects = this.stop();
    this.contextRevision++; this.moodRevision++; this.mood = null;
    this.activityPlan = null; this.moodPlan = null; this.activeCandidate = null; this.explicit = false;
    this.explicitUntilMs = null; this.explicitDurationMs = 0; this.explicitSingleAction = false;
    this.facts = emptyFacts(); this.preparedActivity = null;
    this.restingUntil.clear(); this.lastExplicit = null; this.blockedPlanState = null;
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

