import { feedbackKinds, type CreateFeedbackInput, type DraftValidationResult, type FeedbackRecord } from './feedback-types';

export const MAX_USER_ENTRIES_PER_KIND = 1000;

export function validateDraft(input: CreateFeedbackInput): DraftValidationResult {
  const authorName = input.authorName.trim();
  const content = input.content.trim();

  if (!feedbackKinds.includes(input.kind)) {
    return { valid: false, code: 'INVALID_KIND' };
  }
  if (authorName.length > 24) {
    return { valid: false, code: 'AUTHOR_NAME_TOO_LONG' };
  }
  if (content.length < 10) {
    return { valid: false, code: 'CONTENT_TOO_SHORT' };
  }
  if (content.length > 1000) {
    return { valid: false, code: 'CONTENT_TOO_LONG' };
  }

  return {
    valid: true,
    value: {
      kind: input.kind,
      authorName: authorName || '匿名用户',
      content
    }
  };
}

/** 所有列表和容量裁剪共享同一稳定排序规则。 */
export function sortFeedbackEntries<T extends FeedbackRecord>(entries: readonly T[]): T[] {
  return [...entries].sort((left, right) => {
    if (left.likeCount !== right.likeCount) {
      return right.likeCount - left.likeCount;
    }
    if (left.updatedAt !== right.updatedAt) {
      return left.updatedAt < right.updatedAt ? 1 : -1;
    }
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

/** 官方示例始终保留，用户记录仅在各自类型的独立容量内按优先级保留。 */
export function trimFeedbackEntries<T extends FeedbackRecord>(
  entries: readonly T[],
  limit = MAX_USER_ENTRIES_PER_KIND
): T[] {
  const officialEntries = entries.filter((entry) => entry.source === 'official-example');
  const localEntries = entries.filter((entry) => entry.source === 'local-user');
  const retained = feedbackKinds.flatMap((kind) => sortFeedbackEntries(
    localEntries.filter((entry) => entry.kind === kind)
  ).slice(0, limit));

  return sortFeedbackEntries([...officialEntries, ...retained]);
}
