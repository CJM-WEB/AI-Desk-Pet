import type {
  BehaviorTarget,
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
  const targetByName = new Map<string, ResolvedBehaviorTarget>([
    ['挥手', { kind: 'action', actionId: 'wave-action' }],
    ['庆祝', { kind: 'action', actionId: 'celebrate-action' }]
  ]);
  const behavior = {
    getPublicBehaviorCatalog: vi.fn((): PublicBehaviorCatalog => ({
      characterName: '测试角色', semantics: ['idle', 'celebrate'],
      stateNames: ['开心'], actionNames: ['挥手', '庆祝'], tags: []
    })),
    resolveBehaviorTarget: vi.fn((target: BehaviorTarget): ResolvedBehaviorTarget => {
      const name = target.kind === 'action_name' ? target.name : '';
      const resolved = targetByName.get(name);
      if (!resolved) throw new Error('CHARACTER_ACTION_UNAVAILABLE');
      return resolved;
    }),
    requestDirectedBehavior: vi.fn(() => directedAuthorization),
    handleTaskEvent: vi.fn((_event: TaskEvent) => taskAuthorization),
    applyPlaybackFeedback: vi.fn((_feedback: CharacterPlaybackFeedback) => undefined),
    handleActiveCharacterChanged: vi.fn(async () => undefined),
    close: vi.fn(() => undefined)
  };
  const notices: CharacterBehaviorNotice[] = [];
  const director = new CharacterBehaviorDirector({
    behavior,
    initialGeneration: 'generation-1',
    publishNotice: notice => notices.push(notice)
  });
  return {
    behavior,
    director,
    notices,
    setTaskAuthorization: (value: CharacterBehaviorAuthorization) => { taskAuthorization = value; },
    setDirectedAuthorization: (value: CharacterBehaviorAuthorization) => { directedAuthorization = value; }
  };
}

function play(name: string): CharacterBehaviorPlan {
  return { kind: 'play', target: { kind: 'action_name', name } };
}

describe('Main 角色行为 Director', () => {
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
