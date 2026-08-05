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
    anchors: { ground: { x: 0.5, y: 1 } }
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
    anchors: { ground: { x: 0.5, y: 1 } }
  }));

  return 创建清单({ id, states, actions, presentations, defaultStateId: 'idle-state' });
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
      { type: 'interrupt', playbackToken: 'token-2', fallbackActionId: 'old-fallback' },
      { type: 'play', action: replaced.snapshot.schedule.current }
    ]);
    expect(replaced.snapshot).toMatchObject({
      characterId: 'new-character',
      skinId: 'default-skin',
      state: { revision: 0, primaryStateId: 'new-state' },
      schedule: { revision: 1, history: [], current: { actionId: 'new-left-idle', playbackToken: 'token-3' } }
    });
    expect(replaced.diagnosticCodes).toEqual(['CHARACTER_BEHAVIOR_CHARACTER_REPLACED']);
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
