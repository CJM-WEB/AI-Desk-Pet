import { useEffect, useState } from 'react';

const SAFE_IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9_-]{0,119}$/;
const MAX_TAGS = 32;

export interface TagEditorProps {
  ownerId: string;
  ownerLabel: '状态' | '动作';
  tags: string[];
  disabled: boolean;
  onChange(tags: string[]): void;
}

/** 标签先在本地保留输入态，只把完整安全标识写回草稿。 */
export function TagEditor(props: TagEditorProps) {
  const [draft, setDraft] = useState('');
  const safeDraft = SAFE_IDENTIFIER_PATTERN.test(draft);
  const canAdd = !props.disabled
    && props.tags.length < MAX_TAGS
    && safeDraft
    && !props.tags.includes(draft);

  useEffect(() => setDraft(''), [props.ownerId]);

  function addTag(): void {
    if (!canAdd) return;
    props.onChange([...props.tags, draft]);
    setDraft('');
  }

  return (
    <fieldset className="tag-editor">
      <legend>{props.ownerLabel}标签</legend>
      {props.tags.length > 0 ? (
        <ul className="tag-list" aria-label={`当前${props.ownerLabel}标签`}>
          {props.tags.map(tag => (
            <li key={tag}>
              <code>{tag}</code>
              <button
                type="button"
                disabled={props.disabled}
                aria-label={`删除${props.ownerLabel}标签“${tag}”`}
                onClick={() => props.onChange(props.tags.filter(candidate => candidate !== tag))}
              >
                删除
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="field-help">当前没有标签。</p>
      )}
      <div className="tag-editor-command">
        <label>
          新增{props.ownerLabel}标签
          <input
            value={draft}
            maxLength={120}
            pattern="[a-z0-9][a-z0-9_-]{0,119}"
            disabled={props.disabled || props.tags.length >= MAX_TAGS}
            aria-invalid={draft.length > 0 && !safeDraft}
            onChange={event => setDraft(event.currentTarget.value)}
            onKeyDown={event => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              addTag();
            }}
          />
        </label>
        <button
          type="button"
          disabled={!canAdd}
          onClick={addTag}
        >
          添加{props.ownerLabel}标签
        </button>
      </div>
      <p className="field-help">仅支持小写字母、数字、连字号与下划线，最多 32 项。</p>
    </fieldset>
  );
}
