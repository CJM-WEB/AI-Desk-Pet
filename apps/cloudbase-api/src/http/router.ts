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

/** 已注册 HTTP 路由的精确匹配规则。 */
export interface Route {
  method: string;
  path: string;
  handler: CloudBaseHttpHandler;
}

/** 创建 HTTP 路由边界，并对未匹配请求返回稳定错误信封。 */
export function createRouter(routes: readonly Route[]): CloudBaseHttpHandler {
  return async event => {
    const route = routes.find(candidate => (
      candidate.method === event.httpMethod && candidate.path === event.path
    ));
    if (route) return route.handler(event);

    const error = new ApiError('NOT_FOUND', 404, '接口不存在');
    return jsonResponse(error.statusCode, null, error, randomUUID());
  };
}
