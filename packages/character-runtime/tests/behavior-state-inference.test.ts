import { describe, expect, test } from 'vitest';
import type {
  CharacterBehaviorSignal,
  CharacterBehaviorStateSnapshot,
  CharacterManifestV2,
  CharacterStateDefinitionV2
} from '../src';
import {
  createInitialBehaviorState,
  inferCharacterBehaviorState
} from '../src/behavior-state-inference';

type 状态覆盖 = Partial<CharacterStateDefinitionV2> & Pick<CharacterStateDefinitionV2, 'id' | 'kind' | 'semantic'>;

/** 创建只保留状态推断所需字段的有效 V2 清单。 */
function 创建清单(states: CharacterStateDefinitionV2[], defaultStateId = states[0]!.id): CharacterManifestV2 {
  return {
    version: 2,
    id: 'inference-fixture',
    name: '推断夹具',
    thumbnailAssetId: 'thumbnail',
    compilerVersion: 'test',
    identity: {
      description: '用于状态推断测试的角色。',
      background: '测试环境。',
      traits: ['稳定'],
      languageStyle: '简洁',
      formsOfAddress: ['你'],
      likes: ['测试'],
      dislikes: ['歧义'],
      behavioralTendencies: ['保持确定性'],
      boundaries: ['不执行外部命令'],
      exampleLines: ['正在推断状态。']
    },
    defaultSkinId: 'default-skin',
    defaultStateId,
    skins: [{ id: 'default-skin', name: '默认皮肤', presentations: [], semanticFallbacks: [] }],
    states,
    actions: [],
    resources: [{
      assetId: 'thumbnail',
      fileName: 'thumbnail.png',
      sha256: 'a'.repeat(64),
      byteLength: 1
    }]
  };
}

/** 创建可按单例覆盖的状态定义，避免测试依赖状态 ID 与标准语义同名。 */
function 创建状态(覆盖: 状态覆盖): CharacterStateDefinitionV2 {
  const { id, kind, semantic, ...其余覆盖 } = 覆盖;
  return {
    id,
    name: id,
    kind,
    semantic,
    tags: [],
    intensity: 1,
    coexistWithStateIds: [],
    forbiddenStateIds: [],
    enterConditions: [],
    exitConditions: [],
    agentInferable: false,
    actionIds: [],
    ...其余覆盖
  };
}

function 推断(
  manifest: CharacterManifestV2,
  signal: CharacterBehaviorSignal,
  previous = createInitialBehaviorState(manifest)
): CharacterBehaviorStateSnapshot {
  return inferCharacterBehaviorState({ manifest, previous, signal });
}

const 语义状态 = [
  创建状态({ id: 'resting-core', kind: 'primary', semantic: 'idle' }),
  创建状态({ id: 'receiving-core', kind: 'primary', semantic: 'listen' }),
  创建状态({ id: 'reasoning-core', kind: 'primary', semantic: 'think' }),
  创建状态({ id: 'travelling-core', kind: 'primary', semantic: 'move' }),
  创建状态({ id: 'victory-core', kind: 'primary', semantic: 'celebrate' }),
  创建状态({ id: 'recovery-core', kind: 'primary', semantic: 'fail' })
];

