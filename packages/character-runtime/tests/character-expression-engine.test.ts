import { describe, expect, it } from 'vitest';
import * as runtime from '../src';
import { resourceFields, v3Fixture } from './character-v3-fixture';

function fixture() {
  const draft = v3Fixture();
  for (const id of ['bright', 'soft']) {
    draft.states.push({ ...draft.states[0]!, id, agentInferable: true, actionIds: [id + '-a', id + '-b'] });
    for (const suffix of ['a', 'b']) {
      const actionId = id + '-' + suffix;
      draft.actions.push({ ...draft.actions[0]!, id: actionId, loopPolicy: 'until-interrupted' });
      draft.skins[0]!.presentations.push({ ...draft.skins[0]!.presentations[0]!, actionId });
    }
  }
  return runtime.characterManifestV3Schema.parse({ ...draft, ...resourceFields });
}
const plan = { states: [
  { stateId: 'bright', score: 1, minStrength: .6, maxStrength: 1, actions: [] },
  { stateId: 'soft', score: 1, minStrength: .02, maxStrength: .59, actions: [] }
] };

const movingPlan = { states: [{ ...plan.states[0]!, minStrength: 0,
  when: { moving: true }, lifetime: 'condition', actions: [
    { actionId: 'bright-a', score: 1, when: { carrying: false } },
    { actionId: 'bright-b', score: 1, when: { carrying: true } }
  ] }] };

