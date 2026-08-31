import { describe, expect, it, vi } from 'vitest';
import { publicLikeResponseSchema } from '@myself/shared-types/website-http';
import { ApiClient, ApiClientError } from '../lib/api-client';

describe('公开 REST 客户端', () => {
  it('解包成功信封并只向 API 基址请求', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      requestId: 'request-1', data: { liked: true, likeCount: 1 }
    }), { status: 200 }));
    const client = new ApiClient('/api/v1', fetcher);
    await expect(client.request('/community/pet-1', publicLikeResponseSchema))
      .resolves.toEqual({ liked: true, likeCount: 1 });
    expect(fetcher).toHaveBeenCalledWith('/api/v1/community/pet-1', expect.any(Object));
  });

  it('将受控错误信封转换为稳定错误码', async () => {
    const client = new ApiClient('/api/v1', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      requestId: 'request-1', error: { code: 'RATE_LIMITED', retryAfterSeconds: 30 }
    }), { status: 429 })));
    await expect(client.request('/community', publicLikeResponseSchema)).rejects.toMatchObject({
      code: 'RATE_LIMITED', statusCode: 429, retryAfterSeconds: 30, requestId: 'request-1'
    });
  });

  it.each([
    ['非 JSON', 'not-json', 200],
    ['空 body', '', 200],
    ['成功信封缺少 data', JSON.stringify({ requestId: 'request-1' }), 200],
    ['成功 HTTP 携带错误信封', JSON.stringify({ requestId: 'request-1', error: { code: 'FAILED' } }), 200],
    ['错误 HTTP 携带成功信封', JSON.stringify({ requestId: 'request-1', data: { liked: true, likeCount: 1 } }), 500],
    ['畸形成功 data', JSON.stringify({ requestId: 'request-1', data: { liked: 'yes', likeCount: 1 } }), 200],
    ['畸形错误 error', JSON.stringify({ requestId: 'request-1', error: { code: 'FAILED', privateObject: 'secret' } }), 500]
  ])('%s 时失败关闭', async (_name, body, status) => {
    const client = new ApiClient('/api/v1', vi.fn().mockResolvedValue(new Response(body, { status })));

    await expect(client.request('/community', publicLikeResponseSchema))
      .rejects.toEqual(new ApiClientError('INVALID_RESPONSE', status));
  });
});
