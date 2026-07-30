/** API 可安全返回给调用方的受控错误。 */
export class ApiError extends Error {
  readonly publicMessage: string;

  constructor(
    public readonly code: string,
    public readonly statusCode: number,
    internalReason = code,
    public readonly retryAfterSeconds?: number
  ) {
    super(internalReason);
    this.name = 'ApiError';
    this.publicMessage = publicMessageFor(code);
  }
}

/** 将稳定错误码映射为不包含内部实现细节的公开文案。 */
function publicMessageFor(code: string): string {
  if (code === 'NOT_FOUND') return '接口不存在';
  if (code === 'INTERNAL_ERROR') return '服务暂时不可用';
  return '请求失败';
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
      data: data ?? null,
      error: error ? {
        code: error.code,
        message: error.publicMessage,
        ...(error.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: error.retryAfterSeconds })
      } : null,
      requestId
    })
  };
}