describe('通用情境条件与有限表现', () => {
  it.each([
    { plainScore: 1, activeScore: .8, at: 2100, eligible: false },
    { plainScore: .5, activeScore: 1, at: 100, eligible: false },
    { plainScore: .5, activeScore: 1, at: 2100, eligible: true }
  ])('同步资格遵守分数竞争与两秒保持：%j', ({ plainScore, activeScore, at, eligible }) => {
    let now = 0;
    const engine = new runtime.CharacterExpressionEngine({ manifest: fixture(), now: () => now, random: () => 0 });
    engine.applyDecision({ context: engine.context(), eventId: 'competition', source: 'chat', expressionPlan: { states: [
      { stateId: 'bright', score: plainScore, minStrength: 0, maxStrength: 1, actions: [] },
      { stateId: 'soft', score: activeScore, minStrength: 0, maxStrength: 1, when: { moving: true }, lifetime: 'condition', actions: [] }
    ] } });
    now = at;
    expect(engine.hasEligibleExpressionFor({ moving: true }, 'moving')).toBe(eligible);
    expect(engine.updateRuntimeFacts({ moving: true }).snapshot.stateId).toBe(eligible ? 'soft' : 'bright');
  });
  it('明确播放锁仍生效时不宣称另一条件候选会同步', () => {
    const engine = new runtime.CharacterExpressionEngine({ manifest: fixture(), now: () => 0 });
    engine.applyDecision({ context: engine.context(), eventId: 'plan', source: 'chat', expressionPlan: movingPlan });
    const current = engine.playExplicit('soft').snapshot.schedule.current!;
    expect(engine.hasEligibleExpressionFor({ moving: true }, 'moving')).toBe(false);
    expect(engine.updateRuntimeFacts({ moving: true }).snapshot.schedule.current?.playbackToken).toBe(current.playbackToken);
  });
  it('同状态当前无条件动作仍会保留时不能把另一活动动作算作同步', () => {
    const engine = new runtime.CharacterExpressionEngine({ manifest: fixture(), now: () => 0, random: () => 0 });
    engine.applyDecision({ context: engine.context(), eventId: 'mixed', source: 'chat', expressionPlan: { states: [
      { stateId: 'bright', score: 1, minStrength: 0, maxStrength: 1, actions: [
        { actionId: 'bright-a', score: 1 }, { actionId: 'bright-b', score: 1, when: { moving: true } }
      ] }
    ] } });
    expect(engine.hasEligibleExpressionFor({ moving: true }, 'moving')).toBe(false);
    expect(engine.updateRuntimeFacts({ moving: true }).snapshot.schedule.current?.actionId).toBe('bright-a');
  });
  it.each(['weight', 'suppression', 'cooldown'] as const)('同状态混合动作经过%s仍可能选无条件动作时保守等待', reason => {
    let randomCalls = 0; let tokens = 0;
    const manifest = fixture();
    const active = manifest.actions.find(action => action.id === 'bright-a')!;
    if (reason === 'suppression') active.repeatSuppressionMs = 5000;
    if (reason === 'cooldown') active.cooldownMs = 5000;
    const engine = new runtime.CharacterExpressionEngine({ manifest, now: () => 0,
      random: () => { randomCalls++; return .99; }, createPlaybackToken: () => String(++tokens) });
    if (reason !== 'weight') engine.playExplicit('bright', 'bright-a');
    engine.applyDecision({ context: engine.context(), eventId: 'mixed', source: 'chat', moodUpdate: { summary: '平静', strength: 1 },
      expressionPlan: { states: [{ stateId: 'bright', score: 1, minStrength: 0, maxStrength: 1, when: { carrying: true },
        lifetime: 'condition', actions: [
          { actionId: 'bright-a', score: .1, when: { taskRunning: true } }, { actionId: 'bright-b', score: 1 }
        ] }] } });
    const before = engine.snapshot(); const calls = randomCalls; const serial = tokens;
    expect(engine.hasEligibleExpressionFor({ carrying: true, taskRunning: true }, 'taskRunning')).toBe(false);
    expect(engine.hasEligibleExpressionFor({ carrying: true, taskRunning: true }, 'taskRunning')).toBe(false);
    expect(engine.snapshot()).toEqual(before); expect(randomCalls).toBe(calls); expect(tokens).toBe(serial);
    expect(engine.updateRuntimeFacts({ carrying: true, taskRunning: true }).snapshot.schedule.current?.actionId).toBe('bright-b');
  });
  it('明确截止后失败反馈先结束生命周期，不能新发零时长回退播放', () => {
    let now = 0;
    const manifest = fixture();
    manifest.actions.find(action => action.id === 'bright-a')!.failureFallbackActionId = 'bright-b';
    const engine = new runtime.CharacterExpressionEngine({ manifest, now: () => now, random: () => 0 });
    const current = engine.playExplicit('bright').snapshot.schedule.current!;
    engine.applyFeedback({ playbackToken: current.playbackToken, actionId: current.actionId, status: 'started', occurredAtMs: now });
    now = 3001;
    const result = engine.applyFeedback({ playbackToken: current.playbackToken, actionId: current.actionId, status: 'failed', occurredAtMs: now });
    expect(result.snapshot.stateId).toBe('rest');
    expect(result.effects.filter(effect => effect.type === 'play')).not.toContainEqual(expect.objectContaining({ action: expect.objectContaining({ stateId: 'bright' }) }));
  });
  it('退出边沿被抗中断延后后，失败反馈必须按退出资格择态', () => {
    let now = 0;
    const manifest = fixture();
    manifest.states[1]!.exitConditions = [{ mode: 'any', clauses: [{ kind: 'event', event: 'drag-end' }] }];
    manifest.actions.find(action => action.id === 'bright-a')!.interrupt = 'resistant';
    manifest.actions.find(action => action.id === 'bright-a')!.failureFallbackActionId = 'bright-b';
    const engine = new runtime.CharacterExpressionEngine({ manifest, now: () => now, random: () => 0 });
    engine.updateRuntimeFacts({ moving: true });
    const current = engine.applyDecision({ context: engine.context(), eventId: 'moving', source: 'chat', expressionPlan: {
      states: [{ ...movingPlan.states[0]!, actions: [] }]
    } }).snapshot.schedule.current!;
    engine.applyFeedback({ playbackToken: current.playbackToken, actionId: current.actionId, status: 'started', occurredAtMs: now });
    now = 2500;
    expect(engine.recordEvent({ id: 'drop', type: 'drag-end', occurredAtMs: now }).snapshot.schedule.current?.playbackToken).toBe(current.playbackToken);
    expect(engine.hasEligibleExpressionFor({ moving: true }, 'moving')).toBe(false);
    const result = engine.applyFeedback({ playbackToken: current.playbackToken, actionId: current.actionId, status: 'failed', occurredAtMs: now });
    expect(result.snapshot.stateId).toBe('rest');
    expect(result.effects.filter(effect => effect.type === 'play')).not.toContainEqual(expect.objectContaining({ action: expect.objectContaining({ stateId: 'bright' }) }));
  });
  it('presentation 条件动作完成后立即续播合法动作，无需等待宿主 tick', () => {
    let now = 0;
    const manifest = fixture();
    manifest.actions.find(action => action.id === 'bright-a')!.loopPolicy = 'presentation';
    const engine = new runtime.CharacterExpressionEngine({ manifest, now: () => now });
    engine.updateRuntimeFacts({ moving: true });
    const current = engine.applyDecision({ context: engine.context(), eventId: 'moving', source: 'chat', expressionPlan: movingPlan }).snapshot.schedule.current!;
    engine.applyFeedback({ playbackToken: current.playbackToken, actionId: current.actionId, status: 'started', occurredAtMs: now });
    now = 100;
    const result = engine.applyFeedback({ playbackToken: current.playbackToken, actionId: current.actionId, status: 'completed', occurredAtMs: now });
    expect(result.effects).toContainEqual(expect.objectContaining({ type: 'play' }));
    expect(result.snapshot.schedule.current?.actionId).toBe('bright-a');
    expect(result.snapshot.schedule.current?.playbackToken).not.toBe(current.playbackToken);
  });
  it('真实事实即时切换自定义状态及动作，条件结束越过保持和抗中断，恢复无需休息', () => {
    let now = 0;
    const manifest = fixture();
    manifest.actions.find(action => action.id === 'bright-a')!.interrupt = 'resistant';
    const engine = new runtime.CharacterExpressionEngine({ manifest, now: () => now });
    engine.applyDecision({ context: engine.context(), eventId: 'moving', source: 'chat', expressionPlan: movingPlan });
    expect(engine.snapshot().stateId).toBe('rest');
    const context = engine.context();
    expect(engine.updateRuntimeFacts({ moving: true }).snapshot.schedule.current?.actionId).toBe('bright-a');
    now = 50;
    expect(engine.updateRuntimeFacts({ carrying: true }).snapshot.schedule.current?.actionId).toBe('bright-b');
    now = 100;
    expect(engine.updateRuntimeFacts({ moving: false }).snapshot.stateId).toBe('rest');
    expect(engine.updateRuntimeFacts({ moving: true }).snapshot.stateId).toBe('bright');
    expect(engine.context()).toEqual(context);
    const current = engine.snapshot().schedule.current!;
    engine.applyFeedback({ playbackToken: current.playbackToken, actionId: current.actionId, status: 'started', occurredAtMs: now });
    now = 20_000;
    expect(engine.advance().snapshot.stateId).toBe('bright');
  });
  it('停止后接纳旧推断仍按现在事实过滤，其他事实使用同一引擎', () => {
    const engine = new runtime.CharacterExpressionEngine({ manifest: fixture(), now: () => 0 });
    engine.updateRuntimeFacts({ moving: true });
    const context = engine.context();
    engine.updateRuntimeFacts({ moving: false });
    expect(engine.applyDecision({ context, eventId: 'late', source: 'chat', expressionPlan: movingPlan }).snapshot.stateId).toBe('rest');
    engine.applyDecision({ context, eventId: 'task', source: 'chat', expressionPlan: {
      states: [{ ...plan.states[0]!, stateId: 'soft', minStrength: 0, lifetime: 'condition', when: { taskRunning: true } }]
    } });
    expect(engine.updateRuntimeFacts({ taskRunning: true }).snapshot.stateId).toBe('soft');
    expect(engine.updateRuntimeFacts({ taskRunning: false }).snapshot.stateId).toBe('rest');
  });
  it('失败回退也必须满足动作条件，明确播放可以越过模型条件', () => {
    const manifest = fixture();
    manifest.actions.find(action => action.id === 'bright-a')!.failureFallbackActionId = 'bright-b';
    const engine = new runtime.CharacterExpressionEngine({ manifest, now: () => 0 });
    engine.updateRuntimeFacts({ moving: true });
    const current = engine.applyDecision({ context: engine.context(), eventId: 'moving', source: 'chat', expressionPlan: movingPlan }).snapshot.schedule.current!;
    const failed = engine.applyFeedback({ playbackToken: current.playbackToken, actionId: current.actionId, status: 'failed', occurredAtMs: 0 });
    expect(failed.snapshot.stateId).toBe('rest');
    expect(failed.snapshot.schedule.current?.actionId).not.toBe('bright-b');
    expect(engine.playExplicit('bright', 'bright-b').snapshot.schedule.current?.actionId).toBe('bright-b');
  });
  it('计划失效后到达的失败反馈不能绕过状态资格播放回退动作', () => {
    let now = 0;
    const manifest = fixture();
    manifest.actions.find(action => action.id === 'bright-a')!.failureFallbackActionId = 'bright-b';
    const engine = new runtime.CharacterExpressionEngine({ manifest, now: () => now, random: () => 0 });
    const current = engine.applyDecision({ context: engine.context(), eventId: 'plan', source: 'chat', expressionPlan: {
      validForMs: 100, states: [{ ...plan.states[0]!, minStrength: 0 }]
    } }).snapshot.schedule.current!;
    now = 100;
    expect(engine.applyFeedback({ playbackToken: current.playbackToken, actionId: current.actionId, status: 'failed', occurredAtMs: now }).snapshot.stateId).toBe('rest');
  });
  it('资格查询纯读，要求明确 true 条件，尊重事件、冷却、有效期和推断开关', () => {
    let now = 0; let randomCalls = 0;
    const manifest = fixture();
    manifest.states[1]!.enterConditions = [{ mode: 'all', clauses: [{ kind: 'event', event: 'user-interaction' }] }];
    manifest.actions.find(action => action.id === 'bright-a')!.cooldownMs = 5000;
    const engine = new runtime.CharacterExpressionEngine({ manifest, now: () => now, random: () => { randomCalls++; return 0; } });
    expect(engine.hasEligibleExpressionFor({ moving: true }, 'moving')).toBe(false);
    engine.applyDecision({ context: engine.context(), eventId: 'plan', source: 'chat', expressionPlan: { ...movingPlan, validForMs: 20_000 } });
    expect(engine.hasEligibleExpressionFor({ moving: true }, 'moving')).toBe(false);
    engine.recordEvent({ id: 'touch', type: 'user-interaction', occurredAtMs: now });
    const snapshot = engine.snapshot(); const calls = randomCalls;
    expect(engine.hasEligibleExpressionFor({ moving: true }, 'moving')).toBe(true);
    expect(engine.hasEligibleExpressionFor({ moving: true }, 'moving')).toBe(true);
    expect(engine.snapshot()).toEqual(snapshot); expect(randomCalls).toBe(calls);
    const current = engine.updateRuntimeFacts({ moving: true }).snapshot.schedule.current!;
    engine.applyFeedback({ playbackToken: current.playbackToken, actionId: current.actionId, status: 'started', occurredAtMs: now });
    expect(engine.hasEligibleExpressionFor({ moving: true }, 'moving')).toBe(false);
    now = 20_000;
    expect(engine.hasEligibleExpressionFor({ moving: true }, 'moving')).toBe(false);
    const plain = new runtime.CharacterExpressionEngine({ manifest: fixture(), now: () => 0 });
    plain.applyDecision({ context: plain.context(), eventId: 'plain', source: 'chat', expressionPlan: { states: [{ ...plan.states[0]!, minStrength: 0 }] } });
    expect(plain.hasEligibleExpressionFor({ moving: true }, 'moving')).toBe(false);
    const disabled = fixture(); disabled.states[1]!.agentInferable = false;
    const noInfer = new runtime.CharacterExpressionEngine({ manifest: disabled, now: () => 0 });
    noInfer.applyDecision({ context: noInfer.context(), eventId: 'disabled', source: 'chat', expressionPlan: movingPlan });
    expect(noInfer.hasEligibleExpressionFor({ moving: true }, 'moving')).toBe(false);
  });
  it.each([undefined, 500, 4000])('episode 使用进入时间与作者时长 %s，动作轮换不续命，休息后心情仍可表达', duration => {
    let now = 0;
    const manifest = fixture();
    if (duration !== undefined) manifest.states[1]!.suggestedDurationMs = duration;
    const engine = new runtime.CharacterExpressionEngine({ manifest, now: () => now, random: () => 0 });
    const episodePlan = { states: [{ ...plan.states[0]!, minStrength: 0 }] };
    let current = engine.applyDecision({ context: engine.context(), eventId: 'episode', source: 'chat', moodUpdate: { summary: '喜悦', strength: 1 }, expressionPlan: episodePlan }).snapshot.schedule.current!;
    engine.applyFeedback({ playbackToken: current.playbackToken, actionId: current.actionId, status: 'started', occurredAtMs: now });
    now = 1000;
    engine.applyFeedback({ playbackToken: current.playbackToken, actionId: current.actionId, status: 'completed', occurredAtMs: now });
    current = engine.advance().snapshot.schedule.current!;
    expect(current.actionId).toBe('bright-b');
    engine.applyFeedback({ playbackToken: current.playbackToken, actionId: current.actionId, status: 'started', occurredAtMs: now });
    now = duration === undefined ? 3000 : Math.max(2000, duration);
    expect(engine.advance().snapshot.stateId).toBe('rest');
    expect(engine.snapshot().mood?.summary).toBe('喜悦');
    expect(engine.hasEligibleExpressionFor({})).toBe(false);
    now += 9999; expect(engine.advance().snapshot.stateId).toBe('rest');
    now += 1; expect(engine.hasEligibleExpressionFor({})).toBe(true);
    expect(engine.advance().snapshot.stateId).toBe('bright');
  });
  it.each([false, true])('同轮明确播放结束不被保留计划复活（计划迟到：%s），新互动仍可再次播放', late => {
    let now = 0;
    const engine = new runtime.CharacterExpressionEngine({ manifest: fixture(), now: () => now });
    const current = engine.playExplicit('bright', 'bright-a').snapshot.schedule.current!;
    engine.applyFeedback({ playbackToken: current.playbackToken, actionId: current.actionId, status: 'started', occurredAtMs: now });
    const decision = { context: engine.context(), eventId: 'same-turn', source: 'chat' as const,
      moodUpdate: { summary: '喜悦', strength: 1 }, expressionPlan: { states: [{ ...plan.states[0]!, minStrength: 0 }] },
      preserveExplicitPlaybackToken: current.playbackToken };
    if (!late) engine.applyDecision(decision);
    now = 100;
    expect(engine.advance().snapshot.stateId).toBe('rest');
    if (late) expect(engine.applyDecision(decision).snapshot.stateId).toBe('rest');
    now = 20_000;
    expect(engine.advance().snapshot.stateId).toBe('rest');
    expect(engine.playExplicit('bright', 'bright-a').snapshot.stateId).toBe('bright');
  });
});

