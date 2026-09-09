import { z } from 'zod';
import { characterResourceSchema } from './character-schema';
import {
  actionDefinitionSchema, actionPresentationSchema, characterIdentitySchema,
  preparedActionPresentationSchema, publishedActionPresentationSchema,
  safeIdentifierSchema, skinSchema, stateDefinitionSchema
} from './character-v2-schema';

export const TRUSTED_CHARACTER_EVENTS_V3 = [
  'user-interaction', 'conversation-start', 'response-finished', 'task-start', 'task-waiting',
  'task-paused', 'task-finished', 'drag-start', 'drag-end', 'move-start', 'move-stop'
] as const;

/** 条件仅描述 Main 可核验事件；消费时机和事件寿命由 Main 管理。 */
export const characterStateConditionV3Schema = z.object({
  mode: z.enum(['all', 'any']),
  clauses: z.array(z.object({ kind: z.literal('event'), event: z.enum(TRUSTED_CHARACTER_EVENTS_V3) }).strict()).min(1).max(16)
}).strict();

export const characterStateDefinitionV3Schema = stateDefinitionSchema.omit({
  kind: true, semantic: true, coexistWithStateIds: true, forbiddenStateIds: true,
  enterConditions: true, exitConditions: true
}).extend({
  enterConditions: z.array(characterStateConditionV3Schema).max(16),
  exitConditions: z.array(characterStateConditionV3Schema).max(16)
}).strict();
export const characterActionDefinitionV3Schema = actionDefinitionSchema.omit({
  semantic: true, allowedPrimaryStateIds: true, forbiddenPrimaryStateIds: true,
  requiredModifierStateIds: true, forbiddenModifierStateIds: true
}).strict();
export const characterActionPresentationV3Schema = actionPresentationSchema;
export const publishedCharacterActionPresentationV3Schema = publishedActionPresentationSchema;
export const characterSkinV3Schema = skinSchema.omit({ semanticFallbacks: true }).strict();

const draftDocumentSchema = z.object({
  version: z.literal(3), id: safeIdentifierSchema, name: z.string().trim().min(1).max(120),
  thumbnailAssetId: safeIdentifierSchema.optional(), identity: characterIdentitySchema,
  defaultSkinId: safeIdentifierSchema, idleStateId: safeIdentifierSchema.nullable(),
  skins: z.array(characterSkinV3Schema).min(1).max(128),
  states: z.array(characterStateDefinitionV3Schema).min(1).max(512),
  actions: z.array(characterActionDefinitionV3Schema).max(1024)
}).strict();
const manifestFields = {
  thumbnailAssetId: safeIdentifierSchema,
  compilerVersion: z.string().trim().min(1).max(64), resources: z.array(characterResourceSchema).max(4096)
};
const migrationManifestDocumentSchema = draftDocumentSchema.extend(manifestFields).strict();
const preparedDocumentSchema = migrationManifestDocumentSchema.extend({
  idleStateId: safeIdentifierSchema,
  skins: z.array(characterSkinV3Schema.extend({ presentations: z.array(preparedActionPresentationSchema).max(512) }).strict()).min(1).max(128)
}).strict();
const publishedDocumentSchema = preparedDocumentSchema.extend({
  skins: z.array(characterSkinV3Schema.extend({ presentations: z.array(publishedActionPresentationSchema).max(512) }).strict()).min(1).max(128)
}).strict();

function issue(context: z.RefinementCtx, message: string, path: (string | number)[]): void {
  context.addIssue({ code: z.ZodIssueCode.custom, message, path });
}

/** 身份引用与回退图独立于旧语义模型，所有文档阶段共用此校验。 */
function validateReferences(document: z.output<typeof draftDocumentSchema>, context: z.RefinementCtx): void {
  for (const key of ['skins', 'states', 'actions'] as const) {
    const seen = new Set<string>();
    document[key].forEach((item, index) => {
      if (seen.has(item.id)) issue(context, '对象标识符必须唯一。', [key, index, 'id']);
      seen.add(item.id);
    });
  }
  const actions = new Map(document.actions.map(action => [action.id, action]));
  if (!document.skins.some(skin => skin.id === document.defaultSkinId)) issue(context, '默认皮肤引用无效。', ['defaultSkinId']);
  if (document.idleStateId !== null && !document.states.some(state => state.id === document.idleStateId)) {
    issue(context, '兜底状态引用无效。', ['idleStateId']);
  }
  document.states.forEach((state, index) => {
    if (state.actionIds.some(id => !actions.has(id)) || new Set(state.actionIds).size !== state.actionIds.length) {
      issue(context, '状态动作引用必须有效且唯一。', ['states', index, 'actionIds']);
    }
  });
  document.actions.forEach((action, index) => {
    for (const key of ['failureFallbackActionId', 'interruptedFallbackActionId'] as const) {
      if (action[key] !== undefined && !actions.has(action[key])) issue(context, '回退动作引用无效。', ['actions', index, key]);
    }
  });
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cyclic = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const action = actions.get(id);
    if ([action?.failureFallbackActionId, action?.interruptedFallbackActionId].some(next => next && cyclic(next))) return true;
    visiting.delete(id); visited.add(id); return false;
  };
  if (document.actions.some(action => cyclic(action.id))) issue(context, '动作回退不能形成循环。', ['actions']);
  document.skins.forEach((skin, skinIndex) => {
    const seen = new Set<string>();
    skin.presentations.forEach((presentation, presentationIndex) => {
      const path = ['skins', skinIndex, 'presentations', presentationIndex];
      if (!actions.has(presentation.actionId) || seen.has(presentation.actionId)) issue(context, '表现动作引用必须有效且唯一。', [...path, 'actionId']);
      seen.add(presentation.actionId);
      if (presentation.commitFrameId && presentation.frames.filter(frame => frame.id === presentation.commitFrameId).length !== 1) {
        issue(context, '提交帧必须引用同一表现内唯一的帧标识。', [...path, 'commitFrameId']);
      }
    });
  });
}

