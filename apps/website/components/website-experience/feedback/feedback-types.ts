export const feedbackKinds = ['feedback', 'suggestion'] as const;

export type FeedbackKind = (typeof feedbackKinds)[number];

export const feedbackSources = ['official-example', 'local-user'] as const;

export type FeedbackSource = (typeof feedbackSources)[number];

/** 可持久化的反馈记录，不包含当前浏览器派生状态。 */
export interface FeedbackRecord {
  id: string;
  kind: FeedbackKind;
  authorId: string;
  authorName: string;
  content: string;
  likeCount: number;
  createdAt: string;
  updatedAt: string;
  source: FeedbackSource;
}

/** 提供给界面的记录，在持久化字段上附加当前浏览器点赞状态。 */
export interface FeedbackEntry extends FeedbackRecord {
  likedByCurrentBrowser: boolean;
}

export interface CreateFeedbackInput {
  kind: FeedbackKind;
  authorName: string;
  content: string;
}

export interface FeedbackStorageDocument {
  version: 1;
  localUserId: string;
  entries: FeedbackRecord[];
  likedEntryIds: string[];
}

export interface FeedbackRepository {
  list(kind: FeedbackKind): readonly FeedbackEntry[];
  create(input: CreateFeedbackInput): FeedbackEntry;
  toggleLike(id: string, localUserId: string): FeedbackEntry;
  subscribe(listener: () => void): () => void;
}

export type DraftValidationCode =
  | 'INVALID_KIND'
  | 'AUTHOR_NAME_TOO_LONG'
  | 'CONTENT_TOO_SHORT'
  | 'CONTENT_TOO_LONG';

export type DraftValidationResult =
  | { valid: true; value: CreateFeedbackInput }
  | { valid: false; code: DraftValidationCode };

export interface FeedbackStatusNotice {
  code:
    | 'STORAGE_DATA_RECOVERED'
    | 'STORAGE_READ_FAILED'
    | 'STORAGE_WRITE_FAILED';
  message: string;
}
