import { errorEnvelopeSchema, successEnvelopeSchema } from '@myself/shared-types/website-http';
import { z } from 'zod';

/** REST 请求失败使用稳定错误码，界面不暴露服务端内部信息。 */
export class ApiClientError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
    public readonly retryAfterSeconds?: number,
    public readonly requestId?: string
  ) {
    super(code);
    this.name = 'ApiClientError';
  }
}

type Fetcher = typeof fetch;

/** 公开 REST 客户端；不依赖且不初始化任何 CloudBase 用户身份。 */
export class ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetcher: Fetcher = (input, init) => fetch(input, init)
  ) {}

  async request<T>(
    path: string,
    schema: z.ZodType<T>,
    init: RequestInit = {}
  ): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...init.headers
      }
    });
    const value = await readJson(response);
    if (response.ok) {
      const envelope = successEnvelopeSchema(z.unknown()).safeParse(value);
      if (!envelope.success) throw invalidResponse(response.status);
      const data = schema.safeParse(envelope.data.data);
      if (!data.success) throw invalidResponse(response.status);
      return data.data;
    }
    const envelope = errorEnvelopeSchema.safeParse(value);
    if (!envelope.success) throw invalidResponse(response.status);
    throw new ApiClientError(
      envelope.data.error.code,
      response.status,
      envelope.data.error.retryAfterSeconds,
      envelope.data.requestId
    );
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json() as unknown;
  } catch {
    throw invalidResponse(response.status);
  }
}

function invalidResponse(statusCode: number): ApiClientError {
  return new ApiClientError('INVALID_RESPONSE', statusCode);
}
