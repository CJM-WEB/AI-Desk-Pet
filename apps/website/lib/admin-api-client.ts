import type { AdminAction, AdminActionResult, SubmissionStatus } from '@myself/shared-types';
import {
  adminActionRequestSchema,
  adminActionResponseSchema,
  adminDetailResponseSchema,
  adminQueueResponseSchema,
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
  applyAction(
    accessToken: string,
    id: string,
    action: AdminAction
  ): Promise<AdminActionResult>;
}

/** 管理员客户端复用公开 ApiClient 的错误信封，并用专用头避开 CloudBase 网关认证。 */
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
    headers: { 'x-ai-pet-admin-token': accessToken },
    ...(signal ? { signal } : {})
  };
}
