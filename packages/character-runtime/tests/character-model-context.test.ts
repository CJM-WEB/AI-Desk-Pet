import { expect, it } from 'vitest';
import * as runtime from '../src';
import { resourceFields, v3Fixture } from './character-v3-fixture';

it('完整作者目录保留末尾描述和全部人设，模型候选按本轮描述召回并轮换探索', () => {
  const draft = v3Fixture();
  draft.identity.formsOfAddress = ['朋友']; draft.identity.dislikes = ['噪声'];
  for (let i = 0; i < 40; i++) {
    const actionId = `a${i}`;
    draft.states.push({ ...draft.states[0]!, id: `s${i}`, name: `姿态${i}`, agentInferable: true,
      description: i === 39 ? '闻到花香愉快地伸展' : '日常安静等候', actionIds: [actionId] });
    draft.actions.push({ ...draft.actions[0]!, id: actionId });
    draft.skins[0]!.presentations.push({ ...draft.skins[0]!.presentations[0]!, actionId });
  }
  const catalog = runtime.createPublicBehaviorCatalog(runtime.characterManifestV3Schema.parse({ ...draft, ...resourceFields }), 'base');
  expect(catalog.states).toHaveLength(41);
  expect(catalog.identity).toMatchObject({ formsOfAddress: ['朋友'], dislikes: ['噪声'] });
  const first = runtime.selectBehaviorCandidates(catalog, { text: '闻到花香愉快地伸展', sequence: 0 });
  const next = runtime.selectBehaviorCandidates(catalog, { text: '闻到花香愉快地伸展', sequence: 1 });
  expect(first.states.some(state => state.stateId === 's39')).toBe(true);
  expect(first.states.length).toBeLessThanOrEqual(24);
  expect(first.states.reduce((sum, state) => sum + state.actions.length, 0)).toBeLessThanOrEqual(32);
  expect(next.states.map(state => state.stateId)).not.toEqual(first.states.map(state => state.stateId));
});
