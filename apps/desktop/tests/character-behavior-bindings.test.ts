import { readFileSync } from 'node:fs';
import { expect, test, vi } from 'vitest';
import { characterManifestV3Schema } from '@myself/character-runtime';
import { CharacterBehaviorService } from '../src/main/characters/character-behavior-service';
import { CharacterBehaviorDirector } from '../src/main/characters/character-behavior-director';
import type { CharacterBehaviorBindings } from '../src/main/characters/character-behavior-bindings';
import { CharacterProactivityScheduler } from '../src/main/characters/character-proactivity-scheduler';
import type { CharacterMotionSnapshot } from '../src/shared/character-motion-ipc';

const pair = (stateId: string, actionId = `${stateId}-action`) => ({ stateId, actionId });
const bindings: CharacterBehaviorBindings = { chatting: pair('state-7'), taskRunning: pair('state-6'), awaitingConfirmation: pair('state-7'),
  moving: pair('state', 'state-action'), success: pair('state-8'), error: pair('state-5'), praise: pair('state-8'), boredom: pair('state-3'), rest: pair('state-2') };

/** 真实默认素材契约只改显示名称，证明 Main 使用已验证 ID 用途，不按名称猜测。 */
async function fixture() {
  let now = 0;
  const manifest = characterManifestV3Schema.parse(JSON.parse(readFileSync(new URL('../resources/characters/default/compiled/manifest.json', import.meta.url), 'utf8')));
  manifest.states.forEach((state, index) => { state.name = `作者自定义${index}`; });
  const motion = { getSnapshot: () => ({ revision: 0, timestampMs: now, position: { x: 0, y: 0 }, target: { x: 0, y: 0 }, direction: 'right' as const, moving: false, carrying: false }), requestIntent: vi.fn((): CharacterMotionSnapshot | null => null), applyTaskEvent: () => undefined, stop: () => undefined };
  const service = new CharacterBehaviorService({ store: { getActiveManifestV3: async () => manifest }, motion, now: () => now, random: () => 0 });
  await service.initialize();
  const director = new CharacterBehaviorDirector({ behavior: service, motion, now: () => now, initialGeneration: 'turn', initialSettings: { movementMode: 0, proactivityMode: 'assistive' }, saveMovementMode: async () => undefined });
  const bind = (value = bindings, context = director.captureExpressionContext()!, lifecycle = director.getBehaviorLifecycleGeneration()) => {
    director.applyBehaviorBindings({ bindings: value, context, lifecycle });
  };
  const start = () => { const current = service.snapshot()!.schedule.current!; director.applyPlaybackFeedback({ playbackToken: current.playbackToken, actionId: current.actionId, status: 'started', occurredAtMs: now }); };
  // 用途和优先级测试从已显示的角色开始；冷加载由独立真实 Renderer 组合验证。
  start();
  return { director, service, motion, bind, start, time: (value: number) => { now = value; director.advance(); }, now: () => now };
}

test('聊天准备中接纳用途后立即思考，并跨动画循环保持到正文完成', async () => {
  const f = await fixture();
  f.director.handleTaskEvent({ type: 'phase', phase: 'thinking' });
  await f.director.prepareUserPrompt('你好');
  f.bind();
  expect(f.service.snapshot()?.stateId).toBe('state-7');
  for (let time = 0; time <= 31_000; time += 500) { f.time(time); f.start(); expect(f.service.snapshot()?.stateId).toBe('state-7'); }
  f.director.handleChatResponseFinished();
  expect(f.service.snapshot()?.stateId).toBe('idle');
  expect(f.director.getChatContext().runtime.chatting).toBe(false);
});

test('局部工作计划不能覆盖用途表中的思考，下轮仍立即思考', async () => {
  const f = await fixture(); f.bind();
  await f.director.prepareUserPrompt('稍后帮我工作');
  f.director.handleTaskEvent({ type: 'phase', phase: 'thinking' });
  await f.director.completeUserPrompt({ generation: 'turn', eventId: 'partial', context: f.director.captureExpressionContext(), explicitDirective: null,
    expressionPlan: { states: [{ stateId: 'state-6', score: 1, minStrength: 0, maxStrength: 1, when: { taskRunning: true }, lifetime: 'condition', actions: [{ actionId: 'state-6-action', score: 1 }] }] } });
  f.director.handleTaskEvent({ type: 'phase', phase: 'success' });
  await f.director.prepareUserPrompt('再聊一会'); f.director.handleTaskEvent({ type: 'phase', phase: 'thinking' });
  expect(f.service.snapshot()?.stateId).toBe('state-7');
});

