import { expect, test, vi } from 'vitest';
import { characterManifestV3Schema, type CharacterManifestV3 } from '@myself/character-runtime';
import { CharacterBehaviorService, type CharacterBehaviorPlaybackEvent } from '../src/main/characters/character-behavior-service';
import { CharacterBehaviorDirector } from '../src/main/characters/character-behavior-director';

// 名称只用于作者目录，不是运行时状态类别或官方语义。
const SEMANTICS = ['idle', 'listen', 'think', 'move', 'carry', 'celebrate', 'fail'] as const;
function createManifest(id = 'first'): CharacterManifestV3 {
  return {
    version: 3,
    id,
    name: `${id} 角色`,
    thumbnailAssetId: 'thumbnail',
    compilerVersion: 'test',
    identity: {
      description: '行为服务测试角色',
      background: '测试背景',
      traits: [],
      languageStyle: '简洁',
      formsOfAddress: [],
      likes: [],
      dislikes: [],
      behavioralTendencies: [],
      boundaries: [],
      exampleLines: []
    },
    defaultSkinId: 'default-skin',
    idleStateId: 'idle-state',
    states: SEMANTICS.map(semantic => ({
      id: `${semantic}-state`,
      name: `${semantic} 状态`,
      tags: [],
      intensity: 1,
      enterConditions: [],
      exitConditions: [],
      agentInferable: true,
      actionIds: [`${semantic}-action`]
    })),
    actions: SEMANTICS.map(semantic => ({
      id: `${semantic}-action`,
      name: `${semantic} 动作`,
      tags: [],
      preference: 1,
      cooldownMs: 0,
      repeatSuppressionMs: 0,
      loopPolicy: 'never',
      interrupt: 'normal',
      direction: 'any'
    })),
    skins: [{
      id: 'default-skin',
      name: '默认皮肤',
      presentations: SEMANTICS.map(semantic => ({
        actionId: `${semantic}-action`,
        fps: 20,
        frames: semantic === 'carry'
          ? [
            { id: 'carry-start-frame', assetId: `${semantic}-asset`, x: 0, y: 0, width: 1, height: 1 },
            { id: 'carry-commit', assetId: `${semantic}-asset`, x: 1, y: 0, width: 1, height: 1 }
          ]
          : [{ assetId: `${semantic}-asset`, x: 0, y: 0, width: 1, height: 1 }],
        anchors: { ground: { x: 0.5, y: 1 } },
        geometry: {
          visualBounds: { x: 0, y: 0, width: 1, height: 1 },
          groundAnchor: { x: 0.5, y: 1 },
          resourceRevision: 'a'.repeat(64)
        },
        ...(semantic === 'carry' ? { commitFrameId: 'carry-commit' } : {})
      })),
    }],
    resources: [
      { assetId: 'thumbnail', fileName: 'thumbnail.png', sha256: 'a'.repeat(64), byteLength: 1 },
      ...SEMANTICS.map(semantic => ({
        assetId: `${semantic}-asset`,
        fileName: `${semantic}.png`,
        sha256: 'a'.repeat(64),
        byteLength: 1
      }))
    ]
  };
}

function fixture() {
  let now = 0;
  let serial = 0;
  const store = { getActiveManifestV3: vi.fn(async () => characterManifestV3Schema.parse(createManifest())) };
  const motion = {
    getSnapshot: vi.fn(() => ({ revision: 1, timestampMs: 0, position: { x: 0, y: 0 }, target: { x: 0, y: 0 }, direction: 'right' as const, moving: false, carrying: false })),
    requestIntent: vi.fn(), applyTaskEvent: vi.fn()
  };
  const reportError = vi.fn();
  const service = new CharacterBehaviorService({ store, motion, now: () => now, random: () => 0, createPlaybackToken: () => `behavior-token-${++serial}`, reportError });
  const events: CharacterBehaviorPlaybackEvent[] = [];
  service.subscribe(event => events.push(event));
  return { store, motion, service, events, reportError, setNow: (value: number) => { now = value; } };
}

