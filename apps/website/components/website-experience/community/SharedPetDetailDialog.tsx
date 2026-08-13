'use client';

import { useCallback } from 'react';
import { Download } from 'lucide-react';
import { interpolateMessage, useI18n } from '../../i18n/I18nProvider';
import type { SharedPetPackageSummary } from './shared-pet-types';
import { SharedPetDialogShell } from './SharedPetDialogShell';
import { useObjectUrl } from './use-object-url';
import styles from './community.module.css';

export interface SharedPetDetailDialogProps {
  item: SharedPetPackageSummary;
  downloadDisabled: boolean;
  onDownload: (item: SharedPetPackageSummary) => void;
  onRequestClose: () => void;
}

function formatSize(bytes: number, locale: string): string {
  const units = ['B', 'KB', 'MB'] as const;
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const unit = units[unitIndex]!;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)} ${unit}`;
}

/** 展示列表摘要中的完整元数据，封面地址仅在弹窗存活期间保留。 */
export function SharedPetDetailDialog({
  item,
  downloadDisabled,
  onDownload,
  onRequestClose
}: SharedPetDetailDialogProps) {
  const { locale, t: rawTranslate } = useI18n();
  const t = useCallback((key: Parameters<typeof rawTranslate>[0]) => (
    interpolateMessage(rawTranslate(key))
  ), [rawTranslate]);
  const localCoverUrl = useObjectUrl(item.coverFile ?? null);
  const coverUrl = item.coverUrl ?? localCoverUrl;
  const downloadLabel = interpolateMessage(
    rawTranslate('sharedPet.card.download'),
    { name: item.name }
  );
  const publishedAt = new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(item.createdAt));

  return (
    <SharedPetDialogShell
      title={item.name}
      closeLabel={t('sharedPet.detail.close')}
      onRequestClose={onRequestClose}
      footer={(
        <button
          type="button"
          title={downloadLabel}
          disabled={downloadDisabled}
          onClick={() => onDownload(item)}
        >
          <Download aria-hidden="true" />
          <span>{downloadLabel}</span>
        </button>
      )}
    >
      <div className={styles.detailContent}>
        {coverUrl ? (
          <img
            className={styles.detailCover}
            src={coverUrl}
            alt={item.coverFileName ?? t('sharedPet.detail.cover')}
          />
        ) : null}
        <p className={styles.detailDescription}>{item.description}</p>
        <dl className={styles.detailMetadata}>
          <div><dt>{t('sharedPet.detail.fileName')}</dt><dd>{item.packageFileName}</dd></div>
          <div><dt>{t('sharedPet.detail.fileSize')}</dt><dd>{formatSize(item.packageSizeBytes, locale)}</dd></div>
          <div><dt>{t('sharedPet.detail.publishedAt')}</dt><dd>{publishedAt}</dd></div>
          <div><dt>{t('sharedPet.detail.likes')}</dt><dd>{item.likeCount}</dd></div>
          <div><dt>{t('sharedPet.detail.downloads')}</dt><dd>{item.downloadCount}</dd></div>
        </dl>
      </div>
    </SharedPetDialogShell>
  );
}
