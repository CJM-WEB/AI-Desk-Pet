import type { TaskPermissionRequiredEvent } from '@myself/shared-types';

export interface ConfirmationCardProps {
  action: TaskPermissionRequiredEvent;
  busy: boolean;
  onConfirm(): void;
  onCancel(): void;
}

/** 卡片只呈现 Main 校验后的准确目标；一次拒绝不等于撤销整个任务。 */
export function ConfirmationCard({ action, busy, onConfirm, onCancel }: ConfirmationCardProps) {
  const request = action.request;
  const deletion = request.action === 'delete';
  const label = request.action === 'bash' ? '确认运行命令' : deletion ? '确认移入回收站' : request.action === 'overwrite' ? '确认覆盖文件' : '确认访问目标';
  const explanation = deletion ? '目标将移入 Windows 回收站；已完成的其他操作不会撤销。'
    : request.action === 'overwrite' ? '本次操作将覆盖已有文件，请核对目标。'
    : request.action === 'external_directory' ? '本次请求超出原授权目录，仅确认当前具体访问。'
    : '命令以当前 Windows 用户权限在前台执行，请核对完整命令与工作目录。';
  return (
    <section className="confirmation-card" aria-label="具体操作许可">
      <span className="confirmation-eyebrow">需要你确认</span>
      <h2>{action.summary}</h2>
      {request.action === 'bash' ? <div className="confirmation-details"><span>工作目录</span><code>{request.cwd}</code><pre>{request.command}</pre></div>
        : <div className="confirmation-details">{request.resources.map(resource => <code key={resource}>{resource}</code>)}</div>}
      <p className="confirmation-safety">{explanation}</p>
      <div className="confirmation-actions">
        <button className={deletion ? 'danger-button' : 'primary-button'} type="button" disabled={busy} onClick={onConfirm}>{busy ? '正在处理…' : label}</button>
        <button className="quiet-button" type="button" disabled={busy} onClick={onCancel}>拒绝本次操作</button>
      </div>
    </section>
  );
}
