'use client';

import { useI18n } from '../../i18n/I18nProvider';
import styles from './community.module.css';

/** 统一呈现管理员人工放行共享包的固定风险提示。 */
export function SharedPetOverrideWarning({ ariaLabel }: { ariaLabel: string }) {
  const { t } = useI18n();

  return (
    <div className={styles.overrideWarning} role="note" aria-label={ariaLabel}>
      <strong>{t('sharedPet.override.label')}</strong>
      <span>{t('sharedPet.override.warning')}</span>
    </div>
  );
}
