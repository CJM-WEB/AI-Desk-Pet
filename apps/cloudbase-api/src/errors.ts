import { z } from 'zod';
import {
  errorEnvelopeSchema,
  successEnvelopeSchema
} from '@myself/shared-types/website-http';

/** API 可安全返回给调用方的受控错误。 */
export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
    internalReason = code,
    public readonly retryAfterSeconds?: number
  ) {
    super(internalReason);
    this.name = 'ApiError';
  }
}

export interface CloudBaseHttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

/** 将成功或受控错误统一序列化为不可缓存的 JSON 响应。 */
export function jsonResponse(
  statusCode: number,
  data: unknown,
  error: ApiError | null,
  requestId: string
): CloudBaseHttpResponse {
  const envelope = error
    ? errorEnvelopeSchema.parse({
        requestId,
        error: {
          code: error.code,
          ...(error.retryAfterSeconds === undefined
            ? {}
            : { retryAfterSeconds: error.retryAfterSeconds })
        }
      })
    : successEnvelopeSchema(z.unknown()).parse({ requestId, data });
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    },
    body: JSON.stringify(envelope)
  };
}
