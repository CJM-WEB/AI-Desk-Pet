import type { AdminAction, AdminActionResult, SubmissionStatus } from '@myself/shared-types';
import {
  adminActionRequestSchema,
  adminActionResponseSchema,
  adminDetailResponseSchema,
  adminQueueResponseSchema,
  adminSiteMetricsResponseSchema,
  type AdminQueueResponse,
  type AdminSubmissionDetail
} from '@myself/shared-types/website-http';

import { ApiClient } from './api-client';

export type AdminSubmissionSummary = AdminQueueResponse['items'][number];
export type AdminQueuePage = AdminQueueResponse;
export type { AdminSubmissionDetail } from '@myself/shared-types/website-http';
export type { AdminActionResult } from '@myself/shared-types';

export interface AdminApi {
  listQueue(
    accessToken: string,
    status: SubmissionStatus,
    cursor?: string,
    signal?: AbortSignal
  ): Promise<AdminQueuePage>;
  getDetail(
    accessToken: string,
    id: string,
    signal?: AbortSignal
  ): Promise<AdminSubmissionDetail>;
  getOfficialWindowsDownloadClickCount(
    accessToken: string,
    signal?: AbortSignal
  ): Promise<number>;
  applyAction(
    accessToken: string,
    id: string,
    action: AdminAction
  ): Promise<AdminActionResult>;
}

/** 管理员客户端复用公开 ApiClient 的错误信封，令牌同时供网关与应用层验证。 */
export class AdminApiClient implements AdminApi {
  constructor(private readonly api: ApiClient) {}

  async listQueue(
    accessToken: string,
    status: SubmissionStatus,
    cursor?: string,
    signal?: AbortSignal
  ): Promise<AdminQueuePage> {
    const query = new URLSearchParams({ limit: '20', status });
    if (cursor !== undefined) query.set('cursor', String(cursor));
    return this.api.request(
      `/admin/submissions?${query.toString()}`,
      adminQueueResponseSchema,
      requestInit(accessToken, signal)
    );
  }

  async getDetail(
    accessToken: string,
    id: string,
    signal?: AbortSignal
  ): Promise<AdminSubmissionDetail> {
    return this.api.request(
      `/admin/submissions/${encodeURIComponent(id)}`,
      adminDetailResponseSchema,
      requestInit(accessToken, signal)
    );
  }

  async getOfficialWindowsDownloadClickCount(
    accessToken: string,
    signal?: AbortSignal
  ): Promise<number> {
    const result = await this.api.request(
      '/admin/metrics/official-windows-download',
      adminSiteMetricsResponseSchema,
      requestInit(accessToken, signal)
    );
    return result.clickCount;
  }

  async applyAction(
    accessToken: string,
    id: string,
    action: AdminAction
  ): Promise<AdminActionResult> {
    const body = adminActionRequestSchema.parse(action);
    return this.api.request(
      `/admin/submissions/${encodeURIComponent(id)}/actions`,
      adminActionResponseSchema,
      {
        ...requestInit(accessToken),
        method: 'POST',
        body: JSON.stringify(body)
      }
    );
  }
}

function requestInit(accessToken: string, signal?: AbortSignal): RequestInit {
  return {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'x-ai-pet-admin-token': accessToken
    },
    ...(signal ? { signal } : {})
  };
}
