import type { AdminSubmissionDetail } from '../../lib/admin-api-client';
import { useI18n } from '../i18n/I18nProvider';
import type { Translate } from '../i18n/i18n-types';
import { statusLabel } from './AdminQueue';
import styles from './admin.module.css';

interface AdminAuditLogProps {
  detail: AdminSubmissionDetail | null;
}

/** 当前后端没有全局审计分页，本视图只展示所选投稿的只读日志。 */
export function AdminAuditLog({ detail }: AdminAuditLogProps) {
  const { t } = useI18n();
  return (
    <section className={styles.detailPanel} aria-labelledby="audit-title">
      <header className={styles.panelHeader}>
        <div><p className={styles.eyebrow}>IMMUTABLE LOG</p><h2 id="audit-title">{t('admin.audit.title')}</h2></div>
      </header>
      {!detail ? <p className={styles.empty}>{t('admin.audit.select')}</p> : null}
      {detail ? <h3>{detail.title || t('admin.queue.noTitle')}</h3> : null}
      {detail?.auditLogs.length === 0 ? <p className={styles.empty}>{t('admin.audit.empty')}</p> : null}
      <ol className={styles.auditList}>
        {detail?.auditLogs.map((log, index) => (
          <li key={`${log.createdAt}-${index}`}>
            <span>{statusLabel(log.beforeStatus, t)} → {statusLabel(log.afterStatus, t)}</span>
            <strong>{actionLabel(log.action, t)}</strong>
            <p>{log.reason}</p>
            <time dateTime={log.createdAt}>{new Date(log.createdAt).toLocaleString('zh-CN', { hour12: false })}</time>
          </li>
        ))}
      </ol>
    </section>
  );
}

function actionLabel(action: string, t: Translate): string {
  return ({
    approve: t('admin.action.approve'),
    reject: t('admin.action.reject'),
    move_to_manual: t('admin.action.manual'),
    delete: t('admin.action.delete'),
    restore: t('admin.action.restore')
  } as Record<string, string>)[action]
    ?? action;
}
