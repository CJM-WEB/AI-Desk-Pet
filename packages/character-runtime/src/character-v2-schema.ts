import { z } from 'zod';
import {
  actionFrameSchema,
  anchorSetSchema,
  characterResourceSchema,
  interactionRegionSchema
} from './character-schema';

export const STANDARD_CHARACTER_SEMANTICS = [
  'idle', 'listen', 'think', 'move', 'speak', 'carry', 'celebrate', 'fail'
] as const;

export const TRUSTED_BEHAVIOR_SIGNALS = [
  'idle', 'user-interaction', 'conversation-start', 'listening', 'thinking',
  'task-start', 'task-success', 'task-failure', 'move-start', 'move-stop',
  'carry-start', 'carry-stop'
] as const;

const SAFE_IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9_-]{0,119}$/;
export const safeIdentifierSchema = z.string().regex(SAFE_IDENTIFIER_PATTERN);
const finiteNumberSchema = z.number().finite();
const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const boundedTextList = (maximumItems: number, maximumTextLength: number) => z.array(
  boundedText(maximumTextLength)
).max(maximumItems);

const stateConditionClauseSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('signal'),
    signal: z.enum(TRUSTED_BEHAVIOR_SIGNALS)
  }).strict(),
  z.object({
    kind: z.literal('semantic'),
    semantic: z.enum(STANDARD_CHARACTER_SEMANTICS)
  }).strict(),
  z.object({
    kind: z.literal('state'),
    stateId: safeIdentifierSchema
  }).strict()
]);

const stateConditionSchema = z.object({
  mode: z.enum(['all', 'any']),
  clauses: z.array(stateConditionClauseSchema).min(1).max(16)
}).strict();

const characterIdentitySchema = z.object({
  description: boundedText(2_000),
  background: boundedText(4_000),
  traits: boundedTextList(32, 120),
  languageStyle: boundedText(500),
  formsOfAddress: boundedTextList(32, 120),
  likes: boundedTextList(32, 240),
  dislikes: boundedTextList(32, 240),
  behavioralTendencies: boundedTextList(32, 240),
  boundaries: boundedTextList(32, 240),
  exampleLines: boundedTextList(16, 500)
}).strict();

const stateSemanticSchema = z.union([
  z.enum(STANDARD_CHARACTER_SEMANTICS),
  z.object({
    kind: z.literal('custom'),
    value: safeIdentifierSchema
  }).strict()
]);

const stateDefinitionSchema = z.object({
  id: safeIdentifierSchema,
  name: boundedText(120),
  kind: z.enum(['primary', 'modifier']),
  semantic: stateSemanticSchema,
  tags: z.array(safeIdentifierSchema).max(32),
  intensity: finiteNumberSchema.min(0).max(100),
  suggestedDurationMs: finiteNumberSchema.int().positive().max(3_600_000).optional(),
  coexistWithStateIds: z.array(safeIdentifierSchema).max(128),
  forbiddenStateIds: z.array(safeIdentifierSchema).max(128),
  enterConditions: z.array(stateConditionSchema).max(16),
  exitConditions: z.array(stateConditionSchema).max(16),
  agentInferable: z.boolean(),
  actionIds: z.array(safeIdentifierSchema).max(128)
}).strict();

const actionDefinitionSchema = z.object({
  id: safeIdentifierSchema,
  name: boundedText(120),
  semantic: z.enum(STANDARD_CHARACTER_SEMANTICS),
  tags: z.array(safeIdentifierSchema).max(32),
  preference: finiteNumberSchema.min(0.01).max(100),
  durationMs: finiteNumberSchema.int().positive().max(3_600_000).optional(),
  cooldownMs: finiteNumberSchema.int().nonnegative().max(86_400_000),
  repeatSuppressionMs: finiteNumberSchema.int().nonnegative().max(86_400_000),
  loopPolicy: z.enum(['never', 'presentation', 'until-interrupted']),
  interrupt: z.enum(['normal', 'resistant']),
  failureFallbackActionId: safeIdentifierSchema.optional(),
  interruptedFallbackActionId: safeIdentifierSchema.optional(),
  allowedPrimaryStateIds: z.array(safeIdentifierSchema).max(128),
  forbiddenPrimaryStateIds: z.array(safeIdentifierSchema).max(128),
  requiredModifierStateIds: z.array(safeIdentifierSchema).max(128),
  forbiddenModifierStateIds: z.array(safeIdentifierSchema).max(128),
  direction: z.enum(['left', 'right', 'any']),
  capabilityRef: z.never().optional()
}).strict();

