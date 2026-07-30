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
      if (event.key === 'Escape') {
        setIsOpen(false);
        triggerRef.current?.focus();
        return;
      }

      const options = Array.from(
        containerRef.current?.querySelectorAll<HTMLButtonElement>(
          '[role="menuitemradio"]'
        ) ?? []
      );
      const currentIndex = options.indexOf(document.activeElement as HTMLButtonElement);
      let nextIndex: number;
      switch (event.key) {
        case 'ArrowDown':
          nextIndex = (currentIndex + 1) % options.length;
          break;
        case 'ArrowUp':
          nextIndex = (currentIndex - 1 + options.length) % options.length;
          break;
        case 'Home':
          nextIndex = 0;
          break;
        case 'End':
          nextIndex = options.length - 1;
          break;
        default:
          return;
      }
      event.preventDefault();
      options[nextIndex]?.focus();
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
    triggerRef.current?.focus();
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