test('授权卡只设置等待事实，同一动作跨聊天和等待用途仍合法', async () => {
  const f = await fixture(); f.bind(); f.director.handleTaskEvent({ type: 'phase', phase: 'thinking' });
  f.director.handleTaskEvent({ type: 'history_disclosure_required', requestId: 'history', targetProviderName: '模型', messageCount: 1, characterCount: 2 });
  expect(f.director.getChatContext().runtime).toMatchObject({ chatting: false, awaitingConfirmation: true, taskRunning: false });
  expect(f.service.snapshot()?.stateId).toBe('state-7');
  f.director.handleTaskEvent({ type: 'phase', phase: 'cancelled' });
  expect(f.director.getChatContext().runtime.awaitingConfirmation).toBe(false);
  expect(f.service.snapshot()?.stateId).toBe('idle');
});

test.each([{ phase: 'success' as const, stateId: 'state-8' }, { phase: 'error' as const, stateId: 'state-5' }, { phase: 'cancelled' as const, stateId: 'idle' }])('真实任务 $phase 同步终态反应且取消不表演失败', async ({ phase, stateId }) => {
  const f = await fixture(); f.bind();
  f.director.handleCapabilityTaskPhase('running'); expect(f.service.snapshot()?.stateId).toBe('state-6');
  f.director.handleCapabilityTaskPhase('waiting'); expect(f.service.snapshot()?.stateId).toBe('state-7');
  f.director.handleCapabilityTaskPhase('running'); expect(f.service.snapshot()?.stateId).toBe('state-6');
  f.director.handleCapabilityTaskPhase(phase);
  expect(f.director.getChatContext().runtime.taskRunning).toBe(false);
  expect(f.director.getChatContext().situation?.lastTask?.outcome).toBe(phase);
  expect(f.service.snapshot()?.stateId).toBe(stateId);
  f.director.handleTaskEvent({ type: 'phase', phase });
  expect(f.service.snapshot()?.stateId).toBe(stateId);
});

test('普通聊天success不生成任务结果，新聊天打断上个任务反应', async () => {
  const f = await fixture(); f.bind(); f.director.handleTaskEvent({ type: 'phase', phase: 'thinking' });
  f.director.handleTaskEvent({ type: 'phase', phase: 'success' });
  expect(f.service.snapshot()?.stateId).toBe('idle'); expect(f.director.getChatContext().situation?.lastTask).toBeNull();
  f.director.handleCapabilityTaskPhase('running'); f.director.handleCapabilityTaskPhase('success');
  expect(f.service.snapshot()?.stateId).toBe('state-8');
  await f.director.prepareUserPrompt('新的问题'); f.director.handleTaskEvent({ type: 'phase', phase: 'thinking' });
  expect(f.service.snapshot()?.stateId).toBe('state-7');
  f.director.cancelActive(); expect(f.service.snapshot()?.stateId).toBe('idle');
});

test('五分钟未互动背景幂等保持，互动只移除自己的空闲背景', async () => {
  const f = await fixture(); f.bind();
  expect(f.director.applyIdleBindings?.(299_999)).toBe(false);
  expect(f.director.applyIdleBindings?.(300_000)).toBe(true);
  expect(f.service.snapshot()?.background?.stateId).toBe('state-3');
  const entered = f.service.snapshot()?.background?.enteredAtMs;
  f.time(1000); f.director.applyIdleBindings?.(301_000);
  expect(f.service.snapshot()?.background?.enteredAtMs).toBe(entered);
  f.service.applyDecision({ context: f.service.context()!, eventId: 'mood', source: 'chat', moodUpdate: { summary: '保留的心情', strength: 1 } });
  await f.director.prepareUserPrompt('我回来了');
  expect(f.service.snapshot()?.background).toBeNull();
  expect(f.service.snapshot()?.mood?.summary).toBe('保留的心情');
});

