import { describe, expect, test } from 'vitest';
import {
  createPublicBehaviorCatalog,
  characterManifestV3Schema,
  isPublicBehaviorTarget,
  PUBLIC_BEHAVIOR_CATALOG_ENTRY_BUDGET,
  PUBLIC_BEHAVIOR_CATALOG_UTF8_BYTE_BUDGET,
  publicBehaviorCatalogSchema,
  selectPublicBehaviorTarget,
  resolveBehaviorTarget,
  type CharacterManifestV3,
  type PublicBehaviorCatalog
} from '../src';

/** 构造同时包含稳定标识、公开名称、标签和不可公开状态的最小角色清单。 */
function createManifest(): CharacterManifestV3 {
  const actionIds = ['idle-action', 'wave-action', 'dance-action', 'hidden-action'];
  return {
    version: 3,
    id: 'resolver-fixture',
    name: '解析角色',
    thumbnailAssetId: 'thumbnail',
    compilerVersion: 'test',
    identity: {
      description: '行为目标解析测试角色', background: '测试环境', traits: [], languageStyle: '简洁',
      formsOfAddress: [], likes: [], dislikes: [], behavioralTendencies: [], boundaries: [], exampleLines: []
    },
    defaultSkinId: 'default-skin',
    idleStateId: 'idle-state',
    states: [
      {
        id: 'idle-state', name: '待机', description: '安静陪伴', tags: ['calm'], intensity: 1,
        enterConditions: [], exitConditions: [],
        agentInferable: true, actionIds: ['idle-action']
      },
      {
        id: 'happy-state', name: 'ＣＨＥＥＲ', tags: ['joy'], intensity: 2,
        enterConditions: [], exitConditions: [],
        agentInferable: true, actionIds: ['wave-action', 'dance-action']
      },
      {
        id: 'hidden-state', name: '隐藏状态', tags: ['hidden'], intensity: 1,
        enterConditions: [], exitConditions: [],
        agentInferable: false, actionIds: ['hidden-action']
      }
    ],
    actions: [
      createAction('idle-action', '待机动作', ['calm']),
      { ...createAction('wave-action', '挥手', ['greet']), description: '向用户热情挥手' },
      createAction('dance-action', '跳舞', ['dance']),
      createAction('hidden-action', '隐藏动作', ['hidden'])
    ],
    skins: [{
      id: 'default-skin',
      name: '默认皮肤',
      presentations: actionIds.slice(0, 3).map(actionId => ({
        actionId,
        fps: 12,
        frames: [{ assetId: `${actionId}-asset`, x: 0, y: 0, width: 1, height: 1 }],
        anchors: { ground: { x: 0.5, y: 1 } },
        geometry: {
          visualBounds: { x: 0, y: 0, width: 1, height: 1 },
          groundAnchor: { x: 0.5, y: 1 },
          resourceRevision: 'a'.repeat(64)
        }
      })),
    }],
    resources: [
      { assetId: 'thumbnail', fileName: 'thumbnail.png', sha256: 'a'.repeat(64), byteLength: 1 },
      ...actionIds.slice(0, 3).map(actionId => ({
        assetId: `${actionId}-asset`, fileName: `${actionId}.png`, sha256: 'a'.repeat(64), byteLength: 1
      }))
    ]
  };
}

function createAction(
  id: string,
  name: string,
  tags: string[]
): CharacterManifestV3['actions'][number] {
  return {
    id, name, tags, preference: 1, cooldownMs: 0, repeatSuppressionMs: 0,
    loopPolicy: 'never', interrupt: 'normal',
    direction: 'any'
  };
}

