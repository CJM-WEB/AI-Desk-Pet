import { describe, expect, test } from 'vitest';
import {
  type CharacterActionDefinitionV2,
  type CharacterBehaviorActionSelectionInput,
  type CharacterBehaviorStateSnapshot,
  type CharacterManifestV2,
  type CharacterStateDefinitionV2,
  selectDirectedCharacterBehaviorAction,
  selectCharacterBehaviorAction
} from '../src';

/** 创建只包含动作选择所需字段的有效 V2 清单。 */
function createManifest(overrides: Partial<CharacterManifestV2> = {}): CharacterManifestV2 {
  const actions = overrides.actions ?? [createAction('idle-action', 'idle')];
  const states = overrides.states ?? [createState('idle-state', 'primary', ['idle-action'])];
  const defaultStateId = overrides.defaultStateId ?? 'idle-state';

  return {
    version: 2,
    id: 'behavior-selector-fixture',
    name: '动作选择夹具',
    thumbnailAssetId: 'thumbnail',
    compilerVersion: 'test',
    identity: {
      description: '用于动作选择测试的角色。', background: '测试环境。', traits: [], languageStyle: '简洁',
      formsOfAddress: [], likes: [], dislikes: [], behavioralTendencies: [], boundaries: [], exampleLines: []
    },
    defaultSkinId: 'default-skin',
    defaultStateId,
    skins: [createSkin('default-skin', actions.map((action) => action.id))],
    states,
    actions,
    resources: [{ assetId: 'thumbnail', fileName: 'thumbnail.png', sha256: 'a'.repeat(64), byteLength: 1 }],
    ...overrides
  };
}