function currentAction(events: CharacterBehaviorPlaybackEvent[]) {
  const event = [...events].reverse().find(event => event.type === 'behavior-action');
  if (!event || event.type !== 'behavior-action') throw new Error('缺少动作授权');
  return event;
}

test('Main 运动和搬运事实立即重判同一计划，停止后回到 idle', async () => {
  const f = fixture(); await f.service.initialize();
  f.service.applyDecision({ context: f.service.context()!, eventId: 'facts-plan', source: 'chat',
    moodUpdate: { summary: '跟随运动', strength: 1 }, expressionPlan: { states: [
      { stateId: 'move-state', score: 1, minStrength: 0, maxStrength: 1,
        when: { moving: true, carrying: false }, lifetime: 'condition', actions: [{ actionId: 'move-action', score: 1 }] },
      { stateId: 'carry-state', score: 1, minStrength: 0, maxStrength: 1,
        when: { moving: true, carrying: true }, lifetime: 'condition', actions: [{ actionId: 'carry-action', score: 1 }] }
    ] } });
  f.service.handleMovement({ ...f.motion.getSnapshot(), moving: true });
  expect(currentAction(f.events).actionId).toBe('move-action');
  f.service.handleMovement({ ...f.motion.getSnapshot(), moving: true, carrying: true });
  expect(currentAction(f.events).actionId).toBe('carry-action');
  f.service.handleMovement({ ...f.motion.getSnapshot(), moving: false, carrying: true });
  expect(currentAction(f.events).actionId).toBe('idle-action');
  f.service.close();
});

test('任务占用解除即退出条件状态，角色重载与reset仍保留 Main 事实', async () => {
  const f = fixture(); await f.service.initialize();
  f.service.updateRuntimeFacts({ taskRunning: true, dragging: true });
  const apply = () => f.service.applyDecision({ context: f.service.context()!, eventId: 'task-plan', source: 'chat',
    moodUpdate: { summary: '专注', strength: 1 }, expressionPlan: { states: [
      { stateId: 'think-state', score: 1, minStrength: 0, maxStrength: 1,
        when: { taskRunning: true, dragging: true }, lifetime: 'condition', actions: [{ actionId: 'think-action', score: 1 }] }
    ] } });
  apply(); expect(currentAction(f.events).actionId).toBe('think-action');
  f.service.cancelStateLifecycle(); apply(); expect(currentAction(f.events).actionId).toBe('think-action');
  await f.service.handleActiveCharacterChanged(); apply(); expect(currentAction(f.events).actionId).toBe('think-action');
  f.service.updateRuntimeFacts({ taskRunning: false });
  expect(currentAction(f.events).actionId).toBe('idle-action');
  f.service.close();
});

test('V3 初始化保留真实 ID，公开目录不暴露旧语义', async () => {
  const { service, events } = fixture();
  await service.initialize();
  expect(currentAction(events)).toMatchObject({ stateId: 'idle-state', actionId: 'idle-action' });
  const catalog = service.getPublicBehaviorCatalog();
  expect(catalog.states[0]).toMatchObject({ stateId: 'idle-state', actions: [expect.objectContaining({ actionId: 'idle-action' })] });
  expect(catalog.states[0]).not.toHaveProperty('semantic');
  expect(service.resolveBehaviorTarget({ kind: 'action_name', name: 'think 动作' })).toEqual({ kind: 'state_action', stateId: 'think-state', actionId: 'think-action' });
  service.close();
});

