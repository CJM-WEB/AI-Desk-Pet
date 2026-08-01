import { describe, expect, it, vi } from 'vitest';

import { AdminApiClient } from '../lib/admin-api-client';
import { ApiClient, ApiClientError } from '../lib/api-client';

describe('管理员 API 客户端', () => {
  it('每个管理员请求都携带短期 Bearer 令牌', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { items: [], nextCursor: null },
      error: null
    }), { status: 200 }));
    const client = new AdminApiClient(new ApiClient('/api/v1', fetcher));

    await client.listQueue('access-token', 'manual_review_pending');

    expect(fetcher).toHaveBeenCalledWith(
      '/api/v1/admin/submissions?limit=20&status=manual_review_pending',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer access-token' })
      })
    );
  });

  it('严格拒绝包含未知字段的管理员响应', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { items: [], nextCursor: null, internalSecret: 'hidden' },
      error: null
    }), { status: 200 }));
    const client = new AdminApiClient(new ApiClient('/api/v1', fetcher));

    await expect(client.listQueue('access-token', 'manual_review_pending'))
      .rejects.toEqual(new ApiClientError('INVALID_RESPONSE', 200));
  });

  it('严格解析管理员私有封面短期预览且不接受额外凭据', async () => {
    const valid = adminDetailDto();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(valid))
      .mockResolvedValueOnce(response({
        ...valid,
        coverPreview: { ...valid.coverPreview, storageKey: 'private/cover.webp' }
      }));
    const client = new AdminApiClient(new ApiClient('/api/v1', fetcher));

    await expect(client.getDetail('access-token', 'submission-1')).resolves.toMatchObject({
      coverPreview: { url: 'https://preview.example/cover.webp' }
    });
    await expect(client.getDetail('access-token', 'submission-1'))
      .rejects.toEqual(new ApiClientError('INVALID_RESPONSE', 200));
  });
});

function response(data: unknown): Response {
  return new Response(JSON.stringify({ data, error: null }), { status: 200 });
}

function adminDetailDto() {
  return {
    id: 'submission-1',
    status: 'manual_review_pending',
    statusVersion: 3,
    kind: 'shared_package',
    title: '桌宠资源',
    body: '资源说明',
    moderationLeaseUntil: null,
    purgeAfter: null,
    preQuarantineStatus: null,
    publishedAt: null,
    createdAt: '2026-07-31T00:00:00.000Z',
    updatedAt: '2026-07-31T00:01:00.000Z',
    riskSummary: {},
    autoRejectionReason: null,
    coverPreview: {
      url: 'https://preview.example/cover.webp',
      expiresAt: '2026-07-31T00:05:00.000Z'
    },
    assets: [],
    moderationResults: [],
    auditLogs: []
  };
}
