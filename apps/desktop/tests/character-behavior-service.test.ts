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

test('真实 Engine 接纳未来条件后才提交位移，同步 Motion 回调不能重复提交', async () => {
  const f = fixture(); await f.service.initialize();
  const director = new CharacterBehaviorDirector({ behavior: f.service, motion: { ...f.motion, stop: vi.fn() },
    now: () => 0, initialGeneration: 'real', initialSettings: { movementMode: 0, proactivityMode: 'assistive' }, saveMovementMode: async () => undefined });
  director.handleTaskEvent({ type: 'phase', phase: 'thinking' });
  const prepared = await director.prepareUserPrompt('向左一点');
  expect(f.motion.requestIntent).not.toHaveBeenCalled();
  f.motion.requestIntent.mockImplementation(() => {
    expect(director.getChatContext().runtime).not.toHaveProperty('pendingMovement');
    const snapshot = { ...f.motion.getSnapshot(), moving: true };
    f.service.handleMovement(snapshot); director.handleMotionSnapshot(snapshot); director.advance();
    expect(f.service.snapshot()?.schedule.current?.actionId).toBe('move-action');
    return snapshot;
  });
  await director.completeUserPrompt({ generation: 'real', eventId: 'real-response', context: director.captureExpressionContext(),
    explicitDirective: prepared.explicitDirective, moodUpdate: { summary: '轻快', strength: 1 },
    expressionPlan: { states: [{ stateId: 'move-state', score: 1, minStrength: 0, maxStrength: 1,
      when: { moving: true }, lifetime: 'condition', actions: [{ actionId: 'move-action', score: 1 }] }] } });
  director.handleTaskEvent({ type: 'phase', phase: 'success' });
  expect(f.motion.requestIntent).toHaveBeenCalledExactlyOnceWith({ kind: 'relative', direction: 'left', distance: 'near' });
  f.service.handleMovement(f.motion.getSnapshot());
  expect(f.service.snapshot()?.schedule.current?.actionId).toBe('idle-action');
  await director.close();
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

test('几何绑定保留真实来源并随方向更新 generation', async () => {
  const { service, motion } = fixture(); await service.initialize();
  const first = service.getGeometryBinding()!;
  service.handleMovement({ ...motion.getSnapshot(), direction: 'left' });
  expect(service.getGeometryBinding()).toMatchObject({ direction: 'left', actionId: 'idle-action', skinId: 'default-skin' });
  expect(service.getGeometryBinding()!.generation).toBeGreaterThan(first.generation);
  service.close();
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