const actionPresentationSchema = z.object({
  actionId: safeIdentifierSchema,
  fps: finiteNumberSchema.min(1).max(60),
  frames: z.array(actionFrameSchema),
  anchors: anchorSetSchema,
  regions: z.object({
    click: interactionRegionSchema.optional(),
    drag: interactionRegionSchema.optional(),
    collision: interactionRegionSchema.optional()
  }).strict().optional()
}).strict();

const semanticFallbackSchema = z.object({
  semantic: z.enum(STANDARD_CHARACTER_SEMANTICS),
  actionId: safeIdentifierSchema
}).strict();

const skinSchema = z.object({
  id: safeIdentifierSchema,
  name: boundedText(120),
  description: boundedText(2_000).optional(),
  presentations: z.array(actionPresentationSchema).max(512),
  semanticFallbacks: z.array(semanticFallbackSchema).max(STANDARD_CHARACTER_SEMANTICS.length)
}).strict();

const draftDocumentSchema = z.object({
  version: z.literal(2),
  id: safeIdentifierSchema,
  name: boundedText(120),
  thumbnailAssetId: safeIdentifierSchema.optional(),
  identity: characterIdentitySchema,
  defaultSkinId: safeIdentifierSchema,
  defaultStateId: safeIdentifierSchema,
  skins: z.array(skinSchema).min(1).max(128),
  states: z.array(stateDefinitionSchema).min(1).max(512),
  actions: z.array(actionDefinitionSchema).max(1_024)
}).strict();

const manifestDocumentSchema = draftDocumentSchema.extend({
  thumbnailAssetId: safeIdentifierSchema,
  compilerVersion: boundedText(64),
  resources: z.array(characterResourceSchema).max(4_096)
}).strict();

type V2Document = z.output<typeof draftDocumentSchema> | z.output<typeof manifestDocumentSchema>;

