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
});
