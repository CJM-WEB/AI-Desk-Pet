import { describe, expect, it, vi } from 'vitest';

import { PublicContentService } from '../src/services/public-content-service.js';
import { ApiError } from '../src/errors.js';

const downloadFingerprint = 'd'.repeat(64);
const downloadOperationId = '00000000-0000-4000-8000-000000000010';

function createFixture(status: string | null): {
  store: {
    recordPublicDownload: ReturnType<typeof vi.fn>;
  };
  storage: {
    createSignedUrl: ReturnType<typeof vi.fn>;
  };
  service: PublicContentService;
} {
  const store = {
    findById: vi.fn(async (id: string) => status === null ? null : ({
      id,
      status,
      kind: 'shared_package',
      publicationBasis: status === 'published' ? 'admin_override' : null,
      assets: [{
        role: 'package',
        storageKey: `submissions/${id}/package.zip`,
        fileName: 'pet.zip',
        declaredBytes: 1024,
        contentType: 'application/zip'
      }]
    })),
    recordPublicDownload: vi.fn(async () => ({ downloadCount: 1 }))
  };
  const storage = {
    createSignedUploadUrl: vi.fn(),
    info: vi.fn(),
    createSignedUrl: vi.fn(async () => ({
      url: 'https://storage.example/download',
      expiresAt: '2026-07-31T00:05:00.000Z'
    })),
    delete: vi.fn()
  };
  return {
    store,
    storage,
    service: new PublicContentService(store as never, storage)
  };
}

describe('公开内容服务', () => {
  it.each([null, 'uploading', 'system_reviewing', 'manual_review_pending'])(
    '不存在或状态为 %s 的内容不能获得下载链接',
    async status => {
      const { service, storage } = createFixture(status);

      await expect(service.getDownload(
        'pending-id',
        downloadFingerprint,
        downloadOperationId
      ))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(storage.createSignedUrl).not.toHaveBeenCalled();
    }
  );

  it('只有已发布内容获得五分钟私有包下载链接', async () => {
    const { service, store, storage } = createFixture('published');

    await expect(service.getDownload(
      'published-id',
      downloadFingerprint,
      downloadOperationId
    ))
      .resolves.toEqual({
        url: 'https://storage.example/download',
        expiresAt: '2026-07-31T00:05:00.000Z',
        publicationBasis: 'admin_override'
      });
    expect(storage.createSignedUrl).toHaveBeenCalledWith(
      'submissions/published-id/package.zip',
      300
    );
    expect(storage.createSignedUrl.mock.invocationCallOrder[0])
      .toBeLessThan(store.recordPublicDownload.mock.invocationCallOrder[0]!);
    expect(store.recordPublicDownload).toHaveBeenCalledWith({
      submissionId: 'published-id',
      fingerprintHash: downloadFingerprint,
      operationId: downloadOperationId
    });
  });

  it('已发布记录缺少固定包资产时仍拒绝下载', async () => {
    const store = {
      findById: vi.fn(async () => ({
        id: 'published-id',
        status: 'published',
        kind: 'shared_package',
        assets: []
      })),
      recordPublicDownload: vi.fn(async () => ({ downloadCount: 1 }))
    };
    const storage = {
      createSignedUrl: vi.fn()
    };
    const service = new PublicContentService(store as never, storage as never);

    await expect(service.getDownload(
      'published-id',
      downloadFingerprint,
      downloadOperationId
    ))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(storage.createSignedUrl).not.toHaveBeenCalled();
    expect(store.recordPublicDownload).not.toHaveBeenCalled();
  });

  it('签名失败时不记录成功签发，也不返回替代公开路径', async () => {
    const { service, store, storage } = createFixture('published');
    storage.createSignedUrl.mockRejectedValueOnce(
      Object.assign(new Error('storage failed'), { code: 'STORAGE_ERROR' })
    );

    await expect(service.getDownload(
      'published-id',
      downloadFingerprint,
      downloadOperationId
    ))
      .rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    expect(store.recordPublicDownload).not.toHaveBeenCalled();
  });

  it('签名成功但计数失败时拒绝整个请求且不会返回 URL', async () => {
    const { service, store, storage } = createFixture('published');
    store.recordPublicDownload.mockRejectedValueOnce(
      Object.assign(new Error('database failed'), { code: 'DATABASE_ERROR' })
    );

    await expect(service.getDownload(
      'published-id',
      downloadFingerprint,
      downloadOperationId
    )).rejects.toMatchObject({ code: 'DATABASE_ERROR' });
    expect(storage.createSignedUrl).toHaveBeenCalledOnce();
    expect(store.recordPublicDownload).toHaveBeenCalledOnce();
  });

  it('同一 operation 重试会重新签名，但 Store 只形成一次增量事实', async () => {
    const { service, store, storage } = createFixture('published');
    const snapshots = new Map<string, { downloadCount: number }>();
    let increments = 0;
    store.recordPublicDownload.mockImplementation(async input => {
      const existing = snapshots.get(input.operationId);
      if (existing) return existing;
      increments += 1;
      const result = { downloadCount: increments };
      snapshots.set(input.operationId, result);
      return result;
    });
    storage.createSignedUrl
      .mockResolvedValueOnce({
        url: 'https://storage.example/download?signature=first',
        expiresAt: '2026-07-31T00:05:00.000Z'
      })
      .mockResolvedValueOnce({
        url: 'https://storage.example/download?signature=retry',
        expiresAt: '2026-07-31T00:06:00.000Z'
      });

    const first = await service.getDownload(
      'published-id',
      downloadFingerprint,
      downloadOperationId
    );
    const retry = await service.getDownload(
      'published-id',
      downloadFingerprint,
      downloadOperationId
    );

    expect(first.url).not.toBe(retry.url);
    expect(storage.createSignedUrl).toHaveBeenCalledTimes(2);
    expect(store.recordPublicDownload).toHaveBeenCalledTimes(2);
    expect(increments).toBe(1);
  });
});

