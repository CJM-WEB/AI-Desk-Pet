import type {
  BehaviorTarget,
  MovementControlPlan,
  PublicBehaviorAction,
  PublicBehaviorCatalog
} from './character-behavior-plan';
import type { CharacterStandardSemantic } from './behavior-contracts';
import {
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

/** 自定义状态语义以公开值输出，避免向模型暴露内部判别结构。 */
function publicSemantic(semantic: CharacterManifestV2['states'][number]['semantic']): string {
  return typeof semantic === 'string' ? semantic : semantic.value;
}

/** 生成仅含有界人设与可播放层级的模型清单，绝不包含私有标识或素材数据。 */
export function createPublicBehaviorCatalog(
  manifest: CharacterManifestV2,
  skinId: string
): PublicBehaviorCatalog {
  const playable = playableActionIds(manifest, skinId);
  const publicActionsById = new Map(manifest.actions.flatMap(action => (
    playable.has(action.id)
      ? [[action.id, {
          name: action.name,
          semantic: action.semantic,
          ...(action.description === undefined ? {} : { description: action.description }),
          tags: [...action.tags]
        } satisfies PublicBehaviorAction] as const]
      : []
  )));
  const states = manifest.states.filter(state => (
    state.agentInferable && state.actionIds.some(actionId => playable.has(actionId))
  ));

  return {
    identity: {
      name: manifest.name,
      description: manifest.identity.description,
      background: manifest.identity.background,
      traits: [...manifest.identity.traits],
      languageStyle: manifest.identity.languageStyle,
      likes: [...manifest.identity.likes],
      behavioralTendencies: [...manifest.identity.behavioralTendencies]
    },
    states: states.map(state => ({
      name: state.name,
      semantic: publicSemantic(state.semantic),
      ...(state.description === undefined ? {} : { description: state.description }),
      tags: [...state.tags],
      actions: state.actionIds.flatMap(actionId => {
        const publicAction = publicActionsById.get(actionId);
        return publicAction ? [publicAction] : [];
      })
    }))
  };
}

type PublicCatalogCandidate = Readonly<{
  kind: 'state_name' | 'action_name';
  name: string;
  semantic: string;
  description?: string;
  tags: readonly string[];
  publicKey: string;
}>;

function publicCandidateKey(candidate: Omit<PublicCatalogCandidate, 'publicKey'>): string {
  return JSON.stringify([
    candidate.kind,
    normalizePublicValue(candidate.name),
    normalizePublicValue(candidate.semantic),
    candidate.description === undefined ? null : normalizePublicValue(candidate.description),
    candidate.tags.map(normalizePublicValue).sort()
  ]);
}

/** 旧 play 目标在 Task 3 期间仅作本地兼容视图，稳定键不依赖对象别名或私有 ID。 */
function publicCatalogCandidates(catalog: PublicBehaviorCatalog): PublicCatalogCandidate[] {
  return catalog.states.flatMap(state => {
    const actions = state.actions.map(action => {
      const candidate = {
        kind: 'action_name' as const,
        name: action.name,
        semantic: action.semantic,
        ...(action.description === undefined ? {} : { description: action.description }),
        tags: action.tags
      };
      return { ...candidate, publicKey: publicCandidateKey(candidate) };
    });
    const candidate = {
      kind: 'state_name' as const,
      name: state.name,
      semantic: state.semantic,
      ...(state.description === undefined ? {} : { description: state.description }),
      tags: state.tags
    };
    return [{ ...candidate, publicKey: publicCandidateKey(candidate) }, ...actions];
  });
}

function uniquePublicCatalogCandidates(catalog: PublicBehaviorCatalog): PublicCatalogCandidate[] {
  return [...new Map(publicCatalogCandidates(catalog).map(candidate => [
    candidate.publicKey,
    candidate
  ])).values()];
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
  const candidates = uniquePublicCatalogCandidates(catalog);
  if (queries.length === 0 || candidates.length === 0) {
    return { kind: 'semantic', semantic: 'idle' };
  }
  const motionQueries = motionDescriptors.map(normalizePublicValue);
  const behaviorQueries = [activity, status]
    .filter((value): value is string => typeof value === 'string')
    .map(normalizePublicValue);
  const scoreCandidate = (candidate: PublicCatalogCandidate, inputs: string[]) => (
    inputs.length === 0 ? 0 : Math.max(
      ...inputs.flatMap(query => [
        similarity(query, normalizePublicValue(candidate.name)),
        similarity(query, normalizePublicValue(candidate.semantic)),
        ...candidate.tags.map(tag => similarity(query, normalizePublicValue(tag)))
      ])
    )
  );
  const scored = candidates.map(candidate => ({
    candidate,
    // 明确运动计划优先限定身体状态，activity/status 再负责同类候选间的细分。
    score: scoreCandidate(candidate, motionQueries) * 2
      + scoreCandidate(candidate, behaviorQueries)
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
  const candidates = uniquePublicCatalogCandidates(catalog);
  if (target.kind === 'semantic') {
    return candidates.some(candidate => (
      candidate.kind === 'action_name' && candidate.semantic === target.semantic
    ));
  }
  if (target.kind === 'tag') {
    const normalizedTag = normalizePublicValue(target.tag);
    // 标签可能被用户同时分配给多个动作；只有唯一命中才可作为精确 Provider 计划。
    return candidates.filter(candidate => (
      candidate.tags.some(tag => normalizePublicValue(tag) === normalizedTag)
    )).length === 1;
  }
  return candidates.filter(candidate => (
    candidate.kind === target.kind && normalizePublicValue(candidate.name) === normalizePublicValue(target.name)
  )).length === 1;
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
