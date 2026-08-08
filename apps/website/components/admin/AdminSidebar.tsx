import type { SubmissionStatus } from '@myself/shared-types';

import { useI18n } from '../i18n/I18nProvider';
import type { MessageKey } from '../i18n/i18n-types';
import styles from './admin.module.css';

export type AdminView = SubmissionStatus | 'audit';

interface AdminSidebarProps {
  activeView: AdminView;
  onSelect(view: AdminView): void;
}

const views: ReadonlyArray<{ view: AdminView; label: MessageKey }> = [
  { view: 'system_reviewing', label: 'admin.sidebar.systemReviewing' },
  { view: 'manual_review_pending', label: 'admin.sidebar.manual' },
  { view: 'auto_rejected', label: 'admin.sidebar.autoRejected' },
  { view: 'published', label: 'admin.sidebar.published' },
  { view: 'deleted_quarantined', label: 'admin.sidebar.quarantine' },
  { view: 'audit', label: 'admin.sidebar.audit' }
];

/** 五个固定视图不会在公开网站导航中注册。 */
export function AdminSidebar({ activeView, onSelect }: AdminSidebarProps) {
  const { t } = useI18n();
  return (
    <nav className={styles.sidebar} aria-label={t('admin.sidebar.label')}>
      <div className={styles.brand}>
        <span className={styles.brandMark} aria-hidden="true">AP</span>
        <span><strong>AI Pet</strong><small>{t('admin.sidebar.brandSubtitle')}</small></span>
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
            <span>{t(item.label)}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}
