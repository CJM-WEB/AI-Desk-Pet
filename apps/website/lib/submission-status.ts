import {
  submissionStatusViewSchema,
  type SubmissionStatusView
} from '@myself/shared-types';
import type { ApiClient } from './api-client';

const STATUS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

/** 状态令牌仅允许来自 URL Fragment，避免被服务端日志或跳转来源记录。 */
export function readStatusToken(locationHash: string): string | null {
  const candidate = locationHash.startsWith('#') ? locationHash.slice(1) : '';
  return STATUS_TOKEN_PATTERN.test(candidate) ? candidate : null;
}

/** 查询时只发送令牌，并用共享契约校验服务端公开响应。 */
export async function querySubmissionStatus(
  api: ApiClient,
  statusToken: string
): Promise<SubmissionStatusView> {
  const result = await api.request<unknown>('/submission-status', {
    method: 'POST',
    body: JSON.stringify({ statusToken })
  });
  return submissionStatusViewSchema.parse(result);
}
