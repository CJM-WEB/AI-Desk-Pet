import { randomUUID } from 'node:crypto';

import { ApiError, jsonResponse, type CloudBaseHttpResponse } from '../errors.js';

export interface CloudBaseHttpEvent {
  httpMethod: string;
  path: string;
  headers: Record<string, string | undefined>;
  body?: string;
}

export type CloudBaseHttpHandler = (
  event: CloudBaseHttpEvent
) => Promise<CloudBaseHttpResponse>;

/** 创建 HTTP 路由边界；具体业务路由由后续任务注册。 */
export function createRouter(_routes: readonly unknown[]): CloudBaseHttpHandler {
  return async () => {
    const error = new ApiError('NOT_FOUND', 404, '接口不存在');
    return jsonResponse(error.statusCode, null, error, randomUUID());
  };
}
