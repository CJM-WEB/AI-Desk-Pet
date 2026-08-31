import type { SubmissionReceipt } from '@myself/shared-types';
import {
  feedbackSubmissionRequestSchema,
  feedbackSubmissionResponseSchema,
  publicFeedbackPageSchema,
  publicLikeRequestSchema,
  publicLikeResponseSchema,
  type PublicFeedbackPage
} from '@myself/shared-types/website-http';
import { ApiClient } from '../../../lib/api-client';
import { OFFICIAL_EXAMPLE_ENTRIES } from './feedback-content';
import { sortFeedbackEntries } from './feedback-model';
import type {
  CreateFeedbackInput,
  FeedbackEntry,
  FeedbackKind,
  PendingFeedbackLike,
  FeedbackRepository,
  FeedbackStatusNotice
} from './feedback-types';

const MAX_PUBLIC_FEEDBACK_PAGES = 100;

/** 公开反馈的内存快照；投稿回执不会进入任何公开展示路径。 */
export class CloudFeedbackRepository implements FeedbackRepository {
  private readonly listeners = new Set<() => void>();
  private readonly entries = new Map<FeedbackKind, FeedbackEntry[]>([
    ['feedback', []],
    ['suggestion', []]
  ]);
  private readonly statusNotices = new Map<FeedbackKind, FeedbackStatusNotice>();
  private readonly refreshGenerations = new Map<FeedbackKind, number>();
  private readonly likeQueues = new Map<string, Promise<void>>();
  private readonly pendingLikes = new Map<string, PendingFeedbackLike>();

  constructor(private readonly api: ApiClient) {}

  list(kind: FeedbackKind): readonly FeedbackEntry[] {
    const official = OFFICIAL_EXAMPLE_ENTRIES.filter(entry => entry.kind === kind)
      .map(entry => ({ ...entry, likedByCurrentBrowser: false }));
    return sortFeedbackEntries([...official, ...(this.entries.get(kind) ?? [])]);
  }

  async refresh(kind: FeedbackKind): Promise<void> {
    const generation = (this.refreshGenerations.get(kind) ?? 0) + 1;
    this.refreshGenerations.set(kind, generation);
    try {
      const records: FeedbackEntry[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      for (let pageIndex = 0; pageIndex < MAX_PUBLIC_FEEDBACK_PAGES; pageIndex += 1) {
        const page = await this.api.request(
          `/feedback?kind=${kind}&limit=100${cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
          publicFeedbackPageSchema
        );
        records.push(...page.items
          .filter(item => item.kind === kind)
          .map(item => this.toEntry(item)));
        if (page.nextCursor === null) {
          if (!this.isLatestRefresh(kind, generation)) return;
          this.entries.set(kind, records);
          this.statusNotices.delete(kind);
          this.notify();
          return;
        }
        if (seenCursors.has(page.nextCursor)) {
          throw new Error('FEEDBACK_CURSOR_LOOP');
        }
        seenCursors.add(page.nextCursor);
        cursor = page.nextCursor;
      }
      throw new Error('FEEDBACK_PAGE_LIMIT');
    } catch (error) {
      if (!this.isLatestRefresh(kind, generation)) throw error;
      // 读取失败不得继续暴露过期网络内容，只留下稳定官方示例。
      this.entries.set(kind, []);
      this.statusNotices.set(kind, {
        code: 'CLOUD_READ_FAILED',
        message: '反馈数据暂时无法读取，当前仅展示官方示例。'
      });
      this.notify();
      throw error;
    }
  }

  async create(input: CreateFeedbackInput): Promise<SubmissionReceipt> {
    const body = feedbackSubmissionRequestSchema.parse(input);
    return this.api.request('/feedback', feedbackSubmissionResponseSchema, {
      method: 'POST',
      body: JSON.stringify(body)
    });
  }

  async toggleLike(id: string): Promise<FeedbackEntry> {
    const previous = this.likeQueues.get(id);
    const operation = previous
      ? previous.then(() => this.toggleLikeNow(id), () => this.toggleLikeNow(id))
      : this.toggleLikeNow(id);
    const tail = operation.then(() => undefined, () => undefined);
    this.likeQueues.set(id, tail);
    try {
      return await operation;
    } finally {
      if (this.likeQueues.get(id) === tail) this.likeQueues.delete(id);
    }
  }

  private async toggleLikeNow(id: string): Promise<FeedbackEntry> {
    const current = this.findPublishedEntry(id);
    const pending = this.pendingLikes.get(id) ?? {
      desiredLiked: !current.likedByCurrentBrowser,
      operationId: globalThis.crypto.randomUUID()
    };
    this.pendingLikes.set(id, pending);
    const body = publicLikeRequestSchema.parse({
      liked: pending.desiredLiked,
      operationId: pending.operationId
    });
    const result = await this.api.request(
      `/feedback/${encodeURIComponent(id)}/like`,
      publicLikeResponseSchema,
      { method: 'POST', body: JSON.stringify(body) }
    );
    const updated = {
      ...current,
      likedByCurrentBrowser: result.liked,
      likeCount: result.likeCount
    };
    this.entries.set(current.kind, (this.entries.get(current.kind) ?? []).map(
      entry => entry.id === id ? updated : entry
    ));
    if (this.pendingLikes.get(id)?.operationId === pending.operationId) {
      this.pendingLikes.delete(id);
    }
    this.notify();
    return updated;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getStatusNotice(kind: FeedbackKind): FeedbackStatusNotice | null {
    return this.statusNotices.get(kind) ?? null;
  }

  private findPublishedEntry(id: string): FeedbackEntry {
    for (const entries of this.entries.values()) {
      const entry = entries.find(candidate => candidate.id === id);
      if (entry) return entry;
    }
    throw new Error('FEEDBACK_NOT_PUBLISHED');
  }

  private isLatestRefresh(kind: FeedbackKind, generation: number): boolean {
    return this.refreshGenerations.get(kind) === generation;
  }

  private toEntry(item: PublicFeedbackPage['items'][number]): FeedbackEntry {
    const existing = (this.entries.get(item.kind) ?? [])
      .find(entry => entry.id === item.id);
    return {
      id: item.id,
      kind: item.kind,
      // 公开 DTO 不提供作者身份，匿名前端不伪造可追踪标识。
      authorId: 'published',
      authorName: item.authorName,
      content: item.content,
      likeCount: item.likeCount,
      createdAt: item.createdAt,
      updatedAt: item.createdAt,
      source: 'local-user',
      likedByCurrentBrowser: existing?.likedByCurrentBrowser ?? false
    };
  }

  private notify(): void {
    this.listeners.forEach(listener => listener());
  }
}
