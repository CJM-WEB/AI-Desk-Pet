import { TRUSTED_CHARACTER_EVENTS_V3, type CharacterStateDefinitionV3, type TrustedCharacterEventV3 } from '@myself/character-runtime';
import { TagEditor } from './TagEditor';

export interface StateInspectorProps {
  state: CharacterStateDefinitionV3;
  allStates: CharacterStateDefinitionV3[];
  disabled: boolean;
  onChange(patch: Partial<CharacterStateDefinitionV3>): void;
}

/** 作者条件只编辑 Main 能验证的事件，保持名称、人设描述与事件规则独立。 */
export function StateInspector(props: StateInspectorProps) {
  return <form className="inspector-form state-properties" onSubmit={event => event.preventDefault()}>
    <label>状态名称<input value={props.state.name} maxLength={120} disabled={props.disabled}
      onChange={event => props.onChange({ name: event.currentTarget.value })} /></label>
    <label>状态详细描述<textarea value={props.state.description ?? ''} maxLength={2000} disabled={props.disabled}
      onChange={event => props.onChange({ description: event.currentTarget.value || undefined })} /></label>
    <TagEditor ownerId={props.state.id} ownerLabel="状态" tags={props.state.tags} disabled={props.disabled} onChange={tags => props.onChange({ tags })} />
    <div className="property-grid">
      <label>强度<input type="number" min={0} max={100} value={props.state.intensity} disabled={props.disabled}
        onChange={event => { const intensity = Number(event.currentTarget.value); if (Number.isInteger(intensity) && intensity >= 0 && intensity <= 100) props.onChange({ intensity }); }} /></label>
      <label>建议持续时间（毫秒）<input type="number" min={1} max={3600000} value={props.state.suggestedDurationMs ?? ''} disabled={props.disabled}
        onChange={event => { const value = event.currentTarget.value; const duration = Number(value); if (!value) props.onChange({ suggestedDurationMs: undefined }); else if (Number.isSafeInteger(duration) && duration > 0 && duration <= 3600000) props.onChange({ suggestedDurationMs: duration }); }} /></label>
    </div>
    <label className="toggle-row"><span>允许智能体推断</span><input type="checkbox" checked={props.state.agentInferable} disabled={props.disabled}
      onChange={event => props.onChange({ agentInferable: event.currentTarget.checked })} /></label>
    {(['enterConditions', 'exitConditions'] as const).map(key => {
      const label = key === 'enterConditions' ? '进入' : '退出';
      const conditions = props.state[key];
      return <fieldset key={key}><legend>{label}条件</legend>
        {conditions.map((condition, index) => <div key={index}>
          <label>{label}条件 {index + 1} 组合模式<select disabled={props.disabled} value={condition.mode}
            onChange={event => props.onChange({ [key]: conditions.map((item, i) => i === index ? { ...item, mode: event.currentTarget.value as 'all' | 'any' } : item) })}>
            <option value="all">全部满足</option><option value="any">任一满足</option>
          </select></label>
          {condition.clauses.map((clause, clauseIndex) => <div key={clauseIndex}>
            <label>{label}条件 {index + 1} 可信事件 {clauseIndex + 1}<select disabled={props.disabled} value={clause.event}
              onChange={event => props.onChange({ [key]: conditions.map((item, i) => i === index ? { ...item, clauses: item.clauses.map((candidate, j) => j === clauseIndex ? { kind: 'event', event: event.currentTarget.value as TrustedCharacterEventV3 } : candidate) } : item) })}>
              {TRUSTED_CHARACTER_EVENTS_V3.map(event => <option key={event} value={event}>{event}</option>)}
            </select></label>
            <button type="button" disabled={props.disabled} onClick={() => props.onChange({ [key]: condition.clauses.length === 1 ? conditions.filter((_, i) => i !== index) : conditions.map((item, i) => i === index ? { ...item, clauses: item.clauses.filter((_, j) => j !== clauseIndex) } : item) })}>删除事件</button>
          </div>)}
          <button type="button" disabled={props.disabled || condition.clauses.length >= 16} onClick={() => props.onChange({ [key]: conditions.map((item, i) => i === index ? { ...item, clauses: [...item.clauses, { kind: 'event', event: 'user-interaction' }] } : item) })}>添加事件</button>
          <button type="button" disabled={props.disabled} onClick={() => props.onChange({ [key]: conditions.filter((_, i) => i !== index) })}>删除{label}条件</button>
        </div>)}
        <button type="button" disabled={props.disabled || conditions.length >= 16} onClick={() => props.onChange({ [key]: [...conditions, { mode: 'all', clauses: [{ kind: 'event', event: 'user-interaction' }] }] })}>添加{label}条件</button>
      </fieldset>;
    })}
    <dl className="inspector-summary"><div><dt>状态标识</dt><dd>{props.state.id}</dd></div></dl>
  </form>;
}
