import { describe, expect, it, vi } from 'vitest';

import { PublicContentService } from '../src/services/public-content-service.js';

function createFixture(status: string | null): {
  storage: {
    createSignedUrl: ReturnType<typeof vi.fn>;
  };
  service: PublicContentService;
} {
  const store = {
    findById: vi.fn(async (id: string) => status === null ? null : ({
      id,
      status,
      assets: [{
        role: 'package',
        storageKey: `submissions/${id}/package.zip`,
        fileName: 'pet.zip',
        declaredBytes: 1024,
        contentType: 'application/zip'
      }]
    }))
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
    const { service, storage } = createFixture('published');

    await expect(service.getDownload('published-id', 'device-hash'))
      .resolves.toEqual({
        url: 'https://storage.example/download',
        expiresAt: '2026-07-31T00:05:00.000Z'
      });
    expect(storage.createSignedUrl).toHaveBeenCalledWith(
      'submissions/published-id/package.zip',
      300
    );
  });

  it('已发布记录缺少固定包资产时仍拒绝下载', async () => {
    const store = {
      findById: vi.fn(async () => ({
        id: 'published-id',
        status: 'published',
        assets: []
      }))
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
