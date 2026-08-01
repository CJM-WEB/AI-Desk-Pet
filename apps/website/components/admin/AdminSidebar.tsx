import type { SubmissionStatus } from '@myself/shared-types';

import styles from './admin.module.css';

export type AdminView = SubmissionStatus | 'audit';

interface AdminSidebarProps {
  activeView: AdminView;
  onSelect(view: AdminView): void;
}

const views: ReadonlyArray<{ view: AdminView; label: string; hint: string }> = [
  { view: 'manual_review_pending', label: '待我审核', hint: '系统通过或待确认' },
  { view: 'auto_rejected', label: '自动驳回', hint: '复查机器判定' },
  { view: 'published', label: '已发布', hint: '当前公开内容' },
  { view: 'deleted_quarantined', label: '隔离区', hint: '三天内可恢复' },
  { view: 'audit', label: '审计记录', hint: '当前投稿日志' }
];

/** 五个固定视图不会在公开网站导航中注册。 */
export function AdminSidebar({ activeView, onSelect }: AdminSidebarProps) {
  return (
    <nav className={styles.sidebar} aria-label="管理员工作台导航">
      <div className={styles.brand}>
        <span className={styles.brandMark} aria-hidden="true">AP</span>
        <span><strong>AI Pet</strong><small>审核工作台</small></span>
      </div>
      <div className={styles.navList}>
        {views.map(item => (
          <button
            key={item.view}
            type="button"
            className={activeView === item.view ? styles.navActive : styles.navButton}
            aria-pressed={activeView === item.view}
            onClick={() => onSelect(item.view)}
          >
            <span>{item.label}</span>
            <small>{item.hint}</small>
          </button>
        ))}
      </div>
    </nav>
  );
}
