import { readFileSync } from 'node:fs';
import { afterEach, expect, test, vi } from 'vitest';
import { characterManifestV3Schema, type CharacterPlaybackFeedback } from '@myself/character-runtime';
import { CharacterBehaviorService, type CharacterBehaviorPlaybackEvent } from '../src/main/characters/character-behavior-service';
import { CharacterBehaviorDirector } from '../src/main/characters/character-behavior-director';
import { CharacterMotionService } from '../src/main/characters/character-motion-service';
import { CharacterProactivityScheduler } from '../src/main/characters/character-proactivity-scheduler';
import { PetVisualGeometryAuthority } from '../src/main/characters/pet-visual-geometry';
import { PetGeometryCoordinator } from '../src/main/windows/pet-geometry-coordinator';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.useRealTimers(); });

/** 保留新默认的有限循环参数，真实组合四个运行服务，仅替代窗口端口与 Renderer 回报。 */
async function fixture(mode: 0 | 1 | 2, options: { startIntermittent?: boolean; completeFromRenderer?: boolean; random?: () => number; clockReadStepMs?: number; geometrySaveDelayMs?: number } = {}) {
  vi.useFakeTimers();
  let now = 0;
  const clock = () => { now += options.clockReadStepMs ?? 0; return now; };
  let bounds = { x: 100, y: 100, width: 100, height: 100 };
  const manifest = characterManifestV3Schema.parse(JSON.parse(readFileSync(
    new URL('../resources/characters/default/compiled/manifest.json', import.meta.url), 'utf8')));
  const pending: Extract<CharacterBehaviorPlaybackEvent, { type: 'behavior-action' }>[] = [];
  const interrupted: { playbackToken: string; actionId: string }[] = [];
  const publishedActions = new Map<string, string>();
  const played: { time: number; stateId: string; token: string }[] = [];
  const authority = options.geometrySaveDelayMs === undefined ? null : new PetVisualGeometryAuthority(manifest.id);
  const motion = new CharacterMotionService({ now: clock, random: options.random ?? (() => .9),
    window: { getBounds: () => bounds, setPosition: (x, y) => { bounds = { ...bounds, x, y }; } },
    getDisplays: () => [{ id: 'd', workAreaDip: { x: 0, y: 0, width: 1800, height: 1000 } }],
    getGeometrySnapshot: () => authority?.getSnapshot() ?? ({ revision: 1, characterId: manifest.id, scale: 1,
      footAnchorDip: { x: bounds.x + 50, y: bounds.y + 100 }, visualBoundsInWindowDip: { x: 0, y: 0, width: 100, height: 100 }, windowBoundsDip: bounds, displayId: 'd' }) });
  const behavior = new CharacterBehaviorService({ store: { getActiveManifestV3: async () => manifest }, motion, now: clock });
  const director: CharacterBehaviorDirector = new CharacterBehaviorDirector({ behavior, motion, now: clock, initialGeneration: 'g',
    initialSettings: { movementMode: mode, proactivityMode: 'assistive' },
    saveMovementMode: async (movementMode): Promise<void> => { director.applyBehaviorSettings({ movementMode, proactivityMode: 'assistive' }); } });
  let geometrySaveDelayMs = 0;
  const geometryWrites: { time: number; shapeRevision: number | undefined }[] = [];
  const geometryErrors: unknown[] = [];
  // 组合真实几何 FIFO 与正式 tick 阻塞边界，保留可控落盘延迟以捕获自然续播的运动停顿。
  const geometry = authority ? new PetGeometryCoordinator({
    window: { getBounds: () => bounds, setBounds: next => { bounds = next; }, isDestroyed: () => false }, authority,
    settings: {
      getPetPlacementState: async () => ({ kind: 'ready', placement: null }),
      savePetPlacement: async () => {
        geometryWrites.push({ time: now, shapeRevision: authority.getSnapshot()?.revision });
        if (geometrySaveDelayMs) await new Promise<void>(resolve => setTimeout(resolve, geometrySaveDelayMs));
      },
      commitPetPlacementMigration: async () => {}
    },
    getGeometryBinding: () => behavior.getGeometryBinding(),
    displays: () => [{ id: 'd', workAreaDip: { x: 0, y: 0, width: 1800, height: 1000 } }], primaryDisplayId: () => 'd',
    expectProgrammaticPosition: point => motion.expectProgrammaticPosition(point), publishRenderView: () => {},
    isLayoutBlocked: () => motion.getSnapshot().moving || motion.isUserMoving(), isUserMoving: () => motion.isUserMoving()
  }) : null;
  const refreshGeometry = () => { void geometry?.refreshBinding().catch(error => geometryErrors.push(error)); };
  motion.subscribe(snapshot => {
    if (!snapshot.moving) director.handleMotionSnapshot(snapshot);
    const current = motion.getSnapshot();
    behavior.handleMovement(current);
    refreshGeometry();
    if (current.moving) director.handleMotionSnapshot(current);
  });
  behavior.subscribe(event => { refreshGeometry(); if (event.type === 'behavior-action') {
    publishedActions.set(event.playbackToken, event.actionId);
    pending.push(event); played.push({ time: now, stateId: event.stateId, token: event.playbackToken });
  } else { const actionId = publishedActions.get(event.playbackToken);
    if (actionId) interrupted.push({ playbackToken: event.playbackToken, actionId });
  } });
  await behavior.initialize();
  const feedback = (status: CharacterPlaybackFeedback['status']) => {
    const current = behavior.snapshot()!.schedule.current!;
    director.applyPlaybackFeedback({ playbackToken: current.playbackToken, actionId: current.actionId, status, occurredAtMs: now });
  };
  const acknowledge = () => {
    for (const previous of interrupted.splice(0)) {
      // reset 已撤销旧发布记录，真实 Renderer 的终态 IPC 拒绝不会终止动画事件循环。
      try { director.applyPlaybackFeedback({ ...previous, status: 'interrupted', occurredAtMs: now }); }
      catch (error) { if (!(error instanceof Error) || error.message !== 'CHARACTER_PLAYBACK_UNAUTHORIZED') throw error; }
    }
    while (pending.length) {
    const event = pending.shift()!; const current = behavior.snapshot()?.schedule.current;
    if (current?.playbackToken === event.playbackToken && current.startedAtMs === null) feedback('started');
  } };
  acknowledge();
  await geometry?.commitViewport({ viewportInWindowDip: { x: 12, y: 12, width: 156, height: 192 } });
  behavior.applyDecision({ context: behavior.context()!, eventId: 'moving-match', source: 'chat', expressionPlan: { states: [{
    stateId: 'state', score: 1, minStrength: 0, maxStrength: 1, when: { moving: true }, lifetime: 'condition',
    actions: [{ actionId: 'state-action', score: 1 }]
  }] } });
  const scheduler = new CharacterProactivityScheduler({ director, now: clock, random: () => 0 });
  scheduler.start();
  if (mode === 2 && options.startIntermittent !== false) director.requestIntermittentMovement();
  acknowledge();
  await geometry?.refreshBinding();
  geometrySaveDelayMs = options.geometrySaveDelayMs ?? 0;
  cleanups.push(async () => { await scheduler.close(); await director.close(); });
  const samples: { time: number; moving: boolean; x: number; y: number; stateId: string | undefined; skippedLayoutTick: boolean }[] = [];
  return { director, behavior, motion, played, samples, geometryWrites, geometryErrors, acknowledge, feedback, setTime: (value: number) => { now = value; },
    step: async (acknowledgeFrames = true) => {
      now += 50;
      const current = behavior.snapshot()?.schedule.current;
      if (options.completeFromRenderer && current?.expectedEndAtMs != null && now >= current.expectedEndAtMs) feedback('completed');
      const skippedLayoutTick = geometry?.isLayoutInFlight() ?? false;
      if (!skippedLayoutTick) motion.tick(); if (now % 500 === 0) director.advance();
      if (acknowledgeFrames) acknowledge(); await vi.advanceTimersByTimeAsync(50);
      samples.push({ time: now, moving: motion.getSnapshot().moving, x: bounds.x, y: bounds.y, stateId: behavior.snapshot()?.stateId, skippedLayoutTick });
    }
  };
}

