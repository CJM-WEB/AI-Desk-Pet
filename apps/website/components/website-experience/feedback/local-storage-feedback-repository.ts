import { z } from 'zod';
import { OFFICIAL_EXAMPLE_ENTRIES } from './feedback-content';
import { MAX_USER_ENTRIES_PER_KIND, sortFeedbackEntries, trimFeedbackEntries, validateDraft } from './feedback-model';
import type {
  CreateFeedbackInput,
  FeedbackEntry,
  FeedbackRecord,
  FeedbackRepository,
  FeedbackStatusNotice,
  FeedbackStorageDocument
} from './feedback-types';

export const feedbackStorageKey = 'ai-pet-feedback-v1';

const feedbackRecordSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['feedback', 'suggestion']),
  authorId: z.string().min(1),
  authorName: z.string(),
  content: z.string(),
  likeCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  source: z.enum(['official-example', 'local-user'])
});

const feedbackStorageDocumentSchema = z.object({
  version: z.literal(1),
  localUserId: z.string().min(1),
  entries: z.array(feedbackRecordSchema),
  likedEntryIds: z.array(z.string())
});

export class FeedbackValidationError extends Error {
  readonly name = 'FeedbackValidationError';
  readonly code: string;

  constructor(code: string) {
    super(`反馈内容校验失败：${code}`);
    this.code = code;
  }
}

export class FeedbackStorageError extends Error {
  readonly name = 'FeedbackStorageError';

  constructor(cause: unknown) {
    super('反馈数据无法写入本地存储，请稍后重试。');
    this.cause = cause;
  }
}

export class FeedbackNotFoundError extends Error {
  readonly name = 'FeedbackNotFoundError';

  constructor(id: string) {
    super(`未找到编号为“${id}”的反馈记录。`);
  }
}

type StorageEventTarget = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

export interface LocalStorageFeedbackRepositoryOptions {
  storage?: Storage | null;
  eventTarget?: StorageEventTarget | null;
  key?: string;
  createId?: () => string;
  now?: () => string;
}

export class LocalStorageFeedbackRepository implements FeedbackRepository {
  private readonly storage: Storage | null;
  private readonly eventTarget: StorageEventTarget | null;
  private readonly key: string;
  private readonly createId: () => string;
  private readonly now: () => string;
  private readonly listeners = new Set<() => void>();
  private memoryDocument: FeedbackStorageDocument | null = null;
  private statusNotice: FeedbackStatusNotice | null = null;

  constructor(options: LocalStorageFeedbackRepositoryOptions = {}) {
    // 仅省略 storage 时自动解析浏览器实现；显式 null 表示禁用本地存储。
    this.storage = options.storage === undefined ? this.resolveStorage() : options.storage;
    this.eventTarget = options.eventTarget ?? this.resolveEventTarget();
    this.key = options.key ?? feedbackStorageKey;
    this.createId = options.createId ?? (() => crypto.randomUUID());
    this.now = options.now ?? (() => new Date().toISOString());
  }

  list(kind: FeedbackRecord['kind']): readonly FeedbackEntry[] {
    const document = this.readDocument();
    return sortFeedbackEntries(this.entriesForDisplay(document))
      .filter((entry) => entry.kind === kind);
  }

  create(input: CreateFeedbackInput): FeedbackEntry {
    const validation = validateDraft(input);
    if (!validation.valid) {
      throw new FeedbackValidationError(validation.code);
    }

    const document = this.readDocument();
    const timestamp = this.now();
    const record: FeedbackRecord = {
      id: this.createId(),
      kind: validation.value.kind,
      authorId: document.localUserId,
      authorName: validation.value.authorName,
      content: validation.value.content,
      likeCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      source: 'local-user'
    };
    const nextDocument: FeedbackStorageDocument = {
      ...document,
      entries: trimFeedbackEntries([...document.entries, record], MAX_USER_ENTRIES_PER_KIND)
        .filter((entry) => entry.source === 'local-user')
    };

    this.writeDocument(nextDocument);
    this.notify();
    return this.toEntry(record, nextDocument.likedEntryIds);
  }

  toggleLike(id: string, localUserId: string): FeedbackEntry {
    const document = this.readDocument();
    const likedEntryIds = new Set(document.likedEntryIds);
    const wasLiked = likedEntryIds.has(id);
    const displayed = this.entriesForDisplay(document).find((entry) => entry.id === id);
    if (!displayed) {
      throw new FeedbackNotFoundError(id);
    }

    if (wasLiked) {
      likedEntryIds.delete(id);
    } else {
      likedEntryIds.add(id);
    }

    const nextDocument: FeedbackStorageDocument = {
      ...document,
      entries: document.entries.map((entry) => entry.id === id
        ? {
          ...entry,
          likeCount: Math.max(0, entry.likeCount + (wasLiked ? -1 : 1)),
          updatedAt: this.now()
        }
        : entry),
      likedEntryIds: [...likedEntryIds]
    };

    // 本地模式只保存当前浏览器的点赞集合，调用参数保留给未来服务端实现使用。
    void localUserId;
    this.writeDocument(nextDocument);
    this.notify();
    const updated = this.entriesForDisplay(nextDocument).find((entry) => entry.id === id);
    if (!updated) {
      throw new FeedbackNotFoundError(id);
    }
    return updated;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      this.eventTarget?.addEventListener('storage', this.handleStorageEvent);
    }

