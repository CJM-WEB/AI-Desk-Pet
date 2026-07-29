'use client';

import type { KeyboardEvent } from 'react';
import { Download, ThumbsUp } from 'lucide-react';
import { useI18n } from '../../i18n/I18nProvider';
import type { SharedPetPackageSummary } from './shared-pet-types';
import { useObjectUrl } from './use-object-url';
import styles from './community.module.css';

export interface SharedPetCardProps {
  item: SharedPetPackageSummary;
  onOpen: (item: SharedPetPackageSummary) => void;
  onLike: (item: SharedPetPackageSummary) => void;
  onDownload: (item: SharedPetPackageSummary) => void;
}

/** 提供可点击详情入口，并隔离点赞与下载操作事件。 */
export function SharedPetCard({
  item,
  onOpen,
  onLike,
  onDownload
}: SharedPetCardProps) {
  const { t } = useI18n();
  const coverUrl = useObjectUrl(item.coverFile);
  const handleKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    action: (item: SharedPetPackageSummary) => void
  ) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    action(item);
  };
  const openLabel = t('sharedPet.card.open', { name: item.name });
  const likeLabel = t('sharedPet.card.like', { name: item.name });
  const downloadLabel = t('sharedPet.card.download', { name: item.name });

  return (
    <article className={styles.card}>
      <button
        className={styles.cardOpenButton}
        type="button"
        aria-label={openLabel}
        onClick={() => onOpen(item)}
        onKeyDown={(event) => handleKeyDown(event, onOpen)}
      >
        {coverUrl ? <img className={styles.cardCover} src={coverUrl} alt="" /> : null}
        <div className={styles.cardBody}>
          <h3>{item.name}</h3>
          <p>{item.description}</p>
        </div>
      </button>
      <div className={styles.cardActions}>
        <button
          className={styles.iconButton}
          type="button"
          aria-label={likeLabel}
          aria-pressed={item.likedByCurrentUser}
          title={likeLabel}
          onClick={() => onLike(item)}
          onKeyDown={(event) => handleKeyDown(event, onLike)}
        >
          <ThumbsUp aria-hidden="true" />
          <span>{item.likeCount}</span>
        </button>
        <button
          className={styles.iconButton}
          type="button"
          aria-label={downloadLabel}
          title={downloadLabel}
          onClick={() => onDownload(item)}
          onKeyDown={(event) => handleKeyDown(event, onDownload)}
        >
          <Download aria-hidden="true" />
          <span>{item.downloadCount}</span>
        </button>
      </div>
    </article>
  );
}