test.each(['completed', 'interrupted', 'failed'] as const)('Main先换片段后的已发布旧令牌 %s 回报仅忽略且无副作用', async status => {
  const f = fixture(); await f.service.initialize(); const old = currentAction(f.events);
  f.service.applyPlaybackFeedback({ playbackToken: old.playbackToken, actionId: old.actionId, status: 'started', occurredAtMs: 0 });
  f.setNow(500); f.service.advance();
  expect(currentAction(f.events).playbackToken).not.toBe(old.playbackToken);
  f.setNow(500.8);
  const before = f.service.snapshot(); const events = f.events.length; const recent = f.service.getRecentPublicActions();
  expect(() => f.service.applyPlaybackFeedback({ playbackToken: old.playbackToken, actionId: old.actionId, status, occurredAtMs: 500.8 })).not.toThrow();
  expect(f.service.snapshot()).toEqual(before); expect(f.events).toHaveLength(events);
  expect(f.service.getRecentPublicActions()).toEqual(recent);
  for (const invalid of [
    { playbackToken: 'forged-token', actionId: old.actionId, status, occurredAtMs: 500.8 },
    { playbackToken: old.playbackToken, actionId: 'wrong-action', status, occurredAtMs: 500.8 },
    { playbackToken: old.playbackToken, actionId: old.actionId, status, occurredAtMs: -1 },
    { playbackToken: old.playbackToken, actionId: old.actionId, status, occurredAtMs: 501 }
  ]) expect(() => f.service.applyPlaybackFeedback(invalid)).toThrow('CHARACTER_PLAYBACK_UNAUTHORIZED');
  f.service.cancelStateLifecycle();
  const resetSnapshot = f.service.snapshot(); const resetEvents = f.events.length; const resetRecent = f.service.getRecentPublicActions();
  expect(() => f.service.applyPlaybackFeedback({ playbackToken: old.playbackToken, actionId: old.actionId, status, occurredAtMs: 500.8 })).not.toThrow();
  expect(f.service.snapshot()).toEqual(resetSnapshot); expect(f.events).toHaveLength(resetEvents);
  expect(f.service.getRecentPublicActions()).toEqual(resetRecent);
  f.service.close();
});

test('Main先换片段后的已发布旧令牌迟到started仅忽略且无副作用', async () => {
  const f = fixture(); await f.service.initialize(); const old = currentAction(f.events);
  f.service.applyPlaybackFeedback({ playbackToken: old.playbackToken, actionId: old.actionId, status: 'started', occurredAtMs: 0 });
  f.setNow(500); f.service.advance();
  expect(currentAction(f.events).playbackToken).not.toBe(old.playbackToken);
  f.setNow(500.8);
  const before = f.service.snapshot(); const events = f.events.length; const recent = f.service.getRecentPublicActions();
  expect(() => f.service.applyPlaybackFeedback({ playbackToken: old.playbackToken, actionId: old.actionId, status: 'started', occurredAtMs: 500.8 })).not.toThrow();
  expect(f.service.snapshot()).toEqual(before); expect(f.events).toHaveLength(events);
  expect(f.service.getRecentPublicActions()).toEqual(recent);
  f.service.cancelStateLifecycle();
  const resetSnapshot = f.service.snapshot(); const resetEvents = f.events.length; const resetRecent = f.service.getRecentPublicActions();
  expect(() => f.service.applyPlaybackFeedback({ playbackToken: old.playbackToken, actionId: old.actionId, status: 'started', occurredAtMs: 500.8 })).not.toThrow();
  expect(f.service.snapshot()).toEqual(resetSnapshot); expect(f.events).toHaveLength(resetEvents);
  expect(f.service.getRecentPublicActions()).toEqual(resetRecent);
  f.service.close();
});

test('已结束令牌记录有界淘汰，过旧令牌不能作为当前生命周期授权', async () => {
  const f = fixture(); await f.service.initialize(); const old = currentAction(f.events);
  for (let index = 1; index <= 20; index++) {
    f.setNow(index * 500);
    f.service.requestDirectedBehavior({ kind: 'state_action', stateId: 'idle-state', actionId: 'idle-action' });
  }
  expect(() => f.service.applyPlaybackFeedback({ playbackToken: old.playbackToken, actionId: old.actionId,
    status: 'completed', occurredAtMs: 10000 })).toThrow('CHARACTER_PLAYBACK_UNAUTHORIZED');
  f.service.close();
});

test('几何绑定保留真实来源并随方向更新 generation', async () => {
  const { service, motion } = fixture(); await service.initialize();
  const first = service.getGeometryBinding()!;
  service.handleMovement({ ...motion.getSnapshot(), direction: 'left' });
  expect(service.getGeometryBinding()).toMatchObject({ direction: 'left', actionId: 'idle-action', skinId: 'default-skin' });
  expect(service.getGeometryBinding()!.generation).toBeGreaterThan(first.generation);
  service.close();
});