test('五分钟用途不覆盖已有休息背景，后续自主idle选择不驱逐用途无聊', async () => {
  const f = await fixture(); f.bind();
  await f.director.completeUserPrompt({ generation: 'turn', eventId: 'rest', context: f.director.captureExpressionContext(), explicitDirective: null,
    backgroundSelection: { stateId: 'state-2', actions: [{ actionId: 'state-2-action', score: 1 }] } });
  expect(f.director.applyIdleBindings?.(300_000)).toBe(false); expect(f.service.snapshot()?.background?.stateId).toBe('state-2');
  const g = await fixture(); g.bind(); g.director.applyIdleBindings?.(300_000);
  g.director.applyAutonomousDecision({ lifecycle: g.director.getBehaviorLifecycleGeneration(), eventId: 'idle-reassessment', context: g.director.captureExpressionContext()!,
    backgroundSelection: { stateId: 'idle', actions: [{ actionId: 'idle-action', score: 1 }] } });
  expect(g.service.snapshot()?.background?.stateId).toBe('state-3');
});

test('旧上下文或生命周期不能接纳用途，reset要求重新匹配', async () => {
  const f = await fixture(); const context = f.director.captureExpressionContext()!; const lifecycle = f.director.getBehaviorLifecycleGeneration();
  await f.director.prepareUserPrompt('新的输入'); f.bind(bindings, context, lifecycle);
  expect(f.director.getChatContext().bindings).toBeUndefined();
  f.bind(); expect(f.director.getChatContext().bindings?.chatting).toEqual(pair('state-7'));
  f.director.reset('next'); expect(f.director.needsBehaviorBindings?.()).toBe(true);
  f.bind(bindings, f.director.captureExpressionContext()!, lifecycle);
  expect(f.director.getChatContext().bindings).toBeUndefined();
});

test('任务和移动首帧准备分别安装已匹配用途且不伪造运行事实', async () => {
  const f = await fixture(); f.bind();
  const prepared = f.director.prepareTaskPresentation(new AbortController().signal);
  expect(f.service.snapshot()?.stateId).toBe('state-6'); expect(f.director.getChatContext().runtime.taskRunning).toBe(false);
  f.start(); await prepared; f.director.cancelTaskPreparation();
  f.director.requestBehaviorPlan({ kind: 'move', direction: 'left', distance: 'near' }, 'explicit');
  expect(f.service.snapshot()?.stateId).toBe('state'); expect(f.motion.requestIntent).not.toHaveBeenCalled();
  f.start(); expect(f.motion.requestIntent).toHaveBeenCalledOnce();
});

test.each(['success', 'error'] as const)('任务%s只反应一个有界片段，三十秒内保持恢复的休息背景', async phase => {
  const f = await fixture(); f.bind();
  await f.director.completeUserPrompt({ generation: 'turn', eventId: 'explicit-rest', context: f.director.captureExpressionContext(), explicitDirective: null,
    backgroundSelection: { stateId: 'state-2', actions: [{ actionId: 'state-2-action', score: 1 }] } });
  f.director.handleCapabilityTaskPhase('running'); f.director.handleCapabilityTaskPhase(phase);
  expect(f.service.snapshot()?.stateId).toBe(phase === 'success' ? 'state-8' : 'state-5');
  for (let time = 0; time <= 30_000; time += 500) {
    f.time(time); f.start();
    if (time >= 3000) expect(f.service.snapshot()?.stateId).toBe('state-2');
  }
  expect(f.service.snapshot()?.background?.stateId).toBe('state-2');
});

test.each(['chat', 'autonomous'] as const)('无用途表的%s单次反应遇到新输入也立即撤销', async source => {
  const f = await fixture();
  const expressionPlan = { states: [{ stateId: 'state-8', score: 1, minStrength: 0, maxStrength: 1, lifetime: 'episode' as const, actions: [{ actionId: 'state-8-action', score: 1 }] }] };
  if (source === 'chat') await f.director.completeUserPrompt({ generation: 'turn', eventId: 'reaction', context: f.director.captureExpressionContext(), explicitDirective: null, expressionPlan });
  else f.director.applyAutonomousDecision({ lifecycle: f.director.getBehaviorLifecycleGeneration(), eventId: 'reaction', context: f.director.captureExpressionContext()!, expressionPlan });
  expect(f.service.snapshot()?.stateId).toBe('state-8');
  await f.director.prepareUserPrompt('一个新问题');
  expect(f.service.snapshot()?.stateId).toBe('idle');
});

