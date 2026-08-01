import type { AdminSubmissionSummary } from '../../lib/admin-api-client';
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
  return (
    <section className={styles.queuePanel} aria-label="审核队列" aria-busy={loading}>
      <header className={styles.panelHeader}>
        <div><p className={styles.eyebrow}>SUBMISSION QUEUE</p><h2>投稿队列</h2></div>
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
              <span className={styles.kindBadge}>{kindLabel(item.kind)}</span>
              <time dateTime={item.createdAt}>{formatDate(item.createdAt)}</time>
            </span>
            <strong>{item.title || '无标题投稿'}</strong>
            <span className={styles.riskText}>{riskSummary(item.riskSummary)}</span>
            <span className={styles.statusText}>{statusLabel(item.status)}</span>
          </button>
        ))}
        {!loading && items.length === 0 ? <p className={styles.empty}>当前队列没有投稿。</p> : null}
        {loading ? <p className={styles.muted} role="status">正在加载…</p> : null}
      </div>
      {hasMore ? (
        <button type="button" className={styles.secondaryButton} onClick={onLoadMore} disabled={loading}>
          加载更多
        </button>
      ) : null}
    </section>
  );
}

export function kindLabel(kind: string): string {
  return ({ shared_package: '共享包', feedback: '反馈', suggestion: '建议' } as Record<string, string>)[kind]
    ?? '其他';
}

export function statusLabel(status: string): string {
  return ({
    manual_review_pending: '待管理员审核',
    auto_rejected: '系统自动驳回',
    published: '已发布',
    deleted_quarantined: '隔离中',
    admin_rejected: '管理员驳回'
  } as Record<string, string>)[status] ?? status;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN', { hour12: false });
}

function riskSummary(value: Record<string, unknown>): string {
  const summary = value.summary;
  if (typeof summary === 'string' && summary.trim()) return summary.slice(0, 100);
  const labels = value.labels;
  if (Array.isArray(labels)) return labels.filter(label => typeof label === 'string').slice(0, 3).join(' · ');
  return '暂无风险摘要';
}
