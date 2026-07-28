import { Copy, Trash2 } from 'lucide-react';
import type { CharacterSummaryDto } from '../../../../shared/character-ipc';

export interface CharacterListProps {
  characters: CharacterSummaryDto[];
  selectedCharacterId: string | null;
  disabled: boolean;
  onSelect(characterId: string): void;
  onDuplicate(characterId: string): void;
  onDelete(characterId: string): void;
}

const completenessLabels = {
  complete: '完整',
  incomplete: '待完善',
  broken: '需修复'
} as const;

export function CharacterList(props: CharacterListProps) {
  if (props.characters.length === 0) {
    return <p className="workshop-empty">还没有可编辑角色</p>;
  }

  return (
    <ul className="character-list" aria-label="角色列表">
      {props.characters.map(character => (
        <li
          key={character.id}
          className={character.id === props.selectedCharacterId ? 'is-selected' : undefined}
        >
          <button
            className="character-select"
            type="button"
            aria-pressed={character.id === props.selectedCharacterId}
            disabled={props.disabled}
            onClick={() => props.onSelect(character.id)}
          >
            <span className="character-avatar" aria-hidden="true">
              {character.name.slice(0, 1).toUpperCase()}
            </span>
            <span className="character-copy">
              <strong>{character.name}</strong>
              <small>
                {character.active ? '当前启用 · ' : ''}
                {completenessLabels[character.completeness]}
              </small>
            </span>
          </button>
          <span className="row-commands">
            <button
              type="button"
              aria-label={`复制 ${character.name}`}
              title="复制角色"
              disabled={props.disabled}
              onClick={() => props.onDuplicate(character.id)}
            >
              <Copy size={15} />
            </button>
            {character.id !== 'default' ? (
              <button
                className="danger-icon"
                type="button"
                aria-label={`删除 ${character.name}`}
                title="删除角色"
                disabled={props.disabled}
                onClick={() => props.onDelete(character.id)}
              >
                <Trash2 size={15} />
              </button>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
