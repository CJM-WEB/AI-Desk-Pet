import { expect, test } from 'vitest';
import * as runtime from '../src';
import { resourceFields, v2Fixture, v3Fixture } from './character-v3-fixture';

test('V2 多皮肤语义资源展开为原逻辑动作，并保留描述锚点及原输入', () => {
  expect(runtime).toHaveProperty('migrateCharacterDraftToV3');
  const source = v2Fixture();
  source.actions.push({ ...source.actions[0]!, id: 'other' });
  source.skins[0]!.presentations.push({ ...structuredClone(source.skins[0]!.presentations[0]!), actionId: 'other' });
  source.skins.push({ ...structuredClone(source.skins[0]!), id: 'night',
    presentations: [{ ...structuredClone(source.skins[0]!.presentations[0]!), actionId: 'other' }],
    semanticFallbacks: [{ semantic: 'idle', actionId: 'other' }] });
  const before = structuredClone(source);
  const result = runtime.migrateCharacterDraftToV3(source);
  expect(result.issues).toEqual([]);
  expect(result.sourceVersion).toBe(2);
  expect(result.document.idleStateId).toBe('rest');
  expect(result.document.states[0]!.actionIds).toEqual(['breathe']);
  expect(result.document.skins[1]!.presentations.find(p => p.actionId === 'breathe'))
    .toEqual({ ...source.skins[1]!.presentations[0], actionId: 'breathe' });
  expect(result.document.identity).toEqual(before.identity);
  expect(result.document.states[0]!.description).toBe('保留状态描述');
  expect(result.document.actions[0]!.description).toBe('保留动作描述');
  expect(source).toEqual(before);
});

test('V1 沿旧转换器保留资源，遗漏的作者触发规则进入报告', () => {
  const source = {
    version: 1, id: 'pet', name: '伙伴', ...resourceFields,
    states: [
      { id: 'idle', kind: 'core', actions: [{ id: 'breathe', name: '呼吸', fps: 12, loop: true, weight: 1,
        anchors: { ground: { x: 0.5, y: 1 } }, frames: [{ assetId: 'atlas', x: 0, y: 0, width: 32, height: 32 }] }] },
      { id: 'custom:rain', kind: 'extension', triggers: { events: [], keywords: ['下雨'], emotions: ['calm'] },
        actions: [{ id: 'rain', name: '雨天', fps: 12, loop: true, weight: 1,
          anchors: { ground: { x: 0.5, y: 1 } }, frames: [{ assetId: 'atlas', x: 0, y: 0, width: 32, height: 32 }] }] }
    ]
  };
  const before = structuredClone(source);
  const result = runtime.migrateCharacterManifestToV3(source);
  expect(result.sourceVersion).toBe(1);
  expect(result.document.resources).toEqual(resourceFields.resources);
  expect(result.document.states.map(state => state.id)).toEqual(['idle', 'custom-rain']);
  expect(result.issues).toContainEqual(expect.objectContaining({ code: 'v1-trigger', objectId: 'custom:rain' }));
  expect(source).toEqual(before);
  expect(runtime.preparedCharacterManifestV3Schema.safeParse(result.document).success).toBe(true);
  expect(runtime.characterManifestV3Schema.safeParse(result.document).success).toBe(false);
});

test('复杂旧规则逐项报告，idle 多义保持未选定且不丢清单资源', () => {
  expect(runtime).toHaveProperty('migrateCharacterManifestToV3');
  const source = v2Fixture();
  source.states.push({ ...source.states[0]!, id: 'mood', kind: 'modifier', coexistWithStateIds: ['rest'],
    enterConditions: [{ mode: 'all', clauses: [{ kind: 'state', stateId: 'rest' }, { kind: 'semantic', semantic: 'idle' }] }] });
  source.actions[0]!.requiredModifierStateIds = ['mood'];
  const result = runtime.migrateCharacterManifestToV3({ ...source, ...resourceFields });
  expect(result.document.idleStateId).toBeNull();
  expect(result.document.resources).toEqual(resourceFields.resources);
  expect(result.issues.map(issue => issue.code)).toEqual(expect.arrayContaining([
    'idle-ambiguous', 'modifier-state', 'state-combination', 'unsupported-condition', 'action-constraint'
  ]));
  expect(result.issues.every(issue => issue.objectId && issue.message && issue.originalRule)).toBe(true);
  expect(runtime.characterManifestV3Schema.safeParse(result.document).success).toBe(false);
});

test('精确单状态允许禁止规则只收缩归属，严格 V3 解析且非法输入拒绝', () => {
  expect(runtime).toHaveProperty('migrateCharacterDraftToV3');
  const source = v2Fixture();
  source.states.push({ ...source.states[0]!, id: 'dance', semantic: 'celebrate' });
  const migrated = runtime.migrateCharacterDraftToV3(source);
  expect(migrated.document.states[1]!.actionIds).toEqual([]);
  expect(migrated.issues).toEqual([]);
  const v3 = v3Fixture();
  expect(runtime.migrateCharacterDraftToV3(v3)).toEqual({ document: v3, issues: [], sourceVersion: 3 });
  expect(() => runtime.migrateCharacterDraftToV3({ ...v3, version: 4 })).toThrow();
  expect(() => runtime.migrateCharacterDraftToV3({ ...v3, semantic: 'idle' })).toThrow();
});

test('旧资源解析必须切逻辑动作时报告问题，不把其他动作并入状态', () => {
  expect(runtime).toHaveProperty('migrateCharacterDraftToV3');
  const source = v2Fixture();
  source.actions.push({ ...source.actions[0]!, id: 'wave', semantic: 'speak' });
  source.states.push({ ...source.states[0]!, id: 'talk', semantic: 'speak', actionIds: ['wave'] });
  const result = runtime.migrateCharacterDraftToV3(source);
  expect(result.document.states[1]!.actionIds).toEqual([]);
  expect(result.issues.some(issue => issue.code === 'presentation-fallback' && issue.objectId === 'wave')).toBe(true);
});

test('V1 空草稿不能将旧转换器补出的 idle 误当作者明确指定', () => {
  const result = runtime.migrateCharacterDraftToV3({ version: 1, id: 'empty', name: '空草稿', states: [] });
  expect(result.document.idleStateId).toBeNull();
  expect(result.issues).toContainEqual(expect.objectContaining({ code: 'idle-missing', objectId: 'empty' }));
});

test.each(['single_click', 'double_click', 'context_menu'] as const)('V1 %s 的原事件范围不能被通用交互静默放宽', event => {
  const action = { id: 'breathe', name: '呼吸', fps: 12, loop: true, weight: 1,
    anchors: { ground: { x: 0.5, y: 1 } }, frames: [{ assetId: 'atlas', x: 0, y: 0, width: 32, height: 32 }] };
  const source = { version: 1, id: 'pet', name: '伙伴', states: [
    { id: 'idle', kind: 'core', actions: [action] },
    { id: 'custom:greet', kind: 'extension', actions: [{ ...action, id: 'greet' }],
      triggers: { events: [event], keywords: [], emotions: [] } }
  ] };
  const before = structuredClone(source);
  const result = runtime.migrateCharacterDraftToV3(source);
  const issue = result.issues.find(item => item.code === 'v1-trigger' && item.objectId === 'custom:greet');
  expect(issue).toBeDefined();
  expect(JSON.parse(issue!.originalRule)).toEqual({ events: [event], keywords: [], emotions: [] });
  expect(source).toEqual(before);
});
