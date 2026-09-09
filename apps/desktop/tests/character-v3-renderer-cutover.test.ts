import { expect, test, vi } from 'vitest';
import { characterDraftV3Schema, migrateCharacterDraftToV3 } from '@myself/character-runtime';
import { createCharacterWorkshopStore, type CharacterWorkshopApi } from '../src/renderer/src/characters/store/character-workshop-store';

function setup() {
  const draft = migrateCharacterDraftToV3({ version: 1, id: 'demo', name: '角色', states: [] }).document;
  draft.states[0]!.id = 'quiet-afternoon';
  draft.idleStateId = 'quiet-afternoon';
  const review = { issues: [{ issueId: 'legacy-rule', code: 'modifier-state', objectId: 'quiet-afternoon', message: '请审阅旧规则', originalRule: { kind: 'modifier' } }], resolutions: [] };
  const api = {
    listCharacters: vi.fn(async () => [{ id: 'demo', active: true }]),
    getCharacterDraft: vi.fn(async () => structuredClone(draft)),
    listCharacterSources: vi.fn(async () => []),
    getCharacterMigrationReview: vi.fn(async () => structuredClone(review)),
    saveCharacterDraft: vi.fn(async () => undefined),
    publishCharacter: vi.fn(async () => undefined)
  } as unknown as CharacterWorkshopApi;
  return { api, store: createCharacterWorkshopStore(api) };
}

test('V3 工作台新增自定义状态保留真实 ID 且不写旧语义字段', async () => {
  const { store } = setup();
  await store.getState().load();
  expect(store.getState().selectedStateId).toBe('quiet-afternoon');
  store.getState().addState({ name: '晚风', description: '静静陪伴' });
  const current = store.getState().draft!;
  expect(current.states.at(-1)).toMatchObject({ name: '晚风', description: '静静陪伴' });
  expect(characterDraftV3Schema.safeParse(current).success).toBe(true);
  expect(store.getState().requestRemoveState('quiet-afternoon').blockingReferencePaths).toEqual(['idleStateId']);
  store.getState().dispose();
});

test('V3 迁移审阅阻止未处置发布并逐项提交', async () => {
  const { store, api } = setup();
  await store.getState().load();
  expect(store.getState().migrationReview.issues).toHaveLength(1);
  await store.getState().compileAndPublish();
  expect(api.publishCharacter).not.toHaveBeenCalled();
  store.getState().resolveMigrationIssue('legacy-rule', 'discarded');
  await store.getState().flushDraft();
  expect(api.saveCharacterDraft).toHaveBeenLastCalledWith('demo', expect.any(Object), expect.any(String), [{ issueId: 'legacy-rule', decision: 'discarded' }]);
  store.getState().dispose();
});
