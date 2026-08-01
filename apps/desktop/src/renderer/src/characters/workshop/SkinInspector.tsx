import {
  STANDARD_CHARACTER_SEMANTICS,
  type CharacterActionDefinitionV2,
  type CharacterPresentationSource,
  type CharacterSkinV2
} from '@myself/character-runtime';

export interface SkinInspectorProps {
  skin: CharacterSkinV2;
  actions: CharacterActionDefinitionV2[];
  selectedActionId: string | null;
  presentationSource: CharacterPresentationSource | null;
  disabled: boolean;
  onChange(patch: Partial<CharacterSkinV2>): void;
}

/** 皮肤只编辑元数据，动作表现继续由素材与时间轴区域维护。 */
export function SkinInspector(props: SkinInspectorProps) {
  const sourceLabel = !props.selectedActionId || !props.presentationSource
    ? '无可播放表现'
    : ({
        'skin-action': '当前皮肤精确表现',
        'skin-semantic': '当前皮肤语义回退',
        'default-action': '默认皮肤动作',
        'default-state': '默认状态回退'
      } satisfies Record<CharacterPresentationSource, string>)[props.presentationSource];

  /** 按标准语义重建有序回退表，拒绝不在候选集中的动作 ID。 */
  function updateSemanticFallback(
    semantic: typeof STANDARD_CHARACTER_SEMANTICS[number],
    actionId: string
  ): void {
    if (
      actionId
      && !props.actions.some(action => action.id === actionId && action.semantic === semantic)
    ) {
      return;
    }
    const bySemantic = new Map(
      props.skin.semanticFallbacks.map(fallback => [fallback.semantic, fallback.actionId])
    );
    if (actionId) bySemantic.set(semantic, actionId);
    else bySemantic.delete(semantic);
    props.onChange({
      semanticFallbacks: STANDARD_CHARACTER_SEMANTICS.flatMap(candidate => {
        const candidateActionId = bySemantic.get(candidate);
        return candidateActionId ? [{ semantic: candidate, actionId: candidateActionId }] : [];
      })
    });
  }

  return (
    <form className="inspector-form" onSubmit={event => event.preventDefault()}>
      <label>
        皮肤名称
        <input
          value={props.skin.name}
          maxLength={120}
          disabled={props.disabled}
          onChange={event => props.onChange({ name: event.currentTarget.value })}
        />
      </label>
      <label>
        皮肤说明
        <textarea
          value={props.skin.description ?? ''}
          maxLength={2_000}
          disabled={props.disabled}
          onChange={event => props.onChange({
            description: event.currentTarget.value || undefined
          })}
        />
      </label>
      <p className="field-help">
        当前动作来源：{sourceLabel}。
      </p>
      <fieldset className="semantic-fallback-editor">
        <legend>语义回退</legend>
        <p className="field-help">只能选择同语义的现有动作，不接受自由文本 ID。</p>
        {STANDARD_CHARACTER_SEMANTICS.map(semantic => {
          const candidates = props.actions.filter(action => action.semantic === semantic);
          const configured = props.skin.semanticFallbacks.find(
            fallback => fallback.semantic === semantic
          )?.actionId;
          const value = candidates.some(action => action.id === configured) ? configured : '';
          return (
            <label key={semantic}>
              {semantic} 语义回退
              <select
                value={value}
                disabled={props.disabled}
                onChange={event => updateSemanticFallback(
                  semantic,
                  event.currentTarget.value
                )}
              >
                <option value="">不设置</option>
                {candidates.map(action => (
                  <option key={action.id} value={action.id}>{action.name}</option>
                ))}
              </select>
            </label>
          );
        })}
      </fieldset>
      <dl className="inspector-summary">
        <div><dt>皮肤标识</dt><dd>{props.skin.id}</dd></div>
        <div><dt>语义回退</dt><dd>{props.skin.semanticFallbacks.length}</dd></div>
      </dl>
    </form>
  );
}
