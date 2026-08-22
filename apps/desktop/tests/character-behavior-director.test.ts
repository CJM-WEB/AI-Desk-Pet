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

const NONE: CharacterBehaviorAuthorization = { kind: 'none' };

/** 构造只记录 Director 边界调用的同步行为服务端口。 */
function createFixture() {
  let taskAuthorization: CharacterBehaviorAuthorization = NONE;
  let directedAuthorization: CharacterBehaviorAuthorization = NONE;
  let agentAuthorization: CharacterBehaviorAuthorization = NONE;
  let releasedTokens: readonly string[] = [];
  const targetByName = new Map<string, ResolvedBehaviorTarget>([
    ['挥手', { kind: 'action', actionId: 'wave-action' }],
    ['庆祝', { kind: 'action', actionId: 'celebrate-action' }],
    ['移动', { kind: 'action', actionId: 'move-action' }]
  ]);
  const behavior = {
    getPublicBehaviorCatalog: vi.fn((): PublicBehaviorCatalog => ({
      characterName: '测试角色', semantics: ['idle', 'celebrate'],
      stateNames: ['开心'], actionNames: ['挥手', '庆祝'], tags: []
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
    isMovementAgentIntent: vi.fn((intent: CharacterAgentBehaviorIntent) => (
      intent.actionSemantic === 'move'
      || intent.stateIntent !== null && 'semantic' in intent.stateIntent
        && intent.stateIntent.semantic === 'move'
    )),
    handleAgentIntent: vi.fn(() => agentAuthorization),
    getRecentPublicActions: vi.fn(() => ['挥手']),
    handleIdleDue: vi.fn(() => releasedTokens),
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
      revision: 2,
      timestampMs: 10,
      position: { x: 20, y: 30 },
      target: { x: 40, y: 30 },
      direction: 'right' as const,
      moving: true,
      carrying: false
    })),
    requestIntent: vi.fn(),
    stop: vi.fn()
  };
  const notices: CharacterBehaviorNotice[] = [];
  const director = new CharacterBehaviorDirector({
    behavior,
    motion,
    initialGeneration: 'generation-1',
    publishNotice: notice => notices.push(notice)
  });
  return {
    behavior,
    director,
    motion,
    notices,
    setTaskAuthorization: (value: CharacterBehaviorAuthorization) => { taskAuthorization = value; },
    setDirectedAuthorization: (value: CharacterBehaviorAuthorization) => { directedAuthorization = value; },
    setAgentAuthorization: (value: CharacterBehaviorAuthorization) => { agentAuthorization = value; },
    setReleasedTokens: (value: readonly string[]) => { releasedTokens = value; }
  };
}

function play(name: string): CharacterBehaviorPlan {
  return { kind: 'play', target: { kind: 'action_name', name } };
}

describe('Main 角色行为 Director', () => {
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

  test('显式移动未取得播放授权时不移动并发布稳定提示', async () => {
    const fixture = createFixture();

    await fixture.director.prepareUserPrompt('去右下角');

    expect(fixture.motion.requestIntent).not.toHaveBeenCalled();
    expect(fixture.notices).toEqual([{
      code: 'CHARACTER_ACTION_UNAVAILABLE',
      message: '当前角色没有可播放的对应动作。'
    }]);
  });

  test('停止立即撤销运动并只拦截旧 500ms 候选，仍推进令牌清理', async () => {
    const fixture = createFixture();
    fixture.director.handleIdleDue();
    expect(fixture.behavior.handleIdleDue).toHaveBeenCalledExactlyOnceWith({ allowCandidate: true });

    await fixture.director.prepareUserPrompt('停下');
    fixture.director.handleIdleDue();

    expect(fixture.motion.stop).toHaveBeenCalledOnce();
    expect(fixture.behavior.handleIdleDue).toHaveBeenNthCalledWith(2, { allowCandidate: false });

    await fixture.director.prepareUserPrompt('恢复活动');
    fixture.director.handleIdleDue();
    expect(fixture.behavior.handleIdleDue).toHaveBeenNthCalledWith(3, { allowCandidate: true });
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

  test('公开聊天上下文只包含清单、运行布尔、档位和公开近期动作', () => {
    const fixture = createFixture();

    expect(fixture.director.getChatContext()).toEqual({
      character: {
        characterName: '测试角色', semantics: ['idle', 'celebrate'],
        stateNames: ['开心'], actionNames: ['挥手', '庆祝'], tags: []
      },
      runtime: {
        moving: true,
        dragging: false,
        carrying: false,
        movementStopped: false
      },
      proactivityMode: 'assistive',
      recentActions: ['挥手']
    });
    expect(JSON.stringify(fixture.director.getChatContext())).not.toMatch(
      /actionId|playbackToken|[A-Z]:\\/u
    );
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

  test('同轮本地 stop 指令后忽略 Provider resume，解析后的 move 动作仍受停止锁拦截', () => {
    const fixture = createFixture();
    fixture.setDirectedAuthorization({
      kind: 'play', actionId: 'move-action', playbackToken: 'move-token', semantic: 'move'
    });
    fixture.director.completeUserPrompt({
      generation: 'generation-1',
      explicitDirective: { kind: 'stop_movement' },
      providerPlan: { kind: 'resume_movement' }
    });
    fixture.director.handleTaskEvent({ type: 'phase', phase: 'success' });

    expect(fixture.director.requestBehaviorPlan(play('移动'), 'explicit')).toEqual(NONE);
    expect(fixture.behavior.resolveBehaviorTarget).toHaveBeenCalledWith({
      kind: 'action_name', name: '移动'
    });
    expect(fixture.behavior.requestDirectedBehavior).not.toHaveBeenCalled();
  });

  test('反思 stop 不会写停止锁，后续 move 计划仍可授权', () => {
    const fixture = createFixture();
    fixture.setDirectedAuthorization({
      kind: 'play', actionId: 'move-action', playbackToken: 'move-token', semantic: 'move'
    });

    fixture.director.requestBehaviorPlan({ kind: 'stop_movement' }, 'reflection');

    expect(fixture.director.requestBehaviorPlan(play('移动'), 'reflection')).toMatchObject({
      kind: 'play', semantic: 'move'
    });
  });

  test('反思 resume 不能解除本地停止锁', () => {
    const fixture = createFixture();
    fixture.director.completeUserPrompt({
      generation: 'generation-1',
      explicitDirective: { kind: 'stop_movement' },
      providerPlan: null
    });

    fixture.director.requestBehaviorPlan({ kind: 'resume_movement' }, 'reflection');

    expect(fixture.director.requestBehaviorPlan(play('移动'), 'explicit')).toEqual(NONE);
    expect(fixture.behavior.requestDirectedBehavior).not.toHaveBeenCalled();
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

  test('关闭、安全停止锁、明确指令、可信任务、聊天、反思和本地待机按固定优先级仲裁', async () => {
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
    expect(fixture.director.requestBehaviorPlan(play('挥手'), 'reflection')).toEqual(NONE);
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

    fixture.director.handleIdleDue();

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
    fixture.director.handleIdleDue();
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

  test.each(['reflection', 'local-idle'] as const)(
    '%s 来源动作不可用时静默跳过',
    source => {
      const fixture = createFixture();

      fixture.director.requestBehaviorPlan(play('不存在'), source);

      expect(fixture.notices).toEqual([]);
    }
  );
});