test('配置生命周期失效时同步撤销已安装用途活动，不能继续复用旧思考', async () => {
  const f = await fixture(); f.bind(); f.director.handleTaskEvent({ type: 'phase', phase: 'thinking' });
  expect(f.service.snapshot()?.stateId).toBe('state-7');
  f.director.invalidateBehaviorLifecycle();
  expect(f.director.needsBehaviorBindings()).toBe(true);
  expect(f.service.snapshot()?.stateId).toBe('idle');
});

test('迟到自主背景不能破坏当前无聊背景的互动清理所有权', async () => {
  const f = await fixture(); f.bind(); f.director.applyIdleBindings(300_000);
  const stale = f.director.captureExpressionContext()!;
  f.service.invalidateContext();
  f.director.applyAutonomousDecision({ context: stale, lifecycle: f.director.getBehaviorLifecycleGeneration(), eventId: 'stale-background',
    backgroundSelection: { stateId: 'state-2', actions: [{ actionId: 'state-2-action', score: 1 }] } });
  expect(f.service.snapshot()?.background?.stateId).toBe('state-3');
  f.director.noteUserInteraction('click');
  expect(f.service.snapshot()?.background).toBeNull();
});

test.each([
  { source: 'autonomous', stateId: 'state-3', remains: false },
  { source: 'autonomous', stateId: 'state-2', remains: true },
  { source: 'chat', stateId: 'state-3', remains: true }
] as const)('有效$source选择$stateId后，互动按实际背景来源清理', async ({ source, stateId, remains }) => {
  const f = await fixture(); f.bind(); f.director.applyIdleBindings(300_000);
  const input = { context: f.director.captureExpressionContext()!, eventId: 'current-background',
    backgroundSelection: { stateId, actions: [{ actionId: `${stateId}-action`, score: 1 }] } };
  if (source === 'autonomous') f.director.applyAutonomousDecision({ ...input, lifecycle: f.director.getBehaviorLifecycleGeneration() });
  else await f.director.completeUserPrompt({ ...input, generation: 'turn', explicitDirective: null });
  expect(f.service.snapshot()?.background?.stateId).toBe(stateId);
  f.director.noteUserInteraction('click');
  expect(f.service.snapshot()?.background?.stateId ?? null).toBe(remains ? stateId : null);
});

test('首帧准备期间刷新事实不会被此前聊天或授权等待用途抢回', async () => {
  const f = await fixture(); f.bind(); f.director.handleTaskEvent({ type: 'phase', phase: 'thinking' });
  const prepared = f.director.prepareTaskPresentation(new AbortController().signal);
  expect(f.service.snapshot()?.stateId).toBe('state-6');
  f.director.refreshActivityBlockers();
  expect.soft(f.service.snapshot()?.stateId).toBe('state-6');
  f.director.cancelTaskPreparation(); await prepared;
  f.director.requestBehaviorPlan({ kind: 'move', direction: 'left', distance: 'near' }, 'explicit');
  expect(f.service.snapshot()?.stateId).toBe('state');
  f.director.refreshActivityBlockers();
  expect(f.service.snapshot()?.stateId).toBe('state');
});

test('同角色切换运动档位与同档重试保留用途，十秒后仍可准备移动首帧', async () => {
  vi.useFakeTimers();
  const f = await fixture(); f.bind();
  f.director.applyBehaviorSettings({ movementMode: 2, proactivityMode: 'passive' });
  const scheduler = new CharacterProactivityScheduler({ director: f.director, random: () => 0, now: f.now });
  scheduler.start();
  try {
    await f.director.applyMovementControl({ kind: 'set_mode', mode: 2 }, 'chat');
    expect(f.director.getChatContext().bindings).toEqual(bindings);
    f.time(10_000); await vi.advanceTimersByTimeAsync(10_000);
    expect(f.service.snapshot()?.stateId).toBe('state');
    expect(f.motion.requestIntent).not.toHaveBeenCalled();
    f.start(); expect(f.motion.requestIntent).toHaveBeenCalledOnce();
  } finally { await scheduler.close(); await f.director.close(); vi.useRealTimers(); }
});