describe('V3 心情与表现', () => {
  it('同轮明确动作不中断或重播，结束后进入新心情计划', () => {
    let now = 0;
    const engine = new runtime.CharacterExpressionEngine({ manifest: fixture(), now: () => now });
    const current = engine.playExplicit('soft', 'soft-a').snapshot.schedule.current!;
    engine.applyFeedback({ playbackToken: current.playbackToken, actionId: current.actionId, status: 'started', occurredAtMs: now });
    const started = engine.snapshot().schedule.current;
    const decision = { context: engine.context(), eventId: 'news-and-wave', source: 'chat' as const,
      moodUpdate: { summary: '开心的喜讯', strength: 1 }, expressionPlan: plan,
      preserveExplicitPlaybackToken: current.playbackToken };
    const updated = engine.applyDecision(decision);
    expect(updated.effects).toEqual([]);
    expect(updated.snapshot.schedule.current).toEqual(started);
    expect(updated.snapshot.mood?.summary).toBe('开心的喜讯');
    expect(engine.applyDecision(decision).effects).toEqual([]);
    now = 100;
    expect(engine.advance().snapshot.stateId).toBe('bright');
  });
  it('明确动作覆盖作者无限循环并在完整周期后自主退出，状态请求有界驻留', () => {
    let now = 0;
    const manifest = fixture();
    const engine = new runtime.CharacterExpressionEngine({ manifest, now: () => now });
    const result = engine.playExplicit('bright', 'bright-a');
    const presentation = manifest.skins[0]!.presentations.find(item => item.actionId === 'bright-a')!;
    const cycle = presentation.frames.reduce((sum, frame) => sum + (frame.durationMs ?? 1000 / presentation.fps), 0) / (presentation.playbackRate ?? 1);
    expect(result.effects.find(effect => effect.type === 'play')).toMatchObject({ playback: { mode: 'once', durationMs: cycle } });
    const current = result.snapshot.schedule.current!;
    engine.applyFeedback({ playbackToken: current.playbackToken, actionId: current.actionId, status: 'started', occurredAtMs: now });
    now = cycle + 1;
    expect(engine.advance().snapshot.stateId).toBe('rest');
    const state = engine.playExplicit('bright').snapshot.schedule.current!;
    engine.applyFeedback({ playbackToken: state.playbackToken, actionId: state.actionId, status: 'started', occurredAtMs: now });
    now += 3001;
    expect(engine.advance().snapshot.stateId).toBe('rest');
  });
  it('导出独立 V3 引擎及严格建议契约', () => {
    expect(runtime).toHaveProperty('CharacterExpressionEngine');
    expect(runtime).toHaveProperty('characterMoodUpdateSchema');
    expect(runtime).toHaveProperty('characterExpressionPlanSchema');
  });
  it('无需下一条消息，持续循环随强度从强表现变弱并回到 idle', () => {
    let now = 0;
    const engine = new runtime.CharacterExpressionEngine({ manifest: fixture(), now: () => now, random: () => 0 });
    expect(engine.applyDecision({ context: engine.context(), eventId: 'news', source: 'chat',
      moodUpdate: { summary: '分享喜讯', strength: 1, halfLifeMs: 30_000 }, expressionPlan: plan }).snapshot.stateId).toBe('bright');
    now = 30_000;
    expect(engine.advance().snapshot.stateId).toBe('soft');
    now = 180_000;
    expect(engine.advance().snapshot.stateId).toBe('rest');
    expect(engine.snapshot().mood).toBeNull();
  });
  it('同状态合格动作轮换，非法 ID 和旧 token 不改变播放', () => {
    let now = 0;
    const engine = new runtime.CharacterExpressionEngine({ manifest: fixture(), now: () => now, random: () => 0 });
    const first = engine.playExplicit('bright').snapshot.schedule.current!;
    engine.applyFeedback({ playbackToken: first.playbackToken, actionId: first.actionId, status: 'started', occurredAtMs: now });
    now = 3_000;
    engine.applyFeedback({ playbackToken: first.playbackToken, actionId: first.actionId, status: 'completed', occurredAtMs: now });
    const next = engine.playExplicit('bright').snapshot.schedule.current!;
    expect(next.actionId).not.toBe(first.actionId);
    expect(engine.playExplicit('bright', 'breathe').effects).toEqual([]);
    expect(engine.applyFeedback({ playbackToken: first.playbackToken, actionId: first.actionId, status: 'failed', occurredAtMs: now }).effects).toEqual([]);
    expect(engine.snapshot().schedule.current).toEqual(next);
  });
  it('新心情清旧计划且旧情境、重置和另一实例的响应无法复活', () => {
    const engine = new runtime.CharacterExpressionEngine({ manifest: fixture(), now: () => 0 });
    const old = engine.context();
    engine.applyDecision({ context: old, eventId: 'one', source: 'chat', moodUpdate: { summary: '喜讯', strength: 1 }, expressionPlan: plan });
    engine.applyDecision({ context: engine.context(), eventId: 'two', source: 'chat', moodUpdate: { summary: '新感受', strength: .5 } });
    expect(engine.snapshot().stateId).toBe('rest');
    expect(engine.applyDecision({ context: old, eventId: 'late', source: 'chat', expressionPlan: plan }).effects).toEqual([]);
    const current = engine.context(); engine.reset();
    expect(engine.applyDecision({ context: current, eventId: 'reset-late', source: 'chat', expressionPlan: plan }).effects).toEqual([]);
    const other = new runtime.CharacterExpressionEngine({ manifest: fixture(), now: () => 0 });
    expect(other.applyDecision({ context: engine.context(), eventId: 'foreign', source: 'chat', expressionPlan: plan }).effects).toEqual([]);
  });
  it('自主渐入不提前清除，纯时间采样保持修订，重复事件不刷新', () => {
    let now = 0;
    const engine = new runtime.CharacterExpressionEngine({ manifest: fixture(), now: () => now });
    engine.applyDecision({ context: engine.context(), eventId: 'quiet', source: 'autonomous', moodUpdate: { summary: '渐渐有感受', strength: 1 }, expressionPlan: plan });
    const revision = engine.snapshot().moodRevision;
    expect(engine.snapshot().mood?.strength).toBe(0);
    now = 30_000; engine.advance();
    expect(engine.snapshot().mood?.strength).toBe(.5);
    expect(engine.snapshot().moodRevision).toBe(revision);
    engine.applyDecision({ context: engine.context(), eventId: 'quiet', source: 'autonomous', moodUpdate: { summary: '重复', strength: 1 } });
    expect(engine.snapshot().mood?.summary).toBe('渐渐有感受');
  });
  it('计划过期结束持续循环；停止表现空计划立即中断', () => {
    let now = 0;
    const engine = new runtime.CharacterExpressionEngine({ manifest: fixture(), now: () => now });
    engine.applyDecision({ context: engine.context(), eventId: 'plan', source: 'chat', moodUpdate: { summary: '高兴', strength: 1 }, expressionPlan: { ...plan, validForMs: 10_000 } });
    const current = engine.snapshot().schedule.current!;
    engine.applyFeedback({ playbackToken: current.playbackToken, actionId: current.actionId, status: 'started', occurredAtMs: now });
    now = 10_000;
    expect(engine.advance().snapshot.stateId).toBe('rest');
    engine.playExplicit('bright');
    expect(engine.applyDecision({ context: engine.context(), eventId: 'stop', source: 'chat', expressionPlan: { states: [] } }).snapshot.stateId).toBe('rest');
  });
  it('全冷却只静止一次，到期恢复调度，不反复请求播放', () => {
    let now = 0;
    const manifest = fixture(); manifest.actions[0]!.cooldownMs = 10_000;
    const engine = new runtime.CharacterExpressionEngine({ manifest, now: () => now });
    const current = engine.advance().snapshot.schedule.current!;
    engine.applyFeedback({ playbackToken: current.playbackToken, actionId: current.actionId, status: 'started', occurredAtMs: now });
    now = 100;
    engine.applyFeedback({ playbackToken: current.playbackToken, actionId: current.actionId, status: 'completed', occurredAtMs: now });
    const waiting = engine.advance();
    expect(waiting.effects.find(effect => effect.type === 'play')).toMatchObject({ playback: { mode: 'static' } });
    const staticCurrent = waiting.snapshot.schedule.current!;
    engine.applyFeedback({ playbackToken: staticCurrent.playbackToken, actionId: staticCurrent.actionId, status: 'started', occurredAtMs: now });
    expect(engine.advance().effects).toEqual([]);
    now = 10_100;
    expect(engine.advance().effects.find(effect => effect.type === 'play')).toMatchObject({ playback: { mode: 'loop' } });
  });
  it('事件进入只消费一次，退出只接受进入后新事件', () => {
    let now = 0;
    const manifest = fixture();
    manifest.states[1]!.enterConditions = [{ mode: 'all', clauses: [{ kind: 'event', event: 'user-interaction' }] }];
    manifest.states[1]!.exitConditions = [{ mode: 'any', clauses: [{ kind: 'event', event: 'drag-end' }] }];
    const engine = new runtime.CharacterExpressionEngine({ manifest, now: () => now });
    engine.applyDecision({ context: engine.context(), eventId: 'plan', source: 'chat', moodUpdate: { summary: '感受', strength: 1 }, expressionPlan: plan });
    expect(engine.snapshot().stateId).toBe('rest');
    now = 3_000; engine.recordEvent({ id: 'touch', type: 'user-interaction', occurredAtMs: now });
    expect(engine.snapshot().stateId).toBe('bright');
    now = 6_000; engine.recordEvent({ id: 'drop', type: 'drag-end', occurredAtMs: now });
    expect(engine.snapshot().stateId).toBe('rest');
    now = 9_000; expect(engine.advance().snapshot.stateId).toBe('rest');
  });
  it('严格拒绝重复状态、错误归属与模型修订，播放 token 跨实例唯一', () => {
    expect(runtime.characterExpressionPlanSchema.safeParse({ states: [plan.states[0], plan.states[0]] }).success).toBe(false);
    expect(runtime.characterMoodUpdateSchema.safeParse({ summary: '心情', strength: 1, revision: 3 }).success).toBe(false);
    const one = new runtime.CharacterExpressionEngine({ manifest: fixture(), now: () => 0 });
    const two = new runtime.CharacterExpressionEngine({ manifest: fixture(), now: () => 0 });
    expect(one.advance().snapshot.schedule.current!.playbackToken).not.toBe(two.advance().snapshot.schedule.current!.playbackToken);
    expect(one.applyDecision({ context: one.context(), eventId: 'invalid', source: 'chat', expressionPlan: { states: [{ ...plan.states[0], actions: [{ actionId: 'breathe', score: 1 }] }] } }).snapshot.stateId).toBe('rest');
  });
  it.each([false, true])('退出事件等待两秒状态保持后仍生效（动作提前完成：%s）', completed => {
    let now = 0;
    const manifest = fixture();
    manifest.states[1]!.exitConditions = [{ mode: 'any', clauses: [{ kind: 'event', event: 'drag-end' }] }];
    const engine = new runtime.CharacterExpressionEngine({ manifest, now: () => now });
    engine.applyDecision({ context: engine.context(), eventId: 'feeling', source: 'chat',
      moodUpdate: { summary: '感受', strength: 1 }, expressionPlan: plan });
    const current = engine.snapshot().schedule.current!;
    const feedback = { playbackToken: current.playbackToken, actionId: current.actionId };
    engine.applyFeedback({ ...feedback, status: 'started', occurredAtMs: now });
    now = 500;
    if (completed) engine.applyFeedback({ ...feedback, status: 'completed', occurredAtMs: now });
    expect(engine.recordEvent({ id: 'drop', type: 'drag-end', occurredAtMs: now }).snapshot.stateId).toBe('bright');
    now = 2_000;
    expect(engine.advance().snapshot.stateId).toBe('rest');
  });
});