describe('V2 行为状态推断', () => {
  test('初始快照使用默认主状态且不含修饰状态', () => {
    const manifest = 创建清单(语义状态, 'resting-core');

    expect(createInitialBehaviorState(manifest)).toEqual({
      revision: 0,
      primaryStateId: 'resting-core',
      modifierStateIds: [],
      activeSignals: [],
      desiredActionSemantic: 'idle'
    });
  });

  test.each([
    [{ type: 'idle-due', occurredAtMs: 1 }, 'resting-core', 'idle'],
    [{ type: 'conversation-start', occurredAtMs: 1 }, 'receiving-core', 'listen'],
    [{ type: 'listening', active: true, occurredAtMs: 1 }, 'receiving-core', 'listen'],
    [{ type: 'thinking', active: true, occurredAtMs: 1 }, 'reasoning-core', 'think'],
    [{ type: 'movement', active: true, occurredAtMs: 1 }, 'travelling-core', 'move'],
    [{ type: 'task', phase: 'success', occurredAtMs: 1 }, 'victory-core', 'celebrate'],
    [{ type: 'task', phase: 'failure', occurredAtMs: 1 }, 'recovery-core', 'fail']
  ] satisfies Array<[CharacterBehaviorSignal, string, string]>)('本地信号 %o 按标准语义映射到非同名状态', (signal, stateId, semantic) => {
    const result = 推断(创建清单(语义状态), signal);

    expect(result.primaryStateId).toBe(stateId);
    expect(result.desiredActionSemantic).toBe(semantic);
  });

  test('活动事实合并到前态，并在停止时移除对应活动信号', () => {
    const manifest = 创建清单(语义状态);
    const listening = 推断(manifest, { type: 'listening', active: true, occurredAtMs: 1 });
    const moving = 推断(manifest, { type: 'movement', active: true, occurredAtMs: 2 }, listening);
    const stopped = 推断(manifest, { type: 'movement', active: false, occurredAtMs: 3 }, moving);

    expect(listening.activeSignals).toEqual(['listening']);
    expect(moving.activeSignals).toEqual(['listening', 'move-start']);
    expect(stopped.activeSignals).toEqual(['listening', 'move-stop']);
  });

  test('all 与 any 条件基于本轮活动信号和候选语义匹配', () => {
    const manifest = 创建清单([
      创建状态({ id: 'resting-core', kind: 'primary', semantic: 'idle' }),
      创建状态({
        id: 'signal-verified-think',
        kind: 'primary',
        semantic: 'think',
        intensity: 2,
        agentInferable: true,
        enterConditions: [{
          mode: 'all',
          clauses: [
            { kind: 'signal', signal: 'thinking' },
            { kind: 'semantic', semantic: 'think' }
          ]
        }]
      }),
      创建状态({
        id: 'fallback-think',
        kind: 'primary',
        semantic: 'think',
        agentInferable: true,
        enterConditions: [{
          mode: 'any',
          clauses: [
            { kind: 'signal', signal: 'task-failure' },
            { kind: 'semantic', semantic: 'think' }
          ]
        }]
      })
    ]);

    expect(推断(manifest, { type: 'thinking', active: true, occurredAtMs: 1 }).primaryStateId)
      .toBe('signal-verified-think');
    expect(inferCharacterBehaviorState({
      manifest,
      previous: createInitialBehaviorState(manifest),
      signal: { type: 'user-interaction', occurredAtMs: 2 },
      agentIntent: {
        stateIntent: { semantic: 'think' },
        actionSemantic: null,
        urgency: 1,
        explanation: '使用 any 条件状态。'
      }
    }).primaryStateId).toBe('fallback-think');
  });

  test('同语义主状态按强度降序并在相同强度时保持清单顺序', () => {
    const manifest = 创建清单([
      创建状态({ id: 'resting-core', kind: 'primary', semantic: 'idle' }),
      创建状态({ id: 'first-think', kind: 'primary', semantic: 'think', intensity: 9 }),
      创建状态({ id: 'second-think', kind: 'primary', semantic: 'think', intensity: 9 }),
      创建状态({ id: 'weaker-think', kind: 'primary', semantic: 'think', intensity: 8 })
    ]);

    expect(推断(manifest, { type: 'thinking', active: true, occurredAtMs: 1 }).primaryStateId)
      .toBe('first-think');
  });

  test('修饰状态同时满足进入条件、主状态共存白名单和禁止列表', () => {
    const manifest = 创建清单([
      创建状态({ id: 'resting-core', kind: 'primary', semantic: 'idle' }),
      创建状态({ id: 'reasoning-core', kind: 'primary', semantic: 'think' }),
      创建状态({
        id: 'focused-overlay',
        kind: 'modifier',
        semantic: { kind: 'custom', value: 'focused' },
        coexistWithStateIds: ['reasoning-core'],
        enterConditions: [{ mode: 'all', clauses: [{ kind: 'state', stateId: 'reasoning-core' }] }]
      }),
      创建状态({
        id: 'blocked-overlay',
        kind: 'modifier',
        semantic: { kind: 'custom', value: 'blocked' },
        coexistWithStateIds: ['reasoning-core', 'focused-overlay'],
        forbiddenStateIds: ['focused-overlay'],
        enterConditions: [{ mode: 'all', clauses: [{ kind: 'state', stateId: 'reasoning-core' }] }]
      })
    ]);

    const result = 推断(manifest, { type: 'thinking', active: true, occurredAtMs: 1 });

    expect(result.primaryStateId).toBe('reasoning-core');
    expect(result.modifierStateIds).toEqual(['focused-overlay']);
  });

  test('修饰状态退出条件满足时移除，主状态退出后回到默认状态', () => {
    const manifest = 创建清单([
      创建状态({ id: 'resting-core', kind: 'primary', semantic: 'idle' }),
      创建状态({
        id: 'reasoning-core',
        kind: 'primary',
        semantic: 'think',
        exitConditions: [{ mode: 'all', clauses: [{ kind: 'signal', signal: 'move-stop' }] }]
      }),
      创建状态({
        id: 'focused-overlay',
        kind: 'modifier',
        semantic: { kind: 'custom', value: 'focused' },
        coexistWithStateIds: ['reasoning-core'],
        enterConditions: [{ mode: 'all', clauses: [{ kind: 'state', stateId: 'reasoning-core' }] }],
        exitConditions: [{ mode: 'all', clauses: [{ kind: 'signal', signal: 'move-stop' }] }]
      })
    ]);
    const thinking = 推断(manifest, { type: 'thinking', active: true, occurredAtMs: 1 });
    const stopped = 推断(manifest, { type: 'movement', active: false, occurredAtMs: 2 }, thinking);

    expect(thinking.modifierStateIds).toEqual(['focused-overlay']);
    expect(stopped.primaryStateId).toBe('resting-core');
    expect(stopped.modifierStateIds).toEqual([]);
  });

  test('Agent 只能指定允许推断的状态，且本地思考优先于冲突意图', () => {
    const manifest = 创建清单([
      创建状态({ id: 'resting-core', kind: 'primary', semantic: 'idle' }),
      创建状态({ id: 'reasoning-core', kind: 'primary', semantic: 'think' }),
      创建状态({ id: 'agent-rest', kind: 'primary', semantic: 'idle', agentInferable: true }),
      创建状态({ id: 'private-rest', kind: 'primary', semantic: 'idle', agentInferable: false })
    ]);
    const previous = createInitialBehaviorState(manifest);

    const permitted = inferCharacterBehaviorState({
      manifest,
      previous,
      signal: { type: 'user-interaction', occurredAtMs: 1 },
      agentIntent: {
        stateIntent: { stateId: 'agent-rest' },
        actionSemantic: 'speak',
        urgency: 1,
        explanation: '使用可推断状态。'
      }
    });
    const conflicting = inferCharacterBehaviorState({
      manifest,
      previous,
      signal: { type: 'thinking', active: true, occurredAtMs: 2 },
      agentIntent: {
        stateIntent: { stateId: 'agent-rest' },
        actionSemantic: 'speak',
        urgency: 1,
        explanation: '与本地思考冲突。'
      }
    });
    const illegal = inferCharacterBehaviorState({
      manifest,
      previous,
      signal: { type: 'user-interaction', occurredAtMs: 3 },
      agentIntent: {
        stateIntent: { stateId: 'private-rest' },
        actionSemantic: 'speak',
        urgency: 1,
        explanation: '尝试私有状态。'
      }
    });

    expect(permitted.primaryStateId).toBe('agent-rest');
    expect(permitted.desiredActionSemantic).toBe('speak');
    expect(conflicting.primaryStateId).toBe('reasoning-core');
    expect(conflicting.desiredActionSemantic).toBe('think');
    expect(illegal.primaryStateId).toBe('resting-core');
  });

  test('Agent 语义意图只从可推断的主状态中按强度选择', () => {
    const manifest = 创建清单([
      创建状态({ id: 'resting-core', kind: 'primary', semantic: 'idle' }),
      创建状态({ id: 'private-think', kind: 'primary', semantic: 'think', intensity: 100 }),
      创建状态({ id: 'agent-think', kind: 'primary', semantic: 'think', intensity: 1, agentInferable: true })
    ]);

    const result = inferCharacterBehaviorState({
      manifest,
      previous: createInitialBehaviorState(manifest),
      signal: { type: 'user-interaction', occurredAtMs: 1 },
      agentIntent: {
        stateIntent: { semantic: 'think' },
        actionSemantic: null,
        urgency: 1,
        explanation: '请求可推断的思考状态。'
      }
    });

    expect(result.primaryStateId).toBe('agent-think');
  });

  test('Agent 指定可推断修饰状态时保留唯一主状态并加入修饰状态', () => {
    const manifest = 创建清单([
      创建状态({ id: 'resting-core', kind: 'primary', semantic: 'idle' }),
      创建状态({
        id: 'automatic-overlay',
        kind: 'modifier',
        semantic: { kind: 'custom', value: 'automatic-overlay' },
        coexistWithStateIds: ['resting-core'],
        forbiddenStateIds: ['agent-overlay']
      }),
      创建状态({
        id: 'agent-overlay',
        kind: 'modifier',
        semantic: { kind: 'custom', value: 'agent-overlay' },
        agentInferable: true,
        coexistWithStateIds: ['resting-core'],
        forbiddenStateIds: ['automatic-overlay']
      })
    ]);

    const result = inferCharacterBehaviorState({
      manifest,
      previous: createInitialBehaviorState(manifest),
      signal: { type: 'user-interaction', occurredAtMs: 1 },
      agentIntent: {
        stateIntent: { stateId: 'agent-overlay' },
        actionSemantic: 'speak',
        urgency: 1,
        explanation: '请求可推断的修饰状态。'
      }
    });

    expect(result.primaryStateId).toBe('resting-core');
    expect(result.modifierStateIds).toEqual(['agent-overlay']);
  });

  test('边沿信号进入的修饰状态在普通事件后保留，并在退出条件满足时移除', () => {
    const manifest = 创建清单([
      创建状态({ id: 'resting-core', kind: 'primary', semantic: 'idle' }),
      创建状态({
        id: 'interaction-overlay',
        kind: 'modifier',
        semantic: { kind: 'custom', value: 'interaction-overlay' },
        coexistWithStateIds: ['resting-core'],
        enterConditions: [{ mode: 'all', clauses: [{ kind: 'signal', signal: 'user-interaction' }] }],
        exitConditions: [{ mode: 'all', clauses: [{ kind: 'signal', signal: 'idle' }] }]
      })
    ]);
    const entered = 推断(manifest, { type: 'user-interaction', occurredAtMs: 1 });
    const retained = 推断(manifest, { type: 'listening', active: false, occurredAtMs: 2 }, entered);
    const exited = 推断(manifest, { type: 'idle-due', occurredAtMs: 3 }, retained);

    expect(entered.modifierStateIds).toEqual(['interaction-overlay']);
    expect(retained.modifierStateIds).toEqual(['interaction-overlay']);
    expect(exited.modifierStateIds).toEqual([]);
  });

  test('本地请求没有匹配主状态时回退到默认主状态', () => {
    const manifest = 创建清单([
      创建状态({ id: 'resting-core', kind: 'primary', semantic: 'idle' }),
      创建状态({ id: 'listening-core', kind: 'primary', semantic: 'listen' })
    ]);
    const listening = 推断(manifest, { type: 'conversation-start', occurredAtMs: 1 });

    expect(推断(manifest, { type: 'thinking', active: true, occurredAtMs: 2 }, listening).primaryStateId)
      .toBe('resting-core');
  });

  test('Agent 主状态进入条件不满足时回退默认状态', () => {
    const manifest = 创建清单([
      创建状态({ id: 'resting-core', kind: 'primary', semantic: 'idle' }),
      创建状态({ id: 'listening-core', kind: 'primary', semantic: 'listen' }),
      创建状态({
        id: 'agent-think',
        kind: 'primary',
        semantic: 'think',
        agentInferable: true,
        enterConditions: [{ mode: 'all', clauses: [{ kind: 'signal', signal: 'task-start' }] }]
      })
    ]);
    const listening = 推断(manifest, { type: 'conversation-start', occurredAtMs: 1 });

    expect(inferCharacterBehaviorState({
      manifest,
      previous: listening,
      signal: { type: 'user-interaction', occurredAtMs: 2 },
      agentIntent: {
        stateIntent: { semantic: 'think' },
        actionSemantic: null,
        urgency: 1,
        explanation: '条件尚未满足。'
      }
    }).primaryStateId).toBe('resting-core');
  });

  test('非法 Agent 状态意图回退默认状态但保留合法动作语义', () => {
    const manifest = 创建清单([
      创建状态({ id: 'resting-core', kind: 'primary', semantic: 'idle' }),
      创建状态({ id: 'listening-core', kind: 'primary', semantic: 'listen' })
    ]);
    const listening = 推断(manifest, { type: 'conversation-start', occurredAtMs: 1 });

    const result = inferCharacterBehaviorState({
      manifest,
      previous: listening,
      signal: { type: 'user-interaction', occurredAtMs: 2 },
      agentIntent: {
        stateIntent: { stateId: 'missing-state' },
        actionSemantic: 'speak',
        urgency: 1,
        explanation: '状态意图无效但动作语义有效。'
      }
    });

    expect(result.primaryStateId).toBe('resting-core');
    expect(result.desiredActionSemantic).toBe('speak');
  });

  test('异常清单的默认修饰状态不会成为初始主状态', () => {
    const manifest = 创建清单([
      创建状态({ id: 'fallback-primary', kind: 'primary', semantic: 'idle' }),
      创建状态({
        id: 'invalid-default-modifier',
        kind: 'modifier',
        semantic: { kind: 'custom', value: 'invalid-default' }
      })
    ], 'invalid-default-modifier');

    expect(createInitialBehaviorState(manifest).primaryStateId).toBe('fallback-primary');
  });

  test('异常清单不含主状态时抛出稳定错误', () => {
    const manifest = 创建清单([
      创建状态({
        id: 'only-modifier',
        kind: 'modifier',
        semantic: { kind: 'custom', value: 'only-modifier' }
      })
    ], 'only-modifier');

    expect(() => createInitialBehaviorState(manifest)).toThrow('CHARACTER_BEHAVIOR_PRIMARY_STATE_UNAVAILABLE');
  });
});
