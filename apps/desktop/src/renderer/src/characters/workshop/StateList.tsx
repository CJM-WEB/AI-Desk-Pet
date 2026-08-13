import { Minus, Plus } from 'lucide-react';
import type {
  CharacterActionDefinitionV2,
  CharacterStateDefinitionV2
} from '@myself/character-runtime';

export interface StateListProps {
  states: CharacterStateDefinitionV2[];
  actions: CharacterActionDefinitionV2[];
  defaultStateId: string;
  selectedStateId: string | null;
  selectedActionId: string | null;
  disabled: boolean;
  onSelectState(stateId: string): void;
  onSelectAction(actionId: string): void;
  onAddAction(stateId: string): void;
  onRequestDeleteState(stateId: string): void;
  onRequestDeleteAction(actionId: string): void;
}

/** V2 状态树以状态和动作实体 ID 为唯一列表身份。 */
export function StateList(props: StateListProps) {
  const actionsById = new Map(props.actions.map(action => [action.id, action]));
  if (props.states.length === 0) {
    return <p className="workshop-empty">当前角色还没有状态</p>;
  }

  return (
    <ul className="state-list" aria-label="状态与动作列表">
      {props.states.map(state => {
        const actions = state.actionIds.flatMap(actionId => {
          const action = actionsById.get(actionId);
          return action ? [action] : [];
        });
        return (
          <li key={state.id}>
            <div className="state-row">
              <button
                className="state-select"
                type="button"
                aria-pressed={state.id === props.selectedStateId}
                disabled={props.disabled}
                onClick={() => props.onSelectState(state.id)}
              >
                <span>{state.name}</span>
                <small>{state.kind === 'primary' ? '主状态' : '修饰状态'}</small>
              </button>
              <div className="state-row-commands">
                <button
                  type="button"
                  aria-label={`向“${state.name}”添加动作`}
                  title={`向“${state.name}”添加动作`}
                  disabled={props.disabled}
                  onClick={() => props.onAddAction(state.id)}
                >
                  <Plus size={16} aria-hidden="true" />
                </button>
                {state.id !== props.defaultStateId ? (
                  <button
                    className="danger-icon"
                    type="button"
                    aria-label={`删除状态“${state.name}”`}
                    title={`删除状态“${state.name}”`}
                    disabled={props.disabled}
                    onClick={() => props.onRequestDeleteState(state.id)}
                  >
                    <Minus size={16} aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            </div>
            {state.id === props.selectedStateId && actions.length > 0 ? (
              <ul className="action-list" aria-label={`${state.name}动作`}>
                {actions.map(action => (
                  <li key={action.id}>
                    <div className="action-row">
                      <button
                        className="action-select"
                        type="button"
                        aria-pressed={action.id === props.selectedActionId}
                        disabled={props.disabled}
                        onClick={() => props.onSelectAction(action.id)}
                      >
                        {action.name}
                      </button>
                      <div className="action-row-commands">
                        <button
                          className="danger-icon"
                          type="button"
                          aria-label={`删除动作“${action.name}”`}
                          title={`删除动作“${action.name}”`}
                          disabled={props.disabled}
                          onClick={() => props.onRequestDeleteAction(action.id)}
                        >
                          <Minus size={16} aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
