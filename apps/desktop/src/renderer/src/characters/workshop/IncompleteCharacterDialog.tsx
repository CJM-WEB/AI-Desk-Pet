import type { CoreCharacterState } from '@myself/character-runtime';
import { useEffect, useRef } from 'react';

export interface IncompleteCharacterDialogProps {
  characterName: string;
  missingStates: readonly CoreCharacterState[];
  onCancel(): void;
  onConfirm(): void;
}

/**
 * 对话框只收集明确同意，确认指纹由 Main 计算并持久化。
 */
export function IncompleteCharacterDialog(
  props: IncompleteCharacterDialogProps
) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (!dialogRef.current?.open) dialogRef.current?.showModal();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      aria-modal="true"
      aria-labelledby="incomplete-character-title"
      onCancel={event => {
        event.preventDefault();
        props.onCancel();
      }}
    >
      <div className="workshop-dialog">
        <h2 id="incomplete-character-title">部分动作尚未配置</h2>
        <p>
          “{props.characterName}”缺少 {props.missingStates.length} 个核心状态。
          缺少动画的状态将暂时播放“待机”动作。
        </p>
        <div className="missing-state-list">
          {props.missingStates.map(state => <span key={state}>{state}</span>)}
        </div>
        <div className="dialog-actions">
          <button type="button" autoFocus onClick={props.onCancel}>
            返回完善
          </button>
          <button className="primary-command" type="button" onClick={props.onConfirm}>
            仍然使用
          </button>
        </div>
      </div>
    </dialog>
  );
}