test.each([{ mode: 1 as const, phase: 'success' as const, state: 'state-8' }, { mode: 1 as const, phase: 'error' as const, state: 'state-5' },
  { mode: 2 as const, phase: 'success' as const, state: 'state-8' }, { mode: 2 as const, phase: 'error' as const, state: 'state-5' }])('运动档位$mode让真实任务$phase先完成一个片段，再恢复自动运动', async ({ mode, phase, state }) => {
  vi.useFakeTimers();
  const f = await fixture(); f.bind();
  f.director.applyBehaviorSettings({ movementMode: mode, proactivityMode: 'passive' });
  f.director.handleCapabilityTaskPhase('running');
  const scheduler = new CharacterProactivityScheduler({ director: f.director, random: () => 0, now: f.now });
  scheduler.start();
  try {
    f.director.handleCapabilityTaskPhase(phase);
    expect(f.service.snapshot()?.stateId).toBe(state);
    f.start();
    f.time(500); await vi.advanceTimersByTimeAsync(500);
    expect(f.service.snapshot()?.stateId).toBe(state);
    f.time(3000); await vi.advanceTimersByTimeAsync(2500);
    expect(f.service.snapshot()?.stateId).not.toBe(state);
    if (mode === 2) { f.time(13_000); await vi.advanceTimersByTimeAsync(10_000); }
    expect(f.service.snapshot()?.stateId).toBe('state');
    expect(f.motion.requestIntent).not.toHaveBeenCalled();
    f.start(); expect(f.motion.requestIntent).toHaveBeenCalledOnce();
  } finally { await scheduler.close(); await f.director.close(); vi.useRealTimers(); }
});

test('正文已结束后的反应可以打断尚未首帧的自动移动，片段结束再重新准备', async () => {
  const f = await fixture(); f.bind(); f.director.applyBehaviorSettings({ movementMode: 1, proactivityMode: 'passive' });
  const scheduler = new CharacterProactivityScheduler({ director: f.director, random: () => 0, now: f.now });
  scheduler.start();
  try {
    expect(f.service.snapshot()?.stateId).toBe('state');
    await f.director.completeUserPrompt({ generation: 'turn', context: f.director.captureExpressionContext(), eventId: 'late-praise', explicitDirective: null,
      expressionPlan: { states: [{ stateId: 'state-8', score: 1, minStrength: 0, maxStrength: 1, lifetime: 'episode', actions: [{ actionId: 'state-8-action', score: 1 }] }] } });
    expect(f.service.snapshot()?.stateId).toBe('state-8');
    f.start(); f.time(3000);
    expect(f.service.snapshot()?.stateId).toBe('state');
    expect(f.motion.requestIntent).not.toHaveBeenCalled();
    f.start(); expect(f.motion.requestIntent).toHaveBeenCalledOnce();
  } finally { await scheduler.close(); await f.director.close(); }
});

test('正文后反应暂停已开始的自动移动，停止快照重入不抢走片段且恢复仍等新首帧', async () => {
  const f = await fixture(); f.bind(); f.director.applyBehaviorSettings({ movementMode: 1, proactivityMode: 'passive' });
  let snapshot = f.motion.getSnapshot();
  vi.spyOn(f.motion, 'getSnapshot').mockImplementation(() => snapshot);
  f.motion.requestIntent.mockImplementation(() => {
    snapshot = { ...snapshot, revision: snapshot.revision + 1, moving: true };
    f.service.handleMovement(snapshot); f.director.handleMotionSnapshot(snapshot); return snapshot;
  });
  vi.spyOn(f.motion, 'stop').mockImplementation(() => {
    snapshot = { ...snapshot, revision: snapshot.revision + 1, moving: false };
    // 与 Main 保持同一到达顺序，验证同步快照订阅不会重入抢走反应。
    f.director.handleMotionSnapshot(snapshot); f.service.handleMovement(snapshot);
  });
  const scheduler = new CharacterProactivityScheduler({ director: f.director, random: () => 0, now: f.now });
  scheduler.start();
  try {
    f.start(); expect(snapshot.moving).toBe(true);
    await f.director.completeUserPrompt({ generation: 'turn', context: f.director.captureExpressionContext(), eventId: 'moving-praise', explicitDirective: null,
      expressionPlan: { states: [{ stateId: 'state-8', score: 1, minStrength: 0, maxStrength: 1, lifetime: 'episode', actions: [{ actionId: 'state-8-action', score: 1 }] }] } });
    expect(snapshot.moving).toBe(false); expect(f.service.snapshot()?.stateId).toBe('state-8');
    f.start(); f.time(3000);
    expect(snapshot.moving).toBe(false); expect(f.service.snapshot()?.stateId).toBe('state');
    expect(f.motion.requestIntent).toHaveBeenCalledOnce();
    f.start(); expect(f.motion.requestIntent).toHaveBeenCalledTimes(2); expect(snapshot.moving).toBe(true);
  } finally { await scheduler.close(); await f.director.close(); }
});

