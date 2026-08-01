import { useId, useRef } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { CharacterIdentityV2 } from '@myself/character-runtime';

export interface CharacterIdentityInspectorProps {
  identity: CharacterIdentityV2;
  disabled: boolean;
  onChange(patch: Partial<CharacterIdentityV2>): void;
}

type ListField = Exclude<keyof CharacterIdentityV2,
  'description' | 'background' | 'languageStyle'>;

const listFields: Array<{
  field: ListField;
  label: string;
  maximumItems: number;
  maximumLength: number;
}> = [
  { field: 'traits', label: '性格标签', maximumItems: 32, maximumLength: 120 },
  { field: 'formsOfAddress', label: '称呼方式', maximumItems: 32, maximumLength: 120 },
  { field: 'likes', label: '喜欢', maximumItems: 32, maximumLength: 240 },
  { field: 'dislikes', label: '不喜欢', maximumItems: 32, maximumLength: 240 },
  { field: 'behavioralTendencies', label: '行为倾向', maximumItems: 32, maximumLength: 240 },
  { field: 'boundaries', label: '互动边界', maximumItems: 32, maximumLength: 240 },
  { field: 'exampleLines', label: '示例台词', maximumItems: 16, maximumLength: 500 }
];

function StringListEditor(props: {
  field: ListField;
  label: string;
  values: string[];
  maximumItems: number;
  maximumLength: number;
  disabled: boolean;
  onChange(values: string[]): void;
}) {
  const fieldId = useId();
  const nextKey = useRef(0);
  const keys = useRef<string[]>([]);
  while (keys.current.length < props.values.length) {
    keys.current.push(`${fieldId}-${nextKey.current++}`);
  }
  if (keys.current.length > props.values.length) {
    keys.current.length = props.values.length;
  }

  return (
    <fieldset className="string-list-editor">
      <legend>{props.label}</legend>
      <p className="field-help" id={`${fieldId}-help`}>
        最多 {props.maximumItems} 项，每项最多 {props.maximumLength} 个字符。
      </p>
      {props.values.map((value, index) => (
        <div className="string-list-row" key={keys.current[index]}>
          <label htmlFor={`${fieldId}-${index}`}>{props.label} {index + 1}</label>
          <input
            id={`${fieldId}-${index}`}
            value={value}
            maxLength={props.maximumLength}
            aria-describedby={`${fieldId}-help`}
            disabled={props.disabled}
            onChange={event => props.onChange(props.values.map((item, itemIndex) => (
              itemIndex === index ? event.currentTarget.value : item
            )))}
          />
          <button
            type="button"
            aria-label={`删除${props.label} ${index + 1}`}
            disabled={props.disabled}
            onClick={() => {
              keys.current.splice(index, 1);
              props.onChange(props.values.filter((_, itemIndex) => itemIndex !== index));
            }}
          >
            <Trash2 size={15} aria-hidden="true" />
          </button>
        </div>
      ))}
      <button
        className="secondary-command"
        type="button"
        disabled={props.disabled || props.values.length >= props.maximumItems}
        onClick={() => props.onChange([...props.values, ''])}
      >
        <Plus size={15} aria-hidden="true" />添加{props.label}
      </button>
    </fieldset>
  );
}

/** 人设 Inspector 仅暴露 V2 白名单结构字段。 */
export function CharacterIdentityInspector(props: CharacterIdentityInspectorProps) {
  return (
    <form className="inspector-form" onSubmit={event => event.preventDefault()}>
      <label>
        角色描述
        <textarea
          value={props.identity.description}
          maxLength={2_000}
          disabled={props.disabled}
          onChange={event => props.onChange({ description: event.currentTarget.value })}
        />
      </label>
      <label>
        角色背景
        <textarea
          value={props.identity.background}
          maxLength={4_000}
          disabled={props.disabled}
          onChange={event => props.onChange({ background: event.currentTarget.value })}
        />
      </label>
      <label>
        语言风格
        <textarea
          value={props.identity.languageStyle}
          maxLength={500}
          disabled={props.disabled}
          onChange={event => props.onChange({ languageStyle: event.currentTarget.value })}
        />
      </label>
      {listFields.map(field => (
        <StringListEditor
          key={field.field}
          {...field}
          values={props.identity[field.field]}
          disabled={props.disabled}
          onChange={values => props.onChange({ [field.field]: values })}
        />
      ))}
    </form>
  );
}
