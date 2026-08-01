import { Plus, Trash2 } from 'lucide-react';
import type { CharacterSkinV2 } from '@myself/character-runtime';

export interface SkinListProps {
  skins: CharacterSkinV2[];
  defaultSkinId: string;
  selectedSkinId: string | null;
  disabled: boolean;
  onAdd(): void;
  onSelect(skinId: string): void;
  onSetDefault(skinId: string): void;
  onRequestDelete(skinId: string): void;
}

/** 皮肤列表只使用协议实体 ID 作为渲染与编辑身份。 */
export function SkinList(props: SkinListProps) {
  return (
    <section className="skin-list-section" aria-label="皮肤">
      <div className="section-heading skin-list-heading">
        <button
          className="section-heading-command"
          type="button"
          aria-label="新增皮肤"
          title="新增皮肤"
          disabled={props.disabled}
          onClick={props.onAdd}
        >
          <Plus size={16} aria-hidden="true" />
        </button>
      </div>
      <ul className="skin-list" aria-label="皮肤列表">
        {props.skins.map(skin => {
          const isDefault = skin.id === props.defaultSkinId;
          return (
            <li key={skin.id}>
              <button
                className="skin-select"
                type="button"
                aria-pressed={skin.id === props.selectedSkinId}
                disabled={props.disabled}
                onClick={() => props.onSelect(skin.id)}
              >
                <span>{skin.name}</span>
                <small>{isDefault ? '默认皮肤' : '增量皮肤'}</small>
              </button>
              <span className="skin-row-commands">
                {!isDefault ? (
                  <>
                    <button
                      type="button"
                      disabled={props.disabled}
                      onClick={() => props.onSetDefault(skin.id)}
                    >
                      设为默认
                    </button>
                    <button
                      className="danger-icon"
                      type="button"
                      aria-label={`删除皮肤“${skin.name}”`}
                      title={`删除皮肤“${skin.name}”`}
                      disabled={props.disabled}
                      onClick={() => props.onRequestDelete(skin.id)}
                    >
                      <Trash2 size={15} aria-hidden="true" />
                    </button>
                  </>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
