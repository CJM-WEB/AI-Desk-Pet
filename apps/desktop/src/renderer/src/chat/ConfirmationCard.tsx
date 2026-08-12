import type { PendingAction } from '@myself/shared-types';

export interface ConfirmationCardProps {
  action: PendingAction;
  busy: boolean;
  onConfirm(): void;
  onCancel(): void;
}

function assertNever(value: never): never {
  throw new Error(`未处理的确认动作：${String(value)}`);
}

function actionLabels(action: PendingAction): { confirm: string; cancel: string } {
  // 文案只信任 Main 下发的结构化操作，不解析模型生成的 summary。
  switch (action.operation) {
    case 'create_file':
      return { confirm: '确认创建文件', cancel: '先不创建' };
    case 'apply_patch':
      return { confirm: '确认应用补丁', cancel: '先不修改' };
    case 'delete_file':
      return { confirm: '确认删除', cancel: '先不删除' };
    default:
      return assertNever(action);
  }
}

function safetyMessage(action: PendingAction): string {
  switch (action.operation) {
    case 'create_file':
      return '不会覆盖已有文件；执行前还会再次检查。';
    case 'apply_patch':
      return '仅修改已有文件；执行前还会再次进行冲突校验。';
    case 'delete_file':
      return '将移入 Windows 回收站，可从回收站恢复；执行前还会再次检查。';
    default:
      return assertNever(action);
  }
}

export function ConfirmationCard({ action, busy, onConfirm, onCancel }: ConfirmationCardProps) {
  const labels = actionLabels(action);
  const isDelete = action.operation === 'delete_file';
  return (
    <section className="confirmation-card" aria-labelledby="confirmation-title">
      <span className="confirmation-eyebrow">需要你确认</span>
      <h2 id="confirmation-title">{action.summary}</h2>
      <div className="path-row">
        <span>{isDelete ? '待移入项目' : '目标位置'}</span>
        <code>{action.targetRelativePath}</code>
      </div>
      {action.operation === 'create_file' ? (
        <div className="confirmation-details">
          <span>内容：{action.contentCharacters} 个字符</span>
          {action.contentPreview === null ? null : <pre>{action.contentPreview}</pre>}
          {action.previewTruncated ? <span>预览已截断</span> : null}
        </div>
      ) : action.operation === 'apply_patch' ? (
        <div className="confirmation-details">
          <span>新增 {action.addedLines} 行，删除 {action.removedLines} 行</span>
          <pre>{action.diffPreview}</pre>
          {action.previewTruncated ? <span>预览已截断</span> : null}
        </div>
      ) : null}
      <p className="confirmation-safety">{safetyMessage(action)}</p>
      <div className="confirmation-actions">
        <button
          className={isDelete ? 'danger-button' : 'primary-button'}
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
