import type { AdminSubmissionSummary } from '../../lib/admin-api-client';
import { useI18n } from '../i18n/I18nProvider';
import type { Locale, Translate } from '../i18n/i18n-types';
import styles from './admin.module.css';

interface AdminQueueProps {
  items: readonly AdminSubmissionSummary[];
  selectedId: string | null;
  loading: boolean;
  hasMore: boolean;
  onSelect(id: string): void;
  onLoadMore(): void;
}

/** 队列使用按钮行保证键盘可达，分页追加时由父组件按 ID 去重。 */
export function AdminQueue({
  items,
  selectedId,
  loading,
  hasMore,
  onSelect,
  onLoadMore
}: AdminQueueProps) {
  const { locale, t } = useI18n();
  return (
    <section className={styles.queuePanel} aria-label={t('admin.queue.label')} aria-busy={loading}>
      <header className={styles.panelHeader}>
        <div><p className={styles.eyebrow}>SUBMISSION QUEUE</p><h2>{t('admin.queue.title')}</h2></div>
        <span className={styles.countBadge}>{items.length}</span>
      </header>
      <div className={styles.queueList}>
        {items.map(item => (
          <button
            key={item.id}
            type="button"
            className={selectedId === item.id ? styles.queueActive : styles.queueItem}
            onClick={() => onSelect(item.id)}
          >
            <span className={styles.queueTopline}>
              <span className={styles.kindBadge}>{kindLabel(item.kind, t)}</span>
              <time dateTime={item.createdAt}>{formatDate(item.createdAt, locale, t)}</time>
            </span>
            <strong>{item.title || t('admin.queue.noTitle')}</strong>
            <span className={styles.riskText}>{riskSummary(item.riskSummary, t)}</span>
            <span className={styles.statusText}>{statusLabel(item.status, t)}</span>
          </button>
        ))}
        {!loading && items.length === 0 ? <p className={styles.empty}>{t('admin.queue.empty')}</p> : null}
        {loading ? <p className={styles.muted} role="status">{t('admin.queue.loading')}</p> : null}
      </div>
      {hasMore ? (
        <button type="button" className={styles.secondaryButton} onClick={onLoadMore} disabled={loading}>
          {t('admin.queue.more')}
        </button>
      ) : null}
    </section>
  );
}

export function kindLabel(kind: string, t: Translate): string {
  return ({
    system_reviewing: t('admin.status.systemReviewing'),
    shared_package: t('admin.kind.sharedPackage'),
    feedback: t('admin.kind.feedback'),
    suggestion: t('admin.kind.suggestion')
  } as Record<string, string>)[kind] ?? t('admin.kind.other');
}

export function statusLabel(status: string, t: Translate): string {
  return ({
    manual_review_pending: t('admin.status.manual'),
    auto_rejected: t('admin.status.autoRejected'),
    published: t('admin.status.published'),
    deleted_quarantined: t('admin.status.quarantined'),
    admin_rejected: t('admin.status.adminRejected')
  } as Record<string, string>)[status] ?? status;
}

function formatDate(value: string, locale: Locale, t: Translate): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? t('admin.queue.timeUnknown')
    : date.toLocaleString(locale, { hour12: false });
}

function riskSummary(value: Record<string, unknown>, t: Translate): string {
  const summary = value.summary;
  if (typeof summary === 'string' && summary.trim()) return summary.slice(0, 100);
  const labels = value.labels;
  if (Array.isArray(labels)) return labels.filter(label => typeof label === 'string').slice(0, 3).join(' · ');
  return t('admin.queue.noRisk');
}