test('本轮反应不撤销用户明确位移的原首帧令牌', async () => {
  const f = await fixture(); f.bind();
  f.director.requestBehaviorPlan({ kind: 'move', direction: 'left', distance: 'near' }, 'explicit');
  const token = f.service.snapshot()?.schedule.current?.playbackToken;
  await f.director.completeUserPrompt({ generation: 'turn', context: f.director.captureExpressionContext(), eventId: 'explicit-move-reaction', explicitDirective: null,
    expressionPlan: { states: [{ stateId: 'state-8', score: 1, minStrength: 0, maxStrength: 1, lifetime: 'episode', actions: [{ actionId: 'state-8-action', score: 1 }] }] } });
  expect(f.service.snapshot()?.schedule.current?.playbackToken).toBe(token);
  expect(f.service.snapshot()?.stateId).toBe('state');
  expect(f.motion.requestIntent).not.toHaveBeenCalled();
  f.start(); expect(f.motion.requestIntent).toHaveBeenCalledOnce(); await f.director.close();
});

test.each([1, 2] as const)('长期休息在档位%s下跨循环、拖拽和任务恢复都不启动自动移动', async mode => {
  vi.useFakeTimers();
  const f = await fixture(); f.bind();
  f.director.applyBehaviorSettings({ movementMode: mode, proactivityMode: 'passive' });
  await f.director.completeUserPrompt({ generation: 'turn', eventId: 'hold-rest', context: f.director.captureExpressionContext(), explicitDirective: null,
    backgroundSelection: { stateId: 'state-2', actions: [{ actionId: 'state-2-action', score: 1 }] } });
  const scheduler = new CharacterProactivityScheduler({ director: f.director, random: () => 0, now: f.now });
  scheduler.start();
  try {
    for (let time = 0; time <= 25_000; time += 500) {
      f.time(time); await vi.advanceTimersByTimeAsync(500); f.start();
      expect(f.service.snapshot()?.stateId).toBe('state-2');
    }
    f.director.setDragging(true); f.director.setDragging(false);
    f.director.handleCapabilityTaskPhase('running');
    expect(f.service.snapshot()?.stateId).toBe('state-6');
    f.director.handleCapabilityTaskPhase('cancelled');
    f.time(40_000); await vi.advanceTimersByTimeAsync(15_000); f.start();
    expect(f.service.snapshot()?.stateId).toBe('state-2');
    expect(f.motion.requestIntent).not.toHaveBeenCalled();
    expect(f.director.getDiagnosticSnapshot().movementMode).toBe(mode);
  } finally { await scheduler.close(); await f.director.close(); vi.useRealTimers(); }
});

test('休息背景接纳后撤销旧自动运动首帧准备，迟到started不能提交位移', async () => {
  const f = await fixture(); f.bind(); f.director.applyBehaviorSettings({ movementMode: 1, proactivityMode: 'passive' });
  f.director.requestPersistentMovement();
  const pending = f.service.snapshot()!.schedule.current!;
  expect(pending.stateId).toBe('state');
  await f.director.completeUserPrompt({ generation: 'turn', eventId: 'rest-before-start', context: f.director.captureExpressionContext(), explicitDirective: null,
    backgroundSelection: { stateId: 'state-2', actions: [{ actionId: 'state-2-action', score: 1 }] } });
  expect(f.service.snapshot()?.stateId).toBe('state-2');
  f.director.applyPlaybackFeedback({ playbackToken: pending.playbackToken, actionId: pending.actionId, status: 'started', occurredAtMs: f.now() });
  expect(f.motion.requestIntent).not.toHaveBeenCalled();
  await f.director.close();
});

