'use client';

import { Check, Languages } from 'lucide-react';
import { useState } from 'react';
import type { Locale } from './i18n-types';
import { useI18n } from './I18nProvider';
import styles from './language-menu.module.css';

const languageOptions: readonly Locale[] = ['zh-CN', 'en'];

export function LanguageMenu() {
  const [isOpen, setIsOpen] = useState(false);
  const { locale, setLocale, t } = useI18n();

  const selectLocale = (nextLocale: Locale) => {
    setLocale(nextLocale);
    setIsOpen(false);
  };

  return (
    <div className={styles.controlLayer}>
      <button
        type="button"
        className={styles.trigger}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((open) => !open)}
      >
        <Languages aria-hidden="true" />
        <span>{t('language.button')}</span>
      </button>
      {isOpen ? (
        <div className={styles.menu} role="menu">
          {languageOptions.map((option) => {
            const label = option === 'zh-CN'
              ? t('language.chinese')
              : t('language.english');
            const selected = locale === option;

            return (
              <button
                key={option}
                type="button"
                className={styles.option}
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => selectLocale(option)}
              >
                <span>{label}</span>
                {selected ? <Check aria-hidden="true" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
