import type {
  CharacterActionDefinitionV2,
  CharacterActionPresentationV2,
  CharacterDraftV2,
  CharacterManifestV2,
  CharacterSkinV2
} from './character-v2-schema';

/** 表现解析路径，调用方可据此解释实际使用的回退层级。 */
export type CharacterPresentationSource =
  | 'skin-action'
  | 'skin-semantic'
  | 'default-action'
  | 'default-state';

/** 解析后真正可播放的动作定义与皮肤表现。 */
export type ResolvedCharacterPresentation = {
  action: CharacterActionDefinitionV2;
  presentation: CharacterActionPresentationV2;
  source: CharacterPresentationSource;
};

type CharacterPresentationDocument = CharacterDraftV2 | CharacterManifestV2;

/** 只接受含有至少一帧的表现，避免将不可播放的草稿表现返回给运行时。 */
function exactPresentation(
  skin: CharacterSkinV2,
  actionId: string
): CharacterActionPresentationV2 | undefined {
  const presentation = skin.presentations.find((item) => item.actionId === actionId);
  return presentation?.frames.length ? presentation : undefined;
}

/** 在同语义的皮肤回退中查找实际可播放的动作和表现。 */
function semanticPresentation(
  document: CharacterPresentationDocument,
  skin: CharacterSkinV2,
  semantic: CharacterActionDefinitionV2['semantic']
): Omit<ResolvedCharacterPresentation, 'source'> | undefined {
  const fallback = skin.semanticFallbacks.find((item) => item.semantic === semantic);
  if (!fallback) return undefined;

  const action = document.actions.find((item) => item.id === fallback.actionId);
  const presentation = exactPresentation(skin, fallback.actionId);
  return action && presentation ? { action, presentation } : undefined;
}

/** 从默认状态的动作顺序中寻找默认皮肤可播放的最终表现。 */
function defaultStatePresentation(
  document: CharacterPresentationDocument,
  defaultSkin: CharacterSkinV2
): Omit<ResolvedCharacterPresentation, 'source'> | undefined {
  const defaultState = document.states.find((state) => state.id === document.defaultStateId);
  if (!defaultState) return undefined;

  for (const actionId of defaultState.actionIds) {
    const action = document.actions.find((item) => item.id === actionId);
    const presentation = exactPresentation(defaultSkin, actionId);
    if (action && presentation) return { action, presentation };

    if (action) {
      const semanticFallback = semanticPresentation(document, defaultSkin, action.semantic);
      if (semanticFallback) return semanticFallback;
    }
  }

  return undefined;
}

/**
 * 按固定四级顺序解析皮肤表现：请求皮肤精确动作、请求皮肤语义回退、
 * 默认皮肤精确动作、默认状态可播放表现。该函数只读取输入，不会修改草稿或清单。
 */
export function resolveCharacterPresentation(
  document: CharacterDraftV2 | CharacterManifestV2,
  skinId: string,
  actionId: string
): ResolvedCharacterPresentation | null {
  const skin = document.skins.find((item) => item.id === skinId);
  const defaultSkin = document.skins.find((item) => item.id === document.defaultSkinId);
  const action = document.actions.find((item) => item.id === actionId);
  if (!skin || !defaultSkin || !action) return null;

  const skinAction = exactPresentation(skin, actionId);
  if (skinAction) return { action, presentation: skinAction, source: 'skin-action' };

  const skinSemantic = semanticPresentation(document, skin, action.semantic);
  if (skinSemantic) return { ...skinSemantic, source: 'skin-semantic' };

  const defaultAction = exactPresentation(defaultSkin, actionId);
  if (defaultAction) return { action, presentation: defaultAction, source: 'default-action' };

  const defaultState = defaultStatePresentation(document, defaultSkin);
  return defaultState ? { ...defaultState, source: 'default-state' } : null;
}
