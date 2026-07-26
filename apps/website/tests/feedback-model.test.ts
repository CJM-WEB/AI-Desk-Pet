import { describe, expect, it } from 'vitest';
import { OFFICIAL_EXAMPLE_ENTRIES } from '../components/website-experience/feedback/feedback-content';
import {
  sortFeedbackEntries,
  trimFeedbackEntries,
  validateDraft
} from '../components/website-experience/feedback/feedback-model';
import type { FeedbackRecord } from '../components/website-experience/feedback/feedback-types';

function createRecord(overrides: Partial<FeedbackRecord> = {}): FeedbackRecord {
  return {
    id: 'entry-default',
    kind: 'feedback',
    authorId: 'browser-default',
    authorName: '测试用户',
    content: '这是一条至少十个字符的有效反馈内容。',
    likeCount: 0,
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:00.000Z',
    source: 'local-user',
    ...overrides
  };
}

describe('反馈领域模型', () => {
  it('集中配置每类六条官方示例，且示例可参与排序', () => {
    expect(OFFICIAL_EXAMPLE_ENTRIES.filter((entry) => entry.kind === 'feedback')).toHaveLength(6);
    expect(OFFICIAL_EXAMPLE_ENTRIES.filter((entry) => entry.kind === 'suggestion')).toHaveLength(6);
    expect(OFFICIAL_EXAMPLE_ENTRIES.every((entry) => entry.source === 'official-example')).toBe(true);

    const sorted = sortFeedbackEntries([
      createRecord({ id: 'local', likeCount: 2 }),
      OFFICIAL_EXAMPLE_ENTRIES[0]!
    ]);

    expect(sorted).toHaveLength(2);
    expect(sorted[0]?.likeCount).toBeGreaterThanOrEqual(sorted[1]?.likeCount ?? 0);
  });

  it('规范化昵称与正文，并拒绝越界草稿', () => {
    expect(validateDraft({
      kind: 'feedback',
      authorName: '  小明  ',
      content: '  这是一条至少十个字符的有效反馈内容。  '
    })).toEqual({
      valid: true,
      value: {
        kind: 'feedback',
        authorName: '小明',
        content: '这是一条至少十个字符的有效反馈内容。'
      }
    });
    expect(validateDraft({
      kind: 'suggestion',
      authorName: '   ',
      content: '这是一条至少十个字符的有效建议内容。'
    })).toMatchObject({ valid: true, value: { authorName: '匿名用户' } });
    expect(validateDraft({
      kind: 'feedback',
      authorName: 'a'.repeat(25),
      content: '这是一条至少十个字符的有效反馈内容。'
    })).toMatchObject({ valid: false, code: 'AUTHOR_NAME_TOO_LONG' });
    expect(validateDraft({
      kind: 'feedback',
      authorName: '测试用户',
      content: '太短'
    })).toMatchObject({ valid: false, code: 'CONTENT_TOO_SHORT' });
    expect(validateDraft({
      kind: 'feedback',
      authorName: '测试用户',
      content: 'a'.repeat(1001)
    })).toMatchObject({ valid: false, code: 'CONTENT_TOO_LONG' });
  });

  it('以 trim 后的边界判断昵称与正文长度', () => {
    expect(validateDraft({
      kind: 'feedback',
      authorName: `  ${'名'.repeat(24)}  `,
      content: `  ${'a'.repeat(10)}  `
    })).toMatchObject({
      valid: true,
      value: { authorName: '名'.repeat(24), content: 'a'.repeat(10) }
    });
    expect(validateDraft({
      kind: 'suggestion',
      authorName: '   ',
      content: `\n${'b'.repeat(1000)}\t`
    })).toMatchObject({
      valid: true,
      value: { authorName: '匿名用户', content: 'b'.repeat(1000) }
    });
    expect(validateDraft({
      kind: 'feedback',
      authorName: '  用户  ',
      content: '   \n\t  '
    })).toMatchObject({ valid: false, code: 'CONTENT_TOO_SHORT' });
  });

  it('按点赞、更新时间和稳定 ID 排序', () => {
    const sorted = sortFeedbackEntries([
      createRecord({ id: 'z', likeCount: 2, updatedAt: '2026-07-25T00:00:00.000Z' }),
      createRecord({ id: 'b', likeCount: 2, updatedAt: '2026-07-26T00:00:00.000Z' }),
      createRecord({ id: 'a', likeCount: 2, updatedAt: '2026-07-26T00:00:00.000Z' }),
      createRecord({ id: 'top', likeCount: 3 })
    ]);

    expect(sorted.map((entry) => entry.id)).toEqual(['top', 'a', 'b', 'z']);
  });

  it('分别裁剪两类用户记录，并且官方示例不挤占容量', () => {
    const feedback = Array.from({ length: 1005 }, (_, index) => createRecord({
      id: `feedback-${index}`,
      kind: 'feedback',
      likeCount: index
    }));
    const suggestions = Array.from({ length: 1005 }, (_, index) => createRecord({
      id: `suggestion-${index}`,
      kind: 'suggestion',
      likeCount: index
    }));

    const trimmed = trimFeedbackEntries([
      ...feedback,
      ...suggestions,
      ...OFFICIAL_EXAMPLE_ENTRIES
    ], 1000);

    expect(trimmed.filter((entry) => entry.kind === 'feedback' && entry.source === 'local-user')).toHaveLength(1000);
    expect(trimmed.filter((entry) => entry.kind === 'suggestion' && entry.source === 'local-user')).toHaveLength(1000);
    expect(trimmed.filter((entry) => entry.source === 'official-example')).toHaveLength(12);
    expect(trimmed.some((entry) => entry.id === 'feedback-0')).toBe(false);
    expect(trimmed.some((entry) => entry.id === 'suggestion-1004')).toBe(true);
  });
});
