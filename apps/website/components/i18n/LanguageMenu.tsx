'use client';

import { Check, Languages } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Locale } from './i18n-types';
import { useI18n } from './I18nProvider';
import styles from './language-menu.module.css';

const languageOptions: readonly Locale[] = ['zh-CN', 'en'];

export function LanguageMenu() {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { locale, setLocale, t } = useI18n();

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;

      setIsOpen(false);
      triggerRef.current?.focus();
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && containerRef.current?.contains(event.target)) {
        return;
      }

      setIsOpen(false);
    };

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('pointerdown', handlePointerDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [isOpen]);

  const selectLocale = (nextLocale: Locale) => {
    setLocale(nextLocale);
    setIsOpen(false);
  };

  return (
    <div ref={containerRef} className={styles.controlLayer}>
      <button
        ref={triggerRef}
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
