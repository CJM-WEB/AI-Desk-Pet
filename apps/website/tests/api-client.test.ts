import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiClientError } from '../lib/api-client';

describe('公开 REST 客户端', () => {
  it('解包成功信封并只向 API 基址请求', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { id: 'pet-1' }, error: null, requestId: 'request-1'
    }), { status: 200 }));
    const client = new ApiClient('/api/v1', fetcher);
    await expect(client.request<{ id: string }>('/community/pet-1')).resolves.toEqual({ id: 'pet-1' });
    expect(fetcher).toHaveBeenCalledWith('/api/v1/community/pet-1', expect.any(Object));
  });

  it('将受控错误信封转换为稳定错误码', async () => {
    const client = new ApiClient('/api/v1', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: null, error: { code: 'RATE_LIMITED', retryAfterSeconds: 30 }, requestId: 'request-1'
    }), { status: 429 })));
    await expect(client.request('/community')).rejects.toMatchObject({
      code: 'RATE_LIMITED', statusCode: 429, retryAfterSeconds: 30
    });
  });
});