test('同跑步自然续播不重复落盘几何，即使保存延迟也不暂停运动 tick', async () => {
  const f = await fixture(1, { geometrySaveDelayMs: 80, random: () => .1 });
  const initialWrites = f.geometryWrites.length;
  for (let i = 0; i < 64; i++) await f.step();
  expect(f.geometryErrors).toEqual([]);
  expect(f.played.filter(event => event.time > 0).length).toBeGreaterThanOrEqual(2);
  expect(f.samples.filter(sample => !sample.moving)).toEqual([]);
  expect(f.samples.filter(sample => sample.time >= 500 && sample.skippedLayoutTick)).toEqual([]);
  expect(f.geometryWrites).toHaveLength(initialWrites);
});

test.each([1, 2] as const)('模式 %s 跨越三轮新默认跑步仍保留真实目标，不插待机或停在途中', async mode => {
  const f = await fixture(mode); const target = f.motion.getSnapshot().target;
  for (let i = 0; i < 64; i++) await f.step();
  expect(f.played.filter(event => event.time > 0).every(event => event.stateId === 'state')).toBe(true);
  expect(f.samples.every(sample => sample.moving)).toBe(true);
  expect(f.motion.getSnapshot().target).toEqual(target);
  expect(f.samples.at(-1)!.x).toBeGreaterThan(400);
});

