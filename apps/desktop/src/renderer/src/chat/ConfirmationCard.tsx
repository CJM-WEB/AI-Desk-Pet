import type { PendingAction } from '@myself/shared-types';

export interface ConfirmationCardProps {
  action: PendingAction;
  busy: boolean;
  onConfirm(): void;
  onCancel(): void;
}

function actionLabels(action: PendingAction): { confirm: string; cancel: string } {
  if (action.sourceRelativePath) {
    return { confirm: '确认重命名', cancel: '先不重命名' };
  }
  if (action.summary.includes('目录')) {
    return { confirm: '确认创建目录', cancel: '先不创建' };
  }
  return { confirm: '确认创建文件', cancel: '先不创建' };
}

export function ConfirmationCard({ action, busy, onConfirm, onCancel }: ConfirmationCardProps) {
  const labels = actionLabels(action);
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
        <span>目标位置</span>
        <code>{action.targetRelativePath}</code>
      </div>
      <p className="confirmation-safety">不会覆盖已有文件；执行前还会再次检查。</p>
      <div className="confirmation-actions">
        <button className="primary-button" type="button" disabled={busy} onClick={onConfirm}>
          {busy ? '正在处理…' : labels.confirm}
        </button>
        <button className="quiet-button" type="button" disabled={busy} onClick={onCancel}>
          {labels.cancel}
        </button>
      </div>
    </section>
  );
}
