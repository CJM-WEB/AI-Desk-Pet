import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../lib/api-client';
import { CloudFeedbackRepository } from '../components/website-experience/feedback/cloud-feedback-repository';
import { feedbackRepository } from '../components/website-experience/chapter-registry';

function createApi(...responses: unknown[]) {
  return {
    request: vi.fn().mockImplementation((_path, schema) => {
      const response = responses.shift();
      return response instanceof Promise ? response : Promise.resolve(schema.parse(response));
    })
  } as unknown as ApiClient;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

describe('云端反馈仓库', () => {
  it('只把公开接口返回的已发布反馈装入同步快照', async () => {
    const api = createApi({
      items: [{
        id: 'published-1', kind: 'feedback', authorName: '公开用户', content: '已经审核发布的反馈。',
        likeCount: 3, createdAt: '2026-08-01T00:00:00.000Z'
      }],
      nextCursor: null
    });
    const repository = new CloudFeedbackRepository(api);

    await repository.refresh('feedback');

    expect(repository.list('feedback')).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'published-1', source: 'local-user', likeCount: 3 })
    ]));
    expect(vi.mocked(api.request)).toHaveBeenCalledWith('/feedback?kind=feedback&limit=100', expect.anything());
  });

  it('读取所有公开分页，并在游标循环时失败关闭', async () => {
    const api = createApi(
      {
        items: [{
          id: 'published-1', kind: 'feedback', authorName: '第一页', content: '第一页公开反馈。',
          likeCount: 1, createdAt: '2026-08-01T00:00:00.000Z'
        }], nextCursor: 'v1.feedback-next'
      },
      {
        items: [{
          id: 'published-2', kind: 'feedback', authorName: '第二页', content: '第二页公开反馈。',
          likeCount: 2, createdAt: '2026-08-02T00:00:00.000Z'
        }], nextCursor: null
      }
    );
    const repository = new CloudFeedbackRepository(api);

    await repository.refresh('feedback');

    expect(repository.list('feedback')).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'published-1' }),
      expect.objectContaining({ id: 'published-2' })
    ]));
    expect(vi.mocked(api.request)).toHaveBeenNthCalledWith(2, '/feedback?kind=feedback&limit=100&cursor=v1.feedback-next', expect.anything());
  });

  it('反馈和建议并发刷新时保留各自的失败状态', async () => {
    const api = {
      request: vi.fn((path: string) => {
        if (path.includes('kind=feedback')) {
          return Promise.resolve({ items: [], nextCursor: null });
        }
        return Promise.reject(new Error('SUGGESTION_NETWORK_FAILED'));
      })
    } as unknown as ApiClient;
    const repository = new CloudFeedbackRepository(api);

    await Promise.allSettled([
      repository.refresh('feedback'),
      repository.refresh('suggestion')
    ]);

    expect(repository.getStatusNotice('feedback')).toBeNull();
    expect(repository.getStatusNotice('suggestion')).toMatchObject({
      code: 'CLOUD_READ_FAILED'
    });
  });

  it('旧刷新晚于新失败完成时不覆盖该类型的失败状态', async () => {
    const older = deferred<unknown>();
    const newer = deferred<unknown>();
    const api = {
      request: vi.fn()
        .mockReturnValueOnce(older.promise)
        .mockReturnValueOnce(newer.promise)
    } as unknown as ApiClient;
    const repository = new CloudFeedbackRepository(api);
    const oldRequest = repository.refresh('feedback');
    const newRequest = repository.refresh('feedback');

    newer.reject(new Error('NEW_REQUEST_FAILED'));
    await expect(newRequest).rejects.toThrow('NEW_REQUEST_FAILED');
    older.resolve({ items: [], nextCursor: null });
    await oldRequest;

    expect(repository.getStatusNotice('feedback')).toMatchObject({
      code: 'CLOUD_READ_FAILED'
    });
  });

  it('旧刷新晚于新成功失败时不覆盖该类型的公开快照', async () => {
    const older = deferred<unknown>();
    const api = {
      request: vi.fn()
        .mockReturnValueOnce(older.promise)
        .mockResolvedValueOnce({
          items: [{
            id: 'newest-feedback', kind: 'feedback', authorName: '最新用户', content: '最新公开反馈。',
            likeCount: 5, createdAt: '2026-08-03T00:00:00.000Z'
          }], nextCursor: null
        })
    } as unknown as ApiClient;
    const repository = new CloudFeedbackRepository(api);
    const oldRequest = repository.refresh('feedback');
    await repository.refresh('feedback');
    older.reject(new Error('OLD_REQUEST_FAILED'));
    await expect(oldRequest).rejects.toThrow('OLD_REQUEST_FAILED');

    expect(repository.getStatusNotice('feedback')).toBeNull();
    expect(repository.list('feedback')).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'newest-feedback' })
    ]));
  });

  it('重复游标时清空网络快照并拒绝继续读取', async () => {
    const api = createApi(
      { items: [], nextCursor: 'v1.feedback-loop' },
      { items: [], nextCursor: 'v1.feedback-loop' }
    );
    const repository = new CloudFeedbackRepository(api);

    await expect(repository.refresh('feedback')).rejects.toThrow('FEEDBACK_CURSOR_LOOP');

    expect(repository.list('feedback').every((entry) => entry.source === 'official-example')).toBe(true);
  });

  it('未审核反馈提交成功后不进入公开快照', async () => {
    const api = createApi({
      submissionId: 'submission-1', statusToken: 'a'.repeat(43),
      statusPath: '/submission-status/', status: 'system_reviewing'
    });
    const repository = new CloudFeedbackRepository(api);
    const before = repository.list('feedback');

    const receipt = await repository.create({
      kind: 'feedback', authorName: '匿名用户', content: '等待系统审核的反馈内容。'
    });

    expect(receipt.status).toBe('system_reviewing');
    expect(repository.list('feedback')).toEqual(before);
    expect(vi.mocked(api.request)).toHaveBeenCalledWith('/feedback', expect.anything(), expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        kind: 'feedback', authorName: '匿名用户', content: '等待系统审核的反馈内容。'
      })
    }));
  });

  it('点赞等待独立反馈接口完成后更新快照并通知订阅者', async () => {
    const api = createApi(
      { items: [{
        id: 'published-1', kind: 'feedback', authorName: '公开用户', content: '已经审核发布的反馈。',
        likeCount: 3, createdAt: '2026-08-01T00:00:00.000Z'
      }], nextCursor: null },
      { liked: true, likeCount: 4 }
    );
    const repository = new CloudFeedbackRepository(api);
    const listener = vi.fn();
    repository.subscribe(listener);
    await repository.refresh('feedback');
    listener.mockClear();

    await expect(repository.toggleLike('published-1')).resolves.toMatchObject({
      likedByCurrentBrowser: true, likeCount: 4
    });

    const likeOptions = vi.mocked(api.request).mock.calls.at(-1)?.[2];
    expect(vi.mocked(api.request)).toHaveBeenLastCalledWith(
      '/feedback/published-1/like',
      expect.anything(),
      expect.objectContaining({ method: 'POST' })
    );
    expect(JSON.parse(String(likeOptions?.body))).toEqual({
      liked: true,
      operationId: expect.any(String)
    });
    expect(listener).toHaveBeenCalledOnce();
  });

  it('同一反馈的连续点赞按服务器响应顺序串行更新快照', async () => {
    const firstLike = deferred<unknown>();
    const secondLike = deferred<unknown>();
    const api = {
      request: vi.fn()
        .mockResolvedValueOnce({
          items: [{
            id: 'published-1', kind: 'feedback', authorName: '公开用户', content: '已经审核发布的反馈。',
            likeCount: 3, createdAt: '2026-08-01T00:00:00.000Z'
          }], nextCursor: null
        })
        .mockReturnValueOnce(firstLike.promise)
        .mockReturnValueOnce(secondLike.promise)
    } as unknown as ApiClient;
    const repository = new CloudFeedbackRepository(api);
    await repository.refresh('feedback');

    const first = repository.toggleLike('published-1');
    const second = repository.toggleLike('published-1');
    expect(vi.mocked(api.request)).toHaveBeenCalledTimes(2);

    firstLike.resolve({ liked: true, likeCount: 4 });
    await first;
    await Promise.resolve();
    expect(vi.mocked(api.request)).toHaveBeenCalledTimes(3);
    secondLike.resolve({ liked: false, likeCount: 3 });
    await second;

    expect(repository.list('feedback')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'published-1', likedByCurrentBrowser: false, likeCount: 3
      })
    ]));
    const firstBody = JSON.parse(String(vi.mocked(api.request).mock.calls[1]?.[2]?.body));
    const secondBody = JSON.parse(String(vi.mocked(api.request).mock.calls[2]?.[2]?.body));
    expect(firstBody).toMatchObject({ liked: true });
    expect(secondBody).toMatchObject({ liked: false });
    expect(secondBody.operationId).not.toBe(firstBody.operationId);
  });

  it('点赞失败重试复用同一 desired state 与 operationId', async () => {
    const api = {
      request: vi.fn()
        .mockResolvedValueOnce({
          items: [{
            id: 'published-retry', kind: 'feedback', authorName: '公开用户',
            content: '已经审核发布的反馈。', likeCount: 3,
            createdAt: '2026-08-01T00:00:00.000Z'
          }],
          nextCursor: null
        })
        .mockRejectedValueOnce(new Error('NETWORK_FAILED'))
        .mockResolvedValueOnce({ liked: true, likeCount: 4 })
    } as unknown as ApiClient;
    const repository = new CloudFeedbackRepository(api);
    await repository.refresh('feedback');

    await expect(repository.toggleLike('published-retry')).rejects.toThrow('NETWORK_FAILED');
    await expect(repository.toggleLike('published-retry')).resolves.toMatchObject({
      likedByCurrentBrowser: true,
      likeCount: 4
    });

    const firstBody = JSON.parse(String(vi.mocked(api.request).mock.calls[1]?.[2]?.body));
    const retryBody = JSON.parse(String(vi.mocked(api.request).mock.calls[2]?.[2]?.body));
    expect(firstBody).toEqual({ liked: true, operationId: expect.any(String) });
    expect(retryBody).toEqual(firstBody);
  });

  it('多页刷新期间完成的点赞不会被最终批量提交覆盖', async () => {
    const secondPage = deferred<unknown>();
    let rootReads = 0;
    const api = {
      request: vi.fn((path: string) => {
        if (path.includes('cursor=v1.feedback-next')) return secondPage.promise;
        if (path.endsWith('/like')) {
          const likeCalls = vi.mocked(api.request).mock.calls
            .filter(([calledPath]) => String(calledPath).endsWith('/like')).length;
          return Promise.resolve(likeCalls === 1
            ? { liked: true, likeCount: 4 }
            : { liked: false, likeCount: 3 });
        }
        rootReads += 1;
        return Promise.resolve({
          items: [{
            id: 'published-race', kind: 'feedback', authorName: '公开用户',
            content: '刷新交错反馈。', likeCount: 3,
            createdAt: '2026-08-01T00:00:00.000Z'
          }],
          nextCursor: rootReads === 1 ? null : 'v1.feedback-next'
        });
      })
    } as unknown as ApiClient;
    const repository = new CloudFeedbackRepository(api);
    await repository.refresh('feedback');

    const refresh = repository.refresh('feedback');
    await vi.waitFor(() => {
      expect(vi.mocked(api.request).mock.calls.some(
        ([path]) => String(path).includes('cursor=v1.feedback-next')
      )).toBe(true);
    });
    await repository.toggleLike('published-race');
    secondPage.resolve({ items: [], nextCursor: null });
    await refresh;

    expect(repository.list('feedback')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'published-race', likedByCurrentBrowser: true, likeCount: 4
      })
    ]));
    await repository.toggleLike('published-race');
    const lastBody = JSON.parse(String(vi.mocked(api.request).mock.calls.at(-1)?.[2]?.body));
    expect(lastBody.liked).toBe(false);
  });

  it('刷新保留 pending 目标但采用更新的服务端计数', async () => {
    const pendingLike = deferred<unknown>();
    let reads = 0;
    const api = {
      request: vi.fn((path: string) => {
        if (path.endsWith('/like')) return pendingLike.promise;
        reads += 1;
        return Promise.resolve({
          items: [{
            id: 'published-pending', kind: 'feedback', authorName: '公开用户',
            content: '等待点赞反馈。', likeCount: reads === 1 ? 3 : 9,
            createdAt: '2026-08-01T00:00:00.000Z'
          }],
          nextCursor: null
        });
      })
    } as unknown as ApiClient;
    const repository = new CloudFeedbackRepository(api);
    await repository.refresh('feedback');

    const like = repository.toggleLike('published-pending');
    await vi.waitFor(() => {
      expect(vi.mocked(api.request).mock.calls.some(
        ([path]) => String(path).endsWith('/like')
      )).toBe(true);
    });
    await repository.refresh('feedback');

    expect(repository.list('feedback')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'published-pending', likedByCurrentBrowser: true, likeCount: 9
      })
    ]));
    pendingLike.reject(new Error('NETWORK_FAILED'));
    await expect(like).rejects.toThrow('NETWORK_FAILED');
  });

  it('刷新保留已成功计数并叠加后续 pending 目标', async () => {
    const secondPage = deferred<unknown>();
    const secondLike = deferred<unknown>();
    let rootReads = 0;
    let likeCalls = 0;
    const api = {
      request: vi.fn((path: string) => {
        if (path.includes('cursor=v1.feedback-next')) return secondPage.promise;
        if (path.endsWith('/like')) {
          likeCalls += 1;
          return likeCalls === 1
            ? Promise.resolve({ liked: true, likeCount: 4 })
            : secondLike.promise;
        }
        rootReads += 1;
        return Promise.resolve({
          items: [{
            id: 'published-stacked', kind: 'feedback', authorName: '公开用户',
            content: '连续互动反馈。', likeCount: 3,
            createdAt: '2026-08-01T00:00:00.000Z'
          }],
          nextCursor: rootReads === 1 ? null : 'v1.feedback-next'
        });
      })
    } as unknown as ApiClient;
    const repository = new CloudFeedbackRepository(api);
    await repository.refresh('feedback');

    const refresh = repository.refresh('feedback');
    await vi.waitFor(() => expect(vi.mocked(api.request).mock.calls.some(
      ([path]) => String(path).includes('cursor=v1.feedback-next')
    )).toBe(true));
    await repository.toggleLike('published-stacked');
    const pending = repository.toggleLike('published-stacked');
    await vi.waitFor(() => expect(likeCalls).toBe(2));
    secondPage.resolve({ items: [], nextCursor: null });
    await refresh;

    expect(repository.list('feedback')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'published-stacked', likedByCurrentBrowser: false, likeCount: 4
      })
    ]));
    secondLike.reject(new Error('NETWORK_FAILED'));
    await expect(pending).rejects.toThrow('NETWORK_FAILED');
  });

  it('公开读取失败时清空网络快照，仅保留官方示例', async () => {
    const api = createApi(
      { items: [{
        id: 'published-1', kind: 'feedback', authorName: '公开用户', content: '已经审核发布的反馈。',
        likeCount: 3, createdAt: '2026-08-01T00:00:00.000Z'
      }], nextCursor: null },
      Promise.reject(new Error('NETWORK_FAILED'))
    );
    const repository = new CloudFeedbackRepository(api);
    await repository.refresh('feedback');

    await expect(repository.refresh('feedback')).rejects.toThrow('NETWORK_FAILED');

    expect(repository.list('feedback').every((entry) => entry.source === 'official-example')).toBe(true);
  });

  it('生产章节注册与粒子预览读取同一云端快照仓库', () => {
    expect(feedbackRepository).toBeInstanceOf(CloudFeedbackRepository);
  });
});