test('Renderer 先报告有限跑步完成，同动作自然续播仍保持真实移动', async () => {
  const f = await fixture(2, { completeFromRenderer: true });
  for (let i = 0; i < 64; i++) await f.step();
  expect(f.played.filter(event => event.time > 0).every(event => event.stateId === 'state')).toBe(true);
  expect(f.samples.every(sample => sample.moving)).toBe(true);
});

test('模式零不自动移动，模式二等待到期后才开始，切回零停止位移和跑步', async () => {
  const f = await fixture(0);
  for (let i = 0; i < 240; i++) await f.step();
  expect(f.motion.getSnapshot().moving).toBe(false);
  expect(f.played.every(event => event.stateId === 'idle')).toBe(true);
  f.director.applyBehaviorSettings({ movementMode: 2, proactivityMode: 'assistive' });
  for (let i = 0; i < 199; i++) await f.step();
  expect(f.motion.getSnapshot().moving).toBe(false);
  await f.step(); f.acknowledge(); await f.step();
  expect(f.motion.getSnapshot().moving).toBe(true);
  f.director.applyBehaviorSettings({ movementMode: 0, proactivityMode: 'assistive' });
  await f.step();
  expect(f.motion.getSnapshot().moving).toBe(false);
  expect(f.behavior.snapshot()?.stateId).toBe('idle');
});

test('自然续播的新首帧最多等待一点五秒，丢失回报必须停止而不能无限滑动', async () => {
  const f = await fixture(1);
  for (let i = 0; i < 55; i++) await f.step(false);
  expect(f.motion.getSnapshot().moving).toBe(false);
  for (let i = 0; i < 10; i++) await f.step();
  expect(f.motion.getSnapshot().moving).toBe(false);
});

test.each(['failed', 'interrupted'] as const)('已开始的跑步报告 %s 立即停止，不能以自然续播名义绕过失败', async status => {
  const f = await fixture(1);
  for (let i = 0; i < 10; i++) await f.step();
  f.feedback(status); await f.step();
  expect(f.motion.getSnapshot().moving).toBe(false);
});