test('播放轮次保留实时 actionRevision 且复用几何，动作切换和角色重载仍更换 generation', async () => {
  const f = fixture(); await f.service.initialize();
  const first = f.service.getGeometryBinding()!;
  f.service.requestDirectedBehavior({ kind: 'state_action', stateId: 'idle-state', actionId: 'idle-action' });
  const repeated = f.service.getGeometryBinding()!;
  expect(repeated.actionRevision).toBeGreaterThan(first.actionRevision);
  expect(repeated.generation).toBe(first.generation);
  f.service.requestDirectedBehavior({ kind: 'state_action', stateId: 'think-state', actionId: 'think-action' });
  const changed = f.service.getGeometryBinding()!;
  expect(changed.generation).toBeGreaterThan(repeated.generation);
  expect(changed.actionRevision).toBeGreaterThan(repeated.actionRevision);
  await f.service.handleActiveCharacterChanged();
  const reloaded = f.service.getGeometryBinding()!;
  await f.service.handleActiveCharacterChanged();
  expect(f.service.getGeometryBinding()!.generation).toBeGreaterThan(reloaded.generation);
  f.service.close();
});

test('明确动作覆盖作者循环并在真实周期结束，不依赖终态反馈', async () => {
  const f = fixture(); const manifest = createManifest(); manifest.actions[2]!.loopPolicy = 'until-interrupted';
  f.store.getActiveManifestV3.mockResolvedValue(manifest); await f.service.initialize();
  f.service.requestDirectedBehavior({ kind: 'state_action', stateId: 'think-state', actionId: 'think-action' });
  const event = currentAction(f.events);
  expect(event.playback).toEqual({ mode: 'once', durationMs: 50 });
  f.service.applyPlaybackFeedback({ playbackToken: event.playbackToken, actionId: event.actionId, status: 'started', occurredAtMs: 0 });
  f.setNow(50); f.service.advance();
  expect(f.service.snapshot()!.schedule.current?.playbackToken).not.toBe(event.playbackToken);
  f.service.close();
});

test('仅状态请求有界停留，动作不归属该状态时拒绝', async () => {
  const f = fixture(); await f.service.initialize();
  expect(f.service.requestDirectedBehavior({ kind: 'state_action', stateId: 'idle-state', actionId: 'think-action' }).kind).toBe('none');
  f.service.requestDirectedBehavior({ kind: 'state', stateId: 'think-state' });
  expect(currentAction(f.events).playback.durationMs).toBe(3000);
  f.service.close();
});

test('播放反馈必须匹配精确令牌、动作和 Main 时间', async () => {
  const f = fixture(); await f.service.initialize(); const event = currentAction(f.events);
  expect(() => f.service.applyPlaybackFeedback({ playbackToken: event.playbackToken, actionId: 'wrong-action', status: 'started', occurredAtMs: 0 })).toThrow('CHARACTER_PLAYBACK_UNAUTHORIZED');
  expect(() => f.service.applyPlaybackFeedback({ playbackToken: event.playbackToken, actionId: event.actionId, status: 'started', occurredAtMs: 1 })).toThrow('CHARACTER_PLAYBACK_UNAUTHORIZED');
  expect(() => f.service.applyPlaybackFeedback({ playbackToken: event.playbackToken, actionId: event.actionId, status: 'started', occurredAtMs: 0 })).not.toThrow();
  f.service.close();
});

test('切换角色的异步读取立即失效旧令牌，迟到完成不得恢复旧角色', async () => {
  const f = fixture(); await f.service.initialize(); const old = currentAction(f.events);
  let resolve!: (manifest: CharacterManifestV3) => void;
  f.store.getActiveManifestV3.mockReturnValueOnce(new Promise(done => { resolve = done; }));
  const changing = f.service.handleActiveCharacterChanged();
  expect(f.service.snapshot()).toBeNull();
  expect(() => f.service.applyPlaybackFeedback({ playbackToken: old.playbackToken, actionId: old.actionId, status: 'completed', occurredAtMs: 0 })).toThrow('CHARACTER_PLAYBACK_UNAUTHORIZED');
  resolve(createManifest('second')); await changing;
  expect(f.service.getGeometryBinding()!.manifest.id).toBe('second');
  expect(currentAction(f.events).playbackToken).not.toBe(old.playbackToken);
  f.service.close();
});

