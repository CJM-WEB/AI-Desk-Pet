import { describe, expect, test } from 'vitest';
import {
  CharacterBehaviorEngine,
  type CharacterActionDefinitionV2,
  type CharacterBehaviorSignal,
  type CharacterManifestV2,
  type CharacterStateDefinitionV2
} from '../src';

type 动作覆盖 = Partial<CharacterActionDefinitionV2>;

/** 创建可按单例覆盖的动作定义。 */
function 创建动作(
  id: string,
  semantic: CharacterActionDefinitionV2['semantic'],
  overrides: 动作覆盖 = {}
): CharacterActionDefinitionV2 {
  return {
    id,
    name: id,
    semantic,
    tags: [],
    preference: 1,
    cooldownMs: 0,
    repeatSuppressionMs: 0,
    loopPolicy: 'never',
    interrupt: 'normal',
    allowedPrimaryStateIds: [],
    forbiddenPrimaryStateIds: [],
    requiredModifierStateIds: [],
    forbiddenModifierStateIds: [],
    direction: 'any',
    ...overrides
  };
}

/** 创建单一语义主状态，保持纵向测试的状态与动作归属清晰。 */
function 创建状态(
  id: string,
  semantic: CharacterActionDefinitionV2['semantic'],
  actionIds: string[],
  overrides: Partial<CharacterStateDefinitionV2> = {}
): CharacterStateDefinitionV2 {
  return {
    id,
    name: id,
    kind: 'primary',
    semantic,
    tags: [],
    intensity: 1,
    coexistWithStateIds: [],
    forbiddenStateIds: [],
    enterConditions: [],
    exitConditions: [],
    agentInferable: true,
    actionIds,
    ...overrides
  };
}

