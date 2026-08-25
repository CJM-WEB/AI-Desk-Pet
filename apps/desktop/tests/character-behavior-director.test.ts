import type {
  BehaviorTarget,
  CharacterAgentBehaviorIntent,
  CharacterBehaviorAuthorization,
  CharacterBehaviorPlan,
  CharacterPlaybackFeedback,
  PublicBehaviorCatalog,
  ResolvedBehaviorTarget
} from '@myself/character-runtime';
import type { TaskEvent } from '@myself/shared-types';
import { describe, expect, test, vi } from 'vitest';
import {
  CharacterBehaviorDirector,
  type CharacterBehaviorNotice
} from '../src/main/characters/character-behavior-director';
import { CharacterMotionService } from '../src/main/characters/character-motion-service';
import { CharacterProactivityScheduler } from
  '../src/main/characters/character-proactivity-scheduler';

const NONE: CharacterBehaviorAuthorization = { kind: 'none' };

/** 构造只记录 Director 边界调用的同步行为服务端口。 */
function createFixture(initialSettings: Readonly<{
  movementStopped: boolean;
  proactivityMode: 'passive' | 'assistive' | 'autonomous';
}> = {
  movementStopped: false,
  proactivityMode: 'assistive' as const
}, now?: () => number) {
  let taskAuthorization: CharacterBehaviorAuthorization = NONE;
  let directedAuthorization: CharacterBehaviorAuthorization = NONE;
  let agentAuthorization: CharacterBehaviorAuthorization = NONE;
  let releasedTokens: readonly string[] = [];
  let motionSnapshot = {
    revision: 2,
    timestampMs: 10,
    position: { x: 20, y: 30 },
    target: { x: 40, y: 30 },
    direction: 'right' as const,
    moving: true,
    carrying: false
  };
  let plannedTargets = [{ x: 40, y: 30 }, { x: 60, y: 30 }];
  const targetByName = new Map<string, ResolvedBehaviorTarget>([
    ['挥手', { kind: 'action', actionId: 'wave-action' }],
    ['庆祝', { kind: 'action', actionId: 'celebrate-action' }],
    ['移动', { kind: 'action', actionId: 'move-action' }]
  ]);
  const behavior = {
    getPublicBehaviorCatalog: vi.fn((): PublicBehaviorCatalog => ({
      characterName: '测试角色', semantics: ['idle', 'celebrate'],
      stateNames: ['开心'], actionNames: ['挥手', '庆祝'], tags: [],
      candidates: [
        { kind: 'state_name', name: '开心', semantic: 'celebrate', tags: [] },
        { kind: 'action_name', name: '挥手', semantic: 'celebrate', tags: [] },
        { kind: 'action_name', name: '庆祝', semantic: 'celebrate', tags: ['dance'] }
      ]
    })),
    resolveBehaviorTarget: vi.fn((target: BehaviorTarget): ResolvedBehaviorTarget => {
      if (target.kind === 'semantic') return { kind: 'semantic', semantic: target.semantic };
      const name = target.kind === 'action_name' ? target.name : '';
      const resolved = targetByName.get(name);
      if (!resolved) throw new Error('CHARACTER_ACTION_UNAVAILABLE');
      return resolved;
    }),
    isMovementBehaviorTarget: vi.fn((target: ResolvedBehaviorTarget) => (
      target.kind === 'semantic'
        ? target.semantic === 'move'
        : target.kind === 'action' && target.actionId === 'move-action'
    )),
    requestDirectedBehavior: vi.fn(() => directedAuthorization),
    requestProactiveBehavior: vi.fn((target: BehaviorTarget, options?: { allowMovement?: boolean }) => (
      ((target.kind === 'action_name' && target.name === '移动')
        || (target.kind === 'semantic' && target.semantic === 'move'))
      && options?.allowMovement !== true
        ? NONE
        : directedAuthorization
    )),
    isMovementAgentIntent: vi.fn((intent: CharacterAgentBehaviorIntent) => (
      intent.actionSemantic === 'move'
      || intent.stateIntent !== null && 'semantic' in intent.stateIntent
        && intent.stateIntent.semantic === 'move'
    )),
    handleAgentIntent: vi.fn(() => agentAuthorization),
    getRecentPublicActions: vi.fn(() => ['挥手']),
    advance: vi.fn(() => releasedTokens),
    handleTaskEvent: vi.fn((
      _event: TaskEvent,
      options?: Readonly<{ allowPlayback?: boolean }>
    ) => options?.allowPlayback === false ? NONE : taskAuthorization),
    applyPlaybackFeedback: vi.fn((_feedback: CharacterPlaybackFeedback) => undefined),
    handleActiveCharacterChanged: vi.fn(async () => undefined),
    close: vi.fn(() => undefined)
  };
  const motion = {
    getSnapshot: vi.fn(() => ({
      ...motionSnapshot,
      position: { ...motionSnapshot.position },
      target: { ...motionSnapshot.target }
    })),
    requestIntent: vi.fn(() => {
      const target = plannedTargets.shift() ?? motionSnapshot.target;
      motionSnapshot = { ...motionSnapshot, target: { ...target } };
      return {
        ...motionSnapshot,
        position: { ...motionSnapshot.position },
        target: { ...motionSnapshot.target }
      };
    }),
    stop: vi.fn()
  };
  const notices: CharacterBehaviorNotice[] = [];
  const saveMovementStopped = vi.fn<(stopped: boolean) => Promise<void>>();
  const director = new CharacterBehaviorDirector({
    behavior,
    motion,
    initialGeneration: 'generation-1',
    initialSettings,
    saveMovementStopped,
    now,
    publishNotice: notice => notices.push(notice)
  });
  saveMovementStopped.mockImplementation(async movementStopped => {
    director.applyBehaviorSettings({
      movementStopped,
      proactivityMode: initialSettings.proactivityMode
    });
  });
  return {
    behavior,
    director,
    motion,
    notices,
    saveMovementStopped,
    setTaskAuthorization: (value: CharacterBehaviorAuthorization) => { taskAuthorization = value; },
    setDirectedAuthorization: (value: CharacterBehaviorAuthorization) => { directedAuthorization = value; },
    setAgentAuthorization: (value: CharacterBehaviorAuthorization) => { agentAuthorization = value; },
    setReleasedTokens: (value: readonly string[]) => { releasedTokens = value; },
    setPlannedTargets: (value: Array<{ x: number; y: number }>) => { plannedTargets = value; },
    setMotionSnapshot: (value: typeof motionSnapshot) => { motionSnapshot = value; }
  };
}

/** 使用真实 MotionService 产生快照，避免以手工 moving 边沿掩盖连续状态机。 */
function createRealMotionFixture(input: Readonly<{
  position?: Readonly<{ x: number; y: number }>;
  random?: readonly number[];
}> = {}) {
  const base = createFixture();
  let now = 0;
  let bounds = {
    x: input.position?.x ?? 100,
    y: input.position?.y ?? 100,
    width: 100,
    height: 100
  };
  const randomValues = [...(input.random ?? [0.8, 0.8])];
  const motion = new CharacterMotionService({
    window: {
      getBounds: () => bounds,
      setPosition: (x, y) => { bounds = { ...bounds, x, y }; }
    },
    getDisplays: () => [{
      id: 'test-display', workAreaDip: { x: 0, y: 0, width: 1_000, height: 800 }
    }],
    getGeometrySnapshot: () => ({
      revision: 1,
      characterId: 'test-character',
      scale: 1,
      footAnchorDip: { x: bounds.x + 50, y: bounds.y + 100 },
      visualBoundsInWindowDip: { x: 0, y: 0, width: 100, height: 100 },
      windowBoundsDip: bounds,
      displayId: 'test-display'
    }),
    random: () => randomValues.shift() ?? 0.8,
    now: () => now,
    maxDeltaMs: 10_000
  });
  const director = new CharacterBehaviorDirector({
    behavior: base.behavior,
    motion,
    initialGeneration: 'generation-1',
    initialSettings: { movementStopped: false, proactivityMode: 'assistive' },
    saveMovementStopped: async stopped => {
      director.applyBehaviorSettings({ movementStopped: stopped, proactivityMode: 'assistive' });
    },
    now: () => now
  });
  return {
    ...base,
    director,
    motion,
    tick: (elapsedMs: number) => {
      now += elapsedMs;
      return motion.tick();
    }
  };
}

function play(name: string): CharacterBehaviorPlan {
  return { kind: 'play', target: { kind: 'action_name', name } };
}

