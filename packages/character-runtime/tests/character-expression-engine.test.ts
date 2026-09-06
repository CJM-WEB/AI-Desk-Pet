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

describe('V3 心情与表现', () => {
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

