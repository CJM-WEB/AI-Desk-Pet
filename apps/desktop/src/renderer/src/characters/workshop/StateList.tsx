import type {
  CharacterDraftStateDefinition,
  CharacterStateId,
  DraftActionClip
} from '@myself/character-runtime';
import { Minus, Plus } from 'lucide-react';

const stateLabels: Record<string, string> = {
  idle: '待机',
  listening: '倾听',
  thinking: '思考',
  moving: '移动',
  acting: '行动',
  carrying: '搬运',
  success: '成功',
  error: '错误'
};

export interface StateListProps {
  states: CharacterDraftStateDefinition[];
  selectedStateId: CharacterStateId | null;
  selectedActionId: string | null;
  disabled: boolean;
  onSelectState(stateId: CharacterStateId): void;
  onSelectAction(actionId: string): void;
  onAddAction(stateId: CharacterStateId): void;
  onRequestDeleteState(state: CharacterDraftStateDefinition): void;
  onRequestDeleteAction(
    stateId: CharacterStateId,
    action: DraftActionClip
  ): void;
}

function stateName(state: CharacterDraftStateDefinition): string {
  return stateLabels[state.id] ?? state.id.replace(/^custom:/u, '');
}

export function StateList(props: StateListProps) {
  if (props.states.length === 0) {
    return <p className="workshop-empty">当前角色还没有状态</p>;
  }

  return (
    <ul className="state-list" aria-label="状态与动作列表">
      {props.states.map(state => (
        <li key={state.id}>
          <div className="state-row">
            <button
              className="state-select"
              type="button"
              aria-pressed={state.id === props.selectedStateId}
              disabled={props.disabled}
              onClick={() => props.onSelectState(state.id)}
            >
              <span>{stateName(state)}</span>
              <small>{state.actions.length}</small>
            </button>
            <div className="state-row-commands">
              <button
                type="button"
                aria-label={`向“${stateName(state)}”添加动作`}
                title={`向“${stateName(state)}”添加动作`}
                disabled={props.disabled}
                onClick={() => props.onAddAction(state.id)}
              >
                <Plus size={16} aria-hidden="true" />
              </button>
              {state.kind === 'extension' ? (
                <button
                  className="danger-icon"
                  type="button"
                  aria-label={`删除扩展状态“${stateName(state)}”`}
                  title={`删除扩展状态“${stateName(state)}”`}
                  disabled={props.disabled}
                  onClick={() => props.onRequestDeleteState(state)}
                >
                  <Minus size={16} aria-hidden="true" />
                </button>
              ) : null}
            </div>
          </div>
          {state.id === props.selectedStateId && state.actions.length > 0 ? (
            <ul className="action-list" aria-label={`${stateName(state)}动作`}>
              {state.actions.map(action => (
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
                        onClick={() => props.onRequestDeleteAction(state.id, action)}
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
      ))}
    </ul>
  );
}
