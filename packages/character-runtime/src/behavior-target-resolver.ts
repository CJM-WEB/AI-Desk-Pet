import type { BehaviorTarget, CharacterBehaviorPlan, PublicBehaviorCatalog, PublicBehaviorState, PublicCharacterIdentity } from './character-behavior-plan';
import type { CharacterStandardSemantic } from './behavior-contracts';
import type { CharacterManifestV3 } from './character-v3-schema';
import { resolveCharacterPresentationV3 } from './character-playback-view';

export type ResolvedBehaviorTarget =
  | Readonly<{ kind: 'semantic'; semantic: CharacterStandardSemantic }>
  | Readonly<{ kind: 'state'; stateId: string }>
  | Readonly<{ kind: 'action'; actionId: string }>
  | Readonly<{ kind: 'state_action'; stateId: string; actionId: string }>;

export type CharacterExpressionTarget =
  | Readonly<{ kind: 'state'; stateId: string }>
  | Readonly<{ kind: 'state_action'; stateId: string; actionId: string }>;

export type CharacterBehaviorAuthorization =
  | Readonly<{
      kind: 'play';
      actionId: string;
      playbackToken: string;
      semantic: CharacterStandardSemantic;
    }>
  | Readonly<{
      kind: 'none';
      diagnosticCode?: 'CHARACTER_ACTION_UNAVAILABLE';
    }>;