test('运行时先自然完成旧片段，其迟到中断确认不能终止已经续播的同动作', async () => {
  const f = await fixture(2);
  const previous = f.behavior.snapshot()!.schedule.current!;
  for (let i = 0; i < 23; i++) await f.step();
  f.director.applyPlaybackFeedback({ playbackToken: previous.playbackToken, actionId: previous.actionId,
    status: 'interrupted', occurredAtMs: 1150 });
  await f.step();
  expect(f.motion.getSnapshot().moving).toBe(true);
});

test('提前报告完成不能冒充有限片段自然到期并延长运动', async () => {
  const f = await fixture(2);
  for (let i = 0; i < 10; i++) await f.step();
  f.feedback('completed'); await f.step();
  expect(f.motion.getSnapshot().moving).toBe(false);
});

test('明确播放同一跑步动作不能冒充 moving 活动的自然续播', async () => {
  const f = await fixture(2);
  for (let i = 0; i < 10; i++) await f.step();
  f.behavior.requestDirectedBehavior({ kind: 'state_action', stateId: 'state', actionId: 'state-action' });
  await f.step(); await f.step();
  expect(f.motion.getSnapshot().moving).toBe(false);
});

test('持续模式到达真实目标后直接续行，旧中断回报不清除新一段，也不插入待机', async () => {
  let sample = 0; const values = [.2, .2, .8, .8];
  const f = await fixture(1, { random: () => values[sample++ % values.length]! });
  for (let i = 0; i < 280; i++) await f.step();
  expect(sample).toBeGreaterThanOrEqual(6);
  expect(f.played.filter(event => event.time > 0).every(event => event.stateId === 'state')).toBe(true);
  expect(f.motion.getSnapshot().moving).toBe(true);
});

test.each([0, .01])('到达后原地目标不突破三次重采样，时钟每次读取前进 %s 毫秒', async clockReadStepMs => {
  let calls = 0;
  const f = await fixture(1, { random: () => { calls++; return .2; }, clockReadStepMs });
  for (let i = 0; i < 60; i++) {
    const before = calls;
    await f.step();
    expect(calls - before).toBeLessThanOrEqual(6);
  }
});

test('续播首帧超过一点五秒后立即撤销位移，下一次 Motion tick 不能多走一步', async () => {
  const f = await fixture(2);
  for (let i = 0; i < 23; i++) await f.step(false);
  const before = f.motion.getSnapshot().position;
  f.setTime(2700);
  f.feedback('started'); f.motion.tick();
  expect(f.motion.getSnapshot().position).toEqual(before);
});

test('原地重采样失败后下一真实 tick 可恢复，停止模式不继续采样且 reset 可重新接纳', async () => {
  let calls = 0; let random = .2;
  const f = await fixture(1, { random: () => { calls++; return random; } });
  for (let i = 0; i < 60; i++) await f.step();
  expect(f.motion.getSnapshot().moving).toBe(false);
  random = .8; await f.step();
  expect(f.motion.getSnapshot().moving).toBe(true);
  f.director.applyBehaviorSettings({ movementMode: 0, proactivityMode: 'assistive' });
  const before = calls;
  for (let i = 0; i < 10; i++) await f.step();
  expect(calls).toBe(before);
  expect(f.motion.getSnapshot().moving).toBe(false);
  f.director.reset('new-generation');
  f.behavior.applyDecision({ context: f.behavior.context()!, eventId: 'renewed-match', source: 'chat', expressionPlan: { states: [{
    stateId: 'state', score: 1, minStrength: 0, maxStrength: 1, when: { moving: true }, lifetime: 'condition', actions: [{ actionId: 'state-action', score: 1 }]
  }] } });
  f.director.applyBehaviorSettings({ movementMode: 1, proactivityMode: 'assistive' });
  await f.step();
  expect(f.motion.getSnapshot().moving).toBe(true);
});
