import { useEffect, useState } from 'react';
import {
  STANDARD_CHARACTER_SEMANTICS,
  TRUSTED_BEHAVIOR_SIGNALS,
  type CharacterStateDefinitionV2
} from '@myself/character-runtime';

export interface StateInspectorProps {
  state: CharacterStateDefinitionV2;
  allStates: CharacterStateDefinitionV2[];
  disabled: boolean;
  onChange(patch: Partial<CharacterStateDefinitionV2>): void;
}

type StateCondition = CharacterStateDefinitionV2['enterConditions'][number];
type StateConditionClause = StateCondition['clauses'][number];
type ConditionTarget = 'enter' | 'exit';

const SAFE_IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9_-]{0,119}$/;

interface StateReferenceEditorProps {
  title: string;
  labelVerb: string;
  labelSuffix?: string;
  states: CharacterStateDefinitionV2[];
  selectedIds: string[];
  disabled: boolean;
  onToggle(stateId: string, checked: boolean): void;
}

/** 状态引用只从当前草稿实体中选择，不接受自由文本 ID。 */
function StateReferenceEditor(props: StateReferenceEditorProps) {
  return (
    <fieldset className="state-reference-editor">
      <legend>{props.title}</legend>
      {props.states.length === 0 ? (
        <p className="field-help">当前没有可选状态。</p>
      ) : props.states.map(state => (
        <label key={state.id}>
          <input
            type="checkbox"
            checked={props.selectedIds.includes(state.id)}
            disabled={props.disabled}
            aria-label={`${props.labelVerb}“${state.name}”${props.labelSuffix ?? ''}`}
            onChange={event => props.onToggle(state.id, event.currentTarget.checked)}
          />
          <span>{state.name}</span>
        </label>
      ))}
    </fieldset>
  );
}

