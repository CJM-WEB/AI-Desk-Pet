'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState
} from 'react';
import type { PropsWithChildren } from 'react';
import type { Locale, Translate } from './i18n-types';
import { en, zhCN } from './messages';

export const LANGUAGE_STORAGE_KEY = 'ai-pet-locale';

export interface I18nProviderProps extends PropsWithChildren {
  initialLocale?: Locale;
}

interface I18nContextValue {
  locale: Locale;
  setLocale(locale: Locale): void;
  t: Translate;
}

const defaultLocale: Locale = 'zh-CN';
const I18nContext = createContext<I18nContextValue>({
  locale: defaultLocale,
  setLocale: () => undefined,
  t: (key) => zhCN[key]
});

export function resolveInitialLocale(
  stored: string | null,
  browserLanguage: string
): Locale {
  if (stored === 'zh-CN' || stored === 'en') return stored;
  return browserLanguage.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

export function interpolateMessage(
  message: string,
  values?: Record<string, string | number>
): string {
  return message.replace(/\{([^{}]+)\}/g, (marker, name: string) => {
    const value = values?.[name];
    return value === undefined ? marker : String(value);
  });
}

function readStoredLocale(): string | null {
  try {
    return window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function syncDocumentLanguage(locale: Locale) {
  document.documentElement.lang = locale;
}

export function I18nProvider({
  children,
  initialLocale
}: I18nProviderProps) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale ?? defaultLocale);

  useEffect(() => {
    if (initialLocale) {
      syncDocumentLanguage(initialLocale);
      return;
    }

    const resolvedLocale = resolveInitialLocale(
      readStoredLocale(),
      window.navigator.language
    );
    setLocaleState(resolvedLocale);
    syncDocumentLanguage(resolvedLocale);
  }, [initialLocale]);

  const setLocale = useCallback((nextLocale: Locale) => {
    setLocaleState(nextLocale);
    syncDocumentLanguage(nextLocale);

    try {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, nextLocale);
    } catch {
      // 本地存储不可用时，仍保留当前会话中的语言状态。
    }
  }, []);

  const t = useCallback<Translate>((key, values) => {
    const messages = locale === 'en' ? en : zhCN;
    return interpolateMessage(messages[key], values);
  }, [locale]);

  const value = useMemo<I18nContextValue>(() => ({
    locale,
    setLocale,
    t
  }), [locale, setLocale, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}