/** 完整目录只含作者公开文字及当前皮肤的合法 ID 对，预算留到每次请求。 */
export function createPublicBehaviorCatalog(manifest: CharacterManifestV3, skinId: string): PublicBehaviorCatalog {
  return {
    idleStateId: manifest.idleStateId,
    identity: { name: manifest.name, ...structuredClone(manifest.identity) },
    states: manifest.states.flatMap(state => {
      const actions = state.actionIds.flatMap(actionId => {
        if (!resolveCharacterPresentationV3(manifest, skinId, state.id, actionId)) return [];
        const action = manifest.actions.find(candidate => candidate.id === actionId)!;
        return [{ actionId, name: action.name, ...(action.description === undefined ? {} : { description: action.description }), tags: [...action.tags] }];
      });
      return actions.length ? [{ stateId: state.id, name: state.name, agentInferable: state.agentInferable,
        ...(state.description === undefined ? {} : { description: state.description }), tags: [...state.tags], actions }] : [];
    })
  };
}
function normalized(value: string): string { return value.normalize('NFKC').trim().toLowerCase(); }
function scoreText(query: string, text: string): number {
  query = normalized(query); text = normalized(text);
  if (!query || !text) return 0;
  if (query.includes(text) || text.includes(query)) return 1;
  const terms = (value: string) => new Set(value.match(/[\p{Script=Han}]|[a-z0-9_-]+/gu) ?? []);
  const wanted = terms(query); const actual = terms(text);
  return [...wanted].filter(term => actual.has(term)).length / Math.max(1, wanted.size);
}
function mentionWeight(text: string, candidate: { name: string }, id: string): number {
  const query = normalized(text);
  const name = normalized(candidate.name);
  const normalizedId = normalized(id);
  return Math.max(
    query.includes(name) ? Array.from(name).length : 0,
    query.split(/[^\p{L}\p{N}_-]+/u).includes(normalizedId) ? Array.from(normalizedId).length : 0
  );
}
export type BehaviorCandidateContext = {
  text: string; sequence: number; currentStateId?: string | null | undefined; mood?: string | undefined;
  backgroundStateId?: string | null | undefined;
  recentActions?: readonly string[] | undefined; explicitPlaybackRequested?: boolean | undefined;
};
/** 描述仅排序候选；预留轮换位置，使大包末尾与同状态末尾动作都可被看见。 */
export function selectBehaviorCandidates(catalog: PublicBehaviorCatalog, context: BehaviorCandidateContext): PublicBehaviorCatalog {
  // 描述可能被多个状态共享；每次请求只算一次相关性，避免排序反复扫描长文本。
  const relevance = new Map<string, number>();
  const mentions = new Map<string, number>();
  const isMentioned = (entry: { name: string }, id: string) => {
    const key = `${entry.name}\0${id}`;
    if (!mentions.has(key)) mentions.set(key, mentionWeight(context.text, entry, id));
    return mentions.get(key)!;
  };
  const similarity = (text: string, mood = false) => {
    const key = `${mood ? 'm:' : 't:'}${text}`;
    if (!relevance.has(key)) relevance.set(key, scoreText(mood ? context.mood ?? '' : context.text, text));
    return relevance.get(key)!;
  };
  const score = (entry: { name: string; description?: string | undefined; tags: readonly string[] }) =>
    Math.max(...[entry.name, entry.description ?? '', ...entry.tags].map(text => similarity(text)))
    + .2 * similarity(entry.description ?? entry.name, true);
  const states = catalog.states.filter(state => state.agentInferable || context.explicitPlaybackRequested
    || state.stateId === catalog.idleStateId || state.stateId === context.currentStateId
    || state.stateId === context.backgroundStateId);
  const rank = (state: PublicBehaviorState) =>
    Math.max(isMentioned(state, state.stateId), ...state.actions.map(action => isMentioned(action, action.actionId))) * 10
    + Math.max(score(state), ...state.actions.map(score));
  const ranked = [...states].sort((a, b) => rank(b) - rank(a));
  const explorationReserved = ranked.length > 24;
  const selected = ranked.slice(0, explorationReserved ? 23 : 24);
  if (explorationReserved) {
    const protectedIds = new Set([catalog.idleStateId, context.currentStateId, context.backgroundStateId]);
    for (const state of ranked.filter(state => protectedIds.has(state.stateId))) {
      if (selected.includes(state)) continue;
      let replaceIndex = selected.length - 1;
      while (replaceIndex >= 0 && protectedIds.has(selected[replaceIndex]!.stateId)) replaceIndex--;
      if (replaceIndex >= 0) selected.splice(replaceIndex, 1, state);
    }
    selected.sort((a, b) => rank(b) - rank(a));
    const exploration = ranked.filter(state => !selected.includes(state));
    selected.push(exploration[Math.abs(context.sequence) % exploration.length]!);
  }
  const ordered = selected.map(state => {
    const actions = [...state.actions].sort((a, b) =>
      (isMentioned(b, b.actionId) * 10 + score(b) - Number(context.recentActions?.includes(b.name) === true) * .05)
      - (isMentioned(a, a.actionId) * 10 + score(a) - Number(context.recentActions?.includes(a.name) === true) * .05));
    // 每状态第二个位置用于探索，后续仍按相关性；不会让首个共享动作吞尽目录。
    if (actions.length > 1) {
      const index = 1 + Math.abs(context.sequence) % (actions.length - 1);
      const [explore] = actions.splice(index, 1); actions.splice(1, 0, explore!);
    }
    return { source: state, actions, selected: actions.slice(0, 1) };
  });
  let remaining = 32 - ordered.length;
  for (let depth = 1; remaining > 0; depth++) {
    let added = false;
    for (const item of ordered) {
      if (remaining && item.actions[depth]) { item.selected.push(item.actions[depth]!); remaining--; added = true; }
    }
    if (!added) break;
  }
  return { ...catalog, states: ordered.map(item => ({ ...item.source, actions: item.selected })) };
}
/** 只保留完整 Unicode 字符，调用方按整个请求预算调整字段额度。 */
export function boundCharacterText(text: string, limit: number): string {
  const characters = Array.from(text); return characters.length <= limit ? text : characters.slice(0, limit).join('') + '…';
}
export function projectCharacterIdentity(identity: PublicCharacterIdentity, limit: number): PublicCharacterIdentity {
  return Object.fromEntries(Object.entries(identity).map(([key, value]) => [
    key, Array.isArray(value) ? value.map(text => boundCharacterText(text, limit)) : boundCharacterText(value, limit)
  ])) as PublicCharacterIdentity;
}
/** 明确目标只接受唯一名称或 ID；描述理解留给模型，不做相似度补偿。 */
export function resolveBehaviorTarget(
  manifest: CharacterManifestV3, skinId: string,
  target: BehaviorTarget | Extract<CharacterBehaviorPlan, { kind: 'play_state' }>
): CharacterExpressionTarget {
  const catalog = createPublicBehaviorCatalog(manifest, skinId);
  const equal = (value: string, name: string, id: string) => normalized(value) === normalized(name) || normalized(value) === normalized(id);
  let targets: CharacterExpressionTarget[];
  if (target.kind === 'play_state') {
    const states = catalog.states.filter(state => equal(target.state, state.name, state.stateId));
    targets = states.flatMap<CharacterExpressionTarget>(state => target.action === undefined
      ? [{ kind: 'state' as const, stateId: state.stateId }]
      : state.actions.filter(action => equal(target.action!, action.name, action.actionId))
        .map(action => ({ kind: 'state_action' as const, stateId: state.stateId, actionId: action.actionId })));
  } else if (target.kind === 'state_name') {
    targets = catalog.states.filter(state => equal(target.name, state.name, state.stateId))
      .map(state => ({ kind: 'state' as const, stateId: state.stateId }));
  } else {
    targets = catalog.states.flatMap(state => [
      ...(target.kind === 'tag' && state.tags.includes(target.tag) ? [{ kind: 'state' as const, stateId: state.stateId }] : []),
      ...state.actions.filter(action => target.kind === 'tag' ? action.tags.includes(target.tag) : equal(target.name, action.name, action.actionId))
        .map(action => ({ kind: 'state_action' as const, stateId: state.stateId, actionId: action.actionId }))
    ]);
  }
  if (targets.length !== 1) throw new Error('CHARACTER_ACTION_UNAVAILABLE');
  return targets[0]!;
}
