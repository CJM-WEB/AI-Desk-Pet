import type { Translate } from '../../i18n/i18n-types';
import type { FeedbackRecord } from './feedback-types';

const OFFICIAL_MESSAGE_KEYS = {
  'official-feedback-01': ['feedback.official.official-feedback-01.author', 'feedback.official.official-feedback-01.content'],
  'official-feedback-02': ['feedback.official.official-feedback-02.author', 'feedback.official.official-feedback-02.content'],
  'official-feedback-03': ['feedback.official.official-feedback-03.author', 'feedback.official.official-feedback-03.content'],
  'official-feedback-04': ['feedback.official.official-feedback-04.author', 'feedback.official.official-feedback-04.content'],
  'official-feedback-05': ['feedback.official.official-feedback-05.author', 'feedback.official.official-feedback-05.content'],
  'official-feedback-06': ['feedback.official.official-feedback-06.author', 'feedback.official.official-feedback-06.content'],
  'official-suggestion-01': ['feedback.official.official-suggestion-01.author', 'feedback.official.official-suggestion-01.content'],
  'official-suggestion-02': ['feedback.official.official-suggestion-02.author', 'feedback.official.official-suggestion-02.content'],
  'official-suggestion-03': ['feedback.official.official-suggestion-03.author', 'feedback.official.official-suggestion-03.content'],
  'official-suggestion-04': ['feedback.official.official-suggestion-04.author', 'feedback.official.official-suggestion-04.content'],
  'official-suggestion-05': ['feedback.official.official-suggestion-05.author', 'feedback.official.official-suggestion-05.content'],
  'official-suggestion-06': ['feedback.official.official-suggestion-06.author', 'feedback.official.official-suggestion-06.content']
} as const;

/** 仅替换稳定官方示例；用户内容始终保留原文。 */
export function localizeFeedbackEntry<T extends FeedbackRecord>(entry: T, t: Translate): T {
  if (entry.source === 'local-user') {
    return entry.authorName ? entry : { ...entry, authorName: t('feedback.anonymous') };
  }
  const keys = OFFICIAL_MESSAGE_KEYS[entry.id as keyof typeof OFFICIAL_MESSAGE_KEYS];
  if (!keys) return entry;
  return {
    ...entry,
    authorName: t(keys[0]),
    content: t(keys[1])
  } as T;
}
