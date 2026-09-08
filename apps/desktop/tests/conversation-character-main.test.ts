import type { ModelRequest } from '@myself/agent-core';
import { expect, it, vi } from 'vitest';
import { characterManifestV3Schema } from '@myself/character-runtime';
import { resourceFields, v3Fixture } from '../../../packages/character-runtime/tests/character-v3-fixture';
import { CharacterBehaviorService } from '../src/main/characters/character-behavior-service';
import { CharacterBehaviorDirector } from '../src/main/characters/character-behavior-director';
import { ConversationChatAdapter } from '../src/main/conversation/conversation-chat-adapter';

async function fixture(stateOptions: { suggestedDurationMs?: number; agentInferable?: boolean } = {}) {
  let now = 0;
  const draft = v3Fixture();
  draft.states.push({ ...draft.states[0]!, id: 'joy', name: '飞扬', agentInferable: true, actionIds: ['wave', 'jump'], ...stateOptions });
  for (const id of ['wave', 'jump']) {
    draft.actions.push({ ...draft.actions[0]!, id, name: id === 'wave' ? '挥手' : '跳跃' });
    draft.skins[0]!.presentations.push({ ...draft.skins[0]!.presentations[0]!, actionId: id });
  }
  const motion = { getSnapshot: () => ({ revision: 0, timestampMs: now, position: { x: 0, y: 0 }, target: { x: 0, y: 0 }, direction: 'right' as const, moving: false, carrying: false }), requestIntent: vi.fn(() => null), applyTaskEvent: () => undefined, stop: () => undefined };
  const service = new CharacterBehaviorService({ store: { getActiveManifestV3: async () => characterManifestV3Schema.parse({ ...draft, ...resourceFields }) }, motion, now: () => now });
  await service.initialize();
  const saveMovementMode = vi.fn(async () => undefined);
  const director = new CharacterBehaviorDirector({ behavior: service, motion, now: () => now, initialGeneration: 'one', initialSettings: { movementMode: 0, proactivityMode: 'assistive' }, saveMovementMode });
  return { service, director, motion, saveMovementMode, time: (value: number) => { now = value; } };
}
it('明确状态经本地名称或模型描述直达，按作者时长或默认三秒驻留后回 idle', async () => {
  // 同一真实 Main 生命周期覆盖精确名称与仅 stateId 的描述定位，均允许非推断状态。
  for (const exact of [true, false]) {
    const f = await fixture({ agentInferable: false, ...(exact ? { suggestedDurationMs: 1200 } : {}) });
    const text = exact ? '播放飞扬状态' : '播放轻快喜悦状态';
    const prepared = await f.director.prepareUserPrompt(text);
    expect(prepared.explicitDirective).toMatchObject({ kind: 'play', target: { kind: 'state_name' } });
    expect(!!prepared.explicitPlaybackToken).toBe(exact);
    const context = f.director.captureExpressionContext();
    const reply = exact ? {} : await new ConversationChatAdapter({ respond: async request => {
      if (!request.responseContract) return { type: 'text', text: '轻快地陪你一会儿。' };
      expect(request.tools).toEqual([]);
      expect(request.toolChoice).toBe('none');
      expect(request.responseContract?.jsonSchema.properties).toHaveProperty('explicitPlayback');
      return { type: 'structured', structured_output: {
        moodUpdate: null, expressionPlan: null, requestKind: 'state', explicitPlayback: { stateId: 'joy' }, movementControl: { kind: 'keep' }
      } };
    } }).respond({ history: [], text, signal: new AbortController().signal, behaviorContext: f.director.getChatContext(),
      explicitPlaybackRequested: prepared.explicitDirective?.kind === 'play' && prepared.explicitPlaybackToken === undefined });
    await f.director.completeUserPrompt({ generation: 'one', eventId: 'state', context, explicitDirective: prepared.explicitDirective,
      ...(prepared.explicitPlaybackToken ? { explicitPlaybackToken: prepared.explicitPlaybackToken } : {}), ...reply });
    const current = f.service.snapshot()!.schedule.current!;
    const duration = exact ? 1200 : 3000;
    expect(f.service.snapshot()?.stateId).toBe('joy');
    expect(current.durationMs).toBe(duration);
    f.director.applyPlaybackFeedback({ playbackToken: current.playbackToken, actionId: current.actionId, status: 'started', occurredAtMs: 0 });
    f.time(duration - 1); f.director.advance();
    expect(f.service.snapshot()?.stateId).toBe('joy');
    f.time(duration); f.director.advance();
    expect(f.service.snapshot()?.stateId).toBe('rest');
    expect(f.motion.requestIntent).not.toHaveBeenCalled();
    expect(f.saveMovementMode).not.toHaveBeenCalled();
  }
});
it('Main新互动只失效在途结果，持续心情保留且普通完成提供独立事实', async () => {
  const f = await fixture();
  f.service.applyDecision({ context: f.service.context()!, source: 'chat', eventId: 'mood', moodUpdate: { summary: '持续开心', strength: 1 } });
  const old = f.service.context();
  await f.director.prepareUserPrompt('现在聊聊风景');
  expect(f.service.context()).not.toEqual(old);
  expect(f.director.getChatContext().expression?.mood?.summary).toBe('持续开心');
  await f.director.completeUserPrompt({ generation: 'one', eventId: 'old', context: old, explicitDirective: null,
    movementControl: { kind: 'set_mode', mode: 1 } });
  expect(f.saveMovementMode).not.toHaveBeenCalled();
  f.director.cancelActive();
  expect(f.service.snapshot()?.mood?.summary).toBe('持续开心');
  f.director.reset('two');
  expect(f.service.snapshot()?.mood).toBeNull();
});
it('聊天 null 经真实 Adapter 与 Main 后保留原心情修订及后续计划', async () => {
  const f = await fixture();
  f.service.applyDecision({ context: f.service.context()!, source: 'chat', eventId: 'first',
    moodUpdate: { summary: '持续开心', strength: 1 }, expressionPlan: { states: [{ stateId: 'joy', score: 1,
      minStrength: 0, maxStrength: 1, actions: [{ actionId: 'jump', score: 1 }] }] } });
  const mood = f.service.snapshot()!.mood!;
  const prepared = await f.director.prepareUserPrompt('继续聊聊');
  const context = f.director.captureExpressionContext();
  const respond = vi.fn(async (request: ModelRequest) => request.responseContract
    ? { type: 'structured' as const, structured_output: { moodUpdate: null, expressionPlan: null, requestKind: 'ambient', explicitPlayback: null, movementControl: { kind: 'keep' } } }
    : { type: 'text' as const, text: '我在听。' });
  const reply = await new ConversationChatAdapter({ respond }).respond({ text: prepared.originalText, history: [],
    behaviorContext: f.director.getChatContext(), signal: new AbortController().signal });
  expect(reply).not.toHaveProperty('moodUpdate');
  expect(reply.expressionPlan).toEqual({ states: [] });
  expect(respond).toHaveBeenCalledTimes(2);
  await f.director.completeUserPrompt({ generation: 'one', eventId: 'no-update', context, explicitDirective: prepared.explicitDirective, ...reply });
  f.time(2999); f.director.advance();
  expect(f.service.snapshot()?.schedule.current?.actionId).toBe('jump');
  f.time(3000); f.director.advance();
  expect(f.service.snapshot()?.mood).toMatchObject({ summary: mood.summary, revision: mood.revision, startedAtMs: mood.startedAtMs });
  expect(f.service.snapshot()?.stateId).toBe('rest');
  f.time(12999); f.director.advance();
  expect(f.service.snapshot()?.stateId).toBe('rest');
  // 成功无匹配退役旧候选；片段到期后不再重播，但心情修订保留。
  f.time(13000); f.director.advance();
  expect(f.service.snapshot()?.stateId).toBe('rest');
  expect(f.service.snapshot()?.mood?.revision).toBe(mood.revision);
  expect(f.motion.requestIntent).not.toHaveBeenCalled();
});
it('同轮两级表现不吞独立的一次运动，完成事件不重发运动', async () => {
  const f = await fixture();
  await f.director.prepareUserPrompt('开心地向左一点');
  await f.director.completeUserPrompt({ generation: 'one', eventId: 'motion', context: f.director.captureExpressionContext(), explicitDirective: null,
    movementControl: { kind: 'move_once', target: 'left', distance: 'near' }, moodUpdate: { summary: '开心', strength: 1 },
    expressionStatus: 'ready', requestKind: 'movement', expressionPlan: { states: [{ stateId: 'joy', score: 1, minStrength: 0, maxStrength: 1, when: { moving: true }, lifetime: 'condition', actions: [{ actionId: 'jump', score: 1 }] }] } });
  f.director.handleTaskEvent({ type: 'phase', phase: 'success' });
  f.director.handleTaskEvent({ type: 'phase', phase: 'success' });
  expect(f.motion.requestIntent).not.toHaveBeenCalled();
  const active = f.service.snapshot()!.schedule.current!;
  f.director.applyPlaybackFeedback({ playbackToken: active.playbackToken, actionId: active.actionId, status: 'started', occurredAtMs: 0 });
  expect(f.motion.requestIntent).toHaveBeenCalledOnce();
});
it('明确动作接纳同轮心情及后续计划，重复完成不重播，旧请求不能改心情', async () => {
  const f = await fixture();
  const prepared = await f.director.prepareUserPrompt('播放挥手动作');
  const context = f.director.captureExpressionContext();
  const active = f.service.snapshot()!.schedule.current!;
  f.service.applyPlaybackFeedback({ playbackToken: active.playbackToken, actionId: active.actionId, status: 'started', occurredAtMs: 0 });
  const input = { generation: 'one', eventId: 'turn-1', context, explicitDirective: prepared.explicitDirective,
    explicitPlaybackToken: prepared.explicitPlaybackToken!, moodUpdate: { summary: '今天获奖开心', strength: 1 },
    movementControl: { kind: 'move_once' as const, target: 'left' as const, distance: 'near' as const },
    expressionPlan: { states: [{ stateId: 'joy', score: 1, minStrength: 0, maxStrength: 1, actions: [{ actionId: 'jump', score: 1 }] }] } };
  await f.director.completeUserPrompt(input);
  expect(f.service.snapshot()?.schedule.current?.playbackToken).toBe(active.playbackToken);
  expect(f.service.snapshot()?.mood?.summary).toBe('今天获奖开心');
  // 即使绕过请求 Schema 返回越界运动，Main 仍只保留已开始的明确播放。
  expect(f.motion.requestIntent).not.toHaveBeenCalled();
  await f.director.completeUserPrompt(input);
  f.time(100); f.director.advance();
  expect(f.service.snapshot()?.stateId).toBe('rest');
  expect(f.service.snapshot()?.mood?.summary).toBe('今天获奖开心');
  await f.director.completeUserPrompt(input);
  expect(f.service.snapshot()?.stateId).toBe('rest');
  await f.director.prepareUserPrompt('另一个话题');
  await f.director.completeUserPrompt({ ...input, eventId: 'late', moodUpdate: { summary: '迟到', strength: 1 } });
  expect(f.service.snapshot()?.mood?.summary).toBe('今天获奖开心');
  const current = f.service.snapshot()?.schedule.current?.playbackToken;
  await f.director.completeUserPrompt({ generation: 'one', eventId: 'incomplete-explicit', context: f.director.captureExpressionContext(),
    explicitDirective: { kind: 'play', target: { kind: 'action_name', name: '兴奋跳跃' } }, explicitPlayback: { stateId: 'joy' } });
  expect(f.service.snapshot()?.schedule.current?.playbackToken).toBe(current);
  // 后续独立事件可以再次选择该状态；同轮 token 的完成本身不能重播。
  await f.director.prepareUserPrompt('又有一件开心的事');
  await f.director.completeUserPrompt({ generation: 'one', eventId: 'new-joy', context: f.director.captureExpressionContext(), explicitDirective: null,
    moodUpdate: { summary: '新的开心', strength: 1 }, expressionPlan: input.expressionPlan });
  f.time(2100); f.director.advance();
  expect(f.service.snapshot()?.schedule.current?.actionId).toBe('jump');
  expect(f.service.snapshot()?.schedule.current?.playbackToken).not.toBe(active.playbackToken);
  expect(f.service.snapshot()?.mood?.summary).toBe('新的开心');
});
