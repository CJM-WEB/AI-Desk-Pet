import { useEffect, useId, useRef, useState } from 'react';
import {
  TECHNICAL_SCAN_PROTOCOL_VERSION,
  TECHNICAL_SCAN_RULE_VERSION,
  technicalScanEvidenceSchema
} from '@myself/shared-types';
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
  const [confirmingOverride, setConfirmingOverride] = useState(false);
  const confirmationRegionId = useId();
  const confirmationTitleId = useId();
  const confirmationWarningId = useId();
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const forceButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (confirmingOverride && !acting) confirmButtonRef.current?.focus();
  }, [acting, confirmingOverride]);

  if (loading) return <section className={styles.detailPanel}><p role="status">{t('admin.detail.loading')}</p></section>;
  if (!detail) return <section className={styles.detailPanel}><p className={styles.empty}>{t('admin.detail.empty')}</p></section>;

  const technicalPass = hasCurrentTechnicalPass(detail);
  const actions = availableActions(detail, technicalPass);
  const technicalScanRequired = detail.kind === 'shared_package'
    && detail.status !== 'published'
    && !technicalPass;
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
            alt={t('admin.detail.coverAlt', { title: detail.title || t('admin.queue.noTitle') })}
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
                <p>{result.provider} · {result.score === null
                  ? t('admin.detail.noScore')
                  : t('admin.detail.score', { score: result.score })}</p>
                <pre>{safeStructuredText(result.evidence)}</pre>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.actionSection} aria-label={t('admin.detail.actionsLabel')}>
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
            <button type="button" className={styles.secondaryButton} disabled title={t('admin.detail.keepRejectedTitle')}>
              {t('admin.detail.keepRejected')}
            </button>
          ) : null}
          {actions.map(action => {
            const blockedApprove = action === 'approve' && technicalScanRequired;
            return (
              <button
                key={action}
                ref={action === 'force_publish' ? forceButtonRef : undefined}
                type="button"
                className={action === 'approve' || action === 'restore' ? styles.primaryButton : styles.dangerButton}
                disabled={actionDisabled || blockedApprove}
                title={blockedApprove ? t('admin.detail.technicalBlocked') : undefined}
                aria-expanded={action === 'force_publish' ? confirmingOverride : undefined}
                aria-controls={action === 'force_publish' ? confirmationRegionId : undefined}
                onClick={() => {
                  if (action === 'force_publish') {
                    setConfirmingOverride(true);
                    return;
                  }
                  onAction(action, reason.trim());
                }}
              >
                {actionLabel(action, t)}
              </button>
            );
          })}
        </div>
        {confirmingOverride ? (
          <div
            id={confirmationRegionId}
            className={styles.overrideConfirmation}
            role="alertdialog"
            aria-modal="false"
            aria-labelledby={confirmationTitleId}
            aria-describedby={confirmationWarningId}
          >
            <h3 id={confirmationTitleId}>{t('admin.override.title')}</h3>
            <p id={confirmationWarningId}>{t('admin.override.warning')}</p>
            <div className={styles.confirmationActions}>
              <button
                ref={confirmButtonRef}
                type="button"
                className={styles.dangerButton}
                disabled={actionDisabled}
                onClick={() => onAction('force_publish', reason.trim())}
              >
                {t('admin.override.confirm')}
              </button>
              <button
                type="button"
                className={styles.secondaryButton}
                disabled={acting}
                onClick={() => {
                  setConfirmingOverride(false);
                  queueMicrotask(() => forceButtonRef.current?.focus());
                }}
              >
                {t('admin.override.cancel')}
              </button>
            </div>
          </div>
        ) : null}
        {technicalScanRequired && actions.includes('approve') ? (
          <p className={styles.warningText}>{t('admin.detail.technicalBlocked')}</p>
        ) : null}
      </section>
    </section>
  );
}

function availableActions(
  detail: AdminSubmissionDetail,
  technicalPass: boolean
): AdminAction['action'][] {
  if (detail.status === 'system_reviewing') return ['move_to_manual', 'delete'];
  if (detail.status === 'manual_review_pending') {
    return detail.kind === 'shared_package' && !technicalPass
      ? ['approve', 'force_publish', 'reject', 'delete']
      : ['approve', 'reject', 'delete'];
  }
  if (detail.status === 'auto_rejected') return ['move_to_manual', 'delete'];
  if (detail.status === 'published') return ['delete'];
  if (detail.status === 'deleted_quarantined') return ['restore'];
  return [];
}

function actionLabel(action: AdminAction['action'], t: Translate): string {
  return {
    approve: t('admin.action.approve'),
    force_publish: t('admin.action.forcePublish'),
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
  return detail.moderationResults.some(result => {
    if (
      result.kind !== 'package_scan'
      || result.provider !== 'isolated-scanner'
      || result.suggestion !== 'Pass'
    ) return false;
    const parsed = technicalScanEvidenceSchema.safeParse(result.evidence);
    if (!parsed.success) return false;
    const evidence = parsed.data;
    return evidence.submissionId === detail.id
      && evidence.packageStorageKey === packageAsset.storageKey
      && evidence.packageSizeBytes === packageAsset.actualBytes
      && evidence.archiveSizeBytes === packageAsset.actualBytes
      && evidence.protocolVersion === TECHNICAL_SCAN_PROTOCOL_VERSION
      && evidence.ruleVersion === TECHNICAL_SCAN_RULE_VERSION
      && evidence.submissionStatusVersion === detail.statusVersion
      && Date.parse(evidence.expiresAt) - Date.parse(evidence.completedAt)
        === 24 * 60 * 60 * 1000
      && Date.parse(evidence.expiresAt) > Date.now();
  });
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
