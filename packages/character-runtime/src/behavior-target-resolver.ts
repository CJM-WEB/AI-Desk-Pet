import type {
  BehaviorTarget,
  MovementControlPlan,
  PublicBehaviorCatalog
} from './character-behavior-plan';
import type { CharacterStandardSemantic } from './behavior-contracts';
import {
  STANDARD_CHARACTER_SEMANTICS,
  type CharacterManifestV2
} from './character-v2-schema';

export type ResolvedBehaviorTarget =
  | Readonly<{ kind: 'semantic'; semantic: CharacterStandardSemantic }>
  | Readonly<{ kind: 'state'; stateId: string }>
  | Readonly<{ kind: 'action'; actionId: string }>;

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

const ACTION_UNAVAILABLE = 'CHARACTER_ACTION_UNAVAILABLE';

/** 公开名称匹配统一使用 NFKC 和大小写折叠，不把私有标识符作为候选。 */
function normalizePublicValue(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase();
}

/** 公开描述只用名称、语义和标签排序；目录非空时稳定选取最高分候选。 */
function similarity(query: string, candidate: string): number {
  if (!query || !candidate) return 0;
  if (query === candidate) return 1;
  if (query.includes(candidate) || candidate.includes(query)) return 0.8;
  const queryCharacters = new Set(query);
  const candidateCharacters = new Set(candidate);
  const shared = [...queryCharacters].filter(value => candidateCharacters.has(value)).length;
  return shared / Math.max(queryCharacters.size, candidateCharacters.size);
}

function playableActionIds(manifest: CharacterManifestV2, skinId: string): Set<string> {
  const skin = manifest.skins.find(candidate => candidate.id === skinId);
  return new Set(skin?.presentations.flatMap(presentation => (
    presentation.frames.length > 0 ? [presentation.actionId] : []
  )) ?? []);
}

function uniqueValues(values: readonly string[]): string[] {
  const normalized = new Set<string>();
  return values.filter(value => {
    const key = normalizePublicValue(value);
    if (normalized.has(key)) return false;
    normalized.add(key);
    return true;
  });
}

/** 自定义状态语义以公开值输出，避免向模型暴露内部判别结构。 */
function publicSemantic(semantic: CharacterManifestV2['states'][number]['semantic']): string {
  return typeof semantic === 'string' ? semantic : semantic.value;
}

/** 生成仅含可播放公开能力的模型清单，绝不包含 stateId 或 actionId。 */
export function createPublicBehaviorCatalog(
  manifest: CharacterManifestV2,
  skinId: string
): PublicBehaviorCatalog {
  const playable = playableActionIds(manifest, skinId);
  const actions = manifest.actions.filter(action => playable.has(action.id));
  const states = manifest.states.filter(state => (
    state.agentInferable && state.actionIds.some(actionId => playable.has(actionId))
  ));
  const semantics = STANDARD_CHARACTER_SEMANTICS.filter(semantic => (
    actions.some(action => action.semantic === semantic)
  ));

  return {
    characterName: manifest.name,
    semantics,
    stateNames: uniqueValues(states.map(state => state.name)),
    actionNames: uniqueValues(actions.map(action => action.name)),
    tags: uniqueValues([
      ...states.flatMap(state => state.tags),
      ...actions.flatMap(action => action.tags)
    ]),
    candidates: [
      ...states.map(state => ({
        kind: 'state_name' as const,
        name: state.name,
        semantic: publicSemantic(state.semantic),
        tags: [...state.tags]
      })),
      ...actions.map(action => ({
        kind: 'action_name' as const,
        name: action.name,
        semantic: action.semantic,
        tags: [...action.tags]
      }))
    ]
  };
}

/**
 * 模型隐藏 activity/status 只能命中当前角色、当前皮肤的公开候选。
 * 目录顺序负责稳定平局；选中后仍须经私有清单精确验证。
 */
