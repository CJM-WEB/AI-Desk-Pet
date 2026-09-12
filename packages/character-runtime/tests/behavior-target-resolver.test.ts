import { expect, test } from 'vitest';
import { createPublicBehaviorCatalog, characterManifestV3Schema, publicBehaviorCatalogSchema, resolveBehaviorTarget, selectBehaviorCandidates } from '../src';
import { resourceFields, v3Fixture } from './character-v3-fixture';

/** 精确目标与公开候选共用真实 V3 归属和皮肤解析。 */
function fixture() {
  const draft = v3Fixture();
  draft.states.push({ ...draft.states[0]!, id: 'joy', name: 'ＣＨＥＥＲ', agentInferable: true, actionIds: ['wave'] });
  draft.actions.push({ ...draft.actions[0]!, id: 'wave', name: '挥手', description: '热情向用户问好', tags: ['greet'] });
  draft.skins[0]!.presentations.push({ ...draft.skins[0]!.presentations[0]!, actionId: 'wave' });
  return characterManifestV3Schema.parse({ ...draft, ...resourceFields });
}
test('公开目录保留全部作者字段与ID，不含资源或私有文件信息', () => {
  const catalog = createPublicBehaviorCatalog(fixture(), 'base');
  expect(publicBehaviorCatalogSchema.safeParse(catalog).success).toBe(true);
  expect(catalog).toMatchObject({ idleStateId: 'rest', states: [{ stateId: 'rest', agentInferable: false }, { stateId: 'joy' }] });
  expect(JSON.stringify(catalog)).not.toMatch(/fileName|resourceRevision|sha256/);
});
test('NFKC名称或稳定ID精确命中，明确指定允许非inferable状态', () => {
  const manifest = fixture();
  expect(resolveBehaviorTarget(manifest, 'base', { kind: 'state_name', name: 'cheer' })).toEqual({ kind: 'state', stateId: 'joy' });
  expect(resolveBehaviorTarget(manifest, 'base', { kind: 'state_name', name: 'rest' })).toEqual({ kind: 'state', stateId: 'rest' });
  expect(resolveBehaviorTarget(manifest, 'base', { kind: 'action_name', name: 'wave' })).toEqual({ kind: 'state_action', stateId: 'joy', actionId: 'wave' });
  const catalog = createPublicBehaviorCatalog(manifest, 'base');
  expect(selectBehaviorCandidates(catalog, { text: 'joy', sequence: 0 }).states[0]?.stateId).toBe('joy');
});
test('描述不能冒充精确命中，跨状态动作和未知目标失败关闭', () => {
  const manifest = fixture();
  for (const target of [{ kind: 'action_name', name: '热情问好' }, { kind: 'play_state', state: 'joy', action: 'breathe' }, { kind: 'state_name', name: 'unknown' }] as const) {
    expect(() => resolveBehaviorTarget(manifest, 'base', target)).toThrow('CHARACTER_ACTION_UNAVAILABLE');
  }
});
test('共享动作和重名公开目标仍保留父状态，不选择模糊动作', () => {
  const manifest = fixture(); manifest.states[0]!.actionIds.push('wave');
  expect(() => resolveBehaviorTarget(manifest, 'base', { kind: 'action_name', name: '挥手' })).toThrow('CHARACTER_ACTION_UNAVAILABLE');
  expect(resolveBehaviorTarget(manifest, 'base', { kind: 'play_state', state: 'joy', action: '挥手' })).toEqual({ kind: 'state_action', stateId: 'joy', actionId: 'wave' });
});
test('无意义名称由作者描述区分状态与动作候选', () => {
  const manifest = fixture();
  manifest.states.find(state => state.id === 'joy')!.actionIds.unshift('breathe');
  const catalog = createPublicBehaviorCatalog(manifest, 'base');
  const states = catalog.states.map((state, index) => ({
    ...state,
    name: `状态${index + 1}`,
    description: state.stateId === 'joy' ? '用户问好时短暂表达热情。' : '安静长期陪伴。',
    actions: state.actions.map((action, actionIndex) => ({
      ...action,
      name: `动作${actionIndex + 1}`,
      description: action.actionId === 'wave' ? '抬手向用户打招呼。' : '保持轻柔呼吸。'
    }))
  }));

  const selected = selectBehaviorCandidates(
    { ...catalog, states },
    { text: '抬手向用户打招呼', sequence: 0 }
  );

  expect(selected.states[0]?.stateId).toBe('joy');
  expect(selected.states.find(state => state.stateId === 'joy')).toMatchObject({
    stateId: 'joy',
    description: '用户问好时短暂表达热情。',
    actions: expect.arrayContaining([
      expect.objectContaining({ actionId: 'wave', description: '抬手向用户打招呼。' })
    ])
  });
  expect(selected.states.find(state => state.stateId === 'joy')?.actions[0]?.actionId).toBe('wave');
});
