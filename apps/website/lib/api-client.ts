/** REST 请求失败使用稳定错误码，界面不暴露服务端内部信息。 */
export class ApiClientError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
    public readonly retryAfterSeconds?: number
  ) {
    super(code);
    this.name = 'ApiClientError';
  }
}

interface ApiEnvelope<T> {
  data: T | null;
  error: {
    code: string;
    retryAfterSeconds?: number;
  } | null;
}

type Fetcher = typeof fetch;

/** 公开 REST 客户端；不依赖且不初始化任何 CloudBase 用户身份。 */
export class ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetcher: Fetcher = fetch
  ) {}

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...init.headers
      }
    });
    const envelope = await readEnvelope<T>(response);
    if (!response.ok || envelope.error) {
      throw new ApiClientError(
        envelope.error?.code ?? 'REQUEST_FAILED',
        response.status,
        envelope.error?.retryAfterSeconds
      );
    }
    if (envelope.data === null) throw new ApiClientError('INVALID_RESPONSE', response.status);
    return envelope.data;
  }
}

async function readEnvelope<T>(response: Response): Promise<ApiEnvelope<T>> {
  try {
    const value: unknown = await response.json();
    if (typeof value !== 'object' || value === null) throw new Error();
    const envelope = value as Partial<ApiEnvelope<T>>;
    if (!('data' in envelope) || !('error' in envelope)) throw new Error();
    return envelope as ApiEnvelope<T>;
  } catch {
    throw new ApiClientError('INVALID_RESPONSE', response.status);
  }
}
