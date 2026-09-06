import { characterDraftV1Schema, characterManifestV1Schema } from './character-schema';
import { convertCharacterDraftV1ToV2, convertCharacterManifestV1ToV2 } from './character-v1-converter';
import { resolveCharacterPresentation } from './character-presentation-resolver';
import { characterDraftV2Schema, legacyPreparedCharacterManifestV2Schema, type CharacterDraftV2 } from './character-v2-schema';
import {
  characterDraftV3Schema, characterManifestV3Schema, characterMigrationManifestV3Schema,
  TRUSTED_CHARACTER_EVENTS_V3, type CharacterDraftV3, type CharacterMigrationManifestV3,
  type CharacterStateConditionV3, type TrustedCharacterEventV3
} from './character-v3-schema';

export type CharacterMigrationIssueV3 = {
  code: 'idle-missing' | 'idle-ambiguous' | 'modifier-state' | 'state-combination'
    | 'unsupported-condition' | 'action-constraint' | 'presentation-fallback' | 'presentation-budget' | 'v1-trigger';
  objectId: string;
  message: string;
  originalRule: string;
};
export type CharacterMigrationResultV3<T> = {
  document: T;
  issues: CharacterMigrationIssueV3[];
  sourceVersion: 1 | 2 | 3;
};

function addIssue(issues: CharacterMigrationIssueV3[], code: CharacterMigrationIssueV3['code'], objectId: string, message: string, original: unknown): void {
  issues.push({ code, objectId, message, originalRule: JSON.stringify(original) });
}

/** 条件无法等价表达时整体留给作者处理，不能只删除其中一项放宽原约束。 */
function convertConditions(conditions: CharacterDraftV2['states'][number]['enterConditions'], stateId: string, issues: CharacterMigrationIssueV3[]): CharacterStateConditionV3[] {
  const result: CharacterStateConditionV3[] = [];
  for (const condition of conditions) {
    if (condition.clauses.every(clause => clause.kind === 'signal' && (TRUSTED_CHARACTER_EVENTS_V3 as readonly string[]).includes(clause.signal))) {
      result.push({ mode: condition.mode, clauses: condition.clauses.map(clause => ({
        kind: 'event', event: (clause as { signal: TrustedCharacterEventV3 }).signal
      })) });
    } else {
      addIssue(issues, 'unsupported-condition', stateId, '原条件无法等价表达为可信事件，请明确替换规则。', condition);
    }
  }
  return result;
}

/** 只改变作者契约；不访问磁盘，不覆盖输入，不以资源复用改变逻辑动作身份。 */
function convertV2(source: CharacterDraftV2, issues: CharacterMigrationIssueV3[]): CharacterDraftV3 {
  const idleCandidates = source.states.filter(state => state.semantic === 'idle');
  const idleStateId = idleCandidates.length === 1 ? idleCandidates[0]!.id : null;
  if (idleStateId === null) addIssue(issues, idleCandidates.length ? 'idle-ambiguous' : 'idle-missing', source.id,
    '无法确定唯一兜底状态，请按稳定 ID 明确选择。', { candidates: idleCandidates.map(state => state.id), defaultStateId: source.defaultStateId });
  const { version, defaultStateId, states, actions, skins, ...common } = source;
  const convertedStates = states.map(state => {
    const { kind, semantic, coexistWithStateIds, forbiddenStateIds, enterConditions, exitConditions, actionIds, ...fields } = state;
    if (kind === 'modifier') addIssue(issues, 'modifier-state', state.id, '修饰状态已保留为独立草稿，原叠加含义需要作者确认。', { kind, semantic });
    if (coexistWithStateIds.length || forbiddenStateIds.length) addIssue(issues, 'state-combination', state.id, '共存与禁止组合不能直接用于单状态，请明确替换。', { coexistWithStateIds, forbiddenStateIds });
    return { ...fields, enterConditions: convertConditions(enterConditions, state.id, issues),
      exitConditions: convertConditions(exitConditions, state.id, issues),
      actionIds: [...new Set(actionIds)].filter(id => {
        const action = actions.find(candidate => candidate.id === id)!;
        // 修饰状态原先依赖另一个主状态，不根据当前独立状态猜测动作资格。
        return kind === 'modifier' || ((action.allowedPrimaryStateIds.length === 0 || action.allowedPrimaryStateIds.includes(state.id))
          && !action.forbiddenPrimaryStateIds.includes(state.id));
      }) };
  });
  const convertedActions = actions.map(action => {
    const { semantic, allowedPrimaryStateIds, forbiddenPrimaryStateIds, requiredModifierStateIds, forbiddenModifierStateIds, ...fields } = action;
    if (requiredModifierStateIds.length || forbiddenModifierStateIds.length
      || states.some(state => state.kind === 'modifier' && state.actionIds.includes(action.id) && (allowedPrimaryStateIds.length || forbiddenPrimaryStateIds.length))) {
      addIssue(issues, 'action-constraint', action.id, '动作依赖主／修饰组合，已保留可编辑动作但不能据此宣称发布就绪。', {
        allowedPrimaryStateIds, forbiddenPrimaryStateIds, requiredModifierStateIds, forbiddenModifierStateIds
      });
    }
    return fields;
  });
  const convertedSkins = skins.map(skin => {
    const { semanticFallbacks, presentations, ...fields } = skin;
    const expanded = structuredClone(presentations);
    for (const action of actions) {
      if (presentations.some(p => p.actionId === action.id && p.frames.length)) continue;
      const resolved = resolveCharacterPresentation(source, skin.id, action.id);
      if (!resolved || (resolved.source === 'default-state' && resolved.action.id !== action.id)) {
        addIssue(issues, 'presentation-fallback', action.id, '旧解析无法保留同一逻辑动作的表现，请选择合法目标状态与动作。', {
          skinId: skin.id, actionId: action.id, semanticFallbacks,
          resolvedActionId: resolved?.action.id ?? null, source: resolved?.source ?? null
        });
        continue;
      }
      const index = expanded.findIndex(p => p.actionId === action.id);
      if (index < 0 && expanded.length >= 512) {
        addIssue(issues, 'presentation-budget', action.id, '表现展开超过皮肤资源预算，请人工整理后发布。', { skinId: skin.id, actionId: action.id, semanticFallbacks });
        continue;
      }
      const presentation = { ...structuredClone(resolved.presentation), actionId: action.id };
      if (index < 0) expanded.push(presentation); else expanded[index] = presentation;
    }
    return { ...fields, presentations: expanded };
  });
  return characterDraftV3Schema.parse({ ...common, version: 3, idleStateId, states: convertedStates, actions: convertedActions, skins: convertedSkins });
}

