import type { zhCN } from './messages';

export const locales = ['zh-CN', 'en'] as const;

export type Locale = (typeof locales)[number];
export type MessageKey = keyof typeof zhCN;
export type Translate = (
  key: MessageKey,
  values?: Record<string, string | number>
) => string;
