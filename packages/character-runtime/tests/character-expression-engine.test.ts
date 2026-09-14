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
  it.each(['soft', 'bright'])('明确退出长期%s同时撤销旧明确播放，跨循环不再回流', stateId => {
    let now = 0;
    const engine = new runtime.CharacterExpressionEngine({ manifest: fixture(), now: () => now });
    const previous = engine.applyDecision({ context: engine.context(), eventId: 'hold', source: 'chat',
      backgroundSelection: { stateId, actions: [] }, explicitPlayback: { stateId } }).snapshot.schedule.current!;
    engine.applyFeedback({ playbackToken: previous.playbackToken, actionId: previous.actionId, status: 'started', occurredAtMs: now });
    const result = engine.applyDecision({ context: engine.context(), eventId: 'leave', source: 'chat',
      backgroundSelection: null, preserveExplicitPlaybackToken: previous.playbackToken });
    expect(result.snapshot).toMatchObject({ background: null, stateId: 'rest' });
    expect(result.effects.filter(effect => effect.type === 'play').map(effect => effect.action.stateId)).toEqual(['rest']);
    now = 30_000;
    expect(engine.advance().snapshot).toMatchObject({ background: null, stateId: 'rest' });
  });
  it('明确退出背景不抢占真实任务，任务结束后也不恢复旧背景', () => {
    const engine = new runtime.CharacterExpressionEngine({ manifest: fixture(), now: () => 0 });
    engine.applyDecision({ context: engine.context(), eventId: 'hold', source: 'chat', backgroundSelection: { stateId: 'soft', actions: [] },
      expressionPlan: { states: [{ stateId: 'bright', score: 1, minStrength: 0, maxStrength: 1, lifetime: 'condition', when: { taskRunning: true }, actions: [] }] } });
    const working = engine.updateRuntimeFacts({ taskRunning: true }).snapshot.schedule.current!;
    const result = engine.applyDecision({ context: engine.context(), eventId: 'leave', source: 'chat', backgroundSelection: null });
    expect(result.snapshot).toMatchObject({ background: null, stateId: 'bright' });
    expect(result.snapshot.schedule.current?.playbackToken).toBe(working.playbackToken);
    expect(result.effects).toEqual([]);
    expect(engine.updateRuntimeFacts({ taskRunning: false }).snapshot.stateId).toBe('rest');
  });
  it('新的长期选择立即替换仍在循环的旧背景，不遗留脱离所有权的候选', () => {
    const engine = new runtime.CharacterExpressionEngine({ manifest: fixture(), now: () => 0 });
    const previous = engine.applyDecision({ context: engine.context(), eventId: 'old', source: 'chat', backgroundSelection: { stateId: 'soft', actions: [] } }).snapshot.schedule.current!;
    engine.applyFeedback({ playbackToken: previous.playbackToken, actionId: previous.actionId, status: 'started', occurredAtMs: 0 });
    expect(engine.applyDecision({ context: engine.context(), eventId: 'new', source: 'chat',
      backgroundSelection: { stateId: 'bright', actions: [] } }).snapshot).toMatchObject({ stateId: 'bright', background: { stateId: 'bright' } });
  });
  it('自主空配对和迟到的明确退出均不能清空已接纳背景', () => {
    const engine = new runtime.CharacterExpressionEngine({ manifest: fixture(), now: () => 0 });
    engine.applyDecision({ context: engine.context(), eventId: 'hold', source: 'chat', backgroundSelection: { stateId: 'soft', actions: [] } });
    engine.applyDecision({ context: engine.context(), eventId: 'autonomous', source: 'autonomous', backgroundSelection: null });
    const stale = engine.context(); engine.invalidateContext();
    engine.applyDecision({ context: stale, eventId: 'stale', source: 'chat', backgroundSelection: null });
    expect(engine.snapshot()).toMatchObject({ stateId: 'soft', background: { stateId: 'soft' } });
  });
  it.each(['soft-a', 'soft-b'])('长期状态持续十秒后转为同状态短时动作 %s，从本次接纳计时且恢复不插待机', actionId => {
    let now = 0;
    const engine = new runtime.CharacterExpressionEngine({ manifest: fixture(), now: () => now });
    const initial = engine.applyDecision({ context: engine.context(), eventId: 'background', source: 'chat',
      backgroundSelection: { stateId: 'soft', actions: [{ actionId: 'soft-a', score: 1 }] } });
    const background = initial.snapshot.schedule.current!;
    engine.applyFeedback({ playbackToken: background.playbackToken, actionId: background.actionId, status: 'started', occurredAtMs: now });
    now = 10_000;
    const reaction = engine.applyDecision({ context: engine.context(), eventId: 'reaction', source: 'chat',
      moodUpdate: { summary: '回应', strength: .8 }, expressionPlan: { states: [
        { stateId: 'soft', score: 1, minStrength: 0, maxStrength: 1, actions: [{ actionId, score: 1 }] }
      ] } });
    expect(reaction.snapshot.schedule.current?.actionId).toBe(actionId);
    expect(reaction.effects.filter(effect => effect.type === 'play').every(effect => effect.action.stateId === 'soft')).toBe(true);
    const current = reaction.snapshot.schedule.current!;
    if (current.startedAtMs === null) engine.applyFeedback({ playbackToken: current.playbackToken, actionId, status: 'started', occurredAtMs: now });
    now = 12_999;
    expect(engine.advance().snapshot.schedule.current?.playbackToken).toBe(current.playbackToken);
    now = 13_000;
    const restored = engine.advance();
    expect(restored.snapshot.schedule.current?.actionId).toBe('soft-a');
    expect(restored.snapshot).toMatchObject({ stateId: 'soft', stateEnteredAtMs: 0, background: { stateId: 'soft', enteredAtMs: 0 } });
    expect(restored.effects.filter(effect => effect.type === 'play').every(effect => effect.action.stateId === 'soft')).toBe(true);
  });
  it('背景与活动共用状态时退出事件同时撤销两种播放资格', () => {
    let now = 0;
    const manifest = fixture();
    manifest.states[1]!.exitConditions = [{ mode: 'any', clauses: [{ kind: 'event', event: 'drag-end' }] }];
    const engine = new runtime.CharacterExpressionEngine({ manifest, now: () => now });
    engine.applyDecision({ context: engine.context(), eventId: 'both', source: 'chat',
      backgroundSelection: { stateId: 'bright', actions: [] }, expressionPlan: movingPlan });
    engine.updateRuntimeFacts({ moving: true });
    now = 3000;
    const result = engine.recordEvent({ id: 'exit', type: 'drag-end', occurredAtMs: now });
    expect(result.snapshot).toMatchObject({ stateId: 'rest', background: null });
  });
  it('有限背景动画在十分钟内每次完成都续播本状态，不插入待机', () => {
    let now = 0;
    const manifest = fixture();
    manifest.actions.find(action => action.id === 'soft-a')!.loopPolicy = 'presentation';
    const engine = new runtime.CharacterExpressionEngine({ manifest, now: () => now });
    let result = engine.applyDecision({ context: engine.context(), eventId: 'background', source: 'chat',
      backgroundSelection: { stateId: 'soft', actions: [{ actionId: 'soft-a', score: 1 }] } });
    for (let cycle = 0; cycle < 20; cycle++) {
      const current = result.snapshot.schedule.current!;
      engine.applyFeedback({ playbackToken: current.playbackToken, actionId: current.actionId, status: 'started', occurredAtMs: now });
      now += 30_000;
      result = engine.applyFeedback({ playbackToken: current.playbackToken, actionId: current.actionId, status: 'completed', occurredAtMs: now });
      expect(result.effects.filter(effect => effect.type === 'play').map(effect => effect.action.stateId)).toEqual(['soft']);
    }
    expect(result.snapshot).toMatchObject({ stateId: 'soft', stateEnteredAtMs: 0, background: { stateId: 'soft', enteredAtMs: 0 } });
  });
  it('未知状态、错配动作、关闭推断和无资源选择都不能替换有效背景', () => {
    const manifest = fixture();
    manifest.skins[0]!.presentations = manifest.skins[0]!.presentations.filter(item => !item.actionId.startsWith('bright'));
    const engine = new runtime.CharacterExpressionEngine({ manifest, now: () => 0 });
    engine.applyDecision({ context: engine.context(), eventId: 'valid', source: 'chat',
      backgroundSelection: { stateId: 'soft', actions: [] } });
    for (const [index, backgroundSelection] of [
      { stateId: 'missing', actions: [] }, { stateId: 'soft', actions: [{ actionId: 'bright-a', score: 1 }] },
      { stateId: 'rest', actions: [] }, { stateId: 'bright', actions: [{ actionId: 'bright-a', score: 1 }] }
    ].entries()) {
      expect(engine.applyDecision({ context: engine.context(), eventId: String(index), source: 'chat', backgroundSelection })
        .snapshot.background?.stateId).toBe('soft');
    }
  });
  it('短时心情结束后恢复背景，同状态短时所有权不会删除背景', () => {
    let now = 0;
    const engine = new runtime.CharacterExpressionEngine({ manifest: fixture(), now: () => now });
    engine.applyDecision({ context: engine.context(), eventId: 'bg', source: 'chat', backgroundSelection: { stateId: 'soft', actions: [] } });
    now = 2500;
    const reaction = engine.applyDecision({ context: engine.context(), eventId: 'mood', source: 'chat',
      moodUpdate: { summary: '愉快', strength: 1 }, expressionPlan: { states: [plan.states[0]!] } });
    expect(reaction.snapshot.stateId).toBe('bright');
    now = 5500;
    expect(engine.advance().snapshot.stateId).toBe('soft');
    engine.applyDecision({ context: engine.context(), eventId: 'same-state', source: 'chat', expressionPlan: {
      states: [{ stateId: 'soft', score: 1, minStrength: 0, maxStrength: 1, actions: [] }]
    } });
    now = 9000;
    expect(engine.advance().snapshot).toMatchObject({ stateId: 'soft', background: { stateId: 'soft', enteredAtMs: 0 } });
  });
  it.each(['normal', 'resistant'] as const)('背景动作中断策略 %s 在静态首帧确认后仍能结束冷却并续播', interrupt => {
    let now = 0;
    const manifest = fixture();
    const action = manifest.actions.find(action => action.id === 'soft-a')!;
    action.loopPolicy = 'never'; action.cooldownMs = 5000; action.durationMs = 750; action.interrupt = interrupt;
    const engine = new runtime.CharacterExpressionEngine({ manifest, now: () => now });
    const initial = engine.applyDecision({ context: engine.context(), eventId: 'bg', source: 'chat',
      backgroundSelection: { stateId: 'soft', actions: [{ actionId: 'soft-a', score: 1 }] } });
    expect(initial.effects.find(effect => effect.type === 'play')).toMatchObject({ playback: { mode: 'once', durationMs: 750 } });
    const current = initial.snapshot.schedule.current!;
    engine.applyFeedback({ playbackToken: current.playbackToken, actionId: current.actionId, status: 'started', occurredAtMs: now });
    now = 750;
    const ended = engine.applyFeedback({ playbackToken: current.playbackToken, actionId: current.actionId, status: 'completed', occurredAtMs: now });
    expect(ended.snapshot.stateId).toBe('soft');
    expect(ended.effects.find(effect => effect.type === 'play')).toMatchObject({ action: { actionId: 'soft-a' }, playback: { mode: 'static' } });
    const still = ended.snapshot.schedule.current!;
    engine.applyFeedback({ playbackToken: still.playbackToken, actionId: still.actionId, status: 'started', occurredAtMs: now });
    expect(engine.advance().effects).toEqual([]);
    now = 5750;
    const resumed = engine.advance();
    expect(resumed.effects.find(effect => effect.type === 'play')).toMatchObject({ action: { actionId: 'soft-a' }, playback: { mode: 'once', durationMs: 750 } });
    const playing = resumed.snapshot.schedule.current!;
    engine.applyFeedback({ playbackToken: playing.playbackToken, actionId: playing.actionId, status: 'started', occurredAtMs: now });
    if (interrupt === 'resistant') {
      now = 6000;
      expect(engine.applyDecision({ context: engine.context(), eventId: 'temporary', source: 'chat',
        moodUpdate: { summary: '愉快', strength: 1 }, expressionPlan: { states: [plan.states[0]!] } })
        .snapshot.schedule.current?.playbackToken).toBe(playing.playbackToken);
    }
  });
  it('退出条件或全部选中素材失败永久清除背景，reset 与换皮肤同样清理', () => {
    let now = 0;
    const manifest = fixture();
    manifest.states[2]!.exitConditions = [{ mode: 'any', clauses: [{ kind: 'event', event: 'drag-end' }] }];
    const engine = new runtime.CharacterExpressionEngine({ manifest, now: () => now });
    const select = (id: string) => engine.applyDecision({ context: engine.context(), eventId: id, source: 'chat',
      backgroundSelection: { stateId: 'soft', actions: [{ actionId: 'soft-a', score: 1 }] } });
    select('first');
    now = 100;
    expect(engine.recordEvent({ id: 'exit', type: 'drag-end', occurredAtMs: now }).snapshot.background).toBeNull();
    now = 3000;
    expect(engine.advance().snapshot.stateId).toBe('rest');
    const current = select('second').snapshot.schedule.current!;
    expect(engine.applyFeedback({ playbackToken: current.playbackToken, actionId: current.actionId,
      status: 'failed', occurredAtMs: now }).snapshot.background).toBeNull();
    engine.reset();
    select('third');
    expect(engine.replaceCharacter(manifest, 'base').snapshot.background).toBeNull();
    select('fourth');
    expect(engine.reset().snapshot.background).toBeNull();
  });
  it('具有进入条件的背景恢复不重复消费边沿，暂停期间退出事件仍可令其失效', () => {
    let now = 0;
    const manifest = fixture();
    manifest.states[2]!.enterConditions = [{ mode: 'any', clauses: [{ kind: 'event', event: 'user-interaction' }] }];
    manifest.states[2]!.exitConditions = [{ mode: 'any', clauses: [{ kind: 'event', event: 'drag-end' }] }];
    const engine = new runtime.CharacterExpressionEngine({ manifest, now: () => now });
    const select = (id: string) => engine.applyDecision({ context: engine.context(), eventId: id, source: 'chat',
      backgroundSelection: { stateId: 'soft', actions: [] }, expressionPlan: movingPlan });
    expect(select('missing-enter').snapshot.background).toBeNull();
    engine.recordEvent({ id: 'enter', type: 'user-interaction', occurredAtMs: now });
    select('entered');
    now = 100;
    engine.updateRuntimeFacts({ moving: true });
    expect(engine.updateRuntimeFacts({ moving: false }).snapshot.stateId).toBe('soft');
    engine.updateRuntimeFacts({ moving: true });
    now = 200;
    engine.recordEvent({ id: 'exit', type: 'drag-end', occurredAtMs: now });
    expect(engine.updateRuntimeFacts({ moving: false }).snapshot).toMatchObject({ stateId: 'rest', background: null });
  });
  it('同一状态的活动与背景具有独立动作候选，任务结束只恢复背景动作', () => {
    let now = 0;
    const engine = new runtime.CharacterExpressionEngine({ manifest: fixture(), now: () => now });
    engine.applyDecision({ context: engine.context(), eventId: 'same-state', source: 'chat',
      backgroundSelection: { stateId: 'bright', actions: [{ actionId: 'bright-a', score: 1 }] }, expressionPlan: {
        states: [{ stateId: 'bright', score: 1, minStrength: 0, maxStrength: 1, lifetime: 'condition',
          when: { taskRunning: true }, actions: [{ actionId: 'bright-b', score: 1 }] }]
      } });
    expect(engine.updateRuntimeFacts({ taskRunning: true }).snapshot.schedule.current?.actionId).toBe('bright-b');
    now = 100;
    expect(engine.updateRuntimeFacts({ taskRunning: false }).snapshot.schedule.current?.actionId).toBe('bright-a');
  });
  it('新的明确长期选择立即替换旧背景，单动作仍一遍并恢复独立背景', () => {
    let now = 0;
    const engine = new runtime.CharacterExpressionEngine({ manifest: fixture(), now: () => now });
    engine.applyDecision({ context: engine.context(), eventId: 'old', source: 'chat', backgroundSelection: { stateId: 'soft', actions: [] } });
    now = 100;
    const explicit = engine.applyDecision({ context: engine.context(), eventId: 'new', source: 'chat',
      backgroundSelection: { stateId: 'bright', actions: [] }, explicitPlayback: { stateId: 'bright', actionId: 'bright-a' } });
    expect(explicit.effects.find(effect => effect.type === 'play')).toMatchObject({ playback: { mode: 'once' } });
    const current = explicit.snapshot.schedule.current!;
    engine.applyFeedback({ playbackToken: current.playbackToken, actionId: current.actionId, status: 'started', occurredAtMs: now });
    now = 200;
    const ended = engine.applyFeedback({ playbackToken: current.playbackToken, actionId: current.actionId, status: 'completed', occurredAtMs: now });
    expect(ended.snapshot).toMatchObject({ stateId: 'bright', background: { stateId: 'bright' } });
    expect(ended.effects.find(effect => effect.type === 'play')).toMatchObject({ playback: { mode: 'loop' } });
  });
  it('独立长期选择持续十分钟且心情归零、空结果和失效响应都不驱逐', () => {
    let now = 0;
    const engine = new runtime.CharacterExpressionEngine({ manifest: fixture(), now: () => now });
    const result = engine.applyDecision({ context: engine.context(), eventId: 'background', source: 'chat',
      backgroundSelection: { stateId: 'soft', actions: [{ actionId: 'soft-a', score: 1 }] } });
    expect(result.snapshot.stateId).toBe('soft');
    const current = result.snapshot.schedule.current!;
    engine.applyFeedback({ playbackToken: current.playbackToken, actionId: current.actionId, status: 'started', occurredAtMs: now });
    for (const time of [30_000, 600_000]) {
      now = time;
      const advanced = engine.advance();
      expect(advanced.snapshot.stateId).toBe('soft');
      expect(advanced.effects.filter(effect => effect.type === 'play').every(effect => effect.action.stateId === 'soft')).toBe(true);
    }
    engine.applyDecision({ context: engine.context(), eventId: 'empty', source: 'chat',
      moodUpdate: { summary: '平静', strength: 0 }, expressionPlan: { states: [] } });
    const stale = engine.context();
    engine.invalidateContext();
    engine.applyDecision({ context: stale, eventId: 'stale', source: 'chat',
      backgroundSelection: { stateId: 'bright', actions: [] } });
    expect(engine.advance().snapshot).toMatchObject({ stateId: 'soft', stateEnteredAtMs: 0,
      background: { stateId: 'soft', enteredAtMs: 0 } });
  });
  it('活动结束恢复独立背景，活动候选自身不会成为背景', () => {
    let now = 0;
    const engine = new runtime.CharacterExpressionEngine({ manifest: fixture(), now: () => now });
    engine.applyDecision({ context: engine.context(), eventId: 'both', source: 'chat',
      backgroundSelection: { stateId: 'soft', actions: [] }, expressionPlan: movingPlan });
    now = 100;
    expect(engine.updateRuntimeFacts({ moving: true }).snapshot.stateId).toBe('bright');
    now = 200;
    expect(engine.updateRuntimeFacts({ moving: false }).snapshot).toMatchObject({ stateId: 'soft',
      stateEnteredAtMs: 200, background: { stateId: 'soft', enteredAtMs: 0 } });
    engine.reset();
    engine.applyDecision({ context: engine.context(), eventId: 'activity-only', source: 'chat', expressionPlan: movingPlan });
    engine.updateRuntimeFacts({ moving: true });
    expect(engine.updateRuntimeFacts({ moving: false }).snapshot).toMatchObject({ stateId: 'rest', background: null });
  });
  it.each(['实际移动', '准备移动'] as const)('%s 优先于高分聊天活动，结束后恢复正常选择', mode => {
    let now = 0;
    const engine = new runtime.CharacterExpressionEngine({ manifest: fixture(), now: () => now, random: () => 0 });
    engine.applyDecision({ context: engine.context(), eventId: 'overlap', source: 'chat', expressionPlan: { states: [
      { stateId: 'bright', score: .2, minStrength: 0, maxStrength: 1,
        when: { moving: true }, lifetime: 'condition', actions: [] },
      { stateId: 'soft', score: 1, minStrength: 0, maxStrength: 1,
        when: { chatting: true }, lifetime: 'condition', actions: [] }
    ] } });
    if (mode === '准备移动') {
      engine.updateRuntimeFacts({ chatting: true });
      expect(engine.hasEligibleExpressionFor({ moving: true }, 'moving')).toBe(true);
    }
    const moving = (mode === '实际移动' ? engine.updateRuntimeFacts({ moving: true })
      : engine.prepareActivity('moving')).snapshot.schedule.current!;
    expect(moving.stateId).toBe('bright');
    engine.applyFeedback({ playbackToken: moving.playbackToken, actionId: moving.actionId, status: 'started', occurredAtMs: now });
    now = 2100;
    expect(engine.updateRuntimeFacts({ chatting: true }).snapshot.stateId).toBe('bright');
    expect(engine.hasEligibleExpressionFor({ moving: true }, 'moving')).toBe(true);
    const ended = mode === '实际移动' ? engine.updateRuntimeFacts({ moving: false }) : engine.releasePreparedActivity();
    expect(ended.snapshot.stateId).toBe('soft');
  });
  it('真实活动优先于高分普通心情，并在结束后保留心情', () => {
    let now = 0;
    const engine = new runtime.CharacterExpressionEngine({ manifest: fixture(), now: () => now, random: () => 0 });
    engine.applyDecision({ context: engine.context(), eventId: 'mood-plan', source: 'chat', expressionPlan: { states: [
      { stateId: 'bright', score: 1, minStrength: 0, maxStrength: 1, actions: [] }
    ] } });
    engine.applyDecision({ context: engine.context(), eventId: 'activity-plan', source: 'chat', expressionPlan: { states: [
      { stateId: 'soft', score: .2, minStrength: 0, maxStrength: 1,
        when: { moving: true }, lifetime: 'condition', actions: [] }
    ] } });
    expect(engine.snapshot().stateId).toBe('bright');
    now = 100;
    expect(engine.hasEligibleExpressionFor({ moving: true }, 'moving')).toBe(true);
    expect(engine.updateRuntimeFacts({ moving: true }).snapshot.stateId).toBe('soft');
    expect(engine.updateRuntimeFacts({ moving: false }).snapshot.stateId).toBe('bright');
  });
  it('新心情不删除既有活动候选，但旧心情候选不能绑定新心情', () => {
    let now = 0;
    const engine = new runtime.CharacterExpressionEngine({ manifest: fixture(), now: () => now, random: () => 0 });
    engine.applyDecision({ context: engine.context(), eventId: 'old-mood', source: 'chat',
      moodUpdate: { summary: '旧心情', strength: .8 }, expressionPlan: { states: [
        { stateId: 'bright', score: 1, minStrength: .02, maxStrength: 1, actions: [] },
        { stateId: 'soft', score: .2, minStrength: 0, maxStrength: 1,
          when: { moving: true }, lifetime: 'condition', actions: [] }
      ] } });
    const oldToken = engine.snapshot().schedule.current!.playbackToken;
    now = 100;
    const updated = engine.applyDecision({ context: engine.context(), eventId: 'new-mood', source: 'chat',
      moodUpdate: { summary: '新心情', strength: .4 } });
    expect(updated.snapshot.schedule.current?.playbackToken).toBe(oldToken);
    expect(engine.updateRuntimeFacts({ moving: true }).snapshot.stateId).toBe('soft');
    expect(engine.updateRuntimeFacts({ moving: false }).snapshot.stateId).toBe('rest');
    expect(engine.snapshot().mood?.summary).toBe('新心情');
  });
  it.each(['空计划', '新心情'] as const)('%s 不终止或续期已开始的 episode', update => {
    let now = 0;
    const engine = new runtime.CharacterExpressionEngine({ manifest: fixture(), now: () => now, random: () => 0 });
    const current = engine.applyDecision({ context: engine.context(), eventId: 'episode', source: 'chat',
      moodUpdate: { summary: '原心情', strength: .8 }, expressionPlan: {
        states: [{ stateId: 'bright', score: 1, minStrength: .02, maxStrength: 1, actions: [] }]
      } }).snapshot.schedule.current!;
    engine.applyFeedback({ playbackToken: current.playbackToken, actionId: current.actionId, status: 'started', occurredAtMs: now });
    now = 100;
    const decision = update === '空计划'
      ? { context: engine.context(), eventId: 'empty', source: 'chat' as const, expressionPlan: { states: [] } }
      : { context: engine.context(), eventId: 'mood', source: 'chat' as const, moodUpdate: { summary: '新心情', strength: .4 } };
    const retained = engine.applyDecision(decision);
    expect(retained.effects).toEqual([]);
    expect(retained.snapshot.schedule.current?.playbackToken).toBe(current.playbackToken);
    expect(retained.snapshot.schedule.current?.startedAtMs).toBe(0);
    now = 2999;
    expect(engine.advance().snapshot.schedule.current?.playbackToken).toBe(current.playbackToken);
    now = 3000;
    expect(engine.advance().snapshot.stateId).toBe('rest');
    now = 13_000;
    expect(engine.advance().snapshot.stateId).toBe('rest');
  });
  it('无条件 episode 不因聊天事实结束而失效', () => {
    const engine = new runtime.CharacterExpressionEngine({ manifest: fixture(), now: () => 0 });
    const current = engine.applyDecision({ context: engine.context(), eventId: 'chat-mood', source: 'chat',
      moodUpdate: { summary: '聊天后的感受', strength: .8 }, expressionPlan: {
        states: [{ stateId: 'bright', score: 1, minStrength: .02, maxStrength: 1, actions: [] }]
      } }).snapshot.schedule.current!;
    engine.updateRuntimeFacts({ chatting: true });
    expect(engine.updateRuntimeFacts({ chatting: false }).snapshot.schedule.current?.playbackToken).toBe(current.playbackToken);
  });
  it('活动准备复用唯一调度器且不写入真实事实，释放和 reset 都清理准备', () => {
    const engine = new runtime.CharacterExpressionEngine({ manifest: fixture(), now: () => 0, random: () => 0 });
    engine.applyDecision({ context: engine.context(), eventId: 'moving-plan', source: 'chat', expressionPlan: movingPlan });
    const prepared = engine.prepareActivity('moving');
    const token = prepared.snapshot.schedule.current?.playbackToken;
    expect(token).toBeTruthy();
    expect(prepared.snapshot.stateId).toBe('bright');
    const current = prepared.snapshot.schedule.current!;
    engine.applyFeedback({ playbackToken: current.playbackToken, actionId: current.actionId, status: 'started', occurredAtMs: 0 });
    expect(engine.prepareActivity('moving').snapshot.schedule.current?.playbackToken).toBe(token);
    expect(engine.releasePreparedActivity().snapshot.stateId).toBe('rest');
    expect(engine.advance().snapshot.stateId).toBe('rest');
    expect(engine.prepareActivity('moving').snapshot.schedule.current?.playbackToken).not.toBe(token);
    const reset = engine.reset();
    expect(reset.snapshot.stateId).toBe('rest');
    expect(reset.snapshot.schedule.current).toBeNull();
    expect(engine.advance().snapshot.stateId).toBe('rest');
  });
  it('无活动候选时准备不返回 idle 播放 token', () => {
    const engine = new runtime.CharacterExpressionEngine({ manifest: fixture(), now: () => 0 });
    const result = engine.prepareActivity('moving');
    expect(result.snapshot.schedule.current).toBeNull();
    expect(result.effects).toEqual([]);
  });
  it('准备播放失败后清除准备所有权，再次准备不返回 idle 或失败 token', () => {
    let now = 0;
    const engine = new runtime.CharacterExpressionEngine({ manifest: fixture(), now: () => now, random: () => 0 });
    engine.applyDecision({ context: engine.context(), eventId: 'moving-plan', source: 'chat', expressionPlan: movingPlan });
    const current = engine.prepareActivity('moving').snapshot.schedule.current!;
    const failed = engine.applyFeedback({ playbackToken: current.playbackToken, actionId: current.actionId,
      status: 'failed', occurredAtMs: now });
    expect(failed.snapshot.stateId).toBe('rest');
    expect(engine.releasePreparedActivity().effects).toEqual([]);
    const retry = engine.prepareActivity('moving');
    expect(retry.snapshot.stateId).toBe('rest');
    expect(retry.snapshot.schedule.current?.playbackToken).not.toBe(current.playbackToken);
    expect(retry.effects).toEqual([]);
  });
  it('准备 token 超过开始截止后重新校验并生成新活动 token', () => {
    let now = 0;
    const engine = new runtime.CharacterExpressionEngine({ manifest: fixture(), now: () => now, random: () => 0 });
    engine.applyDecision({ context: engine.context(), eventId: 'moving-plan', source: 'chat', expressionPlan: movingPlan });
    const stale = engine.prepareActivity('moving').snapshot.schedule.current!;
    now = stale.startDeadlineAtMs!;
    const retried = engine.prepareActivity('moving');
    expect(retried.snapshot.stateId).toBe('bright');
    expect(retried.snapshot.schedule.current?.playbackToken).not.toBe(stale.playbackToken);
  });
  it('活动计划换代后从当前候选重新接纳，不复用抗中断的旧准备 token', () => {
    const manifest = fixture();
    manifest.actions.find(action => action.id === 'bright-a')!.interrupt = 'resistant';
    const engine = new runtime.CharacterExpressionEngine({ manifest, now: () => 0, random: () => 0 });
    engine.applyDecision({ context: engine.context(), eventId: 'old-moving', source: 'chat', expressionPlan: movingPlan });
    const old = engine.prepareActivity('moving').snapshot.schedule.current!;
    engine.applyFeedback({ playbackToken: old.playbackToken, actionId: old.actionId, status: 'started', occurredAtMs: 0 });
    const retained = engine.applyDecision({ context: engine.context(), eventId: 'new-moving', source: 'chat', expressionPlan: {
      states: [{ stateId: 'soft', score: 1, minStrength: 0, maxStrength: 1,
        when: { moving: true }, lifetime: 'condition', actions: [{ actionId: 'soft-a', score: 1 }] }]
    } });
    expect(retained.snapshot.schedule.current?.playbackToken).toBe(old.playbackToken);
    const prepared = engine.prepareActivity('moving');
    expect(prepared.snapshot.stateId).toBe('soft');
    expect(prepared.snapshot.schedule.current?.actionId).toBe('soft-a');
    expect(prepared.snapshot.schedule.current?.playbackToken).not.toBe(old.playbackToken);
  });
  it('普通轮次失效与心情 TTL 都不删除已接纳的活动能力', () => {
    let now = 0;
    const engine = new runtime.CharacterExpressionEngine({ manifest: fixture(), now: () => now });
    engine.applyDecision({ context: engine.context(), eventId: 'moving-plan', source: 'chat', expressionPlan: movingPlan });
    engine.invalidateContext();
    now = 1_200_001;
    expect(engine.prepareActivity('moving').snapshot.stateId).toBe('bright');
  });
  it('明确播放锁仍生效时不宣称另一条件候选会同步', () => {
    const engine = new runtime.CharacterExpressionEngine({ manifest: fixture(), now: () => 0 });
    engine.applyDecision({ context: engine.context(), eventId: 'plan', source: 'chat', expressionPlan: movingPlan });
    const current = engine.playExplicit('soft').snapshot.schedule.current!;
    expect(engine.hasEligibleExpressionFor({ moving: true }, 'moving')).toBe(false);
    expect(engine.updateRuntimeFacts({ moving: true }).snapshot.schedule.current?.playbackToken).toBe(current.playbackToken);
  });
  it('移动不保留无条件动作，预检只读且动作级条件仍可提供移动资格', () => {
    const engine = new runtime.CharacterExpressionEngine({ manifest: fixture(), now: () => 0, random: () => 0 });
    engine.applyDecision({ context: engine.context(), eventId: 'mixed', source: 'chat', expressionPlan: { states: [
      { stateId: 'bright', score: 1, minStrength: 0, maxStrength: 1, actions: [
        { actionId: 'bright-a', score: 1 }, { actionId: 'bright-b', score: 1, when: { moving: true } }
      ] }
    ] } });
    const before = engine.snapshot();
    expect(engine.hasEligibleExpressionFor({ moving: true }, 'moving')).toBe(false);
    expect(engine.snapshot()).toEqual(before);
    expect(engine.prepareActivity('moving').snapshot).toEqual(before);
    expect(engine.updateRuntimeFacts({ moving: true }).snapshot.stateId).toBe('rest');
    const qualified = engine.applyDecision({ context: engine.context(), eventId: 'qualified', source: 'chat', expressionPlan: { states: [
      { stateId: 'bright', score: 1, minStrength: 0, maxStrength: 1,
        actions: [{ actionId: 'bright-b', score: 1, when: { moving: true } }] }
    ] } });
    expect(qualified.snapshot.schedule.current?.actionId).toBe('bright-b');
    expect(engine.hasEligibleExpressionFor({ moving: true }, 'moving')).toBe(true);
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
  it('资格查询纯读，要求明确 true 条件，尊重事件、冷却和推断开关', () => {
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
    expect(engine.hasEligibleExpressionFor({ moving: true }, 'moving')).toBe(true);
    now = 20_000;
    expect(engine.hasEligibleExpressionFor({ moving: true }, 'moving')).toBe(true);
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
  it('新心情不复用旧候选，旧情境、重置和另一实例的响应无法复活', () => {
    let now = 0;
    const engine = new runtime.CharacterExpressionEngine({ manifest: fixture(), now: () => now });
    const old = engine.context();
    engine.applyDecision({ context: old, eventId: 'one', source: 'chat', moodUpdate: { summary: '喜讯', strength: 1 }, expressionPlan: plan });
    const token = engine.snapshot().schedule.current!.playbackToken;
    engine.applyDecision({ context: engine.context(), eventId: 'two', source: 'chat', moodUpdate: { summary: '新感受', strength: .5 } });
    expect(engine.snapshot().schedule.current?.playbackToken).toBe(token);
    now = 3000;
    expect(engine.advance().snapshot.stateId).toBe('rest');
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
  it('计划过期结束持续循环；空计划不充当停止命令', () => {
    let now = 0;
    const engine = new runtime.CharacterExpressionEngine({ manifest: fixture(), now: () => now });
    engine.applyDecision({ context: engine.context(), eventId: 'plan', source: 'chat', moodUpdate: { summary: '高兴', strength: 1 }, expressionPlan: { ...plan, validForMs: 10_000 } });
    const current = engine.snapshot().schedule.current!;
    engine.applyFeedback({ playbackToken: current.playbackToken, actionId: current.actionId, status: 'started', occurredAtMs: now });
    now = 10_000;
    expect(engine.advance().snapshot.stateId).toBe('rest');
    const explicit = engine.playExplicit('bright').snapshot.schedule.current!;
    expect(engine.applyDecision({ context: engine.context(), eventId: 'empty', source: 'chat', expressionPlan: { states: [] } })
      .snapshot.schedule.current?.playbackToken).toBe(explicit.playbackToken);
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