/** 构造 V3 现行上限内、且让共享动作在每个状态重复出现的压力清单。 */
function createMaximumSharedManifest(): CharacterManifestV3 {
  const manifest = createManifest();
  const tags = Array.from({ length: 32 }, (_, index) => `tag-${index}`);
  const actions = Array.from({ length: 100 }, (_, index) => ({
    ...createAction(`shared-action-${index}`, `共享动作${index}`, tags),
    description: `动作说明${index}${'甲'.repeat(1_990)}`
  }));
  const states = Array.from({ length: 100 }, (_, index) => ({
    id: `shared-state-${index}`,
    name: `共享状态${index}`,
    description: `状态说明${index}${'乙'.repeat(1_990)}`,


    tags,
    intensity: 1,
    enterConditions: [],
    exitConditions: [],
    agentInferable: true,
    actionIds: actions.map(action => action.id)
  }));
  const presentations = actions.map(action => ({
    actionId: action.id,
    fps: 12,
    frames: [{ assetId: `${action.id}-asset`, x: 0, y: 0, width: 1, height: 1 }],
    anchors: { ground: { x: 0.5, y: 1 } },
    geometry: {
      visualBounds: { x: 0, y: 0, width: 1, height: 1 },
      groundAnchor: { x: 0.5, y: 1 },
      resourceRevision: 'a'.repeat(64)
    }
  }));
  return {
    ...manifest,
    identity: {
      ...manifest.identity,
      description: '角'.repeat(2_000),
      background: '景'.repeat(4_000),
      traits: Array.from({ length: 32 }, (_, index) => `特征${index}${'甲'.repeat(110)}`),
      languageStyle: '语'.repeat(500),
      likes: Array.from({ length: 32 }, (_, index) => `喜好${index}${'乙'.repeat(225)}`),
      behavioralTendencies: Array.from(
        { length: 32 }, (_, index) => `倾向${index}${'丙'.repeat(225)}`
      )
    },
    idleStateId: 'shared-state-99',
    states,
    actions,
    skins: [{ ...manifest.skins[0]!, presentations }],
    resources: [
      manifest.resources[0]!,
      ...actions.map(action => ({
        assetId: `${action.id}-asset`,
        fileName: `${action.id}.png`,
        sha256: 'a'.repeat(64),
        byteLength: 1
      }))
    ]
  };
}

