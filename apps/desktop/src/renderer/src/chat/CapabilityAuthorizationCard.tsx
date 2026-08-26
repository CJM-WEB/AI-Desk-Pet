import type { PendingCapabilityAuthorization } from '../stores/task-store';

export function CapabilityAuthorizationCard({
  authorization,
  busy,
  onConfirm,
  onCancel
}: {
  authorization: PendingCapabilityAuthorization;
  busy: boolean;
  onConfirm(): void;
  onCancel(): void;
}) {
  return (
    <article className="confirmation-card capability-authorization-card" aria-label="本地任务授权">
      <h3>允许进入本地任务吗？</h3>
      <p>{authorization.requestSummary}</p>
      <p>
        {authorization.targetProviderName} 将在确认后规划
        {authorization.capability === 'powershell' ? ' PowerShell' : '文件'}任务；
        具体写入、删除和命令仍会逐次确认。
      </p>
      <div className="confirmation-actions">
        <button type="button" disabled={busy} onClick={onCancel}>取消</button>
        <button type="button" disabled={busy} onClick={onConfirm}>允许规划</button>
      </div>
    </article>
  );
}
