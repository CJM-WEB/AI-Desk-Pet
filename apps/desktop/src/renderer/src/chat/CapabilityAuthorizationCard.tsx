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
        {authorization.targetProviderName} · {authorization.modelId}
      </p>
      <p>任务目录：<code>{authorization.directory}</code></p>
      <p>允许在此目录内连续读取、创建和编辑文件；覆盖、删除、目录外访问及其他命令会另行询问。</p>
      <p>本任务预先批准的完整命令：</p>
      {authorization.approvedCommands.length ? authorization.approvedCommands.map(command => <pre key={command}>{command}</pre>) : <p>无；命令执行时单独询问。</p>}
      <div className="confirmation-actions">
        <button type="button" disabled={busy} onClick={onCancel}>取消</button>
        <button type="button" disabled={busy} onClick={onConfirm}>授权并开始任务</button>
      </div>
    </article>
  );
}
