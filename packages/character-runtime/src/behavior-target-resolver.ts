import type { BehaviorTarget, PublicBehaviorCatalog } from './character-behavior-plan';
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
    ])
  };
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