test.each(['mode', 'move'] as const)('明确%s重新走动结束休息背景，静止命令则保留休息', async command => {
  const f = await fixture(); f.bind();
  await f.director.completeUserPrompt({ generation: 'turn', eventId: 'rest-before-command', context: f.director.captureExpressionContext(), explicitDirective: null,
    backgroundSelection: { stateId: 'state-2', actions: [{ actionId: 'state-2-action', score: 1 }] } });
  await f.director.applyMovementControl({ kind: 'set_mode', mode: 0 }, 'explicit');
  expect(f.service.snapshot()?.background?.stateId).toBe('state-2');
  if (command === 'mode') await f.director.applyMovementControl({ kind: 'set_mode', mode: 2 }, 'explicit');
  else f.director.requestBehaviorPlan({ kind: 'move', direction: 'left', distance: 'near' }, 'explicit');
  expect(f.service.snapshot()?.background).toBeNull();
  await f.director.close();
});

test('自主进入休息会停止正在进行的自动移动，改成无聊背景后可以重新移动', async () => {
  const f = await fixture(); f.bind(); f.director.applyBehaviorSettings({ movementMode: 1, proactivityMode: 'assistive' });
  let snapshot = f.motion.getSnapshot();
  vi.spyOn(f.motion, 'getSnapshot').mockImplementation(() => snapshot);
  f.motion.requestIntent.mockImplementation(() => {
    snapshot = { ...snapshot, revision: snapshot.revision + 1, moving: true };
    f.service.handleMovement(snapshot); f.director.handleMotionSnapshot(snapshot); return snapshot;
  });
  vi.spyOn(f.motion, 'stop').mockImplementation(() => {
    snapshot = { ...snapshot, revision: snapshot.revision + 1, moving: false };
    f.director.handleMotionSnapshot(snapshot); f.service.handleMovement(snapshot);
  });
  const scheduler = new CharacterProactivityScheduler({ director: f.director, random: () => 0, now: f.now });
  scheduler.start();
  try {
    f.start(); expect(snapshot.moving).toBe(true);
    f.director.applyAutonomousDecision({ lifecycle: f.director.getBehaviorLifecycleGeneration(), context: f.director.captureExpressionContext()!, eventId: 'autonomous-rest',
      backgroundSelection: { stateId: 'state-2', actions: [{ actionId: 'state-2-action', score: 1 }] } });
    expect(snapshot.moving).toBe(false); expect(f.service.snapshot()?.stateId).toBe('state-2');
    f.start(); f.time(30_000); f.start();
    expect(snapshot.moving).toBe(false); expect(f.service.snapshot()?.stateId).toBe('state-2');
    f.director.applyAutonomousDecision({ lifecycle: f.director.getBehaviorLifecycleGeneration(), context: f.director.captureExpressionContext()!, eventId: 'rest-ended',
      backgroundSelection: { stateId: 'state-3', actions: [{ actionId: 'state-3-action', score: 1 }] } });
    expect(f.service.snapshot()?.stateId).toBe('state');
    expect(snapshot.moving).toBe(false);
    f.start(); expect(snapshot.moving).toBe(true);
  } finally { await scheduler.close(); await f.director.close(); }
});

test('新角色实例必须取得自己的合法首帧，旧实例反馈不能解锁自动运动', async () => {
  const f = await fixture();
  const old = f.service.snapshot()!.schedule.current!;
  f.start();
  await f.director.handleActiveCharacterChanged(); f.bind();
  f.director.applyBehaviorSettings({ movementMode: 1, proactivityMode: 'passive' });
  expect(() => f.director.applyPlaybackFeedback({ playbackToken: old.playbackToken, actionId: old.actionId, status: 'started', occurredAtMs: 0 }))
    .toThrow('CHARACTER_PLAYBACK_UNAUTHORIZED');
  f.director.requestPersistentMovement();
  expect(f.director.getActivityBlockers()).toMatchObject({ rendererUnready: true });
  expect(f.service.snapshot()?.stateId).toBe('idle');
  expect(f.motion.requestIntent).not.toHaveBeenCalled();
  f.start(); f.director.requestPersistentMovement();
  expect(f.service.snapshot()?.stateId).toBe('state');
  expect(f.motion.requestIntent).not.toHaveBeenCalled();
  f.start(); expect(f.motion.requestIntent).toHaveBeenCalledOnce(); await f.director.close();
});