export function selectPublicBehaviorTarget(
  catalog: PublicBehaviorCatalog,
  activity: string | undefined,
  status: string | undefined,
  movementControl?: MovementControlPlan | null
): BehaviorTarget {
  const motionDescriptors = movementControl?.kind === 'set_mode' && movementControl.mode === 0
    ? ['idle', '静止', '待机']
    : movementControl?.kind === 'set_mode' && movementControl.mode > 0
      ? ['move', 'run', 'walk', '移动', '运动', '跑步', '走动']
      : movementControl?.kind === 'move_once'
        ? [
            'move', 'run', 'walk', '移动', '运动', '跑步', '走动',
            movementControl.target, movementControl.distance
          ]
      : [];
  const queries = [activity, status, ...motionDescriptors]
    .filter((value): value is string => typeof value === 'string')
    .map(normalizePublicValue);
  if (queries.length === 0 || !catalog.candidates?.length) {
    return { kind: 'semantic', semantic: 'idle' };
  }
  const motionQueries = motionDescriptors.map(normalizePublicValue);
  const descriptionQueries = [activity, status]
    .filter((value): value is string => typeof value === 'string')
    .map(normalizePublicValue);
  type PublicCandidate = NonNullable<PublicBehaviorCatalog['candidates']>[number];
  const scoreCandidate = (candidate: PublicCandidate, inputs: string[]) => (
    inputs.length === 0 ? 0 : Math.max(
      ...inputs.flatMap(query => [
        similarity(query, normalizePublicValue(candidate.name)),
        similarity(query, normalizePublicValue(candidate.semantic)),
        ...candidate.tags.map(tag => similarity(query, normalizePublicValue(tag)))
      ])
    )
  );
  const scored = catalog.candidates.map(candidate => ({
    candidate,
    // 明确运动计划优先限定身体状态，activity/status 再负责同类候选间的细分。
    score: scoreCandidate(candidate, motionQueries) * 2
      + scoreCandidate(candidate, descriptionQueries)
  })).sort((left, right) => right.score - left.score);
  const best = scored[0];
  if (!best) {
    return { kind: 'semantic', semantic: 'idle' };
  }
  return best.candidate.kind === 'state_name'
    ? { kind: 'state_name', name: best.candidate.name }
    : { kind: 'action_name', name: best.candidate.name };
}

/** Main 只接受当前公开目录中已有的模型目标，目录外名称不能进入私有解析器。 */
export function isPublicBehaviorTarget(
  catalog: PublicBehaviorCatalog,
  target: BehaviorTarget
): boolean {
  if (target.kind === 'semantic') return catalog.semantics.includes(target.semantic);
  if (target.kind === 'tag') {
    const normalizedTag = normalizePublicValue(target.tag);
    if (!catalog.candidates) {
      return catalog.tags.some(tag => normalizePublicValue(tag) === normalizedTag);
    }
    // 标签可能被用户同时分配给多个动作；只有唯一命中才可作为精确 Provider 计划。
    return catalog.candidates.filter(candidate => (
      candidate.tags.some(tag => normalizePublicValue(tag) === normalizedTag)
    )).length === 1;
  }
  return (catalog.candidates?.filter(candidate => (
    candidate.kind === target.kind && normalizePublicValue(candidate.name) === normalizePublicValue(target.name)
  )).length ?? 0) === 1;
}

/** 解析唯一公开目标；未知、歧义和当前皮肤不可播放统一返回稳定能力错误。 */
export function resolveBehaviorTarget(
  manifest: CharacterManifestV2,
  skinId: string,
  target: BehaviorTarget
): ResolvedBehaviorTarget {
  const playable = playableActionIds(manifest, skinId);
  const actions = manifest.actions.filter(action => playable.has(action.id));
  const states = manifest.states.filter(state => (
    state.agentInferable && state.actionIds.some(actionId => playable.has(actionId))
  ));

  if (target.kind === 'semantic') {
    if (!actions.some(action => action.semantic === target.semantic)) {
      throw new Error(ACTION_UNAVAILABLE);
    }
    return { kind: 'semantic', semantic: target.semantic };
  }

  const normalizedTarget = normalizePublicValue(
    target.kind === 'tag' ? target.tag : target.name
  );
  const candidates: Array<Exclude<ResolvedBehaviorTarget, { kind: 'semantic' }>> = target.kind === 'state_name'
    ? states.flatMap(state => (
      normalizePublicValue(state.name) === normalizedTarget
        ? [{ kind: 'state' as const, stateId: state.id }]
        : []
    ))
    : target.kind === 'action_name'
      ? actions.flatMap(action => (
        normalizePublicValue(action.name) === normalizedTarget
          ? [{ kind: 'action' as const, actionId: action.id }]
          : []
      ))
      : [
          ...states.flatMap(state => (
            state.tags.some(tag => normalizePublicValue(tag) === normalizedTarget)
              ? [{ kind: 'state' as const, stateId: state.id }]
              : []
          )),
          ...actions.flatMap(action => (
            action.tags.some(tag => normalizePublicValue(tag) === normalizedTarget)
              ? [{ kind: 'action' as const, actionId: action.id }]
              : []
          ))
        ];

  const uniqueCandidates = new Map(candidates.map(candidate => [
    candidate.kind === 'state' ? `state:${candidate.stateId}` : `action:${candidate.actionId}`,
    candidate
  ]));
  if (uniqueCandidates.size !== 1) throw new Error(ACTION_UNAVAILABLE);
  return [...uniqueCandidates.values()][0]!;
}