describe('公开列表与互动服务', () => {
  it.each([
    ['feedback', 'published', true],
    ['suggestion', 'published', true],
    ['shared_package', 'published', false],
    ['feedback', 'system_reviewing', false]
  ] as const)('反馈点赞把 endpoint kind 与首次状态统一交给 Store：%s/%s', async (kind, status, allowed) => {
    const store = {
      findById: vi.fn(async () => {
        throw new Error('点赞不应在原子 Store 前读取投稿');
      }),
      setPublicLike: vi.fn(async () => {
        if (status !== 'published' || !['feedback', 'suggestion'].includes(kind)) {
          throw new ApiError('NOT_FOUND', 404);
        }
        return { liked: true, likeCount: 2 };
      })
    };
    const service = new PublicContentService(store as never, {} as never);
    const operationId = '00000000-0000-4000-8000-000000000001';

    const result = service.setFeedbackLike(
      'submission-1',
      'a'.repeat(64),
      true,
      operationId
    );

    if (allowed) {
      await expect(result).resolves.toEqual({ liked: true, likeCount: 2 });
      expect(store.setPublicLike).toHaveBeenCalledWith({
        submissionId: 'submission-1',
        fingerprintHash: 'a'.repeat(64),
        desiredLiked: true,
        operationId,
        endpointKind: 'feedback'
      });
    } else {
      await expect(result).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(store.setPublicLike).toHaveBeenCalledOnce();
    }
    expect(store.findById).not.toHaveBeenCalled();
  });

  it('社区 desired-state 点赞不反转状态并原样传递操作事实', async () => {
    const store = {
      findById: vi.fn(async () => ({
        id: 'community-1', kind: 'shared_package', status: 'published'
      })),
      setPublicLike: vi.fn(async () => ({ liked: false, likeCount: 0 }))
    };
    const service = new PublicContentService(store as never, {} as never);
    const operationId = '00000000-0000-4000-8000-000000000002';

    await expect(service.setCommunityLike(
      'community-1',
      'b'.repeat(64),
      false,
      operationId
    )).resolves.toEqual({ liked: false, likeCount: 0 });
    expect(store.setPublicLike).toHaveBeenCalledWith({
      submissionId: 'community-1',
      fingerprintHash: 'b'.repeat(64),
      desiredLiked: false,
      operationId,
      endpointKind: 'community'
    });
  });

  it('同 operation 在内容取消发布后仍由原子 Store 回放首次结果', async () => {
    let status = 'published';
    const store = {
      findById: vi.fn(async () => ({
        id: 'community-1', kind: 'shared_package', status
      })),
      setPublicLike: vi.fn(async () => ({ liked: true, likeCount: 4 }))
    };
    const service = new PublicContentService(store as never, {} as never);
    const operationId = '00000000-0000-4000-8000-000000000004';

    await expect(service.setCommunityLike(
      'community-1',
      'b'.repeat(64),
      true,
      operationId
    )).resolves.toEqual({ liked: true, likeCount: 4 });
    status = 'manual_review_pending';
    await expect(service.setCommunityLike(
      'community-1',
      'b'.repeat(64),
      true,
      operationId
    )).resolves.toEqual({ liked: true, likeCount: 4 });
    expect(store.setPublicLike).toHaveBeenCalledTimes(2);
  });

  it('社区点赞拒绝已发布但类型错误的反馈', async () => {
    const store = {
      findById: vi.fn(async () => ({
        id: 'feedback-1', kind: 'feedback', status: 'published'
      })),
      setPublicLike: vi.fn(async () => {
        throw new ApiError('NOT_FOUND', 404);
      })
    };
    const service = new PublicContentService(store as never, {} as never);

    await expect(service.setCommunityLike(
      'feedback-1',
      'a'.repeat(64),
      true,
      '00000000-0000-4000-8000-000000000003'
    )).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(store.setPublicLike).toHaveBeenCalledWith({
      submissionId: 'feedback-1',
      fingerprintHash: 'a'.repeat(64),
      desiredLiked: true,
      operationId: '00000000-0000-4000-8000-000000000003',
      endpointKind: 'community'
    });
  });

  it('社区列表只返回公开 DTO 并为封面签发五分钟地址', async () => {
    const store = {
      listPublicCommunity: vi.fn(async () => ({
        items: [{
          id: 'community-1',
          title: '共享名称',
          body: '共享说明',
          assets: [
            {
              role: 'cover',
              storageKey: 'submissions/community-1/cover.webp',
              fileName: 'cover.webp',
              sizeBytes: 512,
              contentType: 'image/webp'
            },
            {
              role: 'package',
              storageKey: 'submissions/community-1/package.zip',
              fileName: 'pet.zip',
              sizeBytes: 1024,
              contentType: 'application/zip'
            }
          ],
          likeCount: 2,
          downloadCount: 3,
          publishedAt: '2026-07-31T00:00:00.000Z',
          publicationBasis: 'admin_override'
        }],
        nextCursor: null
      }))
    };
    const storage = {
      createSignedUrl: vi.fn(async () => ({
        url: 'https://storage.example/cover',
        expiresAt: '2026-07-31T00:05:00.000Z'
      }))
    };
    const service = new PublicContentService(
      store as never,
      storage as never
    );

    await expect(service.listCommunity({ limit: 20 })).resolves.toEqual({
      items: [{
        id: 'community-1',
        name: '共享名称',
        description: '共享说明',
        cover: {
          url: 'https://storage.example/cover',
          expiresAt: '2026-07-31T00:05:00.000Z'
        },
        packageFileName: 'pet.zip',
        packageSizeBytes: 1024,
        likeCount: 2,
        downloadCount: 3,
        publishedAt: '2026-07-31T00:00:00.000Z',
        publicationBasis: 'admin_override'
      }],
      nextCursor: null
    });
    expect(storage.createSignedUrl).toHaveBeenCalledWith(
      'submissions/community-1/cover.webp',
      300
    );
  });

  it('公开反馈把存储字段裁剪为反馈 DTO', async () => {
    const store = {
      listPublicFeedback: vi.fn(async () => ({
        items: [{
          id: 'feedback-1',
          kind: 'feedback',
          title: '匿名用户',
          body: '公开正文',
          likeCount: 1,
          createdAt: '2026-07-31T00:00:00.000Z'
        }],
        nextCursor: null
      }))
    };
    const service = new PublicContentService(store as never, {} as never);

    await expect(service.listFeedback('feedback', { limit: 20 }))
      .resolves.toEqual({
        items: [{
          id: 'feedback-1',
          kind: 'feedback',
          authorName: '匿名用户',
          content: '公开正文',
          likeCount: 1,
          createdAt: '2026-07-31T00:00:00.000Z'
        }],
        nextCursor: null
      });
  });
});
