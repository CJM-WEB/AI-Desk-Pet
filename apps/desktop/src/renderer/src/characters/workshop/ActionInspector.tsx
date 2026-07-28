import type { DraftActionClip } from '@myself/character-runtime';

export interface ActionInspectorProps {
  action: DraftActionClip;
  disabled: boolean;
  onChange(patch: Partial<DraftActionClip>): void;
}

/**
 * 动作基础属性直接遵循角色协议的数值边界。
 */
export function ActionInspector(props: ActionInspectorProps) {
  const { action } = props;
  return (
    <form className="action-properties" onSubmit={event => event.preventDefault()}>
      <label>
        动作名称
        <input
          value={action.name}
          disabled={props.disabled}
          onChange={event => props.onChange({ name: event.currentTarget.value })}
        />
      </label>
      <div className="property-grid">
        <label>
          帧率
          <input
            type="number"
            min="1"
            max="60"
            value={action.fps}
            disabled={props.disabled}
            onChange={event => {
              const fps = Number(event.currentTarget.value);
              if (fps >= 1 && fps <= 60) props.onChange({ fps });
            }}
          />
        </label>
        <label>
          权重
          <input
            type="number"
            min="0.01"
            max="100"
            step="0.01"
            value={action.weight}
            disabled={props.disabled}
            onChange={event => {
              const weight = Number(event.currentTarget.value);
              if (weight > 0 && weight <= 100) props.onChange({ weight });
            }}
          />
        </label>
      </div>
      <label>
        朝向
        <select
          aria-label="动作朝向"
          value={action.direction ?? 'any'}
          disabled={props.disabled}
          onChange={event => props.onChange({
            direction: event.currentTarget.value as 'left' | 'right' | 'any'
          })}
        >
          <option value="any">任意</option>
          <option value="left">向左</option>
          <option value="right">向右</option>
        </select>
      </label>
      <label className="toggle-row">
        <span>
          <strong>循环播放</strong>
          <small>动作结束后从头继续</small>
        </span>
        <input
          type="checkbox"
          checked={action.loop}
          disabled={props.disabled}
          onChange={event => props.onChange({ loop: event.currentTarget.checked })}
        />
      </label>
      <dl className="action-summary">
        <div><dt>动作标识</dt><dd>{action.id}</dd></div>
        <div><dt>帧数</dt><dd>{action.frames.length}</dd></div>
      </dl>
    </form>
  );
}