describe('公开行为目标解析器', () => {
  test('公开清单保留状态到动作归属与有界人设，保留稳定ID且不泄露素材数据', () => {
    const catalog = createPublicBehaviorCatalog(createManifest(), 'default-skin');

    expect(catalog).toEqual({
      identity: {
        name: '解析角色',
        description: '行为目标解析测试角色',
        background: '测试环境',
        traits: [],
        languageStyle: '简洁',
        likes: [],
        behavioralTendencies: []
      },
      states: [
        {
          name: '待机', stateId: 'idle-state', description: '安静陪伴', tags: ['calm'],
          actions: [{ name: '待机动作', actionId: 'idle-action', tags: ['calm'] }]
        },
        {
          name: 'ＣＨＥＥＲ', stateId: 'happy-state', tags: ['joy'],
          actions: [
            { name: '挥手', actionId: 'wave-action', description: '向用户热情挥手', tags: ['greet'] },
            { name: '跳舞', actionId: 'dance-action', tags: ['dance'] }
          ]
        }
      ]
    });
    expect(JSON.stringify(catalog)).not.toMatch(
      /(?:hidden|asset|fileName|frames|formsOfAddress|boundaries|exampleLines)/u
    );
    expect(() => publicBehaviorCatalogSchema.parse({
      ...catalog,
      states: [{
        ...catalog.states[0]!,
        actions: [{ ...catalog.states[0]!.actions[0]!, privatePath: '/private' }]
      }]
    })).toThrow();
  });

  test('最大合法清单与跨状态共享动作被确定性裁剪到公开总预算且保留默认状态', () => {
    const manifest = createMaximumSharedManifest();
    expect(characterManifestV3Schema.safeParse(manifest).success).toBe(true);
    const first = createPublicBehaviorCatalog(manifest, 'default-skin');
    const second = createPublicBehaviorCatalog(manifest, 'default-skin');
    const serialized = JSON.stringify(first);
    const entryCount = first.states.reduce((total, state) => total + 1 + state.actions.length, 0);

    expect(first).toEqual(second);
    expect(new TextEncoder().encode(serialized).byteLength)
      .toBeLessThanOrEqual(PUBLIC_BEHAVIOR_CATALOG_UTF8_BYTE_BUDGET);
    expect(entryCount).toBeLessThanOrEqual(PUBLIC_BEHAVIOR_CATALOG_ENTRY_BUDGET);
    expect(first.states.some(state => state.name === '共享状态99')).toBe(true);
    expect(first.states.find(state => state.name === '共享状态99')?.actions.length)
      .toBeGreaterThan(0);
    expect(first.states.every(state => state.actions.length > 0)).toBe(true);
    expect(serialized).not.toMatch(/(?:asset|fileName|frames)/u);
    expect(first.states.length * 100).toBeGreaterThan(entryCount);
  });

  test.each([
    [{ kind: 'state_name', name: 'cheer' }, { kind: 'state', stateId: 'happy-state' }],
    [{ kind: 'action_name', name: '挥手' }, { kind: 'state_action', stateId: 'happy-state', actionId: 'wave-action' }],
    [{ kind: 'tag', tag: 'dance' }, { kind: 'state_action', stateId: 'happy-state', actionId: 'dance-action' }]
  ] as const)('将公开目标 %o 解析为唯一私有目标', (target, expected) => {
    expect(resolveBehaviorTarget(createManifest(), 'default-skin', target)).toEqual(expected);
  });

  test('名称匹配使用 NFKC 且不区分大小写', () => {
    expect(resolveBehaviorTarget(
      createManifest(),
      'default-skin',
      { kind: 'state_name', name: 'CHEER' }
    )).toEqual({ kind: 'state', stateId: 'happy-state' });
  });

  test('动作描述比同状态名称更接近时返回带动作的层级计划', () => {
    const catalog: PublicBehaviorCatalog = {
      identity: {
        name: '描述角色', description: '描述测试', background: '测试环境', traits: [],
        languageStyle: '简洁', likes: [], behavioralTendencies: []
      },
      states: [{
        name: '公开目标', stateId: 'public-state', description: '状态说明', tags: [],
        actions: [{
          name: '公开目标', actionId: 'public-action', description: '只在动作描述中出现的唯一短语', tags: []
        }]
      }]
    };

    expect(selectPublicBehaviorTarget(
      catalog,
      '只在动作描述中出现的唯一短语',
      '只在动作描述中出现的唯一短语'
    )).toEqual({ kind: 'play_state', state: '公开目标', action: '公开目标' });
  });

  test('只命中状态描述时保留状态层级且不提前固定动作', () => {
    const catalog = createPublicBehaviorCatalog(createManifest(), 'default-skin');

    expect(selectPublicBehaviorTarget(catalog, '安静陪伴', '待机状态')).toEqual({
      kind: 'play_state', state: '待机'
    });
  });

  test.each([
    { kind: 'set_mode', mode: 1 },
    { kind: 'set_mode', mode: 2 },
    { kind: 'move_once', target: 'random_work_area', distance: 'far' }
  ] as const)('运动控制 %o 参与公开候选排序并优先命中用户自定义移动动作', movementControl => {
    const catalog: PublicBehaviorCatalog = {
      identity: {
        name: '运动角色', description: '运动测试', background: '测试环境', traits: [],
        languageStyle: '简洁', likes: [], behavioralTendencies: []
      },
      states: [
        {
          name: '运动状态', stateId: 'move-state', tags: [], actions: [
            { name: '安静等待', actionId: 'wait', tags: ['still'] },
            { name: '巡游四方', actionId: 'wander', description: '移动', tags: ['locomotion'] }
          ]
        }
      ]
    };

    expect(selectPublicBehaviorTarget(
      catalog,
      '开始行动',
      '保持活跃',
      movementControl
    )).toEqual({ kind: 'play_state', state: '运动状态', action: '巡游四方' });
  });

  test.each([
    ['短中文无关词', '哈', '呀'],
    ['普通无关描述', '完全无关的内容', '未知状态']
  ])('%s 低于相似阈值时返回 none', (_name, activity, status) => {
    const catalog = createPublicBehaviorCatalog(createManifest(), 'default-skin');

    expect(selectPublicBehaviorTarget(catalog, activity, status)).toEqual({ kind: 'none' });
  });

  test('中文字符集合相似度在 0.6 边界命中而低于边界不命中', () => {
    const catalog: PublicBehaviorCatalog = {
      identity: {
        name: '阈值角色', description: '阈值测试', background: '测试环境', traits: [],
        languageStyle: '简洁', likes: [], behavioralTendencies: []
      },
      states: [{
        name: '甲乙丙丁戊', stateId: 'threshold', tags: [],
        actions: [{ name: '己庚辛', actionId: 'chars', tags: [] }]
      }]
    };

    expect(selectPublicBehaviorTarget(catalog, '甲丙戊', undefined)).toEqual({
      kind: 'play_state', state: '甲乙丙丁戊'
    });
    expect(selectPublicBehaviorTarget(catalog, '甲丙', undefined)).toEqual({ kind: 'none' });
  });

  test('无关英文单词不以字符集合重合越过 0.6 阈值', () => {
    const catalog: PublicBehaviorCatalog = {
      identity: {
        name: '英文阈值角色', description: '阈值测试', background: '测试环境', traits: [],
        languageStyle: '简洁', likes: [], behavioralTendencies: []
      },
      states: [{ name: 'idle', stateId: 'idle', tags: [], actions: [] }]
    };

    expect(selectPublicBehaviorTarget(catalog, 'inside', undefined)).toEqual({ kind: 'none' });
  });

  test('中英混合文本的字符集合重合只统计汉字', () => {
    const catalog: PublicBehaviorCatalog = {
      identity: {
        name: '混合阈值角色', description: '阈值测试', background: '测试环境', traits: [],
        languageStyle: '简洁', likes: [], behavioralTendencies: []
      },
      states: [{ name: '乙abc', stateId: 'mixed', tags: [], actions: [] }]
    };

    expect(selectPublicBehaviorTarget(catalog, '甲abc', undefined)).toEqual({ kind: 'none' });
  });

  test('精确层级计划只允许动作属于指定状态', () => {
    const manifest = createManifest();
    const catalog = createPublicBehaviorCatalog(manifest, 'default-skin');
    const valid = { kind: 'play_state', state: 'CHEER', action: '挥手' } as const;
    const crossState = { kind: 'play_state', state: '待机', action: '挥手' } as const;

    expect(isPublicBehaviorTarget(catalog, valid as never)).toBe(true);
    expect(resolveBehaviorTarget(manifest, 'default-skin', valid as never)).toEqual({
      kind: 'state_action', stateId: 'happy-state', actionId: 'wave-action'
    });
    expect(isPublicBehaviorTarget(catalog, crossState as never)).toBe(false);
    expect(() => resolveBehaviorTarget(manifest, 'default-skin', crossState as never))
      .toThrow('CHARACTER_ACTION_UNAVAILABLE');
  });

  test.each([
        ['动作描述', '向用户热情挥手'],
    ['动作标签', 'greet']
  ])('层级计划按%s在指定状态内选择最高相似动作', (_label, action) => {
    const manifest = createManifest();
    const catalog = createPublicBehaviorCatalog(manifest, 'default-skin');
    const plan = { kind: 'play_state', state: 'CHEER', action } as const;

    expect(isPublicBehaviorTarget(catalog, plan)).toBe(true);
    expect(resolveBehaviorTarget(manifest, 'default-skin', plan)).toEqual({
      kind: 'state_action', stateId: 'happy-state', actionId: 'wave-action'
    });
  });

  test('层级计划的无关动作文本低于阈值时失败关闭', () => {
    const manifest = createManifest();
    const catalog = createPublicBehaviorCatalog(manifest, 'default-skin');
    const plan = { kind: 'play_state', state: 'CHEER', action: '哈' } as const;

    expect(isPublicBehaviorTarget(catalog, plan)).toBe(false);
    expect(() => resolveBehaviorTarget(manifest, 'default-skin', plan))
      .toThrow('CHARACTER_ACTION_UNAVAILABLE');
  });

  test('精确状态计划解析为状态目标并把动作选择留给运行时', () => {
    expect(resolveBehaviorTarget(
      createManifest(),
      'default-skin',
      { kind: 'play_state', state: 'CHEER' } as never
    )).toEqual({ kind: 'state', stateId: 'happy-state' });
  });

  test.each([
    { kind: 'state_name', name: '隐藏状态' },
    { kind: 'action_name', name: '隐藏动作' },
    { kind: 'tag', tag: 'hidden' },
    { kind: 'action_name', name: '不存在' }
  ] as const)('未知、不可推断或无当前表现的目标 %o 返回稳定能力错误', target => {
    expect(() => resolveBehaviorTarget(createManifest(), 'default-skin', target))
      .toThrow('CHARACTER_ACTION_UNAVAILABLE');
  });

  test('同一动作归属多个状态时克隆前后都按公开重复项失败关闭', () => {
    const manifest = createManifest();
    manifest.states[0]!.actionIds.push('wave-action');
    const originalCatalog = createPublicBehaviorCatalog(manifest, 'default-skin');
    const catalog = structuredClone(createPublicBehaviorCatalog(manifest, 'default-skin'));

    expect(publicBehaviorCatalogSchema.safeParse(catalog).success).toBe(true);
    expect(isPublicBehaviorTarget(originalCatalog, { kind: 'action_name', name: '挥手' })).toBe(false);
    expect(isPublicBehaviorTarget(catalog, { kind: 'action_name', name: '挥手' })).toBe(false);
  });

  test('两个私有动作的全部公开字段相同时仍按两个公开项拒绝猜测', () => {
    const manifest = createManifest();
    expect(isPublicBehaviorTarget(
      createPublicBehaviorCatalog(manifest, 'default-skin'),
      { kind: 'action_name', name: '挥手' }
    )).toBe(true);

    manifest.actions[2]!.name = '挥手';
    manifest.actions[2]!.description = '向用户热情挥手';
    manifest.actions[2]!.tags = ['greet'];
    const catalog = createPublicBehaviorCatalog(manifest, 'default-skin');

    expect(isPublicBehaviorTarget(catalog, { kind: 'action_name', name: '挥手' })).toBe(false);
    expect(isPublicBehaviorTarget(catalog, { kind: 'tag', tag: 'greet' })).toBe(false);
  });

  test('同名或同标签映射到多个目标时拒绝猜测', () => {
    const manifest = createManifest();
    manifest.actions[2]!.name = '挥手';
    manifest.actions[2]!.tags = ['greet'];

    expect(() => resolveBehaviorTarget(
      manifest,
      'default-skin',
      { kind: 'action_name', name: '挥手' }
    )).toThrow('CHARACTER_ACTION_UNAVAILABLE');
    expect(() => resolveBehaviorTarget(
      manifest,
      'default-skin',
      { kind: 'tag', tag: 'greet' }
    )).toThrow('CHARACTER_ACTION_UNAVAILABLE');

    const catalog = createPublicBehaviorCatalog(manifest, 'default-skin');
    expect(isPublicBehaviorTarget(catalog, { kind: 'action_name', name: '挥手' })).toBe(false);
    expect(isPublicBehaviorTarget(catalog, { kind: 'tag', tag: 'greet' })).toBe(false);
  });
});
