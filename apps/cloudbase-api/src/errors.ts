/** API 可安全返回给调用方的受控错误。 */
export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message = code
  ) {
    super(message);
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
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    },
    body: JSON.stringify({
      data,
      error: error ? { code: error.code, message: error.message } : null,
      requestId
    })
  };
}
