import type { AdminSubmissionDetail } from '../../lib/admin-api-client';
import { statusLabel } from './AdminQueue';
import styles from './admin.module.css';

interface AdminAuditLogProps {
  detail: AdminSubmissionDetail | null;
}

/** 当前后端没有全局审计分页，本视图只展示所选投稿的只读日志。 */
export function AdminAuditLog({ detail }: AdminAuditLogProps) {
  return (
    <section className={styles.detailPanel} aria-labelledby="audit-title">
      <header className={styles.panelHeader}>
        <div><p className={styles.eyebrow}>IMMUTABLE LOG</p><h2 id="audit-title">审计记录</h2></div>
      </header>
      {!detail ? <p className={styles.empty}>请先在其他队列中选择一条投稿。</p> : null}
      {detail ? <h3>{detail.title || '无标题投稿'}</h3> : null}
      {detail?.auditLogs.length === 0 ? <p className={styles.empty}>该投稿暂无管理员操作记录。</p> : null}
      <ol className={styles.auditList}>
        {detail?.auditLogs.map((log, index) => (
          <li key={`${log.createdAt}-${index}`}>
            <span>{statusLabel(log.beforeStatus)} → {statusLabel(log.afterStatus)}</span>
            <strong>{actionLabel(log.action)}</strong>
            <p>{log.reason}</p>
            <time dateTime={log.createdAt}>{new Date(log.createdAt).toLocaleString('zh-CN', { hour12: false })}</time>
          </li>
        ))}
      </ol>
    </section>
  );
}

function actionLabel(action: string): string {
  return ({ approve: '批准', reject: '驳回', move_to_manual: '转人工', delete: '删除', restore: '恢复' } as Record<string, string>)[action]
    ?? action;
}
