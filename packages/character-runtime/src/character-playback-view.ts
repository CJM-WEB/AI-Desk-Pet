import { z } from 'zod';
import { characterResourceSchema } from './character-schema';
import { safeIdentifierSchema } from './character-v2-schema';
import {
  characterManifestV3Schema, type CharacterActionDefinitionV3, type CharacterActionPresentationV3,
  type CharacterDraftV3, type CharacterManifestV3, type PublishedCharacterActionPresentationV3,
  characterStateDefinitionV3Schema, characterActionDefinitionV3Schema, publishedCharacterActionPresentationV3Schema
} from './character-v3-schema';

export type ResolvedCharacterPresentationV3<T extends CharacterActionPresentationV3 = CharacterActionPresentationV3> = {
  stateId: string;
  actionId: string;
  skinId: string;
  action: CharacterActionDefinitionV3;
  presentation: T;
  source: 'skin-action' | 'default-action';
};

/** 素材回退只复用相同逻辑动作；非法归属不会自动跳到其他状态或 idle。 */
export function resolveCharacterPresentationV3(document: CharacterManifestV3, skinId: string, stateId: string, actionId: string): ResolvedCharacterPresentationV3<PublishedCharacterActionPresentationV3> | null;
export function resolveCharacterPresentationV3(document: CharacterDraftV3, skinId: string, stateId: string, actionId: string): ResolvedCharacterPresentationV3 | null;
export function resolveCharacterPresentationV3(document: CharacterDraftV3, skinId: string, stateId: string, actionId: string): ResolvedCharacterPresentationV3 | null {
  const state = document.states.find(candidate => candidate.id === stateId);
  const action = document.actions.find(candidate => candidate.id === actionId);
  const skin = document.skins.find(candidate => candidate.id === skinId);
  if (!state?.actionIds.includes(actionId) || !action || !skin) return null;
  for (const candidate of [skin, document.skins.find(item => item.id === document.defaultSkinId)]) {
    const presentation = candidate?.presentations.find(item => item.actionId === actionId && item.frames.length > 0);
    if (candidate && presentation) return { stateId, actionId, skinId: candidate.id, action, presentation,
      source: candidate.id === skinId ? 'skin-action' : 'default-action' };
  }
  return null;
}

export type CharacterReadonlyV3<T> = T extends readonly unknown[]
  ? { readonly [K in keyof T]: CharacterReadonlyV3<T[K]> }
  : T extends object ? { readonly [K in keyof T]: CharacterReadonlyV3<T[K]> } : T;

