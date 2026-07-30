import type {
  CharacterDraftStateDefinition,
  CharacterStateId
} from '@myself/character-runtime';

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
}

export function StateList(props: StateListProps) {
  if (props.states.length === 0) {
    return <p className="workshop-empty">当前角色还没有状态</p>;
  }

  return (
    <ul className="state-list" aria-label="状态与动作列表">
      {props.states.map(state => (
        <li key={state.id}>
          <button
            className="state-select"
            type="button"
            aria-pressed={state.id === props.selectedStateId}
            disabled={props.disabled}
            onClick={() => props.onSelectState(state.id)}
          >
            <span>{stateLabels[state.id] ?? state.id.replace(/^custom:/u, '')}</span>
            <small>{state.actions.length}</small>
          </button>
          {state.id === props.selectedStateId && state.actions.length > 0 ? (
            <ul className="action-list" aria-label={`${stateLabels[state.id] ?? state.id}动作`}>
              {state.actions.map(action => (
                <li key={action.id}>
                  <button
                    type="button"
                    aria-pressed={action.id === props.selectedActionId}
                    disabled={props.disabled}
                    onClick={() => props.onSelectAction(action.id)}
                  >
                    {action.name}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