/** 创建可按测试覆盖字段的动作定义。 */
function createAction(
  id: string,
  semantic: CharacterActionDefinitionV2['semantic'],
  overrides: Partial<CharacterActionDefinitionV2> = {}
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

/** 创建主状态或修饰状态定义。 */
function createState(
  id: string,
  kind: CharacterStateDefinitionV2['kind'],
  actionIds: string[]
): CharacterStateDefinitionV2 {
  return {
    id,
    name: id,
    kind,
    semantic: kind === 'primary' ? 'idle' : { kind: 'custom', value: id },
    tags: [],
    intensity: 1,
    coexistWithStateIds: [],
    forbiddenStateIds: [],
    enterConditions: [],
    exitConditions: [],
    agentInferable: false,
    actionIds
  };
}

/** 创建单帧且可区分来源的皮肤表现。 */
function createSkin(
  id: string,
  actionIds: string[],
  assetPrefix = id,
  semanticFallbacks: CharacterManifestV2['skins'][number]['semanticFallbacks'] = []
): CharacterManifestV2['skins'][number] {
  return {
    id,
    name: id,
    semanticFallbacks,
    presentations: actionIds.map((actionId) => ({
      actionId,
      fps: 12,
      frames: [{ assetId: `${assetPrefix}-${actionId}`, x: 0, y: 0, width: 1, height: 1 }],
      anchors: { ground: { x: 0.5, y: 1 } }
    }))
  };
}

/** 创建当前状态和固定随机源的选择输入。 */
function createInput(
  manifest: CharacterManifestV2,
  overrides: Partial<CharacterBehaviorActionSelectionInput> = {}
): CharacterBehaviorActionSelectionInput {
  const state: CharacterBehaviorStateSnapshot = {
    revision: 1,
    primaryStateId: 'active-state',
    modifierStateIds: [],
    activeSignals: [],
    desiredActionSemantic: null
  };

  return {
    manifest,
    skinId: 'default-skin',
    state,
    direction: 'right',
    nowMs: 1_000,
    history: [],
    actionRecencyById: {},
    random: () => 0,
    ...overrides
  };
}

describe('V2 行为动作选择器', () => {
  test('私有定向目标仍经过状态、方向、冷却、重复抑制与表现硬约束', () => {
    const directed = createAction('directed-action', 'celebrate', {
      direction: 'right',
      cooldownMs: 500,
      repeatSuppressionMs: 500
    });
    const manifest = createManifest({
      actions: [createAction('idle-action', 'idle'), directed],
      states: [
        createState('active-state', 'primary', ['idle-action']),
        createState('directed-state', 'primary', ['directed-action'])
      ],
      defaultStateId: 'active-state',
      skins: [createSkin('default-skin', ['idle-action', 'directed-action'])]
    });

    expect(selectDirectedCharacterBehaviorAction(
      createInput(manifest),
      { kind: 'state', stateId: 'directed-state' }
    )).toMatchObject({ actionId: 'directed-action', stateId: 'directed-state' });

    const constrained = createInput(manifest, {
      actionRecencyById: {
        'directed-action': { latestStartedAtMs: 800, latestFinishedAtMs: 900 }
      }
    });
    expect(() => selectDirectedCharacterBehaviorAction(
      constrained,
      { kind: 'action', actionId: 'directed-action' }
    )).toThrow('CHARACTER_BEHAVIOR_PRESENTATION_UNAVAILABLE');
  });

  test('语义定向不会用默认待机动作冒充缺失的目标语义', () => {
    const manifest = createManifest({
      actions: [createAction('idle-action', 'idle')],
      states: [createState('active-state', 'primary', ['idle-action'])],
      defaultStateId: 'active-state'
    });

    expect(() => selectDirectedCharacterBehaviorAction(
      createInput(manifest),
      { kind: 'semantic', semantic: 'celebrate' }
    )).toThrow('CHARACTER_BEHAVIOR_PRESENTATION_UNAVAILABLE');
  });

  test('定向动作缺少当前皮肤精确表现时不借默认状态表现冒充成功', () => {
    const manifest = createManifest({
      actions: [
        createAction('idle-action', 'idle'),
        createAction('hidden-action', 'celebrate')
      ],
      states: [createState('active-state', 'primary', ['idle-action', 'hidden-action'])],
      defaultStateId: 'active-state',
      skins: [createSkin('default-skin', ['idle-action'])]
    });

    expect(() => selectDirectedCharacterBehaviorAction(
      createInput(manifest),
      { kind: 'action', actionId: 'hidden-action' }
    )).toThrow('CHARACTER_BEHAVIOR_PRESENTATION_UNAVAILABLE');
  });

  test('硬状态约束会排除高偏好动作，只有当前状态引用的合格动作可以入选', () => {
    const actions = [
      createAction('allowed-blocked', 'speak', { preference: 100, allowedPrimaryStateIds: ['other-state'] }),
      createAction('forbidden-blocked', 'speak', { preference: 100, forbiddenPrimaryStateIds: ['active-state'] }),
      createAction('required-blocked', 'speak', { preference: 100, requiredModifierStateIds: ['missing-modifier'] }),
      createAction('modifier-blocked', 'speak', { preference: 100, forbiddenModifierStateIds: ['focus-modifier'] }),
      createAction('not-referenced', 'speak', { preference: 100 }),
      createAction('eligible', 'speak', { preference: 1 })
    ];
    const manifest = createManifest({
      actions,
      defaultStateId: 'active-state',
      states: [
        createState('active-state', 'primary', actions.filter((action) => action.id !== 'not-referenced').map((action) => action.id)),
        createState('focus-modifier', 'modifier', [])
      ]
    });

    expect(selectCharacterBehaviorAction(createInput(manifest, {
      state: { revision: 1, primaryStateId: 'active-state', modifierStateIds: ['focus-modifier'], activeSignals: [], desiredActionSemantic: 'speak' }
    }))).toMatchObject({ actionId: 'eligible', stateId: 'active-state', reason: 'semantic' });
  });

  test('方向、冷却和未来记录都是硬约束，不能由偏好重新选入', () => {
    const actions = [
      createAction('left-only', 'speak', { preference: 100, direction: 'left' }),
      createAction('cooling', 'speak', { preference: 100, cooldownMs: 200 }),
      createAction('future-cooling', 'speak', { preference: 100, cooldownMs: 1 }),
      createAction('any-direction', 'speak', { preference: 1, direction: 'any' })
    ];
    const manifest = createManifest({
      actions,
      defaultStateId: 'active-state',
      states: [createState('active-state', 'primary', actions.map((action) => action.id))]
    });

    expect(selectCharacterBehaviorAction(createInput(manifest, {
      state: { revision: 1, primaryStateId: 'active-state', modifierStateIds: [], activeSignals: [], desiredActionSemantic: 'speak' },
      history: [
        { actionId: 'cooling', startedAtMs: 0, finishedAtMs: 950, outcome: 'completed' },
        { actionId: 'future-cooling', startedAtMs: 1_200, finishedAtMs: null, outcome: null }
      ]
    }))).toMatchObject({ actionId: 'any-direction', reason: 'semantic' });
  });

  test('六十五个无关动作挤出审计明细后，压缩索引仍保持长冷却', () => {
    const cooling = createAction('long-cooling', 'speak', {
      preference: 100,
      cooldownMs: 10_000
    });
    const alternative = createAction('alternative', 'speak');
    const manifest = createManifest({
      actions: [cooling, alternative],
      defaultStateId: 'active-state',
      states: [createState('active-state', 'primary', [cooling.id, alternative.id])]
    });
    const history = Array.from({ length: 64 }, (_, index) => ({
      actionId: `unrelated-${index + 1}`,
      startedAtMs: 20 + index,
      finishedAtMs: 21 + index,
      outcome: 'completed' as const
    }));

    expect(selectCharacterBehaviorAction(createInput(manifest, {
      state: {
        revision: 1,
        primaryStateId: 'active-state',
        modifierStateIds: [],
        activeSignals: [],
        desiredActionSemantic: 'speak'
      },
      nowMs: 100,
      history,
      actionRecencyById: {
        [cooling.id]: { latestStartedAtMs: 0, latestFinishedAtMs: 10 }
      }
    }))).toMatchObject({ actionId: alternative.id });
  });

  test('重复抑制优先选择其他候选，但没有其他候选时恢复最近动作', () => {
    const recent = createAction('recent', 'speak', { preference: 100, repeatSuppressionMs: 200 });
    const alternative = createAction('alternative', 'speak', { preference: 1 });
    const manifest = createManifest({
      actions: [recent, alternative],
      defaultStateId: 'active-state',
      states: [createState('active-state', 'primary', ['recent', 'alternative'])]
    });
    const history = [{ actionId: 'recent', startedAtMs: 900, finishedAtMs: null, outcome: null }];

    expect(selectCharacterBehaviorAction(createInput(manifest, {
      state: { revision: 1, primaryStateId: 'active-state', modifierStateIds: [], activeSignals: [], desiredActionSemantic: 'speak' },
      history
    }))).toMatchObject({ actionId: 'alternative' });
    expect(selectCharacterBehaviorAction(createInput({ ...manifest, actions: [recent], states: [createState('active-state', 'primary', ['recent'])] }, {
      state: { revision: 1, primaryStateId: 'active-state', modifierStateIds: [], activeSignals: [], desiredActionSemantic: 'speak' },
      history
    }))).toMatchObject({ actionId: 'recent' });
  });

  test('没有可播放表现的动作即使偏好更高也会被排除', () => {
    const unavailable = createAction('unavailable', 'speak', { preference: 100 });
    const playable = createAction('playable', 'speak', { preference: 1 });
    const manifest = createManifest({
      actions: [unavailable, playable],
      defaultStateId: 'fallback-state',
      states: [
        createState('active-state', 'primary', ['unavailable', 'playable']),
        createState('fallback-state', 'primary', [])
      ],
      skins: [createSkin('default-skin', ['playable'])]
    });

    expect(selectCharacterBehaviorAction(createInput(manifest, {
      state: { revision: 1, primaryStateId: 'active-state', modifierStateIds: [], activeSignals: [], desiredActionSemantic: 'speak' }
    }))).toMatchObject({ actionId: 'playable' });
  });

  test('期望语义优先于更高偏好的非语义动作', () => {
    const actions = [
      createAction('high-preference-idle', 'idle', { preference: 100 }),
      createAction('matched-semantic', 'speak', { preference: 1 })
    ];
    const manifest = createManifest({
      actions,
      defaultStateId: 'active-state',
      states: [createState('active-state', 'primary', actions.map((action) => action.id))]
    });

    expect(selectCharacterBehaviorAction(createInput(manifest, {
      state: { revision: 1, primaryStateId: 'active-state', modifierStateIds: [], activeSignals: [], desiredActionSemantic: 'speak' }
    }))).toMatchObject({ actionId: 'matched-semantic', reason: 'semantic' });
  });

  test('固定随机源按偏好权重稳定选择动作', () => {
    const actions = [
      createAction('first', 'idle', { preference: 1 }),
      createAction('second', 'idle', { preference: 3 })
    ];
    const manifest = createManifest({
      actions,
      defaultStateId: 'active-state',
      states: [createState('active-state', 'primary', ['first', 'second'])]
    });

    expect(selectCharacterBehaviorAction(createInput(manifest))).toMatchObject({ actionId: 'first', reason: 'state-preference' });
    expect(selectCharacterBehaviorAction(createInput(manifest, { random: () => 0.5 }))).toMatchObject({ actionId: 'second', reason: 'state-preference' });
  });

  test('主状态优先归属共享动作，修饰状态按快照顺序归属独占动作', () => {
    const shared = createAction('shared', 'idle');
    const modifierOnly = createAction('modifier-only', 'speak');
    const manifest = createManifest({
      actions: [shared, modifierOnly],
      defaultStateId: 'primary-state',
      states: [
        createState('primary-state', 'primary', ['shared']),
        createState('first-modifier', 'modifier', ['shared', 'modifier-only']),
        createState('second-modifier', 'modifier', ['modifier-only'])
      ]
    });

    expect(selectCharacterBehaviorAction(createInput(manifest, {
      state: { revision: 1, primaryStateId: 'primary-state', modifierStateIds: ['second-modifier', 'first-modifier'], activeSignals: [], desiredActionSemantic: 'idle' }
    }))).toMatchObject({ actionId: 'shared', stateId: 'primary-state' });
    expect(selectCharacterBehaviorAction(createInput(manifest, {
      state: { revision: 1, primaryStateId: 'primary-state', modifierStateIds: ['second-modifier', 'first-modifier'], activeSignals: [], desiredActionSemantic: 'speak' }
    }))).toMatchObject({ actionId: 'modifier-only', stateId: 'second-modifier' });
  });

  test.each([
    ['当前皮肤精确动作', createSkin('winter-skin', ['requested'], 'skin-exact'), createSkin('default-skin', ['requested'], 'default'), 'requested', 'skin-exact-requested'],
    ['当前皮肤语义回退', createSkin('winter-skin', ['semantic-fallback'], 'skin-semantic', [{ semantic: 'speak', actionId: 'semantic-fallback' }]), createSkin('default-skin', ['requested'], 'default'), 'requested', 'skin-semantic-semantic-fallback'],
    ['默认皮肤精确动作', createSkin('winter-skin', [], 'winter'), createSkin('default-skin', ['requested'], 'default'), 'requested', 'default-requested'],
    ['默认状态表现回退', createSkin('winter-skin', [], 'winter'), createSkin('default-skin', ['idle-default'], 'default'), 'requested', 'default-idle-default']
  ] as const)('%s 保持逻辑动作身份并返回解析后的可播放表现', (_name, currentSkin, defaultSkin, expectedActionId, expectedAssetId) => {
    const requested = createAction('requested', 'speak');
    const semanticFallback = createAction('semantic-fallback', 'speak');
    const idleDefault = createAction('idle-default', 'idle');
    const manifest = createManifest({
      actions: [requested, semanticFallback, idleDefault],
      defaultStateId: 'idle-state',
      skins: [defaultSkin, currentSkin],
      states: [
        createState('active-state', 'primary', ['requested']),
        createState('idle-state', 'primary', ['idle-default'])
      ]
    });

    const result = selectCharacterBehaviorAction(createInput(manifest, {
      skinId: 'winter-skin',
      state: { revision: 1, primaryStateId: 'active-state', modifierStateIds: [], activeSignals: [], desiredActionSemantic: 'speak' }
    }));

    expect(result.actionId).toBe(expectedActionId);
    expect(result.presentation.actionId).not.toBeUndefined();
    expect(result.presentation.frames[0]?.assetId).toBe(expectedAssetId);
  });

  test('当前状态无候选时使用默认状态的同一过滤流程', () => {
    const blocked = createAction('blocked', 'speak', { direction: 'left' });
    const fallback = createAction('fallback', 'idle', { direction: 'any' });
    const manifest = createManifest({
      actions: [blocked, fallback],
      defaultStateId: 'idle-state',
      states: [
        createState('active-state', 'primary', ['blocked']),
        createState('idle-state', 'primary', ['fallback'])
      ]
    });

    expect(selectCharacterBehaviorAction(createInput(manifest, {
      state: { revision: 1, primaryStateId: 'active-state', modifierStateIds: [], activeSignals: [], desiredActionSemantic: 'speak' }
    }))).toMatchObject({ actionId: 'fallback', stateId: 'idle-state', reason: 'default-fallback' });
  });

  test('默认状态回退不继承当前主状态或修饰状态的约束上下文', () => {
    const blocked = createAction('blocked', 'speak', { direction: 'left' });
    const fallback = createAction('fallback', 'idle', {
      allowedPrimaryStateIds: ['idle-state'],
      forbiddenModifierStateIds: ['focus-modifier']
    });
    const manifest = createManifest({
      actions: [blocked, fallback],
      defaultStateId: 'idle-state',
      states: [
        createState('active-state', 'primary', ['blocked']),
        createState('idle-state', 'primary', ['fallback']),
        createState('focus-modifier', 'modifier', [])
      ]
    });

    expect(selectCharacterBehaviorAction(createInput(manifest, {
      state: { revision: 1, primaryStateId: 'active-state', modifierStateIds: ['focus-modifier'], activeSignals: [], desiredActionSemantic: 'speak' }
    }))).toMatchObject({ actionId: 'fallback', stateId: 'idle-state', reason: 'default-fallback' });
  });

  test('默认状态也没有可播放动作时抛出稳定错误', () => {
    const unavailable = createAction('unavailable', 'speak');
    const manifest = createManifest({
      actions: [unavailable],
      defaultStateId: 'idle-state',
      states: [
        createState('active-state', 'primary', ['unavailable']),
        createState('idle-state', 'primary', ['unavailable'])
      ],
      skins: [createSkin('default-skin', [])]
    });

    expect(() => selectCharacterBehaviorAction(createInput(manifest, {
      state: { revision: 1, primaryStateId: 'active-state', modifierStateIds: [], activeSignals: [], desiredActionSemantic: 'speak' }
    }))).toThrow('CHARACTER_BEHAVIOR_PRESENTATION_UNAVAILABLE');
  });
});