/** 完整维护已有条件组的组合模式和删除路径。 */
function ConditionGroupList(props: {
  target: ConditionTarget;
  conditions: StateCondition[];
  allStates: CharacterStateDefinitionV2[];
  catalogClause: StateConditionClause | null;
  disabled: boolean;
  onChange(conditions: StateCondition[]): void;
}) {
  const targetLabel = props.target === 'enter' ? '进入' : '退出';

  function replaceClause(
    conditionIndex: number,
    clauseIndex: number,
    clause: StateConditionClause
  ): void {
    props.onChange(props.conditions.map((condition, index) => (
      index === conditionIndex
        ? {
            ...condition,
            clauses: condition.clauses.map((candidate, candidateIndex) => (
              candidateIndex === clauseIndex ? clause : candidate
            ))
          }
        : condition
    )));
  }

  function defaultClause(kind: StateConditionClause['kind']): StateConditionClause | null {
    if (kind === 'signal') return { kind: 'signal', signal: 'idle' };
    if (kind === 'semantic') return { kind: 'semantic', semantic: 'idle' };
    const stateId = props.allStates[0]?.id;
    return stateId ? { kind: 'state', stateId } : null;
  }

  return (
    <ul className="condition-list" aria-label={`当前${targetLabel}条件`}>
      {props.conditions.map((condition, index) => (
        <li key={`${props.target}-${index}`} className="condition-list-item">
          <label>
            {targetLabel}条件 {index + 1} 组合模式
            <select
              value={condition.mode}
              disabled={props.disabled}
              onChange={event => props.onChange(props.conditions.map((candidate, candidateIndex) => (
                candidateIndex === index
                  ? { ...candidate, mode: event.currentTarget.value as StateCondition['mode'] }
                  : candidate
              )))}
            >
              <option value="all">全部满足</option>
              <option value="any">任一满足</option>
            </select>
          </label>
          <div className="condition-clause-list">
            {condition.clauses.map((clause, clauseIndex) => {
              const clauseLabel = `${targetLabel}条件 ${index + 1} 子句 ${clauseIndex + 1}`;
              return (
                <div key={`${props.target}-${index}-clause-${clauseIndex}`} className="condition-clause-item">
                  <label>
                    {clauseLabel} 类型
                    <select
                      value={clause.kind}
                      disabled={props.disabled}
                      onChange={event => {
                        const replacement = defaultClause(
                          event.currentTarget.value as StateConditionClause['kind']
                        );
                        if (replacement) replaceClause(index, clauseIndex, replacement);
                      }}
                    >
                      <option value="signal">可信 signal</option>
                      <option value="semantic">标准语义</option>
                      <option value="state" disabled={props.allStates.length === 0}>当前状态引用</option>
                    </select>
                  </label>
                  {clause.kind === 'signal' ? (
                    <label>
                      {clauseLabel} 可信 signal
                      <select
                        value={clause.signal}
                        disabled={props.disabled}
                        onChange={event => replaceClause(index, clauseIndex, {
                          kind: 'signal',
                          signal: event.currentTarget.value as typeof TRUSTED_BEHAVIOR_SIGNALS[number]
                        })}
                      >
                        {TRUSTED_BEHAVIOR_SIGNALS.map(candidate => (
                          <option key={candidate} value={candidate}>{candidate}</option>
                        ))}
                      </select>
                    </label>
                  ) : clause.kind === 'semantic' ? (
                    <label>
                      {clauseLabel} 标准语义
                      <select
                        value={clause.semantic}
                        disabled={props.disabled}
                        onChange={event => replaceClause(index, clauseIndex, {
                          kind: 'semantic',
                          semantic: event.currentTarget.value as typeof STANDARD_CHARACTER_SEMANTICS[number]
                        })}
                      >
                        {STANDARD_CHARACTER_SEMANTICS.map(semantic => (
                          <option key={semantic} value={semantic}>{semantic}</option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <label>
                      {clauseLabel} 当前状态引用
                      <select
                        value={clause.stateId}
                        disabled={props.disabled}
                        onChange={event => replaceClause(index, clauseIndex, {
                          kind: 'state', stateId: event.currentTarget.value
                        })}
                      >
                        {props.allStates.map(state => (
                          <option key={state.id} value={state.id}>{state.name}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  <button
                    type="button"
                    disabled={props.disabled}
                    aria-label={`删除${clauseLabel}`}
                    onClick={() => props.onChange(
                      condition.clauses.length === 1
                        ? props.conditions.filter((_, conditionIndex) => conditionIndex !== index)
                        : props.conditions.map((candidate, conditionIndex) => (
                            conditionIndex === index
                              ? {
                                  ...candidate,
                                  clauses: candidate.clauses.filter(
                                    (_, candidateIndex) => candidateIndex !== clauseIndex
                                  )
                                }
                              : candidate
                          ))
                    )}
                  >
                    删除子句
                  </button>
                </div>
              );
            })}
          </div>
          <button
            type="button"
            disabled={props.disabled || !props.catalogClause || condition.clauses.length >= 16}
            aria-label={`向${targetLabel}条件 ${index + 1} 添加当前子句`}
            onClick={() => {
              if (!props.catalogClause) return;
              props.onChange(props.conditions.map((candidate, conditionIndex) => (
                conditionIndex === index
                  ? { ...candidate, clauses: [...candidate.clauses, props.catalogClause!] }
                  : candidate
              )));
            }}
          >
            添加当前子句
          </button>
          <button
            type="button"
            disabled={props.disabled}
            aria-label={`删除${targetLabel}条件 ${index + 1}`}
            onClick={() => props.onChange(
              props.conditions.filter((_, candidateIndex) => candidateIndex !== index)
            )}
          >
            删除
          </button>
        </li>
      ))}
    </ul>
  );
}

/** 条件值仅允许协议可信信号、标准语义或当前草稿中的状态引用。 */
export function StateInspector(props: StateInspectorProps) {
  const [conditionTarget, setConditionTarget] = useState<ConditionTarget>('enter');
  const [conditionMode, setConditionMode] = useState<StateCondition['mode']>('all');
  const [conditionKind, setConditionKind] = useState<StateConditionClause['kind']>('signal');
  const [signal, setSignal] = useState<typeof TRUSTED_BEHAVIOR_SIGNALS[number]>('idle');
  const [conditionSemantic, setConditionSemantic] = useState<
    typeof STANDARD_CHARACTER_SEMANTICS[number]
  >('idle');
  const [conditionStateId, setConditionStateId] = useState(props.allStates[0]?.id ?? '');
  const semanticKind = typeof props.state.semantic === 'string' ? 'standard' : 'custom';
  const referenceStates = props.allStates.filter(state => state.id !== props.state.id);

  /** 候选集合变化时立即收敛本地选择，避免已删除状态 ID 再次写回草稿。 */
  useEffect(() => {
    if (props.allStates.some(state => state.id === conditionStateId)) return;
    setConditionStateId(props.allStates[0]?.id ?? '');
  }, [conditionStateId, props.allStates]);

  function currentClause(): StateConditionClause | null {
    if (conditionKind === 'signal') return { kind: 'signal', signal };
    if (conditionKind === 'semantic') {
      return { kind: 'semantic', semantic: conditionSemantic };
    }
    return props.allStates.some(state => state.id === conditionStateId)
      ? { kind: 'state', stateId: conditionStateId }
      : null;
  }

  function addCondition(): void {
    const clause = currentClause();
    if (!clause) return;
    const field = conditionTarget === 'enter' ? 'enterConditions' : 'exitConditions';
    props.onChange({
      [field]: [...props.state[field], { mode: conditionMode, clauses: [clause] }]
    });
  }

  function toggleReference(
    field: 'coexistWithStateIds' | 'forbiddenStateIds',
    oppositeField: 'coexistWithStateIds' | 'forbiddenStateIds',
    stateId: string,
    checked: boolean
  ): void {
    props.onChange({
      [field]: checked
        ? [...props.state[field], stateId]
        : props.state[field].filter(id => id !== stateId),
      [oppositeField]: checked
        ? props.state[oppositeField].filter(id => id !== stateId)
        : props.state[oppositeField]
    });
  }

  return (
    <form className="inspector-form" onSubmit={event => event.preventDefault()}>
      <label>
        状态名称
        <input
          value={props.state.name}
          maxLength={120}
          disabled={props.disabled}
          onChange={event => props.onChange({ name: event.currentTarget.value })}
        />
      </label>
      <label>
        状态类别
        <select
          value={props.state.kind}
          disabled={props.disabled}
          onChange={event => props.onChange({
            kind: event.currentTarget.value as CharacterStateDefinitionV2['kind']
          })}
        >
          <option value="primary">主状态</option>
          <option value="modifier">修饰状态</option>
        </select>
      </label>
      <label>
        语义类型
        <select
          value={semanticKind}
          disabled={props.disabled}
          onChange={event => props.onChange({
            semantic: event.currentTarget.value === 'custom'
              ? { kind: 'custom', value: 'custom-state' }
              : 'idle'
          })}
        >
          <option value="standard">标准语义</option>
          <option value="custom">自定义语义</option>
        </select>
      </label>
      {semanticKind === 'standard' ? (
        <label>
          标准语义
          <select
            value={props.state.semantic as typeof STANDARD_CHARACTER_SEMANTICS[number]}
            disabled={props.disabled}
            onChange={event => props.onChange({
              semantic: event.currentTarget.value as typeof STANDARD_CHARACTER_SEMANTICS[number]
            })}
          >
            {STANDARD_CHARACTER_SEMANTICS.map(semantic => (
              <option key={semantic} value={semantic}>{semantic}</option>
            ))}
          </select>
        </label>
      ) : (
        <label>
          自定义语义
          <input
            value={typeof props.state.semantic === 'string' ? '' : props.state.semantic.value}
            maxLength={120}
            pattern="[a-z0-9][a-z0-9_-]{0,119}"
            disabled={props.disabled}
            onChange={event => {
              const value = event.currentTarget.value;
              if (SAFE_IDENTIFIER_PATTERN.test(value)) {
                props.onChange({ semantic: { kind: 'custom', value } });
              }
            }}
          />
        </label>
      )}
      <div className="property-grid">
        <label>
          强度
          <input
            type="number"
            min="0"
            max="100"
            value={props.state.intensity}
            disabled={props.disabled}
            onChange={event => {
              const intensity = Number(event.currentTarget.value);
              if (intensity >= 0 && intensity <= 100) props.onChange({ intensity });
            }}
          />
        </label>
        <label>
          建议持续时间（毫秒）
          <input
            type="number"
            min="1"
            max="3600000"
            step="1"
            value={props.state.suggestedDurationMs ?? ''}
            disabled={props.disabled}
            onChange={event => {
              if (!event.currentTarget.value) {
                props.onChange({ suggestedDurationMs: undefined });
                return;
              }
              const suggestedDurationMs = Number(event.currentTarget.value);
              if (
                Number.isSafeInteger(suggestedDurationMs)
                && suggestedDurationMs > 0
                && suggestedDurationMs <= 3_600_000
              ) props.onChange({ suggestedDurationMs });
            }}
          />
        </label>
      </div>
      <div className="state-reference-grid">
        <StateReferenceEditor
          title="可共存状态"
          labelVerb="允许与状态"
          labelSuffix="共存"
          states={referenceStates}
          selectedIds={props.state.coexistWithStateIds}
          disabled={props.disabled}
          onToggle={(stateId, checked) => toggleReference(
            'coexistWithStateIds', 'forbiddenStateIds', stateId, checked
          )}
        />
        <StateReferenceEditor
          title="禁止状态"
          labelVerb="禁止状态"
          states={referenceStates}
          selectedIds={props.state.forbiddenStateIds}
          disabled={props.disabled}
          onToggle={(stateId, checked) => toggleReference(
            'forbiddenStateIds', 'coexistWithStateIds', stateId, checked
          )}
        />
      </div>
      <label className="toggle-row">
        <span><strong>允许智能体推断</strong><small>仅影响受信任的结构化推断。</small></span>
        <input
          type="checkbox"
          checked={props.state.agentInferable}
          disabled={props.disabled}
          onChange={event => props.onChange({ agentInferable: event.currentTarget.checked })}
        />
      </label>
      <fieldset className="condition-catalog">
        <legend>状态条件</legend>
        <div className="property-grid">
          <label>
            新增条件位置
            <select
              value={conditionTarget}
              disabled={props.disabled}
              onChange={event => setConditionTarget(event.currentTarget.value as ConditionTarget)}
            >
              <option value="enter">进入</option>
              <option value="exit">退出</option>
            </select>
          </label>
          <label>
            新增条件组合模式
            <select
              value={conditionMode}
              disabled={props.disabled}
              onChange={event => setConditionMode(event.currentTarget.value as StateCondition['mode'])}
            >
              <option value="all">全部满足</option>
              <option value="any">任一满足</option>
            </select>
          </label>
        </div>
        <label>
          {conditionTarget === 'enter' ? '进入' : '退出'}条件类型
          <select
            value={conditionKind}
            disabled={props.disabled}
            onChange={event => setConditionKind(event.currentTarget.value as StateConditionClause['kind'])}
          >
            <option value="signal">可信 signal</option>
            <option value="semantic">标准语义</option>
            <option value="state">当前状态引用</option>
          </select>
        </label>
        {conditionKind === 'signal' ? (
          <label>
            可信 signal
            <select
              value={signal}
              disabled={props.disabled}
              onChange={event => setSignal(event.currentTarget.value as typeof signal)}
            >
              {TRUSTED_BEHAVIOR_SIGNALS.map(candidate => (
                <option key={candidate} value={candidate}>{candidate}</option>
              ))}
            </select>
          </label>
        ) : conditionKind === 'semantic' ? (
          <label>
            条件标准语义
            <select
              value={conditionSemantic}
              disabled={props.disabled}
              onChange={event => setConditionSemantic(
                event.currentTarget.value as typeof conditionSemantic
              )}
            >
              {STANDARD_CHARACTER_SEMANTICS.map(semantic => (
                <option key={semantic} value={semantic}>{semantic}</option>
              ))}
            </select>
          </label>
        ) : (
          <label>
            当前状态引用
            <select
              value={conditionStateId}
              disabled={props.disabled}
              onChange={event => setConditionStateId(event.currentTarget.value)}
            >
              <option value="">请选择状态</option>
              {props.allStates.map(state => (
                <option key={state.id} value={state.id}>{state.name}</option>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          disabled={
            props.disabled
            || props.state[conditionTarget === 'enter' ? 'enterConditions' : 'exitConditions'].length >= 16
            || (conditionKind === 'state' && !props.allStates.some(
              state => state.id === conditionStateId
            ))
          }
          onClick={addCondition}
        >
          添加{conditionTarget === 'enter' ? '进入' : '退出'}条件
        </button>
        <p className="field-help">条件只接受受信任的枚举值，不接收自由文本。</p>
        <ConditionGroupList
          target="enter"
          conditions={props.state.enterConditions}
          allStates={props.allStates}
          catalogClause={currentClause()}
          disabled={props.disabled}
          onChange={enterConditions => props.onChange({ enterConditions })}
        />
        <ConditionGroupList
          target="exit"
          conditions={props.state.exitConditions}
          allStates={props.allStates}
          catalogClause={currentClause()}
          disabled={props.disabled}
          onChange={exitConditions => props.onChange({ exitConditions })}
        />
      </fieldset>
    </form>
  );
}