test('切换读取失败只报告稳定错误并保持无引擎', async () => {
  const f = fixture(); await f.service.initialize();
  f.store.getActiveManifestV3.mockRejectedValueOnce(new Error('私有路径和内部堆栈'));
  await f.service.handleActiveCharacterChanged();
  expect(f.service.snapshot()).toBeNull();
  expect(f.reportError).toHaveBeenCalledWith('CHARACTER_BEHAVIOR_V3_UNAVAILABLE');
  expect(f.service.requestDirectedBehavior({ kind: 'state', stateId: 'idle-state' })).toEqual({ kind: 'none' });
  f.service.close();
});

test('运动与统一阶段不推断表达状态，关闭后不再发布', async () => {
  const f = fixture(); await f.service.initialize(); const current = f.service.snapshot()!.stateId;
  f.service.handleTaskEvent({ type: 'phase', phase: 'success' });
  f.service.handleMovement({ ...f.motion.getSnapshot(), moving: true });
  expect(f.service.snapshot()!.stateId).toBe(current);
  expect(f.motion.requestIntent).not.toHaveBeenCalled();
  f.service.close(); const count = f.events.length;
  f.service.handleUserInteraction(); f.service.advance();
  expect(f.events).toHaveLength(count);
});

/** 只替换窗口边界；真实 Service/Engine 裁决准备 token 与 started 的可信性。 */
async function movementFixture(mode: 0 | 1 | 2 = 0, matched = true) {
  const f = fixture(); let now = 0;
  const manifest = createManifest();
  manifest.actions.forEach(action => { action.loopPolicy = 'until-interrupted'; });
  f.store.getActiveManifestV3.mockResolvedValue(manifest); await f.service.initialize();
  // 后续用例验证已显示角色的运动首帧；冷加载另由真实 CharacterPlayer 组合覆盖。
  const initial = f.service.snapshot()!.schedule.current!;
  f.service.applyPlaybackFeedback({ playbackToken: initial.playbackToken, actionId: initial.actionId, status: 'started', occurredAtMs: 0 });
  f.service.applyDecision({ context: f.service.context()!, eventId: '能力', source: 'chat',
    moodUpdate: { summary: '开心', strength: .8, fadeInMs: 0 }, expressionPlan: { states: [
      { stateId: 'celebrate-state', score: 1, minStrength: 0, maxStrength: 1, lifetime: 'episode', actions: [] },
      ...(matched ? [{ stateId: 'move-state', score: .1, minStrength: .9, maxStrength: 1,
        when: { moving: true }, lifetime: 'condition' as const, actions: [{ actionId: 'move-action', score: 1 }] }] : [])
    ] } });
  const stop = vi.fn(() => f.service.handleMovement(f.motion.getSnapshot())); const notices = vi.fn();
  const director = new CharacterBehaviorDirector({ behavior: f.service, motion: { ...f.motion, stop },
    now: () => now, initialGeneration: 'real', initialSettings: { movementMode: mode, proactivityMode: 'assistive' },
    saveMovementMode: async () => undefined, publishNotice: notices });
  f.motion.requestIntent.mockImplementation(() => {
    const snapshot = { ...f.motion.getSnapshot(), target: { x: f.motion.requestIntent.mock.calls.length * 100, y: 0 }, moving: true };
    f.service.handleMovement(snapshot); director.handleMotionSnapshot(snapshot); return snapshot;
  });
  const feedback = (status: 'started' | 'failed' | 'interrupted' = 'started') => {
    const current = f.service.snapshot()!.schedule.current!;
    director.applyPlaybackFeedback({ playbackToken: current.playbackToken, actionId: current.actionId, status, occurredAtMs: now });
  };
  return { ...f, director, stop, notices, feedback, time: (value: number) => { now = value; f.setNow(value); } };
}

