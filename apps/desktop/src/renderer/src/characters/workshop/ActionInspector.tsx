import {
  type CharacterActionDefinitionV3,
  type CharacterActionPresentationV3,
  type CharacterStateDefinitionV3
} from '@myself/character-runtime';
import { TagEditor } from './TagEditor';

export interface ActionInspectorProps {
  action: CharacterActionDefinitionV3;
  actions: CharacterActionDefinitionV3[];
  states: CharacterStateDefinitionV3[];
  presentation?: Pick<CharacterActionPresentationV3, 'frames' | 'commitFrameId'> | null;
  disabled: boolean;
  onChange(patch: Partial<CharacterActionDefinitionV3>): void;
  onCommitFrameChange?(frameId: string | null): void;
}

function fallbackOptions(
  actions: CharacterActionDefinitionV3[],
  currentActionId: string
) {
  const actionsById = new Map(actions.map(action => [action.id, action]));

  /** 沿两类回退边查找目标，避免编辑器生成直接或传递回退环。 */
  function reachesCurrent(startId: string): boolean {
    const pending = [startId];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const actionId = pending.pop()!;
      if (actionId === currentActionId) return true;
      if (visited.has(actionId)) continue;
      visited.add(actionId);
      const action = actionsById.get(actionId);
      if (action?.failureFallbackActionId) pending.push(action.failureFallbackActionId);
      if (action?.interruptedFallbackActionId) pending.push(action.interruptedFallbackActionId);
    }
    return false;
  }

  return actions.filter(action => (
    action.id !== currentActionId && !reachesCurrent(action.id)
  ));
}

/** 动作 Inspector 只维护行为策略；帧与 FPS 属于当前皮肤表现。 */
export function ActionInspector(props: ActionInspectorProps) {
  const candidates = fallbackOptions(props.actions, props.action.id);
  // 旧草稿未补 ID 的帧不能成为跨保存周期的提交标记候选。
  const stablePresentationFrames = props.presentation?.frames.filter(
    (frame): frame is typeof frame & { id: string } => typeof frame.id === 'string'
  ) ?? [];
  return (
    <form className="inspector-form action-properties" onSubmit={event => event.preventDefault()}>
      <label>
        动作名称
        <input
          value={props.action.name}
          maxLength={120}
          disabled={props.disabled}
          onChange={event => props.onChange({ name: event.currentTarget.value })}
        />
      </label>
      <label>
        动作详细描述
        <textarea
          value={props.action.description ?? ''}
          maxLength={2_000}
          disabled={props.disabled}
          onChange={event => props.onChange({
            description: event.currentTarget.value || undefined
          })}
        />
      </label>
      {props.onCommitFrameChange ? (
        <label>
          任务提交帧
          <select
            value={props.presentation?.commitFrameId ?? ''}
            disabled={props.disabled || !props.presentation}
            onChange={event => props.onCommitFrameChange?.(
              event.currentTarget.value || null
            )}
          >
            <option value="">不设置</option>
            {stablePresentationFrames.map(frame => (
              <option key={frame.id} value={frame.id}>{frame.id}</option>
            ))}
          </select>
          <span className="field-help">
            保留稳定帧标记；实际提交仍由 Main 的任务授权决定。
          </span>
        </label>
      ) : null}
      <TagEditor
        ownerId={props.action.id}
        ownerLabel="动作"
        tags={props.action.tags}
        disabled={props.disabled}
        onChange={tags => props.onChange({ tags })}
      />
      <div className="property-grid">
        <label>
          偏好权重
          <input
            type="number"
            min="0.01"
            max="100"
            step="0.01"
            value={props.action.preference}
            disabled={props.disabled}
            onChange={event => {
              const preference = Number(event.currentTarget.value);
              if (preference >= 0.01 && preference <= 100) props.onChange({ preference });
            }}
          />
        </label>
        <label>
          冷却时间（毫秒）
          <input
            type="number"
            min="0"
            max="86400000"
            step="1"
            value={props.action.cooldownMs}
            disabled={props.disabled}
            onChange={event => {
              const cooldownMs = Number(event.currentTarget.value);
              if (Number.isSafeInteger(cooldownMs) && cooldownMs >= 0 && cooldownMs <= 86_400_000) {
                props.onChange({ cooldownMs });
              }
            }}
          />
        </label>
      </div>
      <label>
        动作建议持续时间（毫秒）
        <input
          type="number"
          min="1"
          max="3600000"
          step="1"
          value={props.action.durationMs ?? ''}
          disabled={props.disabled}
          onChange={event => {
            if (!event.currentTarget.value) {
              props.onChange({ durationMs: undefined });
              return;
            }
            const durationMs = Number(event.currentTarget.value);
            if (
              Number.isSafeInteger(durationMs)
              && durationMs >= 1
              && durationMs <= 3_600_000
            ) {
              props.onChange({ durationMs });
            }
          }}
        />
      </label>
      <label>
        重复抑制（毫秒）
        <input
          type="number"
          min="0"
          max="86400000"
          step="1"
          value={props.action.repeatSuppressionMs}
          disabled={props.disabled}
          onChange={event => {
            const repeatSuppressionMs = Number(event.currentTarget.value);
            if (Number.isSafeInteger(repeatSuppressionMs) && repeatSuppressionMs >= 0 && repeatSuppressionMs <= 86_400_000) {
              props.onChange({ repeatSuppressionMs });
            }
          }}
        />
      </label>
      <label>
        循环策略
        <select
          value={props.action.loopPolicy}
          disabled={props.disabled}
          onChange={event => props.onChange({
            loopPolicy: event.currentTarget.value as CharacterActionDefinitionV3['loopPolicy']
          })}
        >
          <option value="never">不循环</option>
          <option value="presentation">遵循表现</option>
          <option value="until-interrupted">持续至中断</option>
        </select>
      </label>
      <label>
        中断策略
        <select
          value={props.action.interrupt}
          disabled={props.disabled}
          onChange={event => props.onChange({
            interrupt: event.currentTarget.value as CharacterActionDefinitionV3['interrupt']
          })}
        >
          <option value="normal">正常</option>
          <option value="resistant">抗中断</option>
        </select>
      </label>
      <label>
        动作失败回退
        <select
          value={props.action.failureFallbackActionId ?? ''}
          disabled={props.disabled}
          onChange={event => props.onChange({
            failureFallbackActionId: event.currentTarget.value || undefined
          })}
        >
          <option value="">不设置</option>
          {candidates.map(action => (
            <option key={action.id} value={action.id}>{action.name}</option>
          ))}
        </select>
      </label>
      <label>
        中断回退
        <select
          value={props.action.interruptedFallbackActionId ?? ''}
          disabled={props.disabled}
          onChange={event => props.onChange({
            interruptedFallbackActionId: event.currentTarget.value || undefined
          })}
        >
          <option value="">不设置</option>
          {candidates.map(action => (
            <option key={action.id} value={action.id}>{action.name}</option>
          ))}
        </select>
      </label>
      <label>
        朝向
        <select
          value={props.action.direction}
          disabled={props.disabled}
          onChange={event => props.onChange({
            direction: event.currentTarget.value as CharacterActionDefinitionV3['direction']
          })}
        >
          <option value="any">任意</option>
          <option value="left">向左</option>
          <option value="right">向右</option>
        </select>
      </label>
      <dl className="inspector-summary">
        <div><dt>动作标识</dt><dd>{props.action.id}</dd></div>
      </dl>
    </form>
  );
}
