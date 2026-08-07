import type { PendingAction } from '@myself/shared-types';

export interface ConfirmationCardProps {
  action: PendingAction;
  busy: boolean;
  onConfirm(): void;
  onCancel(): void;
}

function actionLabels(action: PendingAction): { confirm: string; cancel: string } {
  // 文案只信任 Main 下发的结构化操作，不解析模型生成的 summary。
  switch (action.operation) {
    case 'create_file':
      return { confirm: '确认创建文件', cancel: '先不创建' };
    case 'create_directory':
      return { confirm: '确认创建目录', cancel: '先不创建' };
    case 'rename_entry':
      return { confirm: '确认重命名', cancel: '先不重命名' };
    case 'move_to_recycle_bin':
      return { confirm: '确认移入回收站', cancel: '先不移入' };
  }
}

export function ConfirmationCard({ action, busy, onConfirm, onCancel }: ConfirmationCardProps) {
  const labels = actionLabels(action);
  const isRecycleBin = action.operation === 'move_to_recycle_bin';
  return (
    <section className="confirmation-card" aria-labelledby="confirmation-title">
      <span className="confirmation-eyebrow">需要你确认</span>
      <h2 id="confirmation-title">{action.summary}</h2>
      {action.sourceRelativePath ? (
        <div className="path-row">
          <span>原位置</span>
          <code>{action.sourceRelativePath}</code>
        </div>
      ) : null}
      <div className="path-row">
        <span>{isRecycleBin ? '待移入项目' : '目标位置'}</span>
        <code>{action.targetRelativePath}</code>
      </div>
      <p className="confirmation-safety">
        {isRecycleBin
          ? '将移入 Windows 回收站，可从回收站恢复；执行前还会再次检查。'
          : '不会覆盖已有文件；执行前还会再次检查。'}
      </p>
      <div className="confirmation-actions">
        <button
          className={isRecycleBin ? 'danger-button' : 'primary-button'}
          type="button"
          disabled={busy}
          onClick={onConfirm}
        >
          {busy ? '正在处理…' : labels.confirm}
        </button>
        <button className="quiet-button" type="button" disabled={busy} onClick={onCancel}>
          {labels.cancel}
        </button>
      </div>
    </section>
  );
}