/** 为对象 ID 与 ID 引用提供统一且可定位的严格校验。 */
function addUniqueIdIssues<T>(
  values: readonly T[],
  getIdentifier: (value: T) => string,
  collectionName: string,
  path: readonly (string | number)[],
  context: z.RefinementCtx,
  identifierPathKey: string
): void {
  const seenIds = new Set<string>();
  values.forEach((value, index) => {
    const identifier = getIdentifier(value);
    if (seenIds.has(identifier)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${collectionName}标识符必须唯一。`,
        path: [...path, index, identifierPathKey]
      });
    }
    seenIds.add(identifier);
  });
}

function addReferenceIssue(
  context: z.RefinementCtx,
  message: string,
  path: readonly (string | number)[]
): void {
  context.addIssue({
    code: z.ZodIssueCode.custom,
    message,
    path: [...path]
  });
}

function hasActionFallbackCycle(
  actions: readonly z.output<typeof actionDefinitionSchema>[]
): boolean {
  const actionsById = new Map(actions.map((action) => [action.id, action]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (actionId: string): boolean => {
    if (visiting.has(actionId)) return true;
    if (visited.has(actionId)) return false;

    visiting.add(actionId);
    const action = actionsById.get(actionId);
    const fallbackIds = [action?.failureFallbackActionId, action?.interruptedFallbackActionId];
    if (fallbackIds.some((fallbackActionId) => fallbackActionId && visit(fallbackActionId))) {
      return true;
    }
    visiting.delete(actionId);
    visited.add(actionId);
    return false;
  };

  return actions.some((action) => visit(action.id));
}

/** 校验草稿与发布清单共用的跨集合引用和循环约束。 */
function validateDocumentReferences(document: V2Document, context: z.RefinementCtx): void {
  addUniqueIdIssues(document.skins, (skin) => skin.id, '皮肤', ['skins'], context, 'id');
  addUniqueIdIssues(document.states, (state) => state.id, '状态', ['states'], context, 'id');
  addUniqueIdIssues(document.actions, (action) => action.id, '动作', ['actions'], context, 'id');

  const skinIds = new Set(document.skins.map((skin) => skin.id));
  const stateIds = new Set(document.states.map((state) => state.id));
  const actionIds = new Set(document.actions.map((action) => action.id));

  if (!skinIds.has(document.defaultSkinId)) {
    addReferenceIssue(context, '默认皮肤必须引用已声明的皮肤。', ['defaultSkinId']);
  }
  if (!stateIds.has(document.defaultStateId)) {
    addReferenceIssue(context, '默认状态必须引用已声明的状态。', ['defaultStateId']);
  } else if (document.states.find((state) => state.id === document.defaultStateId)?.kind !== 'primary') {
    addReferenceIssue(context, '默认状态必须是主状态。', ['defaultStateId']);
  }

  document.states.forEach((state, stateIndex) => {
    const coexistIds = new Set(state.coexistWithStateIds);
    const forbiddenIds = new Set(state.forbiddenStateIds);
    if (state.coexistWithStateIds.some((stateId) => !stateIds.has(stateId))) {
      addReferenceIssue(context, '状态共存引用必须引用已声明的状态。', ['states', stateIndex, 'coexistWithStateIds']);
    }
    if (state.forbiddenStateIds.some((stateId) => !stateIds.has(stateId))) {
      addReferenceIssue(context, '状态禁止引用必须引用已声明的状态。', ['states', stateIndex, 'forbiddenStateIds']);
    }
    if ([...coexistIds].some((stateId) => forbiddenIds.has(stateId))) {
      addReferenceIssue(context, '状态共存引用不能与禁止引用冲突。', ['states', stateIndex]);
    }
    if (state.actionIds.some((actionId) => !actionIds.has(actionId))) {
      addReferenceIssue(context, '状态动作引用必须引用已声明的动作。', ['states', stateIndex, 'actionIds']);
    }
    [...state.enterConditions, ...state.exitConditions].forEach((condition) => {
      condition.clauses.forEach((clause) => {
        if (clause.kind === 'state' && !stateIds.has(clause.stateId)) {
          addReferenceIssue(context, '状态引用必须引用已声明的状态。', ['states', stateIndex]);
        }
      });
    });
  });

  document.actions.forEach((action, actionIndex) => {
    const stateReferenceFields = [
      'allowedPrimaryStateIds',
      'forbiddenPrimaryStateIds',
      'requiredModifierStateIds',
      'forbiddenModifierStateIds'
    ] as const;
    stateReferenceFields.forEach((field) => {
      if (action[field].some((stateId) => !stateIds.has(stateId))) {
        addReferenceIssue(context, '动作状态引用必须引用已声明的状态。', ['actions', actionIndex, field]);
      }
    });
    ([
      'failureFallbackActionId',
      'interruptedFallbackActionId'
    ] as const).forEach((field) => {
      const fallbackActionId = action[field];
      if (fallbackActionId && !actionIds.has(fallbackActionId)) {
        addReferenceIssue(context, '动作回退必须引用已声明的动作。', ['actions', actionIndex, field]);
      }
    });
  });

  if (hasActionFallbackCycle(document.actions)) {
    addReferenceIssue(context, '动作回退不能形成循环。', ['actions']);
  }

  document.skins.forEach((skin, skinIndex) => {
    const presentationActionIds = new Set<string>();
    skin.presentations.forEach((presentation, presentationIndex) => {
      if (presentationActionIds.has(presentation.actionId)) {
        addReferenceIssue(context, '皮肤表现动作引用必须唯一。', ['skins', skinIndex, 'presentations', presentationIndex, 'actionId']);
      }
      presentationActionIds.add(presentation.actionId);
      if (!actionIds.has(presentation.actionId)) {
        addReferenceIssue(context, '皮肤表现必须引用已声明的动作。', ['skins', skinIndex, 'presentations', presentationIndex, 'actionId']);
      }
    });

    const fallbackSemantics = new Set<string>();
    skin.semanticFallbacks.forEach((fallback, fallbackIndex) => {
      if (fallbackSemantics.has(fallback.semantic)) {
        addReferenceIssue(context, '语义回退必须为每个标准语义唯一声明。', ['skins', skinIndex, 'semanticFallbacks', fallbackIndex, 'semantic']);
      }
      fallbackSemantics.add(fallback.semantic);
      const action = document.actions.find((candidate) => candidate.id === fallback.actionId);
      if (!action) {
        addReferenceIssue(context, '语义回退必须引用已声明的动作。', ['skins', skinIndex, 'semanticFallbacks', fallbackIndex, 'actionId']);
      } else if (action.semantic !== fallback.semantic) {
        addReferenceIssue(context, '语义回退不能跨语义引用动作。', ['skins', skinIndex, 'semanticFallbacks', fallbackIndex, 'actionId']);
      }
    });
  });
}

/** 报告草稿允许保留、但发布清单必须消除的默认回退链缺口。 */
export type CharacterV2CompletenessIssue =
  | 'default-state-action-missing'
  | 'default-presentation-unplayable';

export function characterV2Completeness(document: V2Document): CharacterV2CompletenessIssue[] {
  const defaultState = document.states.find((state) => state.id === document.defaultStateId);
  if (!defaultState || defaultState.actionIds.length === 0) {
    return ['default-state-action-missing'];
  }

  const defaultSkin = document.skins.find((skin) => skin.id === document.defaultSkinId);
  const actionsById = new Map(document.actions.map((action) => [action.id, action]));
  const hasPlayablePresentation = defaultState.actionIds.some((actionId) => {
    const exactPresentation = defaultSkin?.presentations.find((presentation) => presentation.actionId === actionId);
    if (exactPresentation?.frames.length) return true;

    const semantic = actionsById.get(actionId)?.semantic;
    const fallbackActionId = semantic
      ? defaultSkin?.semanticFallbacks.find((fallback) => fallback.semantic === semantic)?.actionId
      : undefined;
    return Boolean(defaultSkin?.presentations.find(
      (presentation) => presentation.actionId === fallbackActionId && presentation.frames.length > 0
    ));
  });

  return hasPlayablePresentation ? [] : ['default-presentation-unplayable'];
}

export const characterDraftV2Schema = draftDocumentSchema.superRefine(validateDocumentReferences);

export const characterManifestV2Schema = manifestDocumentSchema.superRefine((manifest, context) => {
  validateDocumentReferences(manifest, context);
  addUniqueIdIssues(manifest.resources, (resource) => resource.assetId, '资源', ['resources'], context, 'assetId');

  const resourceIds = new Set(manifest.resources.map((resource) => resource.assetId));
  if (!resourceIds.has(manifest.thumbnailAssetId)) {
    addReferenceIssue(context, '缩略图必须引用已声明的资源。', ['thumbnailAssetId']);
  }
  manifest.skins.forEach((skin, skinIndex) => {
    skin.presentations.forEach((presentation, presentationIndex) => {
      presentation.frames.forEach((frame, frameIndex) => {
        if (!resourceIds.has(frame.assetId)) {
          addReferenceIssue(context, '皮肤表现帧必须引用已声明的资源。', [
            'skins', skinIndex, 'presentations', presentationIndex, 'frames', frameIndex, 'assetId'
          ]);
        }
      });
    });
  });

  characterV2Completeness(manifest).forEach((issue) => {
    addReferenceIssue(
      context,
      issue === 'default-state-action-missing'
        ? '可发布角色清单的默认状态必须关联动作。'
        : '可发布角色清单的默认回退链必须存在可播放表现。',
      ['defaultStateId']
    );
  });
});

export type CharacterIdentityV2 = z.output<typeof characterIdentitySchema>;
export type CharacterSkinV2 = z.output<typeof skinSchema>;
export type CharacterStateDefinitionV2 = z.output<typeof stateDefinitionSchema>;
export type CharacterActionDefinitionV2 = z.output<typeof actionDefinitionSchema>;
export type CharacterActionPresentationV2 = z.output<typeof actionPresentationSchema>;
export type CharacterDraftV2 = z.output<typeof characterDraftV2Schema>;
export type CharacterManifestV2 = z.output<typeof characterManifestV2Schema>;