/** V1 转换器遗漏或合并种类的触发规则必须保留摘要，通用交互不等价于原交互。 */
function v1Issues(source: ReturnType<typeof characterDraftV1Schema.parse>, issues: CharacterMigrationIssueV3[]): void {
  source.states.forEach(state => {
    if (state.kind === 'extension' && state.triggers && (state.triggers.keywords.length || state.triggers.emotions.length
      || state.triggers.events.some(event => event !== 'idle'))) {
      addIssue(issues, 'v1-trigger', state.id, '旧交互种类、关键词或情绪触发不能等价转换为通用可信事件，请审阅原规则后重新配置。', state.triggers);
    }
  });
}

function sourceVersion(raw: unknown): 1 | 2 | 3 {
  const version = typeof raw === 'object' && raw !== null && 'version' in raw ? raw.version : undefined;
  if (version !== 1 && version !== 2 && version !== 3) throw new Error('不支持的角色文档版本。');
  return version;
}

export function migrateCharacterDraftToV3(raw: unknown): CharacterMigrationResultV3<CharacterDraftV3> {
  const version = sourceVersion(raw);
  const issues: CharacterMigrationIssueV3[] = [];
  if (version === 3) return { document: characterDraftV3Schema.parse(raw), issues, sourceVersion: version };
  let input: CharacterDraftV2;
  let syntheticIdle = false;
  if (version === 1) {
    const source = characterDraftV1Schema.parse(raw);
    syntheticIdle = source.states.length === 0;
    v1Issues(source, issues);
    input = characterDraftV2Schema.parse(convertCharacterDraftV1ToV2(source).document);
  } else input = characterDraftV2Schema.parse(raw);
  const document = convertV2(input, issues);
  if (syntheticIdle) {
    document.idleStateId = null;
    addIssue(issues, 'idle-missing', input.id, '原空草稿没有明确兜底状态，请选择后发布。', { states: [] });
  }
  return { document, issues, sourceVersion: version };
}

/** 清单迁移返回编辑材料；调用者必须先处理 issues、补齐几何，再解析正式 Schema。 */
export function migrateCharacterManifestToV3(raw: unknown): CharacterMigrationResultV3<CharacterMigrationManifestV3> {
  const version = sourceVersion(raw);
  const issues: CharacterMigrationIssueV3[] = [];
  if (version === 3) return { document: characterManifestV3Schema.parse(raw), issues, sourceVersion: version };
  let input;
  if (version === 1) {
    const source = characterManifestV1Schema.parse(raw);
    v1Issues(source, issues);
    input = legacyPreparedCharacterManifestV2Schema.parse(convertCharacterManifestV1ToV2(source).document);
  } else input = legacyPreparedCharacterManifestV2Schema.parse(raw);
  const { resources, compilerVersion, ...draft } = input;
  const document = characterMigrationManifestV3Schema.parse({
    ...convertV2(draft, issues), resources, compilerVersion
  });
  return { document, issues, sourceVersion: version };
}
