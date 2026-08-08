import {
  STANDARD_CHARACTER_SEMANTICS,
  type CharacterActionDefinitionV2,
  type CharacterActionPresentationV2,
  type CharacterStateDefinitionV2
} from '@myself/character-runtime';
import { TagEditor } from './TagEditor';

export interface ActionInspectorProps {
  action: CharacterActionDefinitionV2;
  actions: CharacterActionDefinitionV2[];
  states: CharacterStateDefinitionV2[];
  presentation?: Pick<CharacterActionPresentationV2, 'frames' | 'commitFrameId'> | null;
  disabled: boolean;
  onChange(patch: Partial<CharacterActionDefinitionV2>): void;
  onCommitFrameChange?(frameId: string | null): void;
}

function fallbackOptions(
  actions: CharacterActionDefinitionV2[],
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

type StateReferenceKey =
  | 'allowedPrimaryStateIds'
  | 'forbiddenPrimaryStateIds'
  | 'requiredModifierStateIds'
  | 'forbiddenModifierStateIds';

interface StateReferenceEditorProps {
  title: string;
  labelVerb: string;
  states: CharacterStateDefinitionV2[];
  selectedIds: string[];
  disabled: boolean;
  onChange(ids: string[]): void;
}

/** 统一维护动作的状态 ID 集合，始终以稳定 state.id 作为值与 React key。 */
function StateReferenceEditor(props: StateReferenceEditorProps) {
  return (
    <fieldset className="state-reference-editor">
      <legend>{props.title}</legend>
      {props.states.length === 0 ? (
        <p className="field-help">当前没有可选状态。</p>
      ) : props.states.map(state => {
        const checked = props.selectedIds.includes(state.id);
        return (
          <label key={state.id}>
            <input
              type="checkbox"
              checked={checked}
              disabled={props.disabled}
              aria-label={`${props.labelVerb}“${state.name}”`}
              onChange={() => props.onChange(
                checked
                  ? props.selectedIds.filter(id => id !== state.id)
                  : [...props.selectedIds, state.id]
              )}
            />
            <span>{state.name}</span>
          </label>
        );
      })}
    </fieldset>
  );
}

/** 动作 Inspector 只维护行为策略；帧与 FPS 属于当前皮肤表现。 */
export function ActionInspector(props: ActionInspectorProps) {
  const candidates = fallbackOptions(props.actions, props.action.id);
  // 旧草稿未补 ID 的帧不能成为跨保存周期的提交标记候选。
  const stablePresentationFrames = props.presentation?.frames.filter(
    (frame): frame is typeof frame & { id: string } => typeof frame.id === 'string'
  ) ?? [];
  const primaryStates = props.states.filter(state => state.kind === 'primary');
  const modifierStates = props.states.filter(state => state.kind === 'modifier');
  const updateStateReferences = (key: StateReferenceKey, ids: string[]) => {
    props.onChange({ [key]: ids });
  };
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
        动作语义
        <select
          value={props.action.semantic}
          disabled={props.disabled}
          onChange={event => props.onChange({
            semantic: event.currentTarget.value as typeof STANDARD_CHARACTER_SEMANTICS[number]
          })}
        >
          {STANDARD_CHARACTER_SEMANTICS.map(semantic => (
            <option key={semantic} value={semantic}>{semantic}</option>
          ))}
        </select>
        <span className="field-help">藏身语义只影响动作表现与素材播放，不授予目录能力。</span>
      </label>
      {props.action.semantic === 'carry' ? (
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
            文件任务只会在该稳定帧到达时提交；普通搬运动画不会触发文件操作。
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
            loopPolicy: event.currentTarget.value as CharacterActionDefinitionV2['loopPolicy']
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
            interrupt: event.currentTarget.value as CharacterActionDefinitionV2['interrupt']
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
            direction: event.currentTarget.value as CharacterActionDefinitionV2['direction']
          })}
        >
          <option value="any">任意</option>
          <option value="left">向左</option>
          <option value="right">向右</option>
        </select>
      </label>
      <div className="state-reference-grid">
        <StateReferenceEditor
          title="允许的主状态"
          labelVerb="允许主状态"
          states={primaryStates}
          selectedIds={props.action.allowedPrimaryStateIds}
          disabled={props.disabled}
          onChange={ids => updateStateReferences('allowedPrimaryStateIds', ids)}
        />
        <StateReferenceEditor
          title="禁止的主状态"
          labelVerb="禁止主状态"
          states={primaryStates}
          selectedIds={props.action.forbiddenPrimaryStateIds}
          disabled={props.disabled}
          onChange={ids => updateStateReferences('forbiddenPrimaryStateIds', ids)}
        />
        <StateReferenceEditor
          title="要求的修饰状态"
          labelVerb="要求修饰状态"
          states={modifierStates}
          selectedIds={props.action.requiredModifierStateIds}
          disabled={props.disabled}
          onChange={ids => updateStateReferences('requiredModifierStateIds', ids)}
        />
        <StateReferenceEditor
          title="禁止的修饰状态"
          labelVerb="禁止修饰状态"
          states={modifierStates}
          selectedIds={props.action.forbiddenModifierStateIds}
          disabled={props.disabled}
          onChange={ids => updateStateReferences('forbiddenModifierStateIds', ids)}
        />
      </div>
      <dl className="inspector-summary">
        <div><dt>动作标识</dt><dd>{props.action.id}</dd></div>
      </dl>
    </form>
  );
}
