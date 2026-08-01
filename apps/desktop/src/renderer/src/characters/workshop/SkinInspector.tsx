import type {
  CharacterPresentationSource,
  CharacterSkinV2
} from '@myself/character-runtime';

export interface SkinInspectorProps {
  skin: CharacterSkinV2;
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
      <dl className="inspector-summary">
        <div><dt>皮肤标识</dt><dd>{props.skin.id}</dd></div>
        <div><dt>语义回退</dt><dd>{props.skin.semanticFallbacks.length}</dd></div>
      </dl>
    </form>
  );
}