/** Prepared 只保证资源和可播放 idle，Published 另验证几何与素材修订绑定。 */
function validateManifest(document: z.output<typeof preparedDocumentSchema>, context: z.RefinementCtx, published = false): void {
  validateReferences(document, context);
  const resources = new Map(document.resources.map(resource => [resource.assetId, resource]));
  if (resources.size !== document.resources.length) issue(context, '资源标识符必须唯一。', ['resources']);
  if (!resources.has(document.thumbnailAssetId)) issue(context, '缩略图必须引用资源。', ['thumbnailAssetId']);
  const idle = document.states.find(state => state.id === document.idleStateId);
  const defaultSkin = document.skins.find(skin => skin.id === document.defaultSkinId);
  document.skins.forEach((skin, skinIndex) => {
    if (!idle?.actionIds.some(id => [skin, defaultSkin].some(candidate => candidate?.presentations.some(p => p.actionId === id && p.frames.length)))) {
      issue(context, '每个皮肤必须可解析至少一个兜底动作表现。', ['skins', skinIndex]);
    }
    skin.presentations.forEach((presentation, presentationIndex) => {
      const path = ['skins', skinIndex, 'presentations', presentationIndex];
      presentation.frames.forEach((frame, frameIndex) => {
        if (!resources.has(frame.assetId)) issue(context, '帧必须引用已声明资源。', [...path, 'frames', frameIndex, 'assetId']);
      });
      if (published && presentation.geometry) {
        const revision = [...new Set(presentation.frames.map(frame => resources.get(frame.assetId)?.sha256).filter(Boolean))].sort().join('.');
        if (presentation.geometry.resourceRevision !== revision) issue(context, '几何必须绑定当前资源修订。', [...path, 'geometry', 'resourceRevision']);
        if (presentation.geometry.groundAnchor.x !== presentation.anchors.ground.x || presentation.geometry.groundAnchor.y !== presentation.anchors.ground.y) {
          issue(context, '几何脚底锚点必须与表现一致。', [...path, 'geometry', 'groundAnchor']);
        }
      }
    });
  });
}

export const characterDraftV3Schema = draftDocumentSchema.superRefine(validateReferences);
/** 迁移清单仍是编辑材料：保留资源，但不得直接传入运行态。 */
export const characterMigrationManifestV3Schema = migrationManifestDocumentSchema.superRefine(validateReferences);
export const preparedCharacterManifestV3Schema = preparedDocumentSchema.superRefine((document, context) => validateManifest(document, context));
export const characterManifestV3Schema = publishedDocumentSchema.superRefine((document, context) => validateManifest(document, context, true));

export type CharacterDraftV3 = z.output<typeof characterDraftV3Schema>;
export type CharacterMigrationManifestV3 = z.output<typeof characterMigrationManifestV3Schema>;
export type PreparedCharacterManifestV3 = z.output<typeof preparedCharacterManifestV3Schema>;
export type CharacterManifestV3 = z.output<typeof characterManifestV3Schema>;
export type CharacterStateDefinitionV3 = z.output<typeof characterStateDefinitionV3Schema>;
export type CharacterActionDefinitionV3 = z.output<typeof characterActionDefinitionV3Schema>;
export type CharacterActionPresentationV3 = z.output<typeof characterActionPresentationV3Schema>;
export type PublishedCharacterActionPresentationV3 = z.output<typeof publishedCharacterActionPresentationV3Schema>;
export type CharacterSkinV3 = z.output<typeof characterSkinV3Schema>;
export type CharacterStateConditionV3 = z.output<typeof characterStateConditionV3Schema>;
export type TrustedCharacterEventV3 = typeof TRUSTED_CHARACTER_EVENTS_V3[number];