test.each([0, 1, 2] as const)('首帧门控：模式%s有活动也必须等同token started才一次位移', async mode => {
  const f = await movementFixture(mode);
  if (mode === 0) await f.director.prepareUserPrompt('向右一点');
  if (mode === 1) f.director.requestPersistentMovement();
  if (mode === 2) f.director.requestIntermittentMovement();
  expect(f.motion.requestIntent).not.toHaveBeenCalled();
  expect(f.director.getChatContext().runtime).toMatchObject({ pendingMovement: true, moving: false });
  expect(f.service.snapshot()?.schedule.current?.actionId).toBe('move-action');
  f.feedback(); expect(f.motion.requestIntent).toHaveBeenCalledTimes(1);
  f.feedback(); expect(f.motion.requestIntent).toHaveBeenCalledTimes(1);
  expect(f.service.snapshot()?.mood?.summary).toBe('开心');
  f.feedback('failed'); expect(f.stop).toHaveBeenCalled();
  expect(f.service.snapshot()?.mood?.summary).toBe('开心');
  await f.director.close();
});

test.each(['started', 'timeout', 'failed'] as const)('真实任务准备 %s 后有界结束，准备期间不生成 taskRunning', async status => {
  vi.useFakeTimers();
  const f = await movementFixture();
  try {
    f.time(60_000); f.director.advance();
    f.service.applyDecision({ context: f.service.context()!, eventId: 'task-candidates', source: 'chat',
      backgroundSelection: { stateId: 'idle-state', actions: [{ actionId: 'idle-action', score: 1 }] },
      expressionPlan: { states: [{ stateId: 'think-state', score: 1, minStrength: 0, maxStrength: 1,
        when: { taskRunning: true }, lifetime: 'condition', actions: [{ actionId: 'think-action', score: 1 }] }] } });
    const ready = vi.fn();
    const preparing = f.director.prepareTaskPresentation(new AbortController().signal).then(ready);
    expect(f.service.snapshot()?.stateId).toBe('think-state');
    expect(f.director.getChatContext().runtime.taskRunning).toBe(false);
    expect(ready).not.toHaveBeenCalled();
    if (status === 'timeout') await vi.advanceTimersByTimeAsync(1500);
    else f.feedback(status);
    await preparing;
    expect(ready).toHaveBeenCalledOnce();
    expect(f.director.getChatContext().situation?.lastTask).toBeNull();
    f.director.handleCapabilityTaskPhase('running');
    expect(f.director.getChatContext().runtime.taskRunning).toBe(true);
    f.director.handleCapabilityTaskPhase('success');
    expect(f.service.snapshot()?.stateId).toBe('idle-state');
    expect(f.director.getChatContext().situation?.lastTask?.outcome).toBe('success');
    expect(f.notices).toHaveBeenCalledTimes(status === 'started' ? 0 : 1);
  } finally {
    await f.director.close();
    vi.useRealTimers();
  }
});

test.each(['timeout', 'wrong', 'failed', 'reset', 'cancel'] as const)('首帧门控：%s不会产生位移', async cause => {
  const f = await movementFixture(); await f.director.prepareUserPrompt('向右一点');
  const current = f.service.snapshot()!.schedule.current!;
  if (cause === 'timeout') { f.time(1500); f.director.advance(); }
  if (cause === 'wrong') expect(() => f.director.applyPlaybackFeedback({ playbackToken: '伪造', actionId: current.actionId, status: 'started', occurredAtMs: 0 })).toThrow();
  if (cause === 'failed') f.feedback('failed');
  if (cause === 'reset') f.director.reset('new');
  if (cause === 'cancel') f.director.cancelActive();
  if (cause !== 'wrong') {
    try { f.director.applyPlaybackFeedback({ playbackToken: current.playbackToken, actionId: current.actionId, status: 'started', occurredAtMs: cause === 'timeout' ? 1500 : 0 }); } catch { /* 旧令牌拒绝也是合法结果。 */ }
  }
  expect(f.motion.requestIntent).not.toHaveBeenCalled(); await f.director.close();
});