/** 创建包含全部运行时字段的角色清单，并允许替换状态、动作和表现。 */
function 创建清单(options: {
  id?: string;
  states?: CharacterStateDefinitionV2[];
  actions?: CharacterActionDefinitionV2[];
  presentations?: CharacterManifestV2['skins'][number]['presentations'];
  defaultStateId?: string;
} = {}): CharacterManifestV2 {
  const actions = options.actions ?? [创建动作('idle-action', 'idle')];
  const states = options.states ?? [创建状态('idle-state', 'idle', ['idle-action'])];
  const presentations = options.presentations ?? actions.map((action) => ({
    actionId: action.id,
    fps: 20,
    frames: [{ assetId: `${action.id}-asset`, x: 0, y: 0, width: 1, height: 1 }],
    anchors: { ground: { x: 0.5, y: 1 } },
    geometry: {
      visualBounds: { x: 0, y: 0, width: 1, height: 1 },
      groundAnchor: { x: 0.5, y: 1 },
      resourceRevision: 'a'.repeat(64)
    }
  }));
  const assetIds = new Set([
    'thumbnail',
    ...presentations.flatMap((presentation) => presentation.frames.map((frame) => frame.assetId))
  ]);

  return {
    version: 2,
    id: options.id ?? 'engine-fixture',
    name: '行为引擎夹具',
    thumbnailAssetId: 'thumbnail',
    compilerVersion: 'test',
    identity: {
      description: '用于行为引擎测试的角色。',
      background: '测试环境。',
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
    defaultStateId: options.defaultStateId ?? states[0]!.id,
    skins: [{
      id: 'default-skin',
      name: '默认皮肤',
      presentations,
      semanticFallbacks: []
    }],
    states,
    actions,
    resources: [...assetIds].map((assetId) => ({
      assetId,
      fileName: `${assetId}.png`,
      sha256: 'a'.repeat(64),
      byteLength: 1
    }))
  };
}

/** 创建覆盖六类核心语义，并带有三种时长来源的角色清单。 */
function 创建六语义清单(id = 'six-semantics'): CharacterManifestV2 {
  const semantics = ['idle', 'listen', 'think', 'move', 'celebrate', 'fail'] as const;
  const actions = semantics.map((semantic) => 创建动作(`${semantic}-action`, semantic, {
    durationMs: semantic === 'idle' ? 320 : semantic === 'listen' || semantic === 'think' ? undefined : 200,
    loopPolicy: semantic === 'think' ? 'until-interrupted' : 'never'
  }));
  const states = semantics.map((semantic) => 创建状态(
    `${semantic}-state`,
    semantic,
    [`${semantic}-action`]
  ));
  const presentations = actions.map((action) => ({
    actionId: action.id,
    fps: 20,
    frames: action.semantic === 'listen'
      ? [
        { assetId: `${action.id}-first`, x: 0, y: 0, width: 1, height: 1, durationMs: 40 },
        { assetId: `${action.id}-second`, x: 0, y: 0, width: 1, height: 1 }
      ]
      : [{ assetId: `${action.id}-asset`, x: 0, y: 0, width: 1, height: 1 }],
    anchors: { ground: { x: 0.5, y: 1 } },
    geometry: {
      visualBounds: { x: 0, y: 0, width: 1, height: 1 },
      groundAnchor: { x: 0.5, y: 1 },
      resourceRevision: 'a'.repeat(64)
    }
  }));

  return 创建清单({ id, states, actions, presentations, defaultStateId: 'idle-state' });
}

/** 创建带真实搬运状态、动作与提交帧表现的角色清单。 */
function 创建搬运清单(id = 'carry-character', commitFrameId: string | null = 'carry-commit'): CharacterManifestV2 {
  const idle = 创建动作('idle-action', 'idle');
  const carry = 创建动作('carry-action', 'carry', { loopPolicy: 'until-interrupted' });
  return 创建清单({
    id,
    actions: [idle, carry],
    states: [
      创建状态('idle-state', 'idle', [idle.id]),
      创建状态('carry-state', 'carry', [carry.id], {
        exitConditions: [{ mode: 'all', clauses: [{ kind: 'signal', signal: 'carry-stop' }] }]
      })
    ],
    presentations: [
      {
        actionId: idle.id,
        fps: 20,
        frames: [{ id: 'idle-frame', assetId: 'idle-asset', x: 0, y: 0, width: 1, height: 1 }],
        anchors: { ground: { x: 0.5, y: 1 } },
        geometry: {
          visualBounds: { x: 0, y: 0, width: 1, height: 1 },
          groundAnchor: { x: 0.5, y: 1 },
          resourceRevision: 'a'.repeat(64)
        }
      },
      {
        actionId: carry.id,
        fps: 20,
        frames: [
          { id: 'carry-start-frame', assetId: 'carry-asset', x: 0, y: 0, width: 1, height: 1 },
          { id: 'carry-commit', assetId: 'carry-asset', x: 1, y: 0, width: 1, height: 1 }
        ],
        anchors: { ground: { x: 0.5, y: 1 } },
        geometry: {
          visualBounds: { x: 0, y: 0, width: 1, height: 1 },
          groundAnchor: { x: 0.5, y: 1 },
          resourceRevision: 'a'.repeat(64)
        },
        ...(commitFrameId === null ? {} : { commitFrameId })
      }
    ],
    defaultStateId: 'idle-state'
  });
}

/** 创建可观察、稳定递增的播放令牌工厂。 */
function 创建令牌工厂(prefix = 'token'): () => string {
  let index = 0;
  return () => `${prefix}-${++index}`;
}

function 创建引擎(
  manifest: CharacterManifestV2,
  overrides: Partial<ConstructorParameters<typeof CharacterBehaviorEngine>[0]> = {}
): CharacterBehaviorEngine {
  return new CharacterBehaviorEngine({
    manifest,
    skinId: 'default-skin',
    now: () => 1_000,
    random: () => 0,
    createPlaybackToken: 创建令牌工厂(),
    ...overrides
  });
}

describe('事件驱动角色行为引擎', () => {
  test('定向授权复用同一调度器并返回真实动作与播放令牌', () => {
    const engine = 创建引擎(创建六语义清单());

    const decision = engine.dispatchDirected({
      target: { kind: 'action', actionId: 'celebrate-action' },
      direction: 'right',
      urgency: 80,
      systemForced: true
    });

    expect(decision.snapshot.state.primaryStateId).toBe('idle-state');
    expect(decision.snapshot.schedule.current).toMatchObject({
      actionId: 'celebrate-action',
      playbackToken: 'token-1'
    });
    expect(decision.effects).toEqual([{ type: 'play', action: decision.snapshot.schedule.current }]);
  });

  test('状态动作完成且状态仍有效时按重复抑制续选同状态动作', () => {
    let now = 1_000;
    const idle = 创建动作('idle-action', 'idle');
    const wave = 创建动作('wave-action', 'celebrate', {
      preference: 1, cooldownMs: 1_000, repeatSuppressionMs: 1_000
    });
    const dance = 创建动作('dance-action', 'celebrate', {
      preference: 3, cooldownMs: 1_000, repeatSuppressionMs: 1_000
    });
    const engine = 创建引擎(创建清单({
      actions: [idle, wave, dance],
      states: [
        创建状态('idle-state', 'idle', [idle.id]),
        创建状态('happy-state', 'celebrate', [wave.id, dance.id])
      ],
      defaultStateId: 'idle-state'
    }), {
      now: () => now,
      random: () => 0,
      createPlaybackToken: 创建令牌工厂('state')
    });

    const first = engine.dispatchDirected({
      target: {
        kind: 'state_action', stateId: 'happy-state', actionId: 'wave-action'
      } as never,
      direction: 'right', urgency: 80, systemForced: true
    });
    expect(first.effects).toContainEqual(expect.objectContaining({
      type: 'play', action: expect.objectContaining({ actionId: 'wave-action' })
    }));
    engine.applyFeedback({
      playbackToken: 'state-1', actionId: 'wave-action', status: 'started', occurredAtMs: now
    });

    now = 1_100;
    const second = engine.applyFeedback({
      playbackToken: 'state-1', actionId: 'wave-action', status: 'completed', occurredAtMs: now
    });

    expect(second.effects).toContainEqual(expect.objectContaining({
      type: 'play', action: expect.objectContaining({
        actionId: 'dance-action', stateId: 'happy-state', playbackToken: 'state-2'
      })
    }));
  });

  test('同状态动作都受冷却或重复抑制时只回到安全 idle 一次', () => {
    let now = 1_000;
    const idle = 创建动作('idle-action', 'idle');
    const wave = 创建动作('wave-action', 'celebrate', {
      cooldownMs: 1_000, repeatSuppressionMs: 1_000
    });
    const engine = 创建引擎(创建清单({
      actions: [idle, wave],
      states: [
        创建状态('idle-state', 'idle', [idle.id]),
        创建状态('happy-state', 'celebrate', [wave.id])
      ],
      defaultStateId: 'idle-state'
    }), { now: () => now, createPlaybackToken: 创建令牌工厂('fallback') });
    engine.dispatchDirected({
      target: { kind: 'state', stateId: 'happy-state' },
      direction: 'right', urgency: 80, systemForced: true
    });
    engine.applyFeedback({
      playbackToken: 'fallback-1', actionId: 'wave-action', status: 'started', occurredAtMs: now
    });

    now = 1_100;
    const completed = engine.applyFeedback({
      playbackToken: 'fallback-1', actionId: 'wave-action', status: 'completed', occurredAtMs: now
    });

    expect(completed.effects.filter(effect => effect.type === 'play')).toEqual([
      expect.objectContaining({ action: expect.objectContaining({ actionId: 'idle-action' }) })
    ]);
    expect(completed.diagnosticCodes).toEqual([]);
  });

  test('自然截止视为动作完成并在一次 advance 中续选同状态动作', () => {
    let now = 1_000;
    const firstAction = 创建动作('first-action', 'celebrate', {
      durationMs: 100, repeatSuppressionMs: 1_000
    });
    const secondAction = 创建动作('second-action', 'celebrate', { durationMs: 100 });
    const engine = 创建引擎(创建清单({
      actions: [firstAction, secondAction],
      states: [创建状态('happy-state', 'celebrate', [firstAction.id, secondAction.id])],
      defaultStateId: 'happy-state'
    }), {
      now: () => now,
      random: () => 0,
      createPlaybackToken: 创建令牌工厂('expiry')
    });
    engine.dispatchDirected({
      target: { kind: 'state', stateId: 'happy-state' },
      direction: 'right', urgency: 80, systemForced: true
    });
    engine.applyFeedback({
      playbackToken: 'expiry-1', actionId: 'first-action', status: 'started', occurredAtMs: now
    });

    now = 1_100;
    const advanced = engine.advance();

    expect(advanced.effects.filter(effect => effect.type === 'play')).toEqual([
      expect.objectContaining({
        action: expect.objectContaining({ actionId: 'second-action', playbackToken: 'expiry-2' })
      })
    ]);
  });

  test('取消状态生命周期后旧动作完成不再续播', () => {
    const actions = [
      创建动作('first-action', 'celebrate'),
      创建动作('second-action', 'celebrate')
    ];
    const engine = 创建引擎(创建清单({
      actions,
      states: [创建状态('happy-state', 'celebrate', actions.map(action => action.id))]
    }), { createPlaybackToken: 创建令牌工厂('cancel') });
    engine.dispatchDirected({
      target: { kind: 'state', stateId: 'happy-state' },
      direction: 'right', urgency: 80, systemForced: true
    });
    engine.applyFeedback({
      playbackToken: 'cancel-1', actionId: 'first-action', status: 'started', occurredAtMs: 1_000
    });

    engine.cancelStateLifecycle();
    const completed = engine.applyFeedback({
      playbackToken: 'cancel-1', actionId: 'first-action', status: 'completed', occurredAtMs: 1_100
    });

    expect(completed.effects).toEqual([{ type: 'none' }]);
    expect(completed.snapshot.schedule.current).toBeNull();
  });

  test('显式切换状态后只延续新状态动作', () => {
    const actions = [
      创建动作('a-first', 'celebrate'),
      创建动作('a-second', 'celebrate'),
      创建动作('b-first', 'speak'),
      创建动作('b-second', 'speak')
    ];
    const engine = 创建引擎(创建清单({
      actions,
      states: [
        创建状态('a-state', 'celebrate', ['a-first', 'a-second']),
        创建状态('b-state', 'speak', ['b-first', 'b-second'])
      ],
      defaultStateId: 'a-state'
    }), { createPlaybackToken: 创建令牌工厂('switch') });
    engine.dispatchDirected({
      target: { kind: 'state', stateId: 'a-state' },
      direction: 'right', urgency: 80, systemForced: true
    });
    const switched = engine.dispatchDirected({
      target: { kind: 'state', stateId: 'b-state' },
      direction: 'right', urgency: 80, systemForced: true
    });
    expect(switched.effects).toContainEqual(expect.objectContaining({
      type: 'play', action: expect.objectContaining({ actionId: 'b-first' })
    }));
    engine.applyFeedback({
      playbackToken: 'switch-2', actionId: 'b-first', status: 'started', occurredAtMs: 1_000
    });

    const completed = engine.applyFeedback({
      playbackToken: 'switch-2', actionId: 'b-first', status: 'completed', occurredAtMs: 1_100
    });

    expect(completed.effects).toContainEqual(expect.objectContaining({
      type: 'play', action: expect.objectContaining({ actionId: 'b-second', stateId: 'b-state' })
    }));
    expect(completed.effects).not.toContainEqual(expect.objectContaining({
      type: 'play', action: expect.objectContaining({ actionId: 'a-second' })
    }));
  });

  test('显式切换到冷却中的状态失败后不再延续旧状态动作', () => {
    let now = 1_000;
    const aAction = 创建动作('a-action', 'celebrate');
    const bAction = 创建动作('b-action', 'speak', { cooldownMs: 1_000 });
    const engine = 创建引擎(创建清单({
      actions: [aAction, bAction],
      states: [
        创建状态('a-state', 'celebrate', [aAction.id]),
        创建状态('b-state', 'speak', [bAction.id])
      ],
      defaultStateId: 'a-state'
    }), {
      now: () => now,
      createPlaybackToken: 创建令牌工厂('unavailable-switch')
    });

    engine.dispatchDirected({
      target: { kind: 'state', stateId: 'b-state' },
      direction: 'right', urgency: 80, systemForced: true
    });
    engine.applyFeedback({
      playbackToken: 'unavailable-switch-1', actionId: 'b-action',
      status: 'started', occurredAtMs: now
    });
    engine.cancelStateLifecycle();
    engine.applyFeedback({
      playbackToken: 'unavailable-switch-1', actionId: 'b-action',
      status: 'completed', occurredAtMs: now
    });

    now = 1_100;
    engine.dispatchDirected({
      target: { kind: 'state', stateId: 'a-state' },
      direction: 'right', urgency: 80, systemForced: true
    });
    engine.applyFeedback({
      playbackToken: 'unavailable-switch-2', actionId: 'a-action',
      status: 'started', occurredAtMs: now
    });
    const rejectedSwitch = engine.dispatchDirected({
      target: { kind: 'state', stateId: 'b-state' },
      direction: 'right', urgency: 80, systemForced: true
    });
    expect(rejectedSwitch.diagnosticCodes).toEqual(['CHARACTER_BEHAVIOR_ACTION_UNAVAILABLE']);

    const completed = engine.applyFeedback({
      playbackToken: 'unavailable-switch-2', actionId: 'a-action',
      status: 'completed', occurredAtMs: now
    });

    expect(completed.effects).toEqual([{ type: 'none' }]);
    expect(completed.snapshot.schedule.current).toBeNull();
  });

  test('定向目标不可用时不生成待机令牌并返回稳定诊断', () => {
    const engine = 创建引擎(创建六语义清单());

    const decision = engine.dispatchDirected({
      target: { kind: 'action', actionId: 'missing-action' },
      direction: 'right',
      urgency: 80,
      systemForced: true
    });

    expect(decision.effects).toEqual([{ type: 'none' }]);
    expect(decision.snapshot.schedule.current).toBeNull();
    expect(decision.diagnosticCodes).toEqual(['CHARACTER_BEHAVIOR_ACTION_UNAVAILABLE']);
  });

  test('主动定向按真实 actionId 抑制连续重复，其他动作与换角会重置相邻关系', () => {
    const engine = 创建引擎(创建六语义清单());
    const proactive = (actionId: string) => engine.dispatchProactiveDirected({
      target: { kind: 'action', actionId }, direction: 'right', urgency: 10
    });

    expect(proactive('celebrate-action').effects[0]?.type).toBe('play');
    expect(proactive('celebrate-action').effects).toEqual([{ type: 'none' }]);
    expect(proactive('idle-action').effects.some(effect => effect.type === 'play')).toBe(true);
    expect(proactive('celebrate-action').effects.some(effect => effect.type === 'play')).toBe(true);

    engine.replaceCharacter(创建六语义清单('replacement'), 'default-skin');
    expect(proactive('celebrate-action').effects.some(effect => effect.type === 'play')).toBe(true);
  });

  test('Main 搬运事实通过现有选择与调度链生成真实播放令牌', () => {
    const engine = 创建引擎(创建搬运清单());

    const decision = engine.dispatch({
      signal: { type: 'carrying', active: true, occurredAtMs: 1 },
      direction: 'right'
    });

    expect(decision.snapshot.state).toMatchObject({
      primaryStateId: 'carry-state',
      desiredActionSemantic: 'carry',
      activeSignals: expect.arrayContaining(['carry-start'])
    });
    expect(decision.snapshot.schedule.current).toMatchObject({
      actionId: 'carry-action',
      playbackToken: 'token-1'
    });
    expect(decision.effects).toEqual([{ type: 'play', action: decision.snapshot.schedule.current }]);
  });

  test('搬运活动期间待机和低优先级 Agent 意图不会替换搬运令牌', () => {
    const engine = 创建引擎(创建搬运清单());
    engine.dispatch({ signal: { type: 'carrying', active: true, occurredAtMs: 1 }, direction: 'right' });

    const idle = engine.dispatch({ signal: { type: 'idle-due', occurredAtMs: 2 }, direction: 'right' });
    const agent = engine.dispatch({
      signal: { type: 'task', phase: 'start', occurredAtMs: 3 },
      agentIntent: {
        stateIntent: { semantic: 'idle' },
        actionSemantic: 'idle',
        urgency: 1,
        explanation: '普通模型意图不能抢占搬运。'
      },
      direction: 'right'
    });

    expect(idle.snapshot.schedule.current?.playbackToken).toBe('token-1');
    expect(agent.snapshot.schedule.current?.playbackToken).toBe('token-1');
    expect(idle.effects).toEqual([{ type: 'none' }]);
    expect(agent.effects).toEqual([{ type: 'none' }]);

    const stopped = engine.dispatch({
      signal: { type: 'carrying', active: false, occurredAtMs: 4 },
      direction: 'right'
    });
    expect(stopped.snapshot.state.primaryStateId).toBe('idle-state');
    expect(stopped.effects).toEqual([{
      type: 'interrupt',
      playbackToken: 'token-1',
      actionId: 'carry-action',
      fallbackActionId: null
    }, {
      type: 'play',
      action: stopped.snapshot.schedule.current!
    }]);
  });

  test('用户直接交互仍按既有强制中断规则替换搬运令牌', () => {
    const engine = 创建引擎(创建搬运清单());
    engine.dispatch({ signal: { type: 'carrying', active: true, occurredAtMs: 1 }, direction: 'right' });

    const interrupted = engine.dispatch({
      signal: { type: 'user-interaction', occurredAtMs: 2 },
      direction: 'right'
    });

    expect(interrupted.effects).toEqual([
      {
        type: 'interrupt',
        playbackToken: 'token-1',
        actionId: 'carry-action',
        fallbackActionId: null
      },
      { type: 'play', action: interrupted.snapshot.schedule.current! }
    ]);
    expect(interrupted.snapshot.schedule.current).toMatchObject({
      actionId: 'carry-action',
      playbackToken: 'token-2'
    });
  });
  test.each([
    ['待机', { type: 'idle-due', occurredAtMs: 1 }, 'idle', 320],
    ['倾听', { type: 'listening', active: true, occurredAtMs: 2 }, 'listen', 90],
    ['思考', { type: 'thinking', active: true, occurredAtMs: 3 }, 'think', null],
    ['移动', { type: 'movement', active: true, occurredAtMs: 4 }, 'move', 200],
    ['成功', { type: 'task', phase: 'success', occurredAtMs: 5 }, 'celebrate', 200],
    ['错误', { type: 'task', phase: 'failure', occurredAtMs: 6 }, 'fail', 200]
  ] satisfies Array<[string, CharacterBehaviorSignal, string, number | null]>)('%s 信号纵向更新状态、选择动作并只产生一个播放效果', (_name, signal, semantic, durationMs) => {
    const engine = 创建引擎(创建六语义清单());

    const decision = engine.dispatch({ signal, direction: 'right' });

    expect(decision.snapshot.state.primaryStateId).toBe(`${semantic}-state`);
    expect(decision.snapshot.state.desiredActionSemantic).toBe(semantic);
    expect(decision.snapshot.schedule.current).toEqual({
      actionId: `${semantic}-action`,
      stateId: `${semantic}-state`,
      playbackToken: 'token-1',
      durationMs,
      scheduledAtMs: 1_000,
      startDeadlineAtMs: 31_000,
      startedAtMs: null,
      expectedEndAtMs: null
    });
    expect(decision.effects).toEqual([{ type: 'play', action: decision.snapshot.schedule.current }]);
    expect(decision.diagnosticCodes).toEqual([]);
  });

  test('没有 Agent 意图时完全由本地信号驱动', () => {
    const decision = 创建引擎(创建六语义清单()).dispatch({
      signal: { type: 'conversation-start', occurredAtMs: 1 },
      direction: 'right'
    });

    expect(decision.snapshot.state.primaryStateId).toBe('listen-state');
    expect(decision.snapshot.schedule.current?.actionId).toBe('listen-action');
    expect(decision.diagnosticCodes).toEqual([]);
  });

  test('非法 Agent 状态意图由推断器安全回退且不产生额外诊断', () => {
    const decision = 创建引擎(创建六语义清单()).dispatch({
      signal: { type: 'user-interaction', occurredAtMs: 1 },
      agentIntent: {
        stateIntent: { stateId: 'missing-state' },
        actionSemantic: 'idle',
        urgency: 60,
        explanation: '该状态不存在，应由已有推断器回退。'
      },
      direction: 'right'
    });

    expect(decision.snapshot.state.primaryStateId).toBe('idle-state');
    expect(decision.snapshot.schedule.current?.actionId).toBe('idle-action');
    expect(decision.diagnosticCodes).toEqual([]);
  });

  test('没有可用动作时保留当前画面并公开稳定诊断码', () => {
    const manifest = 创建六语义清单();
    manifest.actions.find((action) => action.id === 'idle-action')!.cooldownMs = 1_000;
    manifest.actions.find((action) => action.id === 'think-action')!.direction = 'left';
    const engine = 创建引擎(manifest);
    engine.dispatch({ signal: { type: 'idle-due', occurredAtMs: 1 }, direction: 'right' });
    engine.applyFeedback({
      playbackToken: 'token-1',
      actionId: 'idle-action',
      status: 'started',
      occurredAtMs: 10
    });
    engine.applyFeedback({
      playbackToken: 'token-1',
      actionId: 'idle-action',
      status: 'completed',
      occurredAtMs: 20
    });
    const current = engine.dispatch({
      signal: { type: 'movement', active: true, occurredAtMs: 2 },
      direction: 'right'
    });

    const unavailable = engine.dispatch({
      signal: { type: 'thinking', active: true, occurredAtMs: 3 },
      direction: 'right'
    });

    expect(unavailable.snapshot.state.primaryStateId).toBe('think-state');
    expect(unavailable.snapshot.schedule.current).toEqual(current.snapshot.schedule.current);
    expect(unavailable.effects).toEqual([{ type: 'none' }]);
    expect(unavailable.diagnosticCodes).toEqual(['CHARACTER_BEHAVIOR_ACTION_UNAVAILABLE']);
  });

  test('普通信号尊重抗中断动作，系统强制信号可中断并播放新动作', () => {
    const manifest = 创建六语义清单();
    manifest.actions.find((action) => action.id === 'idle-action')!.interrupt = 'resistant';
    const engine = 创建引擎(manifest);
    engine.dispatch({ signal: { type: 'idle-due', occurredAtMs: 1 }, direction: 'right' });

    const thinking = engine.dispatch({
      signal: { type: 'thinking', active: true, occurredAtMs: 2 },
      direction: 'right'
    });
    const success = engine.dispatch({
      signal: { type: 'task', phase: 'success', occurredAtMs: 3 },
      direction: 'right'
    });

    expect(thinking.effects).toEqual([{ type: 'none' }]);
    expect(thinking.snapshot.schedule.current?.actionId).toBe('idle-action');
    expect(success.effects.map((effect) => effect.type)).toEqual(['interrupt', 'play']);
    expect(success.snapshot.schedule.current?.actionId).toBe('celebrate-action');
  });

  test('用户交互作为系统强制信号可替换抗中断动作', () => {
    const manifest = 创建六语义清单();
    manifest.actions.find((action) => action.id === 'idle-action')!.interrupt = 'resistant';
    const engine = 创建引擎(manifest);
    engine.dispatch({ signal: { type: 'idle-due', occurredAtMs: 1 }, direction: 'right' });

    const decision = engine.dispatch({
      signal: { type: 'user-interaction', occurredAtMs: 2 },
      direction: 'right'
    });

    expect(decision.effects.map((effect) => effect.type)).toEqual(['interrupt', 'play']);
    expect(decision.snapshot.schedule.current?.playbackToken).toBe('token-2');
  });

  test('相同固定随机序列可重现相同动作序列', () => {
    const actions = [创建动作('idle-first', 'idle'), 创建动作('idle-second', 'idle')];
    const manifest = 创建清单({
      actions,
      states: [创建状态('idle-state', 'idle', actions.map((action) => action.id))]
    });
    const 随机源 = () => {
      const values = [0.1, 0.9, 0.2];
      let index = 0;
      return () => values[index++ % values.length]!;
    };
    const run = () => {
      const engine = 创建引擎(manifest, { random: 随机源() });
      return [1, 2, 3].map((occurredAtMs) => engine.dispatch({
        signal: { type: 'idle-due', occurredAtMs },
        direction: 'right'
      }).snapshot.schedule.current?.actionId);
    };

    expect(run()).toEqual(['idle-first', 'idle-second', 'idle-first']);
    expect(run()).toEqual(['idle-first', 'idle-second', 'idle-first']);
  });

  test('播放反馈更新当前调度并记录已完成历史', () => {
    const engine = 创建引擎(创建六语义清单());
    engine.dispatch({ signal: { type: 'idle-due', occurredAtMs: 1 }, direction: 'right' });

    const started = engine.applyFeedback({
      playbackToken: 'token-1',
      actionId: 'idle-action',
      status: 'started',
      occurredAtMs: 20
    });
    const completed = engine.applyFeedback({
      playbackToken: 'token-1',
      actionId: 'idle-action',
      status: 'completed',
      occurredAtMs: 340
    });

    expect(started.snapshot.schedule.current).toMatchObject({ startedAtMs: 20, expectedEndAtMs: 340 });
    expect(started.effects).toEqual([{ type: 'none' }]);
    expect(completed.snapshot.schedule.current).toBeNull();
    expect(completed.snapshot.schedule.history).toEqual([{
      actionId: 'idle-action',
      startedAtMs: 20,
      finishedAtMs: 340,
      outcome: 'completed'
    }]);
  });

  test('同角色替换未开始令牌后幂等接收旧 started 与 interrupted', () => {
    let now = 0;
    const engine = 创建引擎(创建六语义清单(), { now: () => now });
    engine.dispatch({ signal: { type: 'idle-due', occurredAtMs: now }, direction: 'right' });
    now = 1;
    const replaced = engine.dispatch({
      signal: { type: 'thinking', active: true, occurredAtMs: now },
      direction: 'right'
    });
    const nextSchedule = replaced.snapshot.schedule;

    now = 2;
    expect(engine.applyFeedback({
      playbackToken: 'token-1',
      actionId: 'idle-action',
      status: 'started',
      occurredAtMs: now
    })).toMatchObject({
      snapshot: { schedule: nextSchedule },
      effects: [{ type: 'none' }],
      diagnosticCodes: []
    });
    now = 3;
    expect(engine.applyFeedback({
      playbackToken: 'token-1',
      actionId: 'idle-action',
      status: 'interrupted',
      occurredAtMs: now
    }).snapshot.schedule).toEqual(nextSchedule);
    expect(engine.snapshot().schedule).toEqual(nextSchedule);
  });

  test('Main 权威替换旧令牌后幂等接收旧 interrupted 且不改变新动作', () => {
    let now = 0;
    const engine = 创建引擎(创建六语义清单(), { now: () => now });
    engine.dispatch({ signal: { type: 'idle-due', occurredAtMs: 1 }, direction: 'right' });
    now = 10;
    engine.applyFeedback({
      playbackToken: 'token-1',
      actionId: 'idle-action',
      status: 'started',
      occurredAtMs: 10
    });
    now = 20;
    const replaced = engine.dispatch({
      signal: { type: 'thinking', active: true, occurredAtMs: now },
      direction: 'right'
    });
    const nextSchedule = replaced.snapshot.schedule;
    const staleInterrupted = {
      playbackToken: 'token-1',
      actionId: 'idle-action',
      status: 'interrupted' as const,
      occurredAtMs: 22
    };

    expect(() => engine.applyFeedback({
      playbackToken: 'token-1',
      actionId: 'idle-action',
      status: 'started',
      occurredAtMs: 21
    })).toThrow('CHARACTER_PLAYBACK_UNAUTHORIZED');
    expect(engine.applyFeedback(staleInterrupted)).toMatchObject({
      snapshot: { schedule: nextSchedule },
      effects: [{ type: 'none' }],
      diagnosticCodes: []
    });
    expect(engine.applyFeedback(staleInterrupted).snapshot.schedule).toEqual(nextSchedule);
    expect(engine.snapshot().schedule.current).toMatchObject({
      playbackToken: 'token-2',
      actionId: 'think-action'
    });
  });

  test.each([
    ['未知令牌', 'interrupted', 'unknown-token', 'idle-action'],
    ['错误动作', 'interrupted', 'token-1', 'think-action'],
    ['迟到 completed', 'completed', 'token-1', 'idle-action'],
    ['迟到 failed', 'failed', 'token-1', 'idle-action']
  ] as const)('Main 退役账本仍拒绝%s反馈', (_name, status, playbackToken, actionId) => {
    let now = 0;
    const engine = 创建引擎(创建六语义清单(), { now: () => now });
    engine.dispatch({ signal: { type: 'idle-due', occurredAtMs: 0 }, direction: 'right' });
    now = 10;
    engine.dispatch({
      signal: { type: 'thinking', active: true, occurredAtMs: now },
      direction: 'right'
    });
    const current = engine.snapshot().schedule;
    now = 20;

    expect(() => engine.applyFeedback({
      playbackToken,
      actionId,
      status,
      occurredAtMs: 20
    })).toThrow('CHARACTER_PLAYBACK_UNAUTHORIZED');
    expect(engine.snapshot().schedule).toEqual(current);
  });

  test('Main 退役账本仅保留最新八个旧播放实例', () => {
    let now = 0;
    const engine = 创建引擎(创建六语义清单(), { now: () => now });
    for (let index = 0; index < 10; index += 1) {
      now = index;
      engine.dispatch({
        signal: { type: 'idle-due', occurredAtMs: now },
        direction: 'right'
      });
    }
    now = 10;

    expect(() => engine.applyFeedback({
      playbackToken: 'token-1',
      actionId: 'idle-action',
      status: 'interrupted',
      occurredAtMs: now
    })).toThrow('CHARACTER_PLAYBACK_UNAUTHORIZED');
    expect(() => engine.applyFeedback({
      playbackToken: 'token-2',
      actionId: 'idle-action',
      status: 'interrupted',
      occurredAtMs: now
    })).not.toThrow();
    expect(engine.snapshot().schedule.current?.playbackToken).toBe('token-10');
  });

  test('advance 清除未开始令牌后仅幂等接收迟到 interrupted', () => {
    let now = 0;
    const engine = 创建引擎(创建六语义清单(), {
      now: () => now,
      startConfirmationTimeoutMs: 100
    });
    engine.dispatch({ signal: { type: 'idle-due', occurredAtMs: 0 }, direction: 'right' });

    now = 99;
    expect(engine.advance().snapshot.schedule.current?.playbackToken).toBe('token-1');
    now = 100;
    expect(engine.advance().snapshot.schedule.current).toBeNull();
    now = 101;
    expect(() => engine.applyFeedback({
      playbackToken: 'token-1',
      actionId: 'idle-action',
      status: 'started',
      occurredAtMs: 101
    })).toThrow('CHARACTER_PLAYBACK_UNAUTHORIZED');
    const next = engine.dispatch({
      signal: { type: 'thinking', active: true, occurredAtMs: now },
      direction: 'right'
    });
    expect(() => engine.applyFeedback({
      playbackToken: 'token-1',
      actionId: 'idle-action',
      status: 'started',
      occurredAtMs: now
    })).toThrow('CHARACTER_PLAYBACK_UNAUTHORIZED');
    expect(() => engine.applyFeedback({
      playbackToken: 'token-1',
      actionId: 'idle-action',
      status: 'interrupted',
      occurredAtMs: 102
    })).not.toThrow();
    expect(engine.snapshot().schedule).toEqual(next.snapshot.schedule);
  });

  test('advance 在已开始动作没有终态反馈时按播放截止时间完成归档', () => {
    let now = 0;
    const engine = 创建引擎(创建六语义清单(), { now: () => now });
    engine.dispatch({ signal: { type: 'idle-due', occurredAtMs: 0 }, direction: 'right' });
    now = 10;
    engine.applyFeedback({
      playbackToken: 'token-1',
      actionId: 'idle-action',
      status: 'started',
      occurredAtMs: 10
    });

    now = 329;
    expect(engine.advance().snapshot.schedule.current).not.toBeNull();
    now = 330;
    const expired = engine.advance();

    expect(expired.snapshot.schedule.current).toBeNull();
    expect(expired.snapshot.schedule.history.at(-1)).toEqual({
      actionId: 'idle-action',
      startedAtMs: 10,
      finishedAtMs: 330,
      outcome: 'completed'
    });
    now = 331;
    const next = engine.dispatch({
      signal: { type: 'thinking', active: true, occurredAtMs: now },
      direction: 'right'
    });
    expect(() => engine.applyFeedback({
      playbackToken: 'token-1',
      actionId: 'idle-action',
      status: 'started',
      occurredAtMs: now
    })).toThrow('CHARACTER_PLAYBACK_UNAUTHORIZED');
    expect(() => engine.applyFeedback({
      playbackToken: 'token-1',
      actionId: 'idle-action',
      status: 'interrupted',
      occurredAtMs: now
    })).not.toThrow();
    expect(engine.snapshot().schedule).toEqual(next.snapshot.schedule);
    expect(engine.snapshot().schedule.current).toMatchObject({
      playbackToken: 'token-2',
      actionId: 'think-action'
    });
  });

  test.each([
    ['失败', 'failed', 'failureFallbackActionId'],
    ['中断', 'interrupted', 'interruptedFallbackActionId']
  ] as const)('%s 反馈把配置回退重新授权并用新令牌排程播放', (
    _name,
    status,
    fallbackField
  ) => {
    const source = 创建动作('source-action', 'idle', {
      [fallbackField]: 'fallback-action'
    });
    const fallback = 创建动作('fallback-action', 'fail');
    const manifest = 创建清单({
      actions: [source, fallback],
      states: [创建状态('idle-state', 'idle', [source.id, fallback.id])]
    });
    const engine = 创建引擎(manifest);
    engine.dispatch({ signal: { type: 'idle-due', occurredAtMs: 1 }, direction: 'right' });

    const fallbackDecision = engine.applyFeedback({
      playbackToken: 'token-1',
      actionId: source.id,
      status,
      occurredAtMs: 20
    });

    expect(fallbackDecision.snapshot.schedule.current).toMatchObject({
      actionId: fallback.id,
      playbackToken: 'token-2',
      startedAtMs: null
    });
    expect(fallbackDecision.effects).toEqual([{
      type: 'play',
      action: fallbackDecision.snapshot.schedule.current
    }]);
  });

  test('不满足方向硬约束的失败回退不排程并公开动作不可用诊断', () => {
    const source = 创建动作('source-action', 'idle', {
      failureFallbackActionId: 'left-fallback'
    });
    const fallback = 创建动作('left-fallback', 'fail', { direction: 'left' });
    const engine = 创建引擎(创建清单({
      actions: [source, fallback],
      states: [创建状态('idle-state', 'idle', [source.id, fallback.id])]
    }));
    engine.dispatch({ signal: { type: 'idle-due', occurredAtMs: 1 }, direction: 'right' });

    const decision = engine.applyFeedback({
      playbackToken: 'token-1',
      actionId: source.id,
      status: 'failed',
      occurredAtMs: 20
    });

    expect(decision.snapshot.schedule.current).toBeNull();
    expect(decision.effects).toEqual([{ type: 'none' }]);
    expect(decision.diagnosticCodes).toEqual(['CHARACTER_BEHAVIOR_ACTION_UNAVAILABLE']);
  });

  test('六十五个无关动作挤出审计历史后，仍由反馈索引保持早期动作冷却', () => {
    let now = 0;
    const cooling = 创建动作('long-cooling', 'idle', { cooldownMs: 10_000 });
    const unrelated = Array.from({ length: 65 }, (_, index) => (
      创建动作(`unrelated-${index}`, 'idle')
    ));
    const actions = [cooling, ...unrelated];
    const states = actions.map((action) => 创建状态(
      `${action.id}-state`,
      'idle',
      [action.id]
    ));
    const engine = 创建引擎(创建清单({
      actions,
      states,
      defaultStateId: 'long-cooling-state'
    }), { now: () => now });
    const playAndComplete = (action: CharacterActionDefinitionV2): void => {
      const decision = engine.dispatch({
        signal: { type: 'user-interaction', occurredAtMs: now },
        agentIntent: {
          stateIntent: { stateId: `${action.id}-state` },
          actionSemantic: 'idle',
          urgency: 100,
          explanation: '依次填充有界审计历史'
        },
        direction: 'right'
      });
      const current = decision.snapshot.schedule.current!;
      engine.applyFeedback({
        playbackToken: current.playbackToken,
        actionId: current.actionId,
        status: 'started',
        occurredAtMs: now
      });
      now += 1;
      engine.applyFeedback({
        playbackToken: current.playbackToken,
        actionId: current.actionId,
        status: 'completed',
        occurredAtMs: now
      });
      now += 1;
    };
    playAndComplete(cooling);
    for (const action of unrelated) playAndComplete(action);

    expect(engine.snapshot().schedule.history).toHaveLength(64);
    expect(engine.snapshot().schedule.history.some(entry => entry.actionId === cooling.id)).toBe(false);
    const blocked = engine.dispatch({
      signal: { type: 'user-interaction', occurredAtMs: now },
      agentIntent: {
        stateIntent: { stateId: 'long-cooling-state' },
        actionSemantic: 'idle',
        urgency: 100,
        explanation: '验证长期冷却没有被审计裁剪解除'
      },
      direction: 'right'
    });

    expect(blocked.snapshot.schedule.current).toBeNull();
    expect(blocked.diagnosticCodes).toEqual(['CHARACTER_BEHAVIOR_ACTION_UNAVAILABLE']);
    expect(blocked.snapshot).not.toHaveProperty('actionRecencyById');
  });

  test('角色切换清空压缩索引，相同动作 ID 不继承旧角色冷却', () => {
    const oldAction = 创建动作('shared-idle', 'idle', { cooldownMs: 10_000 });
    const oldManifest = 创建清单({
      id: 'old-character',
      actions: [oldAction],
      states: [创建状态('old-state', 'idle', [oldAction.id])],
      defaultStateId: 'old-state'
    });
    const newAction = 创建动作('shared-idle', 'idle', { cooldownMs: 10_000 });
    const newManifest = 创建清单({
      id: 'new-character',
      actions: [newAction],
      states: [创建状态('new-state', 'idle', [newAction.id])],
      defaultStateId: 'new-state'
    });
    const engine = 创建引擎(oldManifest);
    engine.dispatch({ signal: { type: 'idle-due', occurredAtMs: 0 }, direction: 'right' });
    engine.applyFeedback({
      playbackToken: 'token-1',
      actionId: oldAction.id,
      status: 'started',
      occurredAtMs: 10
    });
    engine.applyFeedback({
      playbackToken: 'token-1',
      actionId: oldAction.id,
      status: 'completed',
      occurredAtMs: 20
    });

    const replaced = engine.replaceCharacter(newManifest, 'default-skin');

    expect(replaced.snapshot.schedule.current).toMatchObject({
      actionId: newAction.id,
      playbackToken: 'token-2'
    });
  });

  test('未授权播放反馈继续抛出调度器稳定错误', () => {
    const engine = 创建引擎(创建六语义清单());

    expect(() => engine.applyFeedback({
      playbackToken: 'unknown-token',
      actionId: 'idle-action',
      status: 'started',
      occurredAtMs: 20
    })).toThrow('CHARACTER_PLAYBACK_UNAUTHORIZED');
  });

  test('切换角色先中断旧令牌，再清空历史并按最近方向播放新默认动作', () => {
    const oldActions = [
      创建动作('old-idle', 'idle', { interruptedFallbackActionId: 'old-fallback' }),
      创建动作('old-fallback', 'fail')
    ];
    const oldManifest = 创建清单({
      id: 'old-character',
      actions: oldActions,
      states: [创建状态('old-state', 'idle', ['old-idle'])],
      defaultStateId: 'old-state'
    });
    const newAction = 创建动作('new-left-idle', 'idle', { direction: 'left' });
    const newManifest = 创建清单({
      id: 'new-character',
      actions: [newAction],
      states: [创建状态('new-state', 'idle', [newAction.id])],
      defaultStateId: 'new-state'
    });
    const engine = 创建引擎(oldManifest);
    engine.dispatch({ signal: { type: 'idle-due', occurredAtMs: 1 }, direction: 'left' });
    engine.applyFeedback({
      playbackToken: 'token-1',
      actionId: 'old-idle',
      status: 'started',
      occurredAtMs: 10
    });
    engine.applyFeedback({
      playbackToken: 'token-1',
      actionId: 'old-idle',
      status: 'completed',
      occurredAtMs: 20
    });
    engine.dispatch({ signal: { type: 'idle-due', occurredAtMs: 2 }, direction: 'left' });

    const replaced = engine.replaceCharacter(newManifest, 'default-skin');

    expect(replaced.effects).toEqual([
      {
        type: 'interrupt',
        playbackToken: 'token-2',
        actionId: 'old-idle',
        fallbackActionId: 'old-fallback'
      },
      { type: 'play', action: replaced.snapshot.schedule.current }
    ]);
    expect(replaced.snapshot).toMatchObject({
      characterId: 'new-character',
      skinId: 'default-skin',
      state: { revision: 0, primaryStateId: 'new-state' },
      schedule: { revision: 1, history: [], current: { actionId: 'new-left-idle', playbackToken: 'token-3' } }
    });
    expect(replaced.diagnosticCodes).toEqual(['CHARACTER_BEHAVIOR_CHARACTER_REPLACED']);
    expect(() => engine.applyFeedback({
      playbackToken: 'token-2',
      actionId: 'old-idle',
      status: 'started',
      occurredAtMs: 1_001
    })).toThrow('CHARACTER_PLAYBACK_UNAUTHORIZED');
    expect(() => engine.applyFeedback({
      playbackToken: 'token-2',
      actionId: 'old-idle',
      status: 'interrupted',
      occurredAtMs: 1_001
    })).not.toThrow();
    expect(engine.snapshot().schedule.current).toMatchObject({
      actionId: 'new-left-idle',
      playbackToken: 'token-3'
    });
  });

  test('切换后的默认动作不可用时仍中断旧画面并追加动作不可用诊断', () => {
    const engine = 创建引擎(创建六语义清单('old-character'));
    engine.dispatch({ signal: { type: 'idle-due', occurredAtMs: 1 }, direction: 'right' });
    const blocked = 创建动作('new-left-only', 'idle', { direction: 'left' });
    const unavailableManifest = 创建清单({
      id: 'unavailable-character',
      actions: [blocked],
      states: [创建状态('new-state', 'idle', [blocked.id])]
    });

    const replaced = engine.replaceCharacter(unavailableManifest, 'default-skin');

    expect(replaced.effects.map((effect) => effect.type)).toEqual(['interrupt', 'none']);
    expect(replaced.snapshot.schedule).toEqual({ revision: 0, current: null, history: [] });
    expect(replaced.diagnosticCodes).toEqual([
      'CHARACTER_BEHAVIOR_CHARACTER_REPLACED',
      'CHARACTER_BEHAVIOR_ACTION_UNAVAILABLE'
    ]);
  });

  test('快照和已返回效果不能反向修改引擎内部状态', () => {
    const engine = 创建引擎(创建六语义清单());
    const decision = engine.dispatch({ signal: { type: 'idle-due', occurredAtMs: 1 }, direction: 'right' });
    decision.snapshot.state.primaryStateId = 'tampered-state';
    decision.snapshot.schedule.current!.actionId = 'tampered-action';
    const play = decision.effects.find((effect) => effect.type === 'play');
    if (play?.type === 'play') play.action.actionId = 'tampered-effect';

    const snapshot = engine.snapshot();

    expect(snapshot.state.primaryStateId).toBe('idle-state');
    expect(snapshot.schedule.current?.actionId).toBe('idle-action');
  });
});