/** IPC 仅携带播放必需字段；共享动作的表现按动作 ID 唯一存放。 */
export const characterPlaybackViewSchema = z.object({
  version: z.literal(3), id: safeIdentifierSchema, skinId: safeIdentifierSchema,
  defaultSkinId: safeIdentifierSchema, idleStateId: safeIdentifierSchema,
  resources: z.array(characterResourceSchema).max(4096),
  states: z.array(characterStateDefinitionV3Schema.pick({ id: true, name: true, actionIds: true }).strict()).min(1).max(512),
  actions: z.array(characterActionDefinitionV3Schema.pick({ id: true, loopPolicy: true }).strict()).max(1024),
  presentations: z.array(z.object({
    actionId: safeIdentifierSchema, skinId: safeIdentifierSchema,
    source: z.enum(['skin-action', 'default-action']), presentation: publishedCharacterActionPresentationV3Schema
  }).strict()).max(1024),
  idle: z.object({ stateId: safeIdentifierSchema, actionId: safeIdentifierSchema }).strict()
}).strict().superRefine((view, context) => {
  const issue = (message: string, path: (string | number)[]) => context.addIssue({ code: z.ZodIssueCode.custom, message, path });
  const actions = new Set(view.actions.map(action => action.id));
  const states = new Map(view.states.map(state => [state.id, state]));
  const resources = new Map(view.resources.map(resource => [resource.assetId, resource]));
  const presentationIds = new Set(view.presentations.map(item => item.actionId));
  if (actions.size !== view.actions.length || states.size !== view.states.length
    || resources.size !== view.resources.length || presentationIds.size !== view.presentations.length) issue('播放对象标识符必须唯一。', []);
  view.states.forEach((state, index) => {
    if (state.actionIds.some(id => !actions.has(id)) || new Set(state.actionIds).size !== state.actionIds.length) issue('状态动作归属无效。', ['states', index, 'actionIds']);
  });
  if (view.idle.stateId !== view.idleStateId || !states.get(view.idleStateId)?.actionIds.includes(view.idle.actionId)
    || !presentationIds.has(view.idle.actionId)) issue('兜底目标必须是可播放的真实状态与动作对。', ['idle']);
  view.presentations.forEach((item, index) => {
    const path = ['presentations', index];
    const presentation = item.presentation;
    if (!actions.has(item.actionId) || presentation.actionId !== item.actionId) issue('表现动作身份无效。', [...path, 'actionId']);
    if (item.skinId !== (item.source === 'skin-action' ? view.skinId : view.defaultSkinId)) issue('表现来源皮肤不一致。', [...path, 'skinId']);
    presentation.frames.forEach((frame, frameIndex) => {
      if (!resources.has(frame.assetId)) issue('播放帧必须引用有效资源。', [...path, 'presentation', 'frames', frameIndex, 'assetId']);
    });
    if (presentation.commitFrameId && presentation.frames.filter(frame => frame.id === presentation.commitFrameId).length !== 1) issue('提交帧引用无效。', [...path, 'presentation', 'commitFrameId']);
    const revision = [...new Set(presentation.frames.map(frame => resources.get(frame.assetId)?.sha256).filter(Boolean))].sort().join('.');
    if (presentation.geometry.resourceRevision !== revision) issue('几何修订与资源不一致。', [...path, 'presentation', 'geometry']);
    if (presentation.geometry.groundAnchor.x !== presentation.anchors.ground.x || presentation.geometry.groundAnchor.y !== presentation.anchors.ground.y) issue('几何与表现锚点不一致。', [...path, 'presentation', 'geometry']);
  });
}).transform(freeze);

export type CharacterPlaybackView = z.output<typeof characterPlaybackViewSchema>;

/** 只冻结独立投影；避免调用方通过嵌套帧/区域改写运行快照或冻结编辑原件。 */
function freeze<T>(value: T): CharacterReadonlyV3<T> {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(child => freeze(child));
    Object.freeze(value);
  }
  return value as CharacterReadonlyV3<T>;
}

export function createCharacterPlaybackView(manifest: CharacterManifestV3, skinId: string): CharacterPlaybackView {
  const document = characterManifestV3Schema.parse(manifest);
  if (!document.skins.some(skin => skin.id === skinId)) throw new Error('播放视图皮肤不存在。');
  const presentations: Array<Pick<ResolvedCharacterPresentationV3<PublishedCharacterActionPresentationV3>, 'actionId' | 'skinId' | 'source' | 'presentation'>> = [];
  const seen = new Set<string>();
  for (const state of document.states) {
    for (const actionId of state.actionIds) {
      if (seen.has(actionId)) continue;
      seen.add(actionId);
      const resolved = resolveCharacterPresentationV3(document, skinId, state.id, actionId);
      if (resolved) presentations.push({ actionId, skinId: resolved.skinId, source: resolved.source, presentation: resolved.presentation });
    }
  }
  const idleState = document.states.find(state => state.id === document.idleStateId)!;
  const idleActionId = idleState.actionIds.find(id => presentations.some(item => item.actionId === id));
  if (!idleActionId) throw new Error('播放视图缺少可用兜底表现。');
  return characterPlaybackViewSchema.parse({ version: 3, id: document.id, skinId, defaultSkinId: document.defaultSkinId,
    idleStateId: document.idleStateId, resources: document.resources,
    states: document.states.map(({ id, name, actionIds }) => ({ id, name, actionIds })),
    actions: document.actions.map(({ id, loopPolicy }) => ({ id, loopPolicy })), presentations,
    idle: { stateId: document.idleStateId, actionId: idleActionId } });
}