    let subscribed = true;
    return () => {
      if (!subscribed) {
        return;
      }
      subscribed = false;
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.eventTarget?.removeEventListener('storage', this.handleStorageEvent);
      }
    };
  }

  getStatusNotice(): FeedbackStatusNotice | null {
    return this.statusNotice;
  }

  private readonly handleStorageEvent = (event: Event) => {
    const key = (event as StorageEvent).key;
    if (key === this.key) {
      this.memoryDocument = null;
      this.notify();
    }
  };

  private readDocument(): FeedbackStorageDocument {
    if (!this.storage) {
      return this.memoryDocument ?? this.createInitialDocument();
    }

    let raw: string | null;
    try {
      raw = this.storage.getItem(this.key);
    } catch {
      this.statusNotice = {
        code: 'STORAGE_READ_FAILED',
        message: '反馈数据暂时无法读取，当前仅展示官方示例。'
      };
      return this.memoryDocument ?? this.createInitialDocument();
    }

    if (raw === null) {
      const initial = this.createInitialDocument();
      try {
        this.writeDocument(initial);
      } catch {
        this.statusNotice = {
          code: 'STORAGE_WRITE_FAILED',
          message: '本地反馈数据暂时无法保存，当前仅展示官方示例。'
        };
      }
      return initial;
    }

    const parsed = feedbackStorageDocumentSchema.safeParse(this.parseJson(raw));
    if (!parsed.success) {
      this.statusNotice = {
        code: 'STORAGE_DATA_RECOVERED',
        message: '本地反馈数据已损坏，当前已回退为官方示例。'
      };
      return this.recoverInvalidDocument();
    }

    const normalized = this.normalizeStoredDocument(parsed.data);
    this.statusNotice = null;
    if (normalized.changed) {
      this.writeDocument(normalized.document);
      return normalized.document;
    }
    this.memoryDocument = normalized.document;
    return normalized.document;
  }

  private createInitialDocument(): FeedbackStorageDocument {
    const initial: FeedbackStorageDocument = {
      version: 1,
      localUserId: this.createId(),
      entries: [],
      likedEntryIds: []
    };
    this.memoryDocument = initial;
    return initial;
  }

  private writeDocument(document: FeedbackStorageDocument): void {
    const normalized: FeedbackStorageDocument = {
      ...document,
      entries: trimFeedbackEntries(document.entries, MAX_USER_ENTRIES_PER_KIND)
        .filter((entry) => entry.source === 'local-user'),
      likedEntryIds: [...new Set(document.likedEntryIds)]
    };
    // 缺少真实存储时禁止把写入误报为内存中的保存成功。
    if (!this.storage) {
      throw new FeedbackStorageError(null);
    }
    try {
      this.storage.setItem(this.key, JSON.stringify(normalized));
    } catch (error) {
      throw new FeedbackStorageError(error);
    }
    this.memoryDocument = normalized;
  }

  /** 读取路径同样执行迁移归一化，避免历史或外部数据绕过容量与来源约束。 */
  private normalizeStoredDocument(document: FeedbackStorageDocument): {
    document: FeedbackStorageDocument;
    changed: boolean;
  } {
    const entries = trimFeedbackEntries(
      document.entries.filter((entry) => entry.source === 'local-user'),
      MAX_USER_ENTRIES_PER_KIND
    ).filter((entry) => entry.source === 'local-user');
    const likedEntryIds = [...new Set(document.likedEntryIds)];
    const changed = entries.length !== document.entries.length
      || likedEntryIds.length !== document.likedEntryIds.length
      || entries.some((entry, index) => entry !== document.entries[index])
      || likedEntryIds.some((id, index) => id !== document.likedEntryIds[index]);

    return {
      document: { ...document, entries, likedEntryIds },
      changed
    };
  }

  /** 损坏数据不得复用旧缓存；尽力以空文档覆盖本地值，但恢复展示始终不抛错。 */
  private recoverInvalidDocument(): FeedbackStorageDocument {
    const recovered = this.createInitialDocument();
    try {
      this.storage?.setItem(this.key, JSON.stringify(recovered));
    } catch {
      // 恢复路径优先保证章节可用，后续投稿仍会通过正常写入路径报告存储错误。
    }
    return recovered;
  }

  private entriesForDisplay(document: FeedbackStorageDocument): FeedbackEntry[] {
    return [...OFFICIAL_EXAMPLE_ENTRIES, ...document.entries].map((entry) => this.toEntry(entry, document.likedEntryIds));
  }

  private toEntry(record: FeedbackRecord, likedEntryIds: readonly string[]): FeedbackEntry {
    const likedByCurrentBrowser = likedEntryIds.includes(record.id);
    return {
      ...record,
      likeCount: record.source === 'official-example' && likedByCurrentBrowser
        ? record.likeCount + 1
        : record.likeCount,
      likedByCurrentBrowser
    };
  }

  private parseJson(raw: string): unknown {
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener());
  }

  private resolveStorage(): Storage | null {
    if (typeof window === 'undefined') {
      return null;
    }
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  }

  private resolveEventTarget(): StorageEventTarget | null {
    return typeof window === 'undefined' ? null : window;
  }
}