test.each([0, 1, 2] as const)('首帧门控：模式%s缺活动永久零位移且无逐tick提示', async mode => {
  const f = await movementFixture(mode, false);
  if (mode === 0) {
    const prepared = await f.director.prepareUserPrompt('向右一点');
    await f.director.completeUserPrompt({ generation: 'real', eventId: '缺失', context: f.director.captureExpressionContext(),
      explicitDirective: prepared.explicitDirective, expressionStatus: 'no_match', requestKind: 'movement', expressionPlan: { states: [] } });
  }
  for (let i = 0; i < 20; i++) {
    f.time(i * 1000); f.director.advance();
    if (mode === 1) f.director.requestPersistentMovement();
    if (mode === 2) f.director.requestIntermittentMovement();
  }
  expect(f.motion.requestIntent).not.toHaveBeenCalled(); expect(f.notices.mock.calls.length).toBeLessThanOrEqual(1);
  await f.director.close();
});

test('明确移动只释放旧explicit，保留心情并等待新活动首帧', async () => {
  const f = await movementFixture();
  f.service.requestDirectedBehavior({ kind: 'state_action', stateId: 'think-state', actionId: 'think-action' });
  await f.director.prepareUserPrompt('向右一点');
  expect(f.service.snapshot()?.schedule.current?.actionId).toBe('move-action');
  expect(f.service.snapshot()?.mood?.summary).toBe('开心');
  expect(f.motion.requestIntent).not.toHaveBeenCalled(); f.feedback();
  expect(f.motion.requestIntent).toHaveBeenCalledTimes(1); await f.director.close();
});


test('自动首帧超时同生命周期不重复播放或提示，明确请求仍可重试', async () => {
  const f = await movementFixture(1); f.director.requestPersistentMovement();
  f.time(1500); f.director.advance(); const published = f.events.filter(event => event.type === 'behavior-action' && event.actionId === 'move-action').length;
  for (let i = 0; i < 4; i++) { f.director.requestPersistentMovement(); f.time(3000 + i * 1500); f.director.advance(); }
  expect(f.events.filter(event => event.type === 'behavior-action' && event.actionId === 'move-action')).toHaveLength(published); expect(f.notices).toHaveBeenCalledTimes(1);
  await f.director.prepareUserPrompt('向右一点');
  expect(f.service.snapshot()?.schedule.current?.actionId).toBe('move-action'); await f.director.close();
});

test('真实到达先更新Service再续行，新token未started保持零新增位移', async () => {
  const f = await movementFixture(1); f.director.requestPersistentMovement(); f.feedback();
  const arrived = f.motion.getSnapshot();
  f.service.handleMovement(arrived); f.director.handleMotionSnapshot(arrived);
  expect(f.motion.requestIntent).toHaveBeenCalledTimes(1);
  expect(f.service.snapshot()?.schedule.current?.actionId).toBe('move-action');
  f.feedback(); expect(f.motion.requestIntent).toHaveBeenCalledTimes(2); await f.director.close();
});

test.each(['ready', 'no_match', 'failed'] as const)('无固定Gate的明确状态%s：精确播放或如实反馈', async status => {
  const f = await movementFixture();
  const prepared = await f.director.prepareUserPrompt('你表现得开心一点');
  await f.director.completeUserPrompt({ generation: 'real', eventId: '状态', context: f.director.captureExpressionContext(),
    explicitDirective: prepared.explicitDirective, requestKind: 'state', expressionStatus: status,
    ...(status === 'ready' ? { explicitPlayback: { stateId: 'think-state' } } : {}),
    ...(status === 'no_match' ? { expressionPlan: { states: [] } } : {}) });
  if (status === 'ready') expect(f.service.snapshot()?.stateId).toBe('think-state');
  else expect(f.notices).toHaveBeenCalledWith(expect.objectContaining({ code: status === 'no_match' ? 'CHARACTER_ACTION_UNAVAILABLE' : 'CHARACTER_EXPRESSION_NOT_EXECUTED' }));
  expect(f.motion.requestIntent).not.toHaveBeenCalled(); await f.director.close();
});

