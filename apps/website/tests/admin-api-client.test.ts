import { describe, expect, it, vi } from 'vitest';

import { AdminApiClient } from '../lib/admin-api-client';
import { ApiClient, ApiClientError } from '../lib/api-client';

describe('管理员 API 客户端', () => {
  it('管理员令牌使用专用请求头，避免被 CloudBase 网关抢先认证', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { items: [], nextCursor: null },
      requestId: 'request-1'
    }), { status: 200 }));
    const client = new AdminApiClient(new ApiClient('/api/v1', fetcher));

    await client.listQueue('access-token', 'manual_review_pending');

    expect(fetcher).toHaveBeenCalledWith(
      '/api/v1/admin/submissions?limit=20&status=manual_review_pending',
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-ai-pet-admin-token': 'access-token' })
      })
    );
    expect(fetcher.mock.calls[0]?.[1]?.headers).not.toHaveProperty('authorization');
  });

  it('严格拒绝包含未知字段的管理员响应', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { items: [], nextCursor: null, internalSecret: 'hidden' },
      requestId: 'request-1'
    }), { status: 200 }));
    const client = new AdminApiClient(new ApiClient('/api/v1', fetcher));

    await expect(client.listQueue('access-token', 'manual_review_pending'))
      .rejects.toEqual(new ApiClientError('INVALID_RESPONSE', 200));
  });

  it('严格解析管理员私有短期地址且不接受额外凭据', async () => {
    const valid = adminDetailDto();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({
        ...valid,
        packageDownload: {
          url: 'https://preview.example/pet.zip',
          expiresAt: '2026-07-31T00:05:00.000Z'
        }
      }))
      .mockResolvedValueOnce(response({
        ...valid,
        packageDownload: {
          url: 'https://preview.example/pet.zip',
          expiresAt: '2026-07-31T00:05:00.000Z',
          storageKey: 'private/pet.zip'
        }
      }));
    const client = new AdminApiClient(new ApiClient('/api/v1', fetcher));

    await expect(client.getDetail('access-token', 'submission-1')).resolves.toMatchObject({
      packageDownload: { url: 'https://preview.example/pet.zip' }
    });
    await expect(client.getDetail('access-token', 'submission-1'))
      .rejects.toEqual(new ApiClientError('INVALID_RESPONSE', 200));
  });

  it('读取官方下载点击时沿用管理员令牌并严格解析累计值', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ clickCount: 12 }));
    const client = new AdminApiClient(new ApiClient('/api/v1', fetcher));

    await expect(client.getOfficialWindowsDownloadClickCount('access-token'))
      .resolves.toBe(12);

    expect(fetcher).toHaveBeenCalledWith(
      '/api/v1/admin/metrics/official-windows-download',
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-ai-pet-admin-token': 'access-token' })
      })
    );
  });

  it('管理员分页原样回传并安全编码服务端 opaque token', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { items: [], nextCursor: null },
      requestId: 'request-1'
    }), { status: 200 }));
    const client = new AdminApiClient(new ApiClient('/api/v1', fetcher));

    await client.listQueue(
      'access-token',
      'system_reviewing',
      'v1.admin/token'
    );

    expect(fetcher).toHaveBeenCalledWith(
      '/api/v1/admin/submissions?limit=20&status=system_reviewing&cursor=v1.admin%2Ftoken',
      expect.anything()
    );
  });

  it('使用共享最小契约解析管理员动作首次结果与两种幂等回放', async () => {
    const safeSubmission = adminActionSubmissionDto();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ submission: safeSubmission, replayed: false }))
      .mockResolvedValueOnce(response({ submission: safeSubmission, replayed: true }))
      .mockResolvedValueOnce(response({
        submission: {
          id: 'legacy-purged',
          status: 'published',
          statusVersion: 1,
          publicationBasis: 'standard'
        },
        replayed: true
      }));
    const client = new AdminApiClient(new ApiClient('/api/v1', fetcher));
    const action = {
      action: 'approve' as const,
      version: 3,
      idempotencyKey: 'admin-action-result',
      reason: '复核通过'
    };

    await expect(client.applyAction('access-token', 'submission-1', action))
      .resolves.toEqual({ submission: safeSubmission, replayed: false });
    await expect(client.applyAction('access-token', 'submission-1', action))
      .resolves.toEqual({ submission: safeSubmission, replayed: true });
    await expect(client.applyAction('access-token', 'legacy-purged', action))
      .resolves.toMatchObject({
        submission: { id: 'legacy-purged', statusVersion: 1 },
        replayed: true
      });
  });

  it('管理员动作响应对缺失字段和额外私密字段失败关闭', async () => {
    const safeSubmission = adminActionSubmissionDto();
    const { kind: _kind, ...missingKind } = safeSubmission;
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ submission: missingKind, replayed: false }))
      .mockResolvedValueOnce(response({
        submission: { ...safeSubmission, body: '不得返回的正文' },
        replayed: true
      }));
    const client = new AdminApiClient(new ApiClient('/api/v1', fetcher));
    const action = {
      action: 'approve' as const,
      version: 3,
      idempotencyKey: 'admin-action-invalid',
      reason: '拒绝异常响应'
    };

    await expect(client.applyAction('access-token', 'submission-1', action))
      .rejects.toEqual(new ApiClientError('INVALID_RESPONSE', 200));
    await expect(client.applyAction('access-token', 'submission-1', action))
      .rejects.toEqual(new ApiClientError('INVALID_RESPONSE', 200));
  });
});

function response(data: unknown): Response {
  return new Response(JSON.stringify({ requestId: 'request-1', data }), { status: 200 });
}

function adminDetailDto() {
  return {
    id: 'submission-1',
    status: 'manual_review_pending',
    statusVersion: 3,
    kind: 'shared_package',
    title: '桌宠资源',
    body: '资源说明',
    purgeAfter: null,
    preQuarantineStatus: null,
    publishedAt: null,
    publicationBasis: null,
    createdAt: '2026-07-31T00:00:00.000Z',
    updatedAt: '2026-07-31T00:01:00.000Z',
    riskSummary: {},
    autoRejectionReason: null,
    coverPreview: {
      url: 'https://preview.example/cover.webp',
      expiresAt: '2026-07-31T00:05:00.000Z'
    },
    packageDownload: null,
    assets: [],
    moderationResults: [],
    auditLogs: []
  };
}

function adminActionSubmissionDto() {
  return {
    id: 'submission-1',
    kind: 'shared_package',
    status: 'published',
    statusVersion: 4,
    publicationBasis: 'standard',
    publicReason: null,
    publishedAt: '2026-08-31T00:00:00.000Z',
    rejectedAt: null,
    quarantinedAt: null,
    createdAt: '2026-08-30T00:00:00.000Z',
    updatedAt: '2026-08-31T00:00:00.000Z'
  };
}
