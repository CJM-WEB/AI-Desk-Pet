'use client';

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent } from 'react';
import { LIQUID_GLASS_RIPPLE_EVENT } from '../home-experience/LiquidGlassHome';
import type { Locale } from './i18n-types';
import { useI18n } from './I18nProvider';
import styles from './language-menu.module.css';

const languageOptions: readonly Locale[] = ['zh-CN', 'en'];

interface LanguageMenuProps {
  transitionProgress?: number;
}

export function LanguageMenu({ transitionProgress = 0 }: LanguageMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { locale, setLocale, t } = useI18n();
  const progress = Math.min(1, Math.max(0, transitionProgress));
  const exitY = progress < 0.14
    ? (progress / 0.14) * 14
    : 14 - (((progress - 0.14) / 0.86) * 190);

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

  /** 同步参考页的控件近场波纹，并通知首页画布生成同位置水波。 */
  const triggerRipple = (event: MouseEvent<HTMLButtonElement>) => {
    const target = event.currentTarget;
    const bounds = target.getBoundingClientRect();
    const ripple = document.createElement('span');
    ripple.className = styles.ripple!;
    ripple.style.left = `${event.clientX - bounds.left}px`;
    ripple.style.top = `${event.clientY - bounds.top}px`;
    ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
    target.append(ripple);
    window.dispatchEvent(new CustomEvent(LIQUID_GLASS_RIPPLE_EVENT, {
      detail: {
        clientX: event.clientX,
        clientY: event.clientY,
        strength: 1.35
      }
    }));
  };

  return (
    <div
      ref={containerRef}
      className={styles.controlLayer}
      style={{
        '--language-exit-y': `${exitY}px`,
        '--language-exit-opacity': Math.max(0, 1 - progress * 1.16)
      } as CSSProperties}
    >
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={(event) => {
          triggerRipple(event);
          setIsOpen((open) => !open);
        }}
      >
        <span>{t('language.button')}</span>
      </button>
      <div
        className={styles.menu}
        data-open={isOpen}
        role="menu"
        aria-hidden={!isOpen}
      >
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
              data-selected={selected}
              role="menuitemradio"
              aria-checked={selected}
              tabIndex={isOpen ? 0 : -1}
              onClick={(event) => {
                triggerRipple(event);
                selectLocale(option);
              }}
            >
              <span>{label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
