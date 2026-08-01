import { useEffect, useState } from 'react';
import type { AdminAction } from '@myself/shared-types';

import type { AdminSubmissionDetail } from '../../lib/admin-api-client';
import { useI18n } from '../i18n/I18nProvider';
import type { Translate } from '../i18n/i18n-types';
import { kindLabel, statusLabel } from './AdminQueue';
import styles from './admin.module.css';

interface AdminDetailProps {
  detail: AdminSubmissionDetail | null;
  loading: boolean;
  acting: boolean;
  onAction(action: AdminAction['action'], reason: string): void;
}

/** 详情仅渲染 React 文本节点和经过裁剪的结构化证据，不接受原始 HTML。 */
export function AdminDetail({ detail, loading, acting, onAction }: AdminDetailProps) {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  useEffect(() => {
    setReason('');
  }, [detail?.id, detail?.statusVersion]);
  if (loading) return <section className={styles.detailPanel}><p role="status">{t('admin.detail.loading')}</p></section>;
  if (!detail) return <section className={styles.detailPanel}><p className={styles.empty}>{t('admin.detail.empty')}</p></section>;

  const actions = availableActions(detail);
  const technicalPass = hasCurrentTechnicalPass(detail);
  const actionDisabled = acting || !reason.trim();

  return (
    <section className={styles.detailPanel} aria-labelledby="detail-title">
      <header className={styles.panelHeader}>
        <div>
          <p className={styles.eyebrow}>{kindLabel(detail.kind, t)} · {statusLabel(detail.status, t)}</p>
          <h2 id="detail-title">{detail.title || t('admin.queue.noTitle')}</h2>
        </div>
        <span className={styles.versionBadge}>v{detail.statusVersion}</span>
      </header>

      {detail.autoRejectionReason ? (
        <div className={styles.warning}><strong>{t('admin.detail.autoReason')}</strong><p>{detail.autoRejectionReason}</p></div>
      ) : null}

      {detail.coverPreview ? (
        <section className={styles.detailSection}>
          <h3>{t('admin.detail.cover')}</h3>
          <img
            className={styles.coverPreview}
            src={detail.coverPreview.url}
            alt={`${detail.title || '投稿'}封面`}
            referrerPolicy="no-referrer"
          />
          <p className={styles.muted}>{t('admin.detail.coverExpiry')}</p>
        </section>
      ) : null}

      <section className={styles.detailSection}>
        <h3>{t('admin.detail.body')}</h3>
        <p className={styles.bodyText}>{detail.body || t('admin.detail.noBody')}</p>
      </section>

      <section className={styles.detailSection}>
        <h3>{t('admin.detail.risk')}</h3>
        <pre>{safeStructuredText(detail.riskSummary)}</pre>
      </section>

      <section className={styles.detailSection}>
        <h3>{t('admin.detail.files')}</h3>
        {detail.assets.length === 0 ? <p className={styles.muted}>{t('admin.detail.noFiles')}</p> : (
          <ul className={styles.fileList}>
            {detail.assets.map((asset, index) => (
              <li key={`${asset.role}-${asset.fileName}-${index}`}>
                <strong>{asset.fileName}</strong>
                <span>{asset.role} · {asset.contentType}</span>
                <span>{formatBytes(asset.actualBytes ?? asset.declaredBytes)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.detailSection}>
        <h3>{t('admin.detail.scan')}</h3>
        {detail.moderationResults.length === 0 ? <p className={styles.muted}>{t('admin.detail.noScan')}</p> : (
          <ul className={styles.scanList}>
            {detail.moderationResults.map((result, index) => (
              <li key={`${result.kind}-${result.createdAt}-${index}`}>
                <div><strong>{result.label || result.kind}</strong><span className={styles[`signal${result.suggestion}`]}>{result.suggestion}</span></div>
                <p>{result.provider} · {result.score === null ? '无评分' : `评分 ${result.score}`}</p>
                <pre>{safeStructuredText(result.evidence)}</pre>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.actionSection} aria-label="审核动作">
        <label className={styles.field}>
          <span>{t('admin.detail.reason')}</span>
          <textarea
            value={reason}
            onChange={event => setReason(event.target.value.slice(0, 500))}
            maxLength={500}
            disabled={acting}
            required
          />
        </label>
        <div className={styles.actionGrid}>
          {detail.status === 'auto_rejected' ? (
            <button type="button" className={styles.secondaryButton} disabled title="保持当前状态，不产生审计动作">
              {t('admin.detail.keepRejected')}
            </button>
          ) : null}
          {actions.map(action => {
            const blockedApprove = action === 'approve'
              && detail.kind === 'shared_package'
              && !technicalPass;
            return (
              <button
                key={action}
                type="button"
                className={action === 'approve' || action === 'restore' ? styles.primaryButton : styles.dangerButton}
                disabled={actionDisabled || blockedApprove}
                title={blockedApprove ? t('admin.detail.technicalBlocked') : undefined}
                onClick={() => onAction(action, reason.trim())}
              >
                {actionLabel(action, t)}
              </button>
            );
          })}
        </div>
        {detail.kind === 'shared_package' && !technicalPass && actions.includes('approve') ? (
          <p className={styles.warningText}>{t('admin.detail.technicalBlocked')}</p>
        ) : null}
      </section>
    </section>
  );
}

function availableActions(detail: AdminSubmissionDetail): AdminAction['action'][] {
  if (detail.status === 'manual_review_pending') return ['approve', 'reject', 'delete'];
  if (detail.status === 'auto_rejected') return ['move_to_manual', 'approve', 'delete'];
  if (detail.status === 'published') return ['delete'];
  if (detail.status === 'deleted_quarantined') return ['restore'];
  return [];
}

function actionLabel(action: AdminAction['action'], t: Translate): string {
  return {
    approve: t('admin.action.approve'),
    reject: t('admin.action.reject'),
    move_to_manual: t('admin.action.manual'),
    delete: t('admin.action.delete'),
    restore: t('admin.action.restore')
  }[action];
}

function hasCurrentTechnicalPass(detail: AdminSubmissionDetail): boolean {
  if (detail.kind !== 'shared_package') return true;
  const packageAsset = detail.assets.find(asset => asset.role === 'package');
  if (!packageAsset || packageAsset.actualBytes === null) return false;
  return detail.moderationResults.some(result => (
    result.kind === 'package_scan'
    && result.provider === 'isolated-scanner'
    && result.suggestion === 'Pass'
    && result.evidence.packageStorageKey === packageAsset.storageKey
    && result.evidence.packageSizeBytes === packageAsset.actualBytes
    && result.evidence.scanCode === 'CHARACTER_PACKAGE_SCAN_PASSED'
  ));
}

/** 删除存储路径、令牌、签名等前端不需要的键，并限制证据体积。 */
function safeStructuredText(value: Record<string, unknown>): string {
  const sensitiveKey = /(secret|token|signature|storage.?key|object.?key|url)/iu;
  const entries = Object.entries(value)
    .filter(([key]) => !sensitiveKey.test(key))
    .slice(0, 20)
    .map(([key, item]) => [key, safeValue(item, 0)]);
  return JSON.stringify(Object.fromEntries(entries), null, 2).slice(0, 4_000);
}

function safeValue(value: unknown, depth: number): unknown {
  if (depth >= 2) return '[已折叠]';
  if (typeof value === 'string') return value.slice(0, 300);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 10).map(item => safeValue(item, depth + 1));
  if (typeof value === 'object' && value) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !/(secret|token|signature|storage.?key|object.?key|url)/iu.test(key))
      .slice(0, 10)
      .map(([key, item]) => [key, safeValue(item, depth + 1)]));
  }
  return String(value).slice(0, 100);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
