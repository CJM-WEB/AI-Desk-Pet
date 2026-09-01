import { afterEach, describe, expect, it, vi } from 'vitest';

import { recordOfficialDownloadClick } from '../lib/official-download-metric-client';

describe('官方安装包点击上报客户端', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('使用配置的非同源 API 基地址发送旁路请求', () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'https://api.example.test/api/v1');
    vi.stubGlobal('fetch', fetcher);

    recordOfficialDownloadClick();

    expect(fetcher).toHaveBeenCalledWith(
      'https://api.example.test/api/v1/official-downloads/windows/click',
      expect.any(Object)
    );
  });

  it('只发送一次严格空的旁路请求', () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetcher);

    recordOfficialDownloadClick();

    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
      '/api/v1/official-downloads/windows/click',
      expect.objectContaining({
        method: 'POST',
        body: '{}',
        keepalive: true,
        credentials: 'omit'
      })
    );
  });

  it.each([
    ['同步抛错', () => { throw new Error('offline'); }],
    ['网络拒绝', () => Promise.reject(new Error('offline'))],
    ['429 响应', () => Promise.resolve(new Response(null, { status: 429 }))],
    ['500 响应', () => Promise.resolve(new Response(null, { status: 500 }))]
  ])('辅助请求%s时吞掉错误且不重试', async (_label, request) => {
    const fetcher = vi.fn(request);
    vi.stubGlobal('fetch', fetcher);

    expect(() => recordOfficialDownloadClick()).not.toThrow();
    await Promise.resolve();

    expect(fetcher).toHaveBeenCalledOnce();
  });
});