test('明确移动已开始后失败表现不能留下正在移动的失败状态', async () => {
  const f = await movementFixture(); const prepared = await f.director.prepareUserPrompt('向右一点'); f.feedback();
  await f.director.completeUserPrompt({ generation: 'real', eventId: '失败', context: f.director.captureExpressionContext(),
    explicitDirective: prepared.explicitDirective, expressionStatus: 'failed' });
  expect(f.stop).toHaveBeenCalled(); await f.director.close();
});


test('取消已开始的移动及时停止且不会清掉心情', async () => {
  const f = await movementFixture(); await f.director.prepareUserPrompt('向右一点'); f.feedback();
  f.director.cancelActive(); expect(f.stop).toHaveBeenCalled();
  expect(f.service.snapshot()?.mood?.summary).toBe('开心'); await f.director.close();
});

test('真实运动快照导致活动token失效时立即停止，不能等下一次poll滑行', async () => {
  const f = await movementFixture(); await f.director.prepareUserPrompt('向右一点'); f.feedback();
  f.service.requestDirectedBehavior({ kind: 'state_action', stateId: 'think-state', actionId: 'think-action' });
  f.director.handleMotionSnapshot({ ...f.motion.getSnapshot(), moving: true });
  expect(f.stop).toHaveBeenCalled(); await f.director.close();
});


test('普通聊天单次表现先完成，再恢复自动活动准备', async () => {
  const f = await movementFixture(1); await f.director.prepareUserPrompt('你好'); f.time(3000);
  await f.director.completeUserPrompt({ generation: 'real', eventId: '普通', context: f.director.captureExpressionContext(),
    explicitDirective: null, expressionStatus: 'ready', requestKind: 'ambient', expressionPlan: { states: [
      { stateId: 'think-state', score: 1, minStrength: 0, maxStrength: 1, lifetime: 'episode', actions: [] }
    ] } });
  expect(f.service.snapshot()?.stateId).toBe('think-state');
  f.director.requestPersistentMovement();
  expect(f.service.snapshot()?.stateId).toBe('think-state');
  f.feedback(); f.time(6000); f.director.advance(); f.director.requestPersistentMovement();
  expect(f.service.snapshot()?.stateId).toBe('move-state');
  expect(f.motion.requestIntent).not.toHaveBeenCalled(); f.feedback();
  expect(f.motion.requestIntent).toHaveBeenCalledTimes(1); await f.director.close();
});

test('截止时started先于poll到达也只失败一次，自动模式不能重复准备', async () => {
  const f = await movementFixture(1); f.director.requestPersistentMovement();
  f.time(1500); f.feedback(); f.director.requestPersistentMovement();
  expect(f.events.filter(event => event.type === 'behavior-action' && event.actionId === 'move-action')).toHaveLength(1);
  expect(f.motion.requestIntent).not.toHaveBeenCalled(); expect(f.notices).toHaveBeenCalledTimes(1); await f.director.close();
});


test.each([1, 2] as const)('模式%s首帧失败后，用户明确请求相同模式可用新token重试', async mode => {
  const f = await movementFixture(mode);
  const request = () => mode === 1 ? f.director.requestPersistentMovement() : f.director.requestIntermittentMovement();
  request(); const previous = f.service.snapshot()!.schedule.current!.playbackToken;
  f.time(1500); f.director.advance();
  for (let index = 0; index < 3; index++) request();
  expect(f.motion.requestIntent).not.toHaveBeenCalled();
  expect(f.notices).toHaveBeenCalledTimes(1);
  await f.director.prepareUserPrompt(mode === 1 ? '让他一直运动' : '让他时不时动一下');
  request();
  expect(f.service.snapshot()?.schedule.current?.actionId).toBe('move-action');
  expect(f.service.snapshot()?.schedule.current?.playbackToken).not.toBe(previous);
  expect(f.motion.requestIntent).not.toHaveBeenCalled();
  f.feedback(); expect(f.motion.requestIntent).toHaveBeenCalledTimes(1);
  expect(f.service.snapshot()?.mood?.summary).toBe('开心'); await f.director.close();
});
