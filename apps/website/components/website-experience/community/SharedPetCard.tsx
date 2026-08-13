'use client';

import { Download, ThumbsUp } from 'lucide-react';
import { LIQUID_GLASS_RIPPLE_EVENT } from '../../home-experience/LiquidGlassHome';
import { useI18n } from '../../i18n/I18nProvider';
import type { SharedPetPackageSummary } from './shared-pet-types';
import { useObjectUrl } from './use-object-url';
import styles from './community.module.css';

export interface SharedPetCardProps {
  item: SharedPetPackageSummary;
  detailDisabled?: boolean;
  likeDisabled?: boolean;
  downloadDisabled?: boolean;
  onOpen: (item: SharedPetPackageSummary) => void;
  onLike: (item: SharedPetPackageSummary) => void;
  onDownload: (item: SharedPetPackageSummary) => void;
}

/** 卡片复用共享液态水波，同时隔离详情、点赞与下载操作。 */
export function SharedPetCard({
  item,
  detailDisabled = false,
  likeDisabled = false,
  downloadDisabled = false,
  onOpen,
  onLike,
  onDownload
}: SharedPetCardProps) {
  const { t } = useI18n();
  const localCoverUrl = useObjectUrl(item.coverFile ?? null);
  const coverUrl = item.coverUrl ?? localCoverUrl;
  const openLabel = t('sharedPet.card.open', { name: item.name });
  const likeLabel = t('sharedPet.card.like', { name: item.name });
  const downloadLabel = t('sharedPet.card.download', { name: item.name });

  return (
    <article
      className={styles.card}
      onPointerDown={(event) => {
        window.dispatchEvent(new CustomEvent(LIQUID_GLASS_RIPPLE_EVENT, {
          detail: {
            clientX: event.clientX,
            clientY: event.clientY,
            strength: 1.35
          }
        }));
      }}
    >
      <button
        className={styles.cardOpenButton}
        type="button"
        aria-label={openLabel}
        disabled={detailDisabled}
        onClick={() => onOpen(item)}
      >
        {coverUrl ? (
          <img
            className={styles.cardCover}
            src={coverUrl}
            alt=""
            loading="lazy"
            decoding="async"
          />
        ) : <span className={styles.cardCoverFallback} aria-hidden="true">AI PET</span>}
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
          disabled={likeDisabled}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => onLike(item)}
        >
          <ThumbsUp aria-hidden="true" />
          <span>{item.likeCount}</span>
        </button>
        <button
          className={styles.iconButton}
          type="button"
          aria-label={downloadLabel}
          title={downloadLabel}
          disabled={downloadDisabled}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => onDownload(item)}
        >
          <Download aria-hidden="true" />
          <span>{item.downloadCount}</span>
        </button>
      </div>
    </article>
  );
}
