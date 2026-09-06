import type { TaskPermissionRequiredEvent } from '@myself/shared-types';

export interface ConfirmationCardProps {
  action: TaskPermissionRequiredEvent;
  busy: boolean;
  onConfirm(): void;
  onCancel(): void;
}

/** 卡片只呈现 Main 校验后的决策字段；循环结束与普通单次拒绝显式区分。 */
export function ConfirmationCard({ action, busy, onConfirm, onCancel }: ConfirmationCardProps) {
  const request = action.request;
  const deletion = request.action === 'delete';
  const loop = request.action === 'doom_loop';
  const label = loop ? '仅继续这一次' : request.action === 'bash' ? '确认运行命令' : deletion ? '确认移入回收站' : request.action === 'overwrite' ? '确认覆盖文件' : '确认访问目标';
  const explanation = loop ? '同一操作连续重复；继续仅放行本次，原文件和命令许可仍有效。' : deletion ? '目标将移入 Windows 回收站；已完成的其他操作不会撤销。'
    : request.action === 'overwrite' ? '本次操作将覆盖已有文件，请核对目标。'
    : request.action === 'external_directory' ? '本次请求超出原授权目录，仅确认当前具体访问。'
    : '命令以当前 Windows 用户权限在前台执行，请核对完整命令与工作目录。';
  return (
    <section className="confirmation-card" aria-label="具体操作许可">
      <span className="confirmation-eyebrow">需要你确认</span>
      <h2>{action.summary}</h2>
      {request.action === 'doom_loop' ? <div className="confirmation-details"><code>{request.tool}</code><span>连续 {request.repeatCount} 次</span></div>
        : request.action === 'bash' ? <div className="confirmation-details"><span>工作目录</span><code>{request.cwd}</code><pre>{request.command}</pre></div>
        : <div className="confirmation-details">{request.resources.map(resource => <code key={resource}>{resource}</code>)}</div>}
      <p className="confirmation-safety">{explanation}</p>
      {loop ? <p className="confirmation-safety">结束当前任务不会撤销已完成的本地操作。</p> : null}
      <div className="confirmation-actions">
        <button className={deletion ? 'danger-button' : 'primary-button'} type="button" disabled={busy} onClick={onConfirm}>{busy ? '正在处理…' : label}</button>
        <button className="quiet-button" type="button" disabled={busy} onClick={onCancel}>{loop ? '结束当前任务' : '拒绝本次操作'}</button>
      </div>
    </section>
  );
}