describe('Main 角色行为 Director', () => {
  test('启动快照初始化同一 Director 的停止锁与主动性档位', () => {
    const fixture = createFixture({ movementStopped: true, proactivityMode: 'autonomous' });

    fixture.director.advance();
    fixture.director.handleAgentBehaviorIntent({
      stateIntent: { semantic: 'move' },
      actionSemantic: 'move',
      urgency: 20,
      explanation: '旧 V1 待机游走'
    });

    expect(fixture.director.getChatContext()).toMatchObject({
      runtime: { movementStopped: true },
      proactivityMode: 'autonomous'
    });
    expect(fixture.behavior.advance).toHaveBeenCalledOnce();
    expect(fixture.behavior.handleAgentIntent).not.toHaveBeenCalled();
    expect(fixture.motion.requestIntent).not.toHaveBeenCalled();
  });

  test('诊断快照把初始 movementStopped 映射为独立自主移动许可', () => {
    const running = createFixture();
    const stopped = createFixture({ movementStopped: true, proactivityMode: 'autonomous' });

    expect(running.director.getDiagnosticSnapshot()).toMatchObject({
      autonomousMovementAllowed: true,
      continuousMovementRequested: false
    });
    expect(stopped.director.getDiagnosticSnapshot()).toMatchObject({
      autonomousMovementAllowed: false,
      continuousMovementRequested: false
    });
  });

  test('停止成功落盘后锁住自主移动、清除持续请求并停止当前 Motion', async () => {
    const fixture = createFixture();
    fixture.setDirectedAuthorization({
      kind: 'play', actionId: 'move-action', playbackToken: 'move-token', semantic: 'move'
    });
    fixture.director.completeUserPrompt({
      generation: 'generation-1', explicitDirective: null, providerPlan: null,
      motionPlan: { mode: 'continuous', durationSeconds: null, target: 'random_work_area', distance: 'medium' }
    });
    fixture.director.handleTaskEvent({ type: 'phase', phase: 'success' });
    await fixture.director.prepareUserPrompt('静止不动');

    expect(fixture.director.getDiagnosticSnapshot()).toMatchObject({
      autonomousMovementAllowed: false,
      continuousMovementRequested: false,
      currentTargetType: null
    });
    expect(fixture.motion.stop).toHaveBeenCalledOnce();
  });

  test('resume 只解除自主移动锁，不自动发起新的 Motion', async () => {
    const fixture = createFixture({ movementStopped: true, proactivityMode: 'autonomous' });

    await fixture.director.prepareUserPrompt('恢复活动');

    expect(fixture.director.getDiagnosticSnapshot()).toMatchObject({
      autonomousMovementAllowed: true,
      continuousMovementRequested: false
    });
    expect(fixture.motion.requestIntent).not.toHaveBeenCalled();
  });

  test.each([
    ['动', { kind: 'wander', scope: 'short' }],
    ['运动', { kind: 'wander', scope: 'short' }],
    ['跑', { kind: 'wander', scope: 'short' }],
    ['跑一跑', { kind: 'wander', scope: 'short' }],
    ['保持运动', { kind: 'wander', scope: 'work_area', distance: 'medium' }]
  ] as const)('停止锁下明确命令“%s”落盘恢复后立即请求对应运动', async (text, motion) => {
    const fixture = createFixture({ movementStopped: true, proactivityMode: 'autonomous' });
    fixture.setDirectedAuthorization({
      kind: 'play', actionId: 'move-action', playbackToken: 'move-token', semantic: 'move'
    });

    await fixture.director.prepareUserPrompt(text);

    expect(fixture.saveMovementStopped).toHaveBeenCalledExactlyOnceWith(false);
    expect(fixture.motion.requestIntent).toHaveBeenCalledExactlyOnceWith(motion);
    expect(fixture.saveMovementStopped.mock.invocationCallOrder[0])
      .toBeLessThan(fixture.motion.requestIntent.mock.invocationCallOrder[0]!);
  });

  test.each(['动', '保持运动'] as const)(
    '停止锁下明确命令“%s”恢复落盘失败时不请求 Motion',
    async text => {
      const fixture = createFixture({ movementStopped: true, proactivityMode: 'autonomous' });
      fixture.setDirectedAuthorization({
        kind: 'play', actionId: 'move-action', playbackToken: 'move-token', semantic: 'move'
      });
      fixture.saveMovementStopped.mockRejectedValueOnce(new Error('WRITE_FAILED'));

      await expect(fixture.director.prepareUserPrompt(text)).rejects.toThrow('WRITE_FAILED');

      expect(fixture.motion.requestIntent).not.toHaveBeenCalled();
      expect(fixture.behavior.requestDirectedBehavior).not.toHaveBeenCalled();
      expect(fixture.director.getChatContext().runtime.movementStopped).toBe(true);
    }
  );

  test.each([
    { mode: 'once' as const, continuous: false },
    { mode: 'continuous' as const, continuous: true }
  ])('停止锁下当前用户轮次的 Schema $mode 计划先落盘解锁再运动', async ({ mode, continuous }) => {
    const fixture = createFixture({ movementStopped: true, proactivityMode: 'autonomous' });
    fixture.setDirectedAuthorization({
      kind: 'play', actionId: 'move-action', playbackToken: 'move-token', semantic: 'move'
    });

    await fixture.director.completeUserPrompt({
      generation: 'generation-1',
      explicitDirective: null,
      providerPlan: null,
      motionPlan: {
        mode,
        durationSeconds: null,
        target: 'random_work_area',
        distance: 'medium'
      }
    });
    fixture.director.handleTaskEvent({ type: 'phase', phase: 'success' });

    expect(fixture.saveMovementStopped).toHaveBeenCalledExactlyOnceWith(false);
    expect(fixture.motion.requestIntent).toHaveBeenCalledOnce();
    expect(fixture.director.getDiagnosticSnapshot().continuousMovementRequested)
      .toBe(continuous);
  });

  test('Schema 移动计划解锁落盘失败时不保留待执行动作', async () => {
    const fixture = createFixture({ movementStopped: true, proactivityMode: 'autonomous' });
    fixture.setDirectedAuthorization({
      kind: 'play', actionId: 'move-action', playbackToken: 'move-token', semantic: 'move'
    });
    fixture.saveMovementStopped.mockRejectedValueOnce(new Error('WRITE_FAILED'));

    await expect(fixture.director.completeUserPrompt({
      generation: 'generation-1',
      explicitDirective: null,
      providerPlan: null,
      motionPlan: {
        mode: 'once', durationSeconds: null, target: 'random_work_area', distance: 'medium'
      }
    })).rejects.toThrow('WRITE_FAILED');
    fixture.director.handleTaskEvent({ type: 'phase', phase: 'success' });

    expect(fixture.motion.requestIntent).not.toHaveBeenCalled();
    expect(fixture.behavior.requestDirectedBehavior).not.toHaveBeenCalled();
  });

  test.each([
    ['reset', async (fixture: ReturnType<typeof createFixture>) => {
      fixture.director.reset('generation-2');
    }],
    ['close', async (fixture: ReturnType<typeof createFixture>) => {
      await fixture.director.close();
    }]
  ] as const)('Schema 移动解锁保存悬空期间 %s 后旧轮不得复活 pending', async (_name, invalidate) => {
    const fixture = createFixture({ movementStopped: true, proactivityMode: 'autonomous' });
    let releaseSave: (() => void) | undefined;
    fixture.saveMovementStopped.mockImplementationOnce(async movementStopped => {
      await new Promise<void>(resolve => { releaseSave = resolve; });
      fixture.director.applyBehaviorSettings({
        movementStopped,
        proactivityMode: 'autonomous'
      });
    });

    const completion = fixture.director.completeUserPrompt({
      generation: 'generation-1',
      explicitDirective: null,
      providerPlan: null,
      motionPlan: {
        mode: 'once', durationSeconds: null, target: 'random_work_area', distance: 'medium'
      }
    });
    await vi.waitFor(() => expect(releaseSave).toBeTypeOf('function'));
    await invalidate(fixture);
    releaseSave?.();
    await completion;
    fixture.director.handleTaskEvent({ type: 'phase', phase: 'success' });

    expect(Reflect.get(fixture.director, 'pendingMotionPlan')).toBeNull();
    expect(fixture.motion.requestIntent).not.toHaveBeenCalled();
    expect(fixture.behavior.requestDirectedBehavior).not.toHaveBeenCalled();
  });

  test('Schema none 与纯行为候选不解除停止锁', async () => {
    const fixture = createFixture({ movementStopped: true, proactivityMode: 'autonomous' });

    await fixture.director.completeUserPrompt({
      generation: 'generation-1',
      explicitDirective: null,
      providerPlan: { kind: 'none' },
      motionPlan: { mode: 'none', durationSeconds: null, target: 'current', distance: 'none' }
    });
    fixture.director.handleTaskEvent({ type: 'phase', phase: 'success' });

    expect(fixture.saveMovementStopped).not.toHaveBeenCalled();
    expect(fixture.director.getChatContext().runtime.movementStopped).toBe(true);
  });

  test('move→stop→move 不等待旧显式播放令牌结束', async () => {
    const fixture = createFixture();
    fixture.setDirectedAuthorization({
      kind: 'play', actionId: 'move-action', playbackToken: 'move-token', semantic: 'move'
    });

    await fixture.director.prepareUserPrompt('动');
    await fixture.director.prepareUserPrompt('停下');
    await fixture.director.prepareUserPrompt('动');

    expect(fixture.motion.requestIntent).toHaveBeenCalledTimes(2);
    expect(fixture.saveMovementStopped.mock.calls.map(([value]) => value))
      .toEqual([true, false]);
  });

  test('持续计划到达后复用 MotionService 请求下一随机工作区目标，停止后不再续行', () => {
    const fixture = createFixture();
    fixture.setDirectedAuthorization({
      kind: 'play', actionId: 'move-action', playbackToken: 'move-token', semantic: 'move'
    });
    fixture.director.completeUserPrompt({
      generation: 'generation-1', explicitDirective: null, providerPlan: null,
      motionPlan: { mode: 'continuous', durationSeconds: null, target: 'random_work_area', distance: 'medium' }
    });
    fixture.director.handleTaskEvent({ type: 'phase', phase: 'success' });
    fixture.director.handleMotionSnapshot({ ...fixture.motion.getSnapshot(), moving: true });
    fixture.director.handleMotionSnapshot({ ...fixture.motion.getSnapshot(), moving: false });

    expect(fixture.motion.requestIntent).toHaveBeenCalledTimes(2);
    expect(fixture.motion.requestIntent).toHaveBeenNthCalledWith(1, {
      kind: 'wander', scope: 'work_area', distance: 'medium'
    });
    expect(fixture.motion.requestIntent).toHaveBeenNthCalledWith(2, {
      kind: 'wander', scope: 'work_area', distance: 'medium'
    });
    fixture.director.applyBehaviorSettings({ movementStopped: true, proactivityMode: 'assistive' });
    fixture.director.handleMotionSnapshot({ ...fixture.motion.getSnapshot(), moving: true });
    fixture.director.handleMotionSnapshot({ ...fixture.motion.getSnapshot(), moving: false });
    expect(fixture.motion.requestIntent).toHaveBeenCalledTimes(2);
  });

  test.each([
    ['current', { x: 100, y: 100 }, [0.8, 0.8]],
    ['bottom_right', { x: 900, y: 700 }, [0.8, 0.8]],
    ['random_work_area', { x: 100, y: 100 }, [0.12, 0.12, 0.8, 0.8]]
  ] as const)(
    '连续计划 %s 初始未形成运动时立即以真实 MotionService 快照重采样',
    async (target, position, random) => {
      const fixture = createRealMotionFixture({ position, random });
      const requestIntent = vi.spyOn(fixture.motion, 'requestIntent');
      fixture.setDirectedAuthorization({
        kind: 'play', actionId: 'move-action', playbackToken: 'move-token', semantic: 'move'
      });

      await fixture.director.completeUserPrompt({
        generation: 'generation-1', explicitDirective: null, providerPlan: null,
        motionPlan: { mode: 'continuous', durationSeconds: null, target, distance: 'medium' }
      });
      fixture.director.handleTaskEvent({ type: 'phase', phase: 'success' });

      expect(requestIntent).toHaveBeenCalledTimes(2);
      expect(fixture.motion.getSnapshot().moving).toBe(true);
      expect(fixture.director.getDiagnosticSnapshot()).toMatchObject({
        continuousMovementRequested: true,
        continuationDeadlineActive: false
      });
    }
  );

  test('连续计划的后续随机近点以真实静止快照重采样，不会在无时限状态挂起', async () => {
    const fixture = createRealMotionFixture({
      random: [0.8, 0.8, 0.8, 0.8, 0.6, 0.6]
    });
    const requestIntent = vi.spyOn(fixture.motion, 'requestIntent');
    fixture.setDirectedAuthorization({
      kind: 'play', actionId: 'move-action', playbackToken: 'move-token', semantic: 'move'
    });

    await fixture.director.completeUserPrompt({
      generation: 'generation-1', explicitDirective: null, providerPlan: null,
      motionPlan: { mode: 'continuous', durationSeconds: null, target: 'current', distance: 'none' }
    });
    fixture.director.handleTaskEvent({ type: 'phase', phase: 'success' });
    const arrived = fixture.tick(10_000);
    expect(arrived.moving).toBe(false);
    fixture.director.handleMotionSnapshot(arrived);

    expect(requestIntent).toHaveBeenCalledTimes(4);
    expect(fixture.motion.getSnapshot().moving).toBe(true);
    expect(fixture.director.getDiagnosticSnapshot()).toMatchObject({
      continuousMovementRequested: true,
      continuationDeadlineActive: false
    });
  });

  test.each([
    ['拖拽', (fixture: ReturnType<typeof createRealMotionFixture>) => fixture.director.setDragging(true)],
    ['可信任务', (fixture: ReturnType<typeof createRealMotionFixture>) => fixture.director.handleTaskEvent({
      type: 'phase', phase: 'thinking'
    })],
    ['确认任务', (fixture: ReturnType<typeof createRealMotionFixture>) => fixture.director.handleTaskEvent({
      type: 'phase', phase: 'awaiting_confirmation'
    })],
    ['能力执行', (fixture: ReturnType<typeof createRealMotionFixture>) => fixture.director.handleTaskEvent({
      type: 'phase', phase: 'acting'
    })],
    ['更高优先级播放', (fixture: ReturnType<typeof createRealMotionFixture>) => {
      fixture.setDirectedAuthorization({
        kind: 'play', actionId: 'wave-action', playbackToken: 'wave-token', semantic: 'celebrate'
      });
      fixture.director.requestBehaviorPlan(play('挥手'), 'explicit');
    }]
  ] as const)('连续窗口尚未到达时进入%s立即停止真实 Motion', async (_name, enterBlocker) => {
    const fixture = createRealMotionFixture();
    fixture.setDirectedAuthorization({
      kind: 'play', actionId: 'move-action', playbackToken: 'move-token', semantic: 'move'
    });
    await fixture.director.completeUserPrompt({
      generation: 'generation-1', explicitDirective: null, providerPlan: null,
      motionPlan: { mode: 'continuous', durationSeconds: null, target: 'random_work_area', distance: 'medium' }
    });
    fixture.director.handleTaskEvent({ type: 'phase', phase: 'success' });
    const moving = fixture.tick(1);
    expect(moving.moving).toBe(true);
    fixture.director.handleMotionSnapshot(moving);

    enterBlocker(fixture);

    expect(fixture.director.getDiagnosticSnapshot()).toMatchObject({
      continuousMovementRequested: false,
      currentTargetType: null,
      continuationDeadlineActive: false
    });
    expect(fixture.tick(1).moving).toBe(false);
  });

  test.each([
    ['reset', async (fixture: ReturnType<typeof createRealMotionFixture>) => fixture.director.reset('generation-2')],
    ['角色切换', async (fixture: ReturnType<typeof createRealMotionFixture>) => {
      await fixture.director.handleActiveCharacterChanged();
    }],
    ['close', async (fixture: ReturnType<typeof createRealMotionFixture>) => fixture.director.close()]
  ] as const)('连续窗口尚未到达时 %s 立即清理真实 Motion', async (_name, clear) => {
    const fixture = createRealMotionFixture();
    fixture.setDirectedAuthorization({
      kind: 'play', actionId: 'move-action', playbackToken: 'move-token', semantic: 'move'
    });
    await fixture.director.completeUserPrompt({
      generation: 'generation-1', explicitDirective: null, providerPlan: null,
      motionPlan: { mode: 'continuous', durationSeconds: null, target: 'random_work_area', distance: 'medium' }
    });
    fixture.director.handleTaskEvent({ type: 'phase', phase: 'success' });
    expect(fixture.tick(1).moving).toBe(true);

    await clear(fixture);

    expect(fixture.director.getDiagnosticSnapshot()).toMatchObject({
      continuousMovementRequested: false,
      currentTargetType: null,
      continuationDeadlineActive: false
    });
    expect(fixture.tick(1).moving).toBe(false);
  });

  test.each([
    ['random_work_area', { kind: 'wander', scope: 'work_area', distance: 'medium' }],
    ['bottom_right', { kind: 'region', region: 'bottom_right' }],
    ['current', { kind: 'return-visible' }]
  ] as const)('连续计划 %s 的续行选择不同实际目标且不复用固定 intent', (target, firstIntent) => {
    const fixture = createFixture();
    fixture.setPlannedTargets([
      { x: 40, y: 30 },
      { x: 40, y: 30 },
      { x: 60, y: 30 }
    ]);
    fixture.setDirectedAuthorization({
      kind: 'play', actionId: 'move-action', playbackToken: 'move-token', semantic: 'move'
    });
    fixture.director.completeUserPrompt({
      generation: 'generation-1', explicitDirective: null, providerPlan: null,
      motionPlan: { mode: 'continuous', durationSeconds: null, target, distance: 'medium' }
    });
    fixture.director.handleTaskEvent({ type: 'phase', phase: 'success' });
    const firstTarget = { x: 40, y: 30 };
    fixture.director.handleMotionSnapshot({ ...fixture.motion.getSnapshot(), moving: true });
    fixture.director.handleMotionSnapshot({ ...fixture.motion.getSnapshot(), moving: false });

    expect(fixture.motion.requestIntent).toHaveBeenNthCalledWith(1, firstIntent);
    expect(fixture.motion.requestIntent).toHaveBeenNthCalledWith(2, {
      kind: 'wander', scope: 'work_area', distance: 'medium'
    });
    expect(fixture.motion.getSnapshot().target).not.toEqual(firstTarget);
  });

  test('连续计划三次重采样仍未得到新空间目标时安全终止', () => {
    const fixture = createFixture();
    fixture.setPlannedTargets([
      { x: 40, y: 30 },
      { x: 40, y: 30 },
      { x: 40, y: 30 },
      { x: 40, y: 30 }
    ]);
    fixture.setDirectedAuthorization({
      kind: 'play', actionId: 'move-action', playbackToken: 'move-token', semantic: 'move'
    });
    fixture.director.completeUserPrompt({
      generation: 'generation-1', explicitDirective: null, providerPlan: null,
      motionPlan: { mode: 'continuous', durationSeconds: null, target: 'random_work_area', distance: 'medium' }
    });
    fixture.director.handleTaskEvent({ type: 'phase', phase: 'success' });
    fixture.director.handleMotionSnapshot({ ...fixture.motion.getSnapshot(), moving: true });
    fixture.director.handleMotionSnapshot({ ...fixture.motion.getSnapshot(), moving: false });

    expect(fixture.motion.requestIntent).toHaveBeenCalledTimes(4);
    expect(fixture.director.getDiagnosticSnapshot()).toMatchObject({
      continuousMovementRequested: false,
      currentTargetType: null,
      continuationDeadlineActive: false
    });
    expect(fixture.motion.stop).toHaveBeenCalledOnce();
  });

  test.each([
    ['拖拽', (fixture: ReturnType<typeof createFixture>) => fixture.director.setDragging(true)],
    ['可信任务确认', (fixture: ReturnType<typeof createFixture>) => fixture.director.handleTaskEvent({
      type: 'phase', phase: 'awaiting_confirmation'
    })],
    ['更高优先级播放', (fixture: ReturnType<typeof createFixture>) => {
      fixture.setDirectedAuthorization({
        kind: 'play', actionId: 'wave-action', playbackToken: 'wave-token', semantic: 'celebrate'
      });
      fixture.director.requestBehaviorPlan(play('挥手'), 'explicit');
    }]
  ] as const)('连续运动在%s到达时安全终止且不绕过 Director blocker', (_名称, block) => {
    const fixture = createFixture();
    fixture.setDirectedAuthorization({
      kind: 'play', actionId: 'move-action', playbackToken: 'move-token', semantic: 'move'
    });
    fixture.director.completeUserPrompt({
      generation: 'generation-1', explicitDirective: null, providerPlan: null,
      motionPlan: { mode: 'continuous', durationSeconds: null, target: 'random_work_area', distance: 'medium' }
    });
    fixture.director.handleTaskEvent({ type: 'phase', phase: 'success' });
    fixture.director.handleMotionSnapshot({ ...fixture.motion.getSnapshot(), moving: true });
    block(fixture);
    fixture.director.handleMotionSnapshot({ ...fixture.motion.getSnapshot(), moving: false });

    expect(fixture.motion.requestIntent).toHaveBeenCalledOnce();
    expect(fixture.director.getDiagnosticSnapshot()).toMatchObject({
      continuousMovementRequested: false,
      currentTargetType: null,
      continuationDeadlineActive: false
    });
    expect(fixture.motion.stop).toHaveBeenCalledOnce();
  });

  test.each(['reset', '角色切换', 'close'] as const)(
    '%s 清除连续请求、截止和当前目标并停止 Motion',
    async operation => {
      const fixture = createFixture();
      fixture.setDirectedAuthorization({
        kind: 'play', actionId: 'move-action', playbackToken: 'move-token', semantic: 'move'
      });
      fixture.director.completeUserPrompt({
        generation: 'generation-1', explicitDirective: null, providerPlan: null,
        motionPlan: { mode: 'continuous', durationSeconds: 30, target: 'random_work_area', distance: 'medium' }
      });
      fixture.director.handleTaskEvent({ type: 'phase', phase: 'success' });

      if (operation === 'reset') fixture.director.reset('generation-2');
      else if (operation === '角色切换') await fixture.director.handleActiveCharacterChanged();
      else await fixture.director.close();

      expect(fixture.director.getDiagnosticSnapshot()).toMatchObject({
        continuousMovementRequested: false,
        currentTargetType: null,
        continuationDeadlineActive: false
      });
      expect(fixture.motion.stop).toHaveBeenCalledOnce();
    }
  );

  test('持续计划在 Main 单调时钟到期后清除请求并停止 Motion', () => {
    let now = 0;
    const fixture = createFixture(undefined, () => now);
    fixture.setDirectedAuthorization({
      kind: 'play', actionId: 'move-action', playbackToken: 'move-token', semantic: 'move'
    });
    fixture.director.completeUserPrompt({
      generation: 'generation-1', explicitDirective: null, providerPlan: null,
      motionPlan: { mode: 'continuous', durationSeconds: 1, target: 'random_work_area', distance: 'medium' }
    });
    fixture.director.handleTaskEvent({ type: 'phase', phase: 'success' });
    now = 1_000;
    fixture.director.advance();

    expect(fixture.director.getDiagnosticSnapshot()).toMatchObject({
      continuousMovementRequested: false,
      continuationDeadlineActive: false
    });
    expect(fixture.motion.stop).toHaveBeenCalledOnce();
  });

  test('一次性计划到达后回到 idle 且不保留当前目标', () => {
    const fixture = createFixture();
    fixture.setDirectedAuthorization({
      kind: 'play', actionId: 'move-action', playbackToken: 'move-token', semantic: 'move'
    });
    fixture.director.completeUserPrompt({
      generation: 'generation-1', explicitDirective: null, providerPlan: null,
      motionPlan: { mode: 'once', durationSeconds: null, target: 'bottom_right', distance: 'far' }
    });
    fixture.director.handleTaskEvent({ type: 'phase', phase: 'success' });
    expect(fixture.director.getDiagnosticSnapshot()).toMatchObject({
      continuousMovementRequested: false,
      currentTargetType: 'bottom_right'
    });

    fixture.director.handleMotionSnapshot({ ...fixture.motion.getSnapshot(), moving: true });
    fixture.director.handleMotionSnapshot({ ...fixture.motion.getSnapshot(), moving: false });
    expect(fixture.director.getDiagnosticSnapshot()).toMatchObject({
      continuousMovementRequested: false,
      currentTargetType: null
    });
    expect(fixture.motion.requestIntent).toHaveBeenCalledOnce();
  });

  test('本地 Gate 的停止与恢复会持久化，并在成功快照应用后更新锁', async () => {
    const fixture = createFixture();

    await fixture.director.prepareUserPrompt('停下');
    await fixture.director.prepareUserPrompt('恢复活动');

    expect(fixture.saveMovementStopped).toHaveBeenNthCalledWith(1, true);
    expect(fixture.saveMovementStopped).toHaveBeenNthCalledWith(2, false);
    expect(fixture.motion.stop).toHaveBeenCalledOnce();
    expect(fixture.director.getChatContext().runtime.movementStopped).toBe(false);
  });

  test('Provider motionPlan.stop 也等待成功落盘后锁住自主移动', async () => {
    const fixture = createFixture();

    await fixture.director.completeUserPrompt({
      generation: 'generation-1', explicitDirective: null, providerPlan: null,
      motionPlan: { mode: 'stop', durationSeconds: null, target: 'current', distance: 'none' }
    });

    expect(fixture.saveMovementStopped).toHaveBeenCalledExactlyOnceWith(true);
    expect(fixture.director.getDiagnosticSnapshot()).toMatchObject({
      autonomousMovementAllowed: false,
      continuousMovementRequested: false
    });
  });

  test('Provider motionPlan.stop 落盘失败时不提前修改停止锁', async () => {
    const fixture = createFixture();
    fixture.saveMovementStopped.mockRejectedValueOnce(new Error('WRITE_FAILED'));

    await expect(fixture.director.completeUserPrompt({
      generation: 'generation-1', explicitDirective: null, providerPlan: null,
      motionPlan: { mode: 'stop', durationSeconds: null, target: 'current', distance: 'none' }
    })).rejects.toThrow('WRITE_FAILED');

    expect(fixture.director.getDiagnosticSnapshot()).toMatchObject({
      autonomousMovementAllowed: true,
      continuousMovementRequested: false
    });
    expect(fixture.motion.stop).not.toHaveBeenCalled();
  });

  test('本地 Gate 停止落盘失败时不修改运动或停止锁', async () => {
    const fixture = createFixture();
    fixture.saveMovementStopped.mockRejectedValueOnce(new Error('WRITE_FAILED'));

    await expect(fixture.director.prepareUserPrompt('停下')).rejects.toThrow('WRITE_FAILED');

    expect(fixture.motion.stop).not.toHaveBeenCalled();
    expect(fixture.director.getChatContext().runtime.movementStopped).toBe(false);
  });

  test('显式移动先取得 move 动作授权再产生唯一对象化运动意图', async () => {
    const fixture = createFixture();
    fixture.setDirectedAuthorization({
      kind: 'play', actionId: 'move-action', playbackToken: 'move-token', semantic: 'move'
    });

    await expect(fixture.director.prepareUserPrompt('向左一点')).resolves.toEqual({
      originalText: '向左一点',
      capabilityText: '向左一点',
      explicitDirective: {
        kind: 'move',
        motion: { kind: 'relative', direction: 'left', distance: 'near' }
      }
    });

    expect(fixture.behavior.requestDirectedBehavior).toHaveBeenCalledExactlyOnceWith(
      { kind: 'semantic', semantic: 'move' },
      { urgency: 100, systemForced: true }
    );
    expect(fixture.motion.requestIntent).toHaveBeenCalledExactlyOnceWith({
      kind: 'relative', direction: 'left', distance: 'near'
    });
    expect(fixture.behavior.requestDirectedBehavior.mock.invocationCallOrder[0])
      .toBeLessThan(fixture.motion.requestIntent.mock.invocationCallOrder[0]!);
  });

  test('“跑远一点”从显式 Gate 到 Motion 意图始终保留 far 且只提交一次', async () => {
    const fixture = createFixture();
    fixture.setDirectedAuthorization({
      kind: 'play', actionId: 'move-action', playbackToken: 'move-token', semantic: 'move'
    });

    const prepared = await fixture.director.prepareUserPrompt('跑远一点');

    expect(prepared.explicitDirective).toEqual({
      kind: 'move',
      motion: { kind: 'wander', scope: 'work_area', distance: 'far' }
    });
    expect(fixture.motion.requestIntent).toHaveBeenCalledExactlyOnceWith({
      kind: 'wander', scope: 'work_area', distance: 'far'
    });
  });

  test('显式移动未取得播放授权时不移动并发布稳定提示', async () => {
    const fixture = createFixture();

    await fixture.director.prepareUserPrompt('去右下角');

    expect(fixture.motion.requestIntent).not.toHaveBeenCalled();
    expect(fixture.notices).toEqual([{
      code: 'CHARACTER_ACTION_UNAVAILABLE',
      message: '当前角色没有可播放的对应动作。'
    }]);
  });

  test('明确动作命令在 Provider 前直接请求精确动作且不请求运动', async () => {
    const fixture = createFixture();
    fixture.setDirectedAuthorization({
      kind: 'play', actionId: 'wave-action', playbackToken: 'wave-token', semantic: 'celebrate'
    });

    await expect(fixture.director.prepareUserPrompt('请播放挥手动作')).resolves.toEqual({
      originalText: '请播放挥手动作',
      capabilityText: '请播放挥手动作',
      explicitDirective: {
        kind: 'play',
        target: { kind: 'action_name', name: '挥手' }
      }
    });

    expect(fixture.behavior.resolveBehaviorTarget).toHaveBeenCalledExactlyOnceWith({
      kind: 'action_name', name: '挥手'
    });
    expect(fixture.behavior.requestDirectedBehavior).toHaveBeenCalledExactlyOnceWith(
      { kind: 'action', actionId: 'wave-action' },
      { urgency: 100, systemForced: true }
    );
    expect(fixture.motion.requestIntent).not.toHaveBeenCalled();
  });

  test('明确动作不存在时在 Provider 前发布稳定提示且不播放待机冒充', async () => {
    const fixture = createFixture();

    await fixture.director.prepareUserPrompt('请做一个后空翻动作');

    expect(fixture.behavior.resolveBehaviorTarget).toHaveBeenCalledExactlyOnceWith({
      kind: 'action_name', name: '后空翻'
    });
    expect(fixture.behavior.requestDirectedBehavior).not.toHaveBeenCalled();
    expect(fixture.motion.requestIntent).not.toHaveBeenCalled();
    expect(fixture.notices).toEqual([{
      code: 'CHARACTER_ACTION_UNAVAILABLE',
      message: '当前角色没有可播放的对应动作。'
    }]);
  });

  test('停止立即撤销运动且 500ms poll 始终只推进令牌清理', async () => {
    const fixture = createFixture();
    fixture.director.advance();
    expect(fixture.behavior.advance).toHaveBeenCalledOnce();

    await fixture.director.prepareUserPrompt('停下');
    fixture.director.advance();

    expect(fixture.motion.stop).toHaveBeenCalledOnce();
    expect(fixture.behavior.advance).toHaveBeenCalledTimes(2);

    await fixture.director.prepareUserPrompt('恢复活动');
    fixture.director.advance();
    expect(fixture.behavior.advance).toHaveBeenCalledTimes(3);
  });

  test('旧能力任务意图经 Director 授权且 move 只产生一次受控运动意图', () => {
    const fixture = createFixture();
    fixture.setAgentAuthorization({
      kind: 'play', actionId: 'move-action', playbackToken: 'agent-move-token', semantic: 'move'
    });
    const intent: CharacterAgentBehaviorIntent = {
      stateIntent: { semantic: 'move' }, actionSemantic: 'move', urgency: 80,
      explanation: '能力任务完成后移动'
    };

    expect(fixture.director.handleAgentBehaviorIntent(intent)).toMatchObject({
      kind: 'play', playbackToken: 'agent-move-token', semantic: 'move'
    });

    expect(fixture.behavior.handleAgentIntent).toHaveBeenCalledExactlyOnceWith(intent);
    expect(fixture.motion.requestIntent).toHaveBeenCalledExactlyOnceWith({
      kind: 'wander', scope: 'work_area'
    });
  });

  test('autonomous 的本地 move 候选取得移动授权并发起当前单屏 wander', () => {
    const fixture = createFixture({ movementStopped: false, proactivityMode: 'autonomous' });
    fixture.setDirectedAuthorization({
      kind: 'play', actionId: 'move-action', playbackToken: 'local-move-token', semantic: 'move'
    });

    expect(fixture.director.requestBehaviorPlan({
      kind: 'play', target: { kind: 'semantic', semantic: 'move' }
    }, 'local-idle')).toMatchObject({ kind: 'play', semantic: 'move' });

    expect(fixture.behavior.requestProactiveBehavior).toHaveBeenCalledWith(
      { kind: 'semantic', semantic: 'move' },
      { urgency: 10, allowMovement: true }
    );
    expect(fixture.motion.requestIntent).toHaveBeenCalledExactlyOnceWith({
      kind: 'wander', scope: 'work_area'
    });
  });

  test('停止锁与显式动作优先级都阻止旧能力任务的 move 意图', async () => {
    const intent: CharacterAgentBehaviorIntent = {
      stateIntent: { semantic: 'move' }, actionSemantic: 'move', urgency: 80,
      explanation: '旧能力任务移动'
    };
    const stopped = createFixture();
    await stopped.director.prepareUserPrompt('停下');
    expect(stopped.director.handleAgentBehaviorIntent(intent)).toEqual(NONE);
    expect(stopped.behavior.handleAgentIntent).not.toHaveBeenCalled();

    const explicit = createFixture();
    explicit.setDirectedAuthorization({
      kind: 'play', actionId: 'wave-action', playbackToken: 'explicit-token', semantic: 'celebrate'
    });
    explicit.director.requestBehaviorPlan(play('挥手'), 'explicit');
    expect(explicit.director.handleAgentBehaviorIntent(intent)).toEqual(NONE);
    expect(explicit.behavior.handleAgentIntent).not.toHaveBeenCalled();
  });

  test('聊天移动计划只有在 move 动作授权后才请求对应运动且不重复 wander', () => {
    const fixture = createFixture();
    fixture.setDirectedAuthorization({
      kind: 'play', actionId: 'move-action', playbackToken: 'move-token', semantic: 'move'
    });
    fixture.director.completeUserPrompt({
      generation: 'generation-1',
      explicitDirective: null,
      providerPlan: { kind: 'move_region', region: 'bottom_right' }
    });

    fixture.director.handleTaskEvent({ type: 'phase', phase: 'success' });

    expect(fixture.motion.requestIntent).toHaveBeenCalledExactlyOnceWith({
      kind: 'region', region: 'bottom_right'
    });
  });

  test('聊天隐藏描述只选择当前公开目录中的最高相似动作', () => {
    const fixture = createFixture();
    fixture.setDirectedAuthorization({
      kind: 'play', actionId: 'celebrate-action', playbackToken: 'dance-token', semantic: 'celebrate'
    });
    fixture.director.completeUserPrompt({
      generation: 'generation-1',
      explicitDirective: null,
      providerPlan: { kind: 'play', target: { kind: 'action_name', name: '目录外动作' } },
      activity: '来一段 dance',
      status: 'dance'
    });
    fixture.director.handleTaskEvent({ type: 'phase', phase: 'success' });

    expect(fixture.behavior.resolveBehaviorTarget).toHaveBeenCalledWith({
      kind: 'action_name', name: '庆祝'
    });
  });

  test('Provider 返回 none 时仍按隐藏描述与运动计划选择最高相似动作', () => {
    const fixture = createFixture();
    fixture.setDirectedAuthorization({
      kind: 'play', actionId: 'celebrate-action', playbackToken: 'dance-token', semantic: 'celebrate'
    });
    fixture.director.completeUserPrompt({
      generation: 'generation-1',
      explicitDirective: null,
      providerPlan: { kind: 'none' },
      motionPlan: { mode: 'none', durationSeconds: null, target: 'current', distance: 'none' },
      activity: '来一段 dance',
      status: '欢快 dance'
    });
    fixture.director.handleTaskEvent({ type: 'phase', phase: 'success' });

    expect(fixture.behavior.resolveBehaviorTarget).toHaveBeenCalledWith({
      kind: 'action_name', name: '庆祝'
    });
  });

  test.each([
    ['once', false],
    ['continuous', true]
  ] as const)('同轮自定义移动动作与 %s 计划共用一次授权并实际提交运动', (mode, continuous) => {
    const fixture = createFixture();
    fixture.behavior.getPublicBehaviorCatalog.mockReturnValue({
      characterName: '测试角色', semantics: ['idle', 'move'],
      stateNames: [], actionNames: ['巡游四方'], tags: ['locomotion'],
      candidates: [
        { kind: 'action_name', name: '巡游四方', semantic: 'move', tags: ['locomotion'] }
      ]
    });
    fixture.behavior.resolveBehaviorTarget.mockReturnValue({
      kind: 'action', actionId: 'move-action'
    });
    fixture.setDirectedAuthorization({
      kind: 'play', actionId: 'move-action', playbackToken: 'move-token', semantic: 'move'
    });
    fixture.director.completeUserPrompt({
      generation: 'generation-1', explicitDirective: null, providerPlan: { kind: 'none' },
      motionPlan: { mode, durationSeconds: null, target: 'bottom_right', distance: 'far' },
      activity: '开始巡游', status: '保持运动'
    });

    fixture.director.handleTaskEvent({ type: 'phase', phase: 'success' });

    expect(fixture.behavior.resolveBehaviorTarget).toHaveBeenCalledExactlyOnceWith({
      kind: 'action_name', name: '巡游四方'
    });
    expect(fixture.behavior.requestDirectedBehavior).toHaveBeenCalledOnce();
    expect(fixture.motion.requestIntent).toHaveBeenCalledExactlyOnceWith({
      kind: 'region', region: 'bottom_right'
    });
    expect(fixture.director.getDiagnosticSnapshot().continuousMovementRequested).toBe(continuous);
  });

  test('Provider 精确命中当前自定义动作时优先于隐藏描述的相似回退', () => {
    const fixture = createFixture();
    fixture.setDirectedAuthorization({
      kind: 'play', actionId: 'wave-action', playbackToken: 'wave-token', semantic: 'celebrate'
    });
    fixture.director.completeUserPrompt({
      generation: 'generation-1',
      explicitDirective: null,
      providerPlan: { kind: 'play', target: { kind: 'action_name', name: '挥手' } },
      activity: '来一段 dance',
      status: 'dance'
    });
    fixture.director.handleTaskEvent({ type: 'phase', phase: 'success' });

    expect(fixture.behavior.resolveBehaviorTarget).toHaveBeenCalledWith({
      kind: 'action_name', name: '挥手'
    });
  });

  test('公开聊天上下文只包含清单、运行布尔、档位和公开近期动作', () => {
    const fixture = createFixture();

    expect(fixture.director.getChatContext()).toEqual({
      character: {
        characterName: '测试角色', semantics: ['idle', 'celebrate'],
        stateNames: ['开心'], actionNames: ['挥手', '庆祝'], tags: [],
        candidates: [
          { kind: 'state_name', name: '开心', semantic: 'celebrate', tags: [] },
          { kind: 'action_name', name: '挥手', semantic: 'celebrate', tags: [] },
          { kind: 'action_name', name: '庆祝', semantic: 'celebrate', tags: ['dance'] }
        ]
      },
      runtime: {
        moving: true,
        dragging: false,
        carrying: false,
        movementStopped: false,
        autonomousMovementAllowed: true,
        continuousMovementRequested: false
      },
      proactivityMode: 'assistive',
      recentActions: ['挥手']
    });
    expect(JSON.stringify(fixture.director.getChatContext())).not.toMatch(
      /actionId|playbackToken|[A-Z]:\\/u
    );
  });

  test('聊天、拖拽、移动、文件任务、确认等待和 close 更新同一 blockers 快照', async () => {
    const fixture = createFixture();
    fixture.motion.getSnapshot.mockReturnValue({
      revision: 2,
      timestampMs: 10,
      position: { x: 20, y: 30 },
      target: { x: 20, y: 30 },
      direction: 'right',
      moving: false,
      carrying: false
    });
    const observed: unknown[] = [];
    fixture.director.subscribeActivityBlockers(() => {
      observed.push(fixture.director.getActivityBlockers());
    });

    fixture.director.handleTaskEvent({ type: 'phase', phase: 'thinking' });
    fixture.director.setDragging(true);
    fixture.motion.getSnapshot.mockReturnValue({
      ...fixture.motion.getSnapshot(),
      target: { x: 40, y: 30 },
      moving: true
    });
    fixture.director.refreshActivityBlockers();
    fixture.director.handleTaskEvent({
      type: 'pending_action',
      action: {
        category: 'file',
        actionId: 'pending-1',
        conversationId: 'conversation-1',
        risk: 'write',
        operation: 'create_file',
        summary: '等待确认',
        targetRelativePath: 'safe.txt',
        contentCharacters: 0,
        contentPreview: null,
        contentPreviewSuppressedReason: null,
        previewTruncated: false,
        createdAt: '2026-08-23T00:00:00.000Z',
        expiresAt: '2026-08-23T00:05:00.000Z'
      }
    });
    await fixture.director.close();

    expect(observed).toEqual(expect.arrayContaining([
      expect.objectContaining({ chatting: true }),
      expect.objectContaining({ dragging: true }),
      expect.objectContaining({ moving: true }),
      expect.objectContaining({ capabilityTask: true, awaitingConfirmation: true }),
      expect.objectContaining({ closed: true })
    ]));
  });

  test('角色清单切换或兼容态暂不可用时仍保留普通聊天的空公开上下文', () => {
    const fixture = createFixture();
    fixture.behavior.getPublicBehaviorCatalog.mockImplementation(() => {
      throw new Error('CHARACTER_ACTION_UNAVAILABLE');
    });

    expect(fixture.director.getChatContext()).toMatchObject({
      character: {
        characterName: '当前角色',
        semantics: [],
        stateNames: [],
        actionNames: [],
        tags: []
      },
      runtime: { movementStopped: false },
      recentActions: []
    });
  });

  test('同轮本地 stop 指令后忽略 Provider resume，解析后的 move 动作仍受停止锁拦截', async () => {
    const fixture = createFixture();
    fixture.setDirectedAuthorization({
      kind: 'play', actionId: 'move-action', playbackToken: 'move-token', semantic: 'move'
    });
    const prepared = await fixture.director.prepareUserPrompt('停下');
    fixture.director.completeUserPrompt({
      generation: 'generation-1',
      explicitDirective: prepared.explicitDirective,
      providerPlan: { kind: 'resume_movement' }
    });
    fixture.director.handleTaskEvent({ type: 'phase', phase: 'success' });

    expect(fixture.director.requestBehaviorPlan(play('移动'), 'explicit')).toEqual(NONE);
    expect(fixture.behavior.resolveBehaviorTarget).toHaveBeenCalledWith({
      kind: 'action_name', name: '移动'
    });
    expect(fixture.behavior.requestDirectedBehavior).not.toHaveBeenCalled();
    expect(fixture.saveMovementStopped).toHaveBeenCalledExactlyOnceWith(true);
  });

  test('停止锁在 Director 内拒绝 local-idle 的 move 语义并且不请求位移', () => {
    const fixture = createFixture({ movementStopped: true, proactivityMode: 'autonomous' });
    fixture.setDirectedAuthorization({
      kind: 'play', actionId: 'move-action', playbackToken: 'move-token', semantic: 'move'
    });

    expect(fixture.director.requestBehaviorPlan({
      kind: 'play', target: { kind: 'semantic', semantic: 'move' }
    }, 'local-idle')).toEqual(NONE);
    expect(fixture.motion.requestIntent).not.toHaveBeenCalled();
  });

  test('“停止不动”持久关闭自主移动且推进三十秒仍无本地移动候选', async () => {
    vi.useFakeTimers();
    const fixture = createFixture({ movementStopped: false, proactivityMode: 'autonomous' });
    fixture.setMotionSnapshot({
      revision: 3,
      timestampMs: 20,
      position: { x: 20, y: 30 },
      target: { x: 20, y: 30 },
      direction: 'right',
      moving: false,
      carrying: false
    });
    const scheduler = new CharacterProactivityScheduler({
      director: fixture.director,
      random: () => 0
    });
    try {
      await fixture.director.prepareUserPrompt('停止不动');
      scheduler.start();
      await vi.advanceTimersByTimeAsync(30_000);

      expect(fixture.director.getDiagnosticSnapshot()).toMatchObject({
        autonomousMovementAllowed: false,
        moving: false
      });
      expect(fixture.behavior.requestProactiveBehavior).not.toHaveBeenCalled();
    } finally {
      await scheduler.close();
      vi.useRealTimers();
    }
  });

  test.each([
    [{ movementStopped: false, proactivityMode: 'assistive' as const }, { kind: 'stop_movement' as const }, false],
    [{ movementStopped: true, proactivityMode: 'assistive' as const }, { kind: 'resume_movement' as const }, true]
  ])('Provider %j 不持久化也不改变停止锁', (initialSettings, providerPlan, expected) => {
    const fixture = createFixture(initialSettings);

    fixture.director.completeUserPrompt({
      generation: 'generation-1',
      explicitDirective: null,
      providerPlan
    });
    fixture.director.handleTaskEvent({ type: 'phase', phase: 'success' });

    expect(fixture.saveMovementStopped).not.toHaveBeenCalled();
    expect(fixture.motion.stop).not.toHaveBeenCalled();
    expect(fixture.director.getChatContext().runtime.movementStopped).toBe(expected);
  });

  test.each([
    { kind: 'stop_movement' as const },
    { kind: 'resume_movement' as const }
  ])('Provider %j 不能在 success 令牌迟到时留在待提交槽阻塞低优先级候选', providerPlan => {
    const fixture = createFixture();
    fixture.setTaskAuthorization({
      kind: 'play', actionId: 'success-action', playbackToken: 'success-token', semantic: 'celebrate'
    });
    fixture.director.completeUserPrompt({
      generation: 'generation-1',
      explicitDirective: null,
      providerPlan
    });
    fixture.director.handleTaskEvent({ type: 'phase', phase: 'success' });

    // 显式动作抢占迟到的 success 令牌，终态后只剩待提交槽可能阻塞候选。
    fixture.setDirectedAuthorization({
      kind: 'play', actionId: 'wave-action', playbackToken: 'explicit-token', semantic: 'celebrate'
    });
    fixture.director.requestBehaviorPlan(play('挥手'), 'explicit');
    fixture.director.applyPlaybackFeedback({
      actionId: 'wave-action',
      playbackToken: 'explicit-token',
      status: 'completed',
      occurredAtMs: 100
    });

    fixture.setDirectedAuthorization({
      kind: 'play', actionId: 'celebrate-action', playbackToken: 'idle-token', semantic: 'celebrate'
    });
    expect(fixture.director.requestBehaviorPlan(play('庆祝'), 'local-idle')).toMatchObject({
      kind: 'play', playbackToken: 'idle-token'
    });
    expect(fixture.saveMovementStopped).not.toHaveBeenCalled();
    expect(fixture.motion.stop).not.toHaveBeenCalled();
    expect(fixture.motion.requestIntent).not.toHaveBeenCalled();
    expect(fixture.director.getChatContext().runtime.movementStopped).toBe(false);
  });

  test('explicit 动作活跃时 thinking、listening 与 dragging 只更新可信事实而不抢播放', () => {
    const fixture = createFixture();
    fixture.setDirectedAuthorization({
      kind: 'play', actionId: 'wave-action', playbackToken: 'explicit-token', semantic: 'celebrate'
    });
    fixture.setTaskAuthorization({
      kind: 'play', actionId: 'think-action', playbackToken: 'task-token', semantic: 'think'
    });
    fixture.director.requestBehaviorPlan(play('挥手'), 'explicit');
    fixture.director.setDragging(true);

    fixture.director.handleTaskEvent({ type: 'phase', phase: 'thinking' });
    fixture.director.handleTaskEvent({ type: 'phase', phase: 'listening' });

    expect(fixture.behavior.handleTaskEvent).toHaveBeenNthCalledWith(
      1,
      { type: 'phase', phase: 'thinking' },
      { allowPlayback: false }
    );
    expect(fixture.behavior.handleTaskEvent).toHaveBeenNthCalledWith(
      2,
      { type: 'phase', phase: 'listening' },
      { allowPlayback: false }
    );
    expect(fixture.behavior.requestDirectedBehavior).toHaveBeenCalledTimes(1);
  });

  test('关闭、安全停止锁、明确指令、可信任务、聊天和本地待机按固定优先级仲裁', async () => {
    const fixture = createFixture();
    fixture.setTaskAuthorization({
      kind: 'play', actionId: 'celebrate-action', playbackToken: 'task-token', semantic: 'celebrate'
    });
    fixture.setDirectedAuthorization({
      kind: 'play', actionId: 'wave-action', playbackToken: 'explicit-token', semantic: 'celebrate'
    });

    fixture.director.completeUserPrompt({
      generation: 'generation-1',
      explicitDirective: { kind: 'stop_movement' },
      providerPlan: { kind: 'move', direction: 'right', distance: 'near' }
    });
    fixture.director.handleTaskEvent({ type: 'phase', phase: 'thinking' });
    expect(fixture.director.requestBehaviorPlan(play('挥手'), 'local-idle')).toEqual(NONE);

    expect(fixture.director.requestBehaviorPlan(play('挥手'), 'explicit')).toMatchObject({
      kind: 'play', playbackToken: 'explicit-token'
    });
    expect(fixture.behavior.requestDirectedBehavior).toHaveBeenCalledExactlyOnceWith(
      { kind: 'action', actionId: 'wave-action' },
      { urgency: 100, systemForced: true }
    );

    await fixture.director.close();
    expect(fixture.director.requestBehaviorPlan(play('挥手'), 'explicit')).toEqual(NONE);
  });

  test('聊天计划等待可信 success 动作的终态反馈后才提交', () => {
    const fixture = createFixture();
    fixture.setTaskAuthorization({
      kind: 'play', actionId: 'celebrate-action', playbackToken: 'success-token', semantic: 'celebrate'
    });
    fixture.setDirectedAuthorization({
      kind: 'play', actionId: 'wave-action', playbackToken: 'chat-token', semantic: 'celebrate'
    });
    fixture.director.completeUserPrompt({
      generation: 'generation-1', explicitDirective: null, providerPlan: play('挥手')
    });

    fixture.director.handleTaskEvent({ type: 'phase', phase: 'success' });
    expect(fixture.behavior.requestDirectedBehavior).not.toHaveBeenCalled();
    fixture.director.applyPlaybackFeedback({
      playbackToken: 'success-token', actionId: 'celebrate-action', status: 'started', occurredAtMs: 1
    });
    expect(fixture.behavior.requestDirectedBehavior).not.toHaveBeenCalled();
    fixture.director.applyPlaybackFeedback({
      playbackToken: 'success-token', actionId: 'celebrate-action', status: 'completed', occurredAtMs: 2
    });

    expect(fixture.behavior.requestDirectedBehavior).toHaveBeenCalledExactlyOnceWith(
      { kind: 'action', actionId: 'wave-action' },
      { urgency: 80, systemForced: true }
    );
  });

  test('success 动作无 Renderer 反馈时由轮询过期令牌并释放待提交计划', () => {
    const fixture = createFixture();
    fixture.setTaskAuthorization({
      kind: 'play', actionId: 'celebrate-action', playbackToken: 'success-token', semantic: 'celebrate'
    });
    fixture.setDirectedAuthorization({
      kind: 'play', actionId: 'wave-action', playbackToken: 'chat-token', semantic: 'celebrate'
    });
    fixture.director.completeUserPrompt({
      generation: 'generation-1', explicitDirective: null, providerPlan: play('挥手')
    });
    fixture.director.handleTaskEvent({ type: 'phase', phase: 'success' });
    fixture.setReleasedTokens(['success-token']);

    fixture.director.advance();

    expect(fixture.behavior.requestDirectedBehavior).toHaveBeenCalledExactlyOnceWith(
      { kind: 'action', actionId: 'wave-action' },
      { urgency: 80, systemForced: true }
    );
  });

  test('停止后轮询仍释放过期显式动作，恢复后可接受新动作', async () => {
    const fixture = createFixture();
    fixture.setDirectedAuthorization({
      kind: 'play', actionId: 'wave-action', playbackToken: 'expired-token', semantic: 'celebrate'
    });
    fixture.director.requestBehaviorPlan(play('挥手'), 'explicit');
    await fixture.director.prepareUserPrompt('停下');
    fixture.setReleasedTokens(['expired-token']);
    fixture.director.advance();
    await fixture.director.prepareUserPrompt('恢复活动');
    fixture.setDirectedAuthorization({
      kind: 'play', actionId: 'celebrate-action', playbackToken: 'new-token', semantic: 'celebrate'
    });

    expect(fixture.director.requestBehaviorPlan(play('庆祝'), 'chat')).toMatchObject({
      kind: 'play', playbackToken: 'new-token'
    });
  });

  test('success 没有排出可播放动作时立即提交聊天计划', () => {
    const fixture = createFixture();
    fixture.setDirectedAuthorization({
      kind: 'play', actionId: 'wave-action', playbackToken: 'chat-token', semantic: 'celebrate'
    });
    fixture.director.completeUserPrompt({
      generation: 'generation-1', explicitDirective: null, providerPlan: play('挥手')
    });

    fixture.director.handleTaskEvent({ type: 'phase', phase: 'success' });

    expect(fixture.behavior.requestDirectedBehavior).toHaveBeenCalledExactlyOnceWith(
      { kind: 'action', actionId: 'wave-action' },
      { urgency: 80, systemForced: true }
    );
  });

  test('success 无动作时清除旧 thinking 来源并立即提交聊天计划', () => {
    const fixture = createFixture();
    fixture.setTaskAuthorization({
      kind: 'play', actionId: 'think-action', playbackToken: 'thinking-token', semantic: 'think'
    });
    fixture.director.handleTaskEvent({ type: 'phase', phase: 'thinking' });
    fixture.director.completeUserPrompt({
      generation: 'generation-1', explicitDirective: null, providerPlan: play('挥手')
    });
    fixture.setTaskAuthorization(NONE);
    fixture.setDirectedAuthorization({
      kind: 'play', actionId: 'wave-action', playbackToken: 'chat-token', semantic: 'celebrate'
    });

    fixture.director.handleTaskEvent({ type: 'phase', phase: 'success' });

    expect(fixture.behavior.requestDirectedBehavior).toHaveBeenCalledExactlyOnceWith(
      { kind: 'action', actionId: 'wave-action' },
      { urgency: 80, systemForced: true }
    );
  });

  test.each(['completed', 'interrupted', 'failed'] as const)(
    'success 动作以 %s 结束都会释放等待中的聊天计划',
    status => {
      const fixture = createFixture();
      fixture.setTaskAuthorization({
        kind: 'play', actionId: 'celebrate-action', playbackToken: 'success-token', semantic: 'celebrate'
      });
      fixture.setDirectedAuthorization({
        kind: 'play', actionId: 'wave-action', playbackToken: 'chat-token', semantic: 'celebrate'
      });
      fixture.director.completeUserPrompt({
        generation: 'generation-1', explicitDirective: null, providerPlan: play('挥手')
      });
      fixture.director.handleTaskEvent({ type: 'phase', phase: 'success' });

      fixture.director.applyPlaybackFeedback({
        playbackToken: 'success-token', actionId: 'celebrate-action', status, occurredAtMs: 2
      });

      expect(fixture.behavior.requestDirectedBehavior).toHaveBeenCalledTimes(1);
    }
  );

  test('旧 generation、角色切换、reset 与 close 都丢弃待提交计划', async () => {
    const fixture = createFixture();
    fixture.setTaskAuthorization({
      kind: 'play', actionId: 'celebrate-action', playbackToken: 'success-token', semantic: 'celebrate'
    });
    fixture.director.completeUserPrompt({
      generation: 'old-generation', explicitDirective: null, providerPlan: play('挥手')
    });
    fixture.director.handleTaskEvent({ type: 'phase', phase: 'success' });
    expect(fixture.behavior.requestDirectedBehavior).not.toHaveBeenCalled();

    fixture.director.completeUserPrompt({
      generation: 'generation-1', explicitDirective: null, providerPlan: play('挥手')
    });
    fixture.director.handleTaskEvent({ type: 'phase', phase: 'success' });
    await fixture.director.handleActiveCharacterChanged();
    fixture.director.applyPlaybackFeedback({
      playbackToken: 'success-token', actionId: 'celebrate-action', status: 'completed', occurredAtMs: 3
    });
    expect(fixture.behavior.requestDirectedBehavior).not.toHaveBeenCalled();

    fixture.director.completeUserPrompt({
      generation: 'generation-1', explicitDirective: null, providerPlan: play('挥手')
    });
    fixture.director.handleTaskEvent({ type: 'phase', phase: 'success' });
    fixture.director.reset('generation-2');
    fixture.director.applyPlaybackFeedback({
      playbackToken: 'success-token', actionId: 'celebrate-action', status: 'completed', occurredAtMs: 4
    });
    expect(fixture.behavior.requestDirectedBehavior).not.toHaveBeenCalled();

    await fixture.director.close();
    expect(fixture.behavior.close).toHaveBeenCalledTimes(1);
  });

  test('角色切换读取完成后再次通知同一 Scheduler 重新读取新目录', async () => {
    const fixture = createFixture();
    let resolve!: () => void;
    fixture.behavior.handleActiveCharacterChanged.mockImplementationOnce(() => (
      new Promise<undefined>(done => { resolve = () => done(undefined); })
    ));
    const changed = vi.fn();
    fixture.director.subscribeActivityBlockers(changed);

    const switching = fixture.director.handleActiveCharacterChanged();
    expect(changed).toHaveBeenCalledTimes(1);
    resolve();
    await switching;

    expect(changed).toHaveBeenCalledTimes(2);
  });

  test.each(['explicit', 'chat'] as const)(
    '%s 来源动作不可用时发布固定提示且不请求待机替代',
    source => {
      const fixture = createFixture();
      const plan = play('不存在');

      if (source === 'chat') {
        fixture.director.completeUserPrompt({
          generation: 'generation-1', explicitDirective: null, providerPlan: plan
        });
        fixture.director.handleTaskEvent({ type: 'phase', phase: 'success' });
      } else {
        fixture.director.requestBehaviorPlan(plan, source);
      }

      expect(fixture.notices).toEqual([{
        code: 'CHARACTER_ACTION_UNAVAILABLE',
        message: '当前角色没有可播放的对应动作。'
      }]);
      expect(fixture.behavior.requestDirectedBehavior).not.toHaveBeenCalled();
    }
  );

  test('本地待机来源动作不可用时静默跳过', () => {
    const fixture = createFixture();

    fixture.director.requestBehaviorPlan(play('不存在'), 'local-idle');

    expect(fixture.notices).toEqual([]);
  });
});
