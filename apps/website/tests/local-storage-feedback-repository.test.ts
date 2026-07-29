import { describe, expect, it, vi } from 'vitest';
import {
  FeedbackNotFoundError,
  FeedbackStorageError,
  LocalStorageFeedbackRepository,
  feedbackStorageKey
} from '../components/website-experience/feedback/local-storage-feedback-repository';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

class ThrowingStorage extends MemoryStorage {
  override setItem(): void {
    throw new Error('存储空间不足');
  }
}

function createRepository(storage = new MemoryStorage(), eventTarget = new EventTarget()) {
  let id = 0;
  return {
    storage,
    eventTarget,
    repository: new LocalStorageFeedbackRepository({
      storage,
      eventTarget,
      createId: () => `generated-${++id}`,
      now: () => '2026-07-26T12:00:00.000Z'
    })
  };
}

const validInput = {
  kind: 'feedback' as const,
  authorName: '  小明  ',
  content: '  这是一条至少十个字符的有效反馈内容。  '
};

describe('本地反馈仓储', () => {
  it('首次读取持久化匿名浏览器 ID，并返回每类六条官方示例', () => {
    const { repository, storage } = createRepository();

    expect(repository.list('feedback')).toHaveLength(6);
    expect(repository.list('suggestion')).toHaveLength(6);

    const document = JSON.parse(storage.getItem(feedbackStorageKey)!);
    expect(document).toMatchObject({ version: 1, localUserId: 'generated-1', entries: [], likedEntryIds: [] });
  });

  it('创建后可由重建仓储读取，且保留规范化字段', () => {
    const { repository, storage, eventTarget } = createRepository();
    const created = repository.create(validInput);
    const restored = new LocalStorageFeedbackRepository({
      storage,
      eventTarget,
      createId: () => 'should-not-be-used',
      now: () => '2026-07-26T12:00:00.000Z'
    });

    expect(created).toMatchObject({
      id: 'generated-2',
      authorId: 'generated-1',
      authorName: '小明',
      content: '这是一条至少十个字符的有效反馈内容。',
      source: 'local-user',
      likedByCurrentBrowser: false
    });
    expect(restored.list('feedback').find((entry) => entry.id === created.id)).toMatchObject(created);
  });

  it('能点赞、取消点赞并派生当前浏览器状态', () => {
    const { repository } = createRepository();
    const created = repository.create(validInput);

    expect(repository.toggleLike(created.id, 'generated-1')).toMatchObject({ likeCount: 1, likedByCurrentBrowser: true });
    expect(repository.toggleLike(created.id, 'generated-1')).toMatchObject({ likeCount: 0, likedByCurrentBrowser: false });
    expect(() => repository.toggleLike('missing', 'generated-1')).toThrow(FeedbackNotFoundError);
  });

  it('损坏 JSON、错误结构和未知版本均回退为示例并给出非阻断通知', () => {
    for (const value of ['{坏数据', JSON.stringify({ version: 2 }), JSON.stringify({ version: 1, entries: 'bad' })]) {
      const storage = new MemoryStorage();
      storage.setItem(feedbackStorageKey, value);
      const repository = new LocalStorageFeedbackRepository({ storage, createId: () => 'fallback-id' });

      expect(repository.list('feedback')).toHaveLength(6);
      expect(repository.getStatusNotice()).toMatchObject({ code: 'STORAGE_DATA_RECOVERED' });
    }
  });

  it('读取历史或外部过量数据时立即按类型裁剪，并过滤持久化官方示例', () => {
    const storage = new MemoryStorage();
    const createEntry = (kind: 'feedback' | 'suggestion', index: number) => ({
      id: `${kind}-${index}`,
      kind,
      authorId: 'external-user',
      authorName: '外部用户',
      content: '这是一条至少十个字符的外部持久化内容。',
      likeCount: index,
      createdAt: '2026-07-26T12:00:00.000Z',
      updatedAt: '2026-07-26T12:00:00.000Z',
      source: 'local-user'
    });
    storage.setItem(feedbackStorageKey, JSON.stringify({
      version: 1,
      localUserId: 'external-browser',
      entries: [
        ...Array.from({ length: 1005 }, (_, index) => createEntry('feedback', index)),
        ...Array.from({ length: 1005 }, (_, index) => createEntry('suggestion', index)),
        { ...createEntry('feedback', 9999), id: 'persisted-official', source: 'official-example' }
      ],
      likedEntryIds: []
    }));
    const repository = new LocalStorageFeedbackRepository({ storage, createId: () => 'unused-id' });

    expect(repository.list('feedback')).toHaveLength(1006);
    expect(repository.list('suggestion')).toHaveLength(1006);
    expect(repository.list('feedback').some((entry) => entry.id === 'persisted-official')).toBe(false);

    const persisted = JSON.parse(storage.getItem(feedbackStorageKey)!);
    expect(persisted.entries).toHaveLength(2000);
    expect(persisted.entries.every((entry: { source: string }) => entry.source === 'local-user')).toBe(true);
  });

  it('有效缓存之后遇到损坏持久化数据时清空本地记录并回退示例', () => {
    const storage = new MemoryStorage();
    storage.setItem(feedbackStorageKey, JSON.stringify({
      version: 1,
      localUserId: 'cached-browser',
      entries: [{
        id: 'cached-local',
        kind: 'feedback',
        authorId: 'cached-browser',
        authorName: '缓存用户',
        content: '这是一条至少十个字符的缓存反馈内容。',
        likeCount: 1,
        createdAt: '2026-07-26T12:00:00.000Z',
        updatedAt: '2026-07-26T12:00:00.000Z',
        source: 'local-user'
      }],
      likedEntryIds: []
    }));
    const repository = new LocalStorageFeedbackRepository({ storage, createId: () => 'recovery-browser' });

    expect(repository.list('feedback').some((entry) => entry.id === 'cached-local')).toBe(true);
    storage.setItem(feedbackStorageKey, '{损坏数据');

    const recoveredEntries = repository.list('feedback');
    expect(recoveredEntries).toHaveLength(6);
    expect(recoveredEntries.some((entry) => entry.id === 'cached-local')).toBe(false);
    expect(repository.getStatusNotice()).toMatchObject({ code: 'STORAGE_DATA_RECOVERED' });
  });

  it('写入失败抛出可识别领域错误，不吞掉投稿失败', () => {
    const storage = new ThrowingStorage();
    const repository = new LocalStorageFeedbackRepository({
      storage,
      createId: () => 'browser-id',
      now: () => '2026-07-26T12:00:00.000Z'
    });
    let thrown: unknown;

    try {
      repository.create(validInput);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(FeedbackStorageError);
    expect(thrown).toMatchObject({ code: 'WRITE_FAILED' });
  });

  it('storage 事件通知订阅者，且取消订阅可重复调用', () => {
    const { repository, eventTarget } = createRepository();
    const listener = vi.fn();
    const unsubscribe = repository.subscribe(listener);

    eventTarget.dispatchEvent(Object.assign(new Event('storage'), { key: feedbackStorageKey }));
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    unsubscribe();
    eventTarget.dispatchEvent(Object.assign(new Event('storage'), { key: feedbackStorageKey }));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('首次初始化写入失败时仍回退到内存示例并提供非阻断通知', () => {
    const repository = new LocalStorageFeedbackRepository({
      storage: new ThrowingStorage(),
      createId: () => 'memory-browser'
    });

    expect(() => repository.list('feedback')).not.toThrow();
    expect(repository.list('feedback')).toHaveLength(6);
    expect(repository.getStatusNotice()).toMatchObject({ code: 'STORAGE_WRITE_FAILED' });
  });

  it('本地存储不可用时仍读取官方示例，但拒绝创建和点赞写入', () => {
    const repository = new LocalStorageFeedbackRepository({
      storage: null,
      createId: () => 'unavailable-browser'
    });
    const entriesBeforeFailedWrite = repository.list('feedback');
    const example = repository.list('feedback')[0]!;
    let createError: unknown;

    expect(repository.list('feedback')).toHaveLength(6);
    try {
      repository.create(validInput);
    } catch (error) {
      createError = error;
    }
    expect(createError).toBeInstanceOf(FeedbackStorageError);
    expect(createError).toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(repository.list('feedback')).toEqual(entriesBeforeFailedWrite);
    expect(() => repository.toggleLike(example.id, 'unavailable-browser'))
      .toThrow(FeedbackStorageError);
  });

  it('浏览器本地存储可用时，显式 null 仍禁用反馈存储', () => {
    const browserStorage = new MemoryStorage();
    vi.stubGlobal('window', { localStorage: browserStorage });
    try {
      const repository = new LocalStorageFeedbackRepository({
        storage: null,
        createId: () => 'explicitly-unavailable-browser'
      });
      const example = repository.list('feedback')[0]!;

      expect(browserStorage.getItem(feedbackStorageKey)).toBeNull();
      expect(() => repository.create(validInput)).toThrow(FeedbackStorageError);
      expect(() => repository.toggleLike(example.id, 'explicitly-unavailable-browser'))
        .toThrow(FeedbackStorageError);
      expect(browserStorage.getItem(feedbackStorageKey)).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
