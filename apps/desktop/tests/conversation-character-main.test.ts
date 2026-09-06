import { expect, it, vi } from 'vitest';
import { characterManifestV3Schema } from '@myself/character-runtime';
import { resourceFields, v3Fixture } from '../../../packages/character-runtime/tests/character-v3-fixture';
import { CharacterBehaviorService } from '../src/main/characters/character-behavior-service';
import { CharacterBehaviorDirector } from '../src/main/characters/character-behavior-director';

async function fixture() {
  let now = 0;
  const draft = v3Fixture();
  draft.states.push({ ...draft.states[0]!, id: 'joy', name: '飞扬', agentInferable: true, actionIds: ['wave', 'jump'] });
  for (const id of ['wave', 'jump']) {
    draft.actions.push({ ...draft.actions[0]!, id, name: id === 'wave' ? '挥手' : '跳跃' });
    draft.skins[0]!.presentations.push({ ...draft.skins[0]!.presentations[0]!, actionId: id });
  }
  const motion = { getSnapshot: () => ({ revision: 0, timestampMs: now, position: { x: 0, y: 0 }, target: { x: 0, y: 0 }, direction: 'right' as const, moving: false, carrying: false }), requestIntent: vi.fn(() => null), applyTaskEvent: () => undefined, stop: () => undefined };
  const service = new CharacterBehaviorService({ store: { getActiveManifestV3: async () => characterManifestV3Schema.parse({ ...draft, ...resourceFields }) }, motion, now: () => now });
  await service.initialize();
  const saveMovementMode = vi.fn(async () => undefined);
  const director = new CharacterBehaviorDirector({ behavior: service, motion, initialGeneration: 'one', initialSettings: { movementMode: 0, proactivityMode: 'assistive' }, saveMovementMode });
  return { service, director, motion, saveMovementMode, time: (value: number) => { now = value; } };
}
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
it('同轮两级表现不吞独立的一次运动，完成事件不重发运动', async () => {
  const f = await fixture();
  await f.director.prepareUserPrompt('开心地向左一点');
  await f.director.completeUserPrompt({ generation: 'one', eventId: 'motion', context: f.director.captureExpressionContext(), explicitDirective: null,
    movementControl: { kind: 'move_once', target: 'left', distance: 'near' }, moodUpdate: { summary: '开心', strength: 1 },
    expressionPlan: { states: [{ stateId: 'joy', score: 1, minStrength: 0, maxStrength: 1, actions: [{ actionId: 'jump', score: 1 }] }] } });
  f.director.handleTaskEvent({ type: 'phase', phase: 'success' });
  f.director.handleTaskEvent({ type: 'phase', phase: 'success' });
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
    expressionPlan: { states: [{ stateId: 'joy', score: 1, minStrength: 0, maxStrength: 1, actions: [{ actionId: 'jump', score: 1 }] }] } };
  await f.director.completeUserPrompt(input);
  expect(f.service.snapshot()?.schedule.current?.playbackToken).toBe(active.playbackToken);
  expect(f.service.snapshot()?.mood?.summary).toBe('今天获奖开心');
  await f.director.completeUserPrompt(input);
  f.time(100); f.director.advance();
  expect(f.service.snapshot()?.schedule.current?.actionId).toBe('jump');
  await f.director.prepareUserPrompt('另一个话题');
  await f.director.completeUserPrompt({ ...input, eventId: 'late', moodUpdate: { summary: '迟到', strength: 1 } });
  expect(f.service.snapshot()?.mood?.summary).toBe('今天获奖开心');
  const current = f.service.snapshot()?.schedule.current?.playbackToken;
  await f.director.completeUserPrompt({ generation: 'one', eventId: 'incomplete-explicit', context: f.director.captureExpressionContext(),
    explicitDirective: { kind: 'play', target: { kind: 'action_name', name: '兴奋跳跃' } }, explicitPlayback: { stateId: 'joy' } });
  expect(f.service.snapshot()?.schedule.current?.playbackToken).toBe(current);
});
