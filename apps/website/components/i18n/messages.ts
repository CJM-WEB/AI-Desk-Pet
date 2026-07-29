import type { MessageKey } from './i18n-types';

export const zhCN = {
  'language.button': 'language',
  'language.chinese': '简体中文',
  'language.english': 'English',
  'navigation.label': '章节导航',
  'navigation.previousChapter': '上一章节',
  'navigation.nextChapter': '下一章节'
} as const;

export const en: Record<MessageKey, string> = {
  'language.button': 'language',
  'language.chinese': '简体中文',
  'language.english': 'English',
  'navigation.label': 'Chapter navigation',
  'navigation.previousChapter': 'Previous chapter',
  'navigation.nextChapter': 'Next chapter'
};
