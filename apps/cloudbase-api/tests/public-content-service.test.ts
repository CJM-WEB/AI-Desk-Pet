import { describe, expect, it, vi } from 'vitest';

import { PublicContentService } from '../src/services/public-content-service.js';

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

      await expect(service.getDownload('pending-id', 'device-hash'))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(storage.createSignedUrl).not.toHaveBeenCalled();
    }
  );

  it('只有已发布内容获得五分钟私有包下载链接', async () => {
    const { service, store, storage } = createFixture('published');

    await expect(service.getDownload('published-id', 'device-hash'))
      .resolves.toEqual({
        url: 'https://storage.example/download',
        expiresAt: '2026-07-31T00:05:00.000Z'
      });
    expect(storage.createSignedUrl).toHaveBeenCalledWith(
      'submissions/published-id/package.zip',
      300
    );
    expect(store.recordPublicDownload.mock.invocationCallOrder[0])
      .toBeLessThan(storage.createSignedUrl.mock.invocationCallOrder[0]!);
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

    await expect(service.getDownload('published-id', 'device-hash'))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(storage.createSignedUrl).not.toHaveBeenCalled();
  });

  it('签名服务失败时不返回替代公开路径', async () => {
    const { service, storage } = createFixture('published');
    storage.createSignedUrl.mockRejectedValueOnce(
      Object.assign(new Error('storage failed'), { code: 'STORAGE_ERROR' })
    );

    await expect(service.getDownload('published-id', 'device-hash'))
      .rejects.toMatchObject({ code: 'STORAGE_ERROR' });
  });
});

describe('公开列表与互动服务', () => {
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
          publishedAt: '2026-07-31T00:00:00.000Z'
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
        publishedAt: '2026-07-31T00:00:00.000Z'
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
