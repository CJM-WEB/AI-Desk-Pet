export type BoundedJsonResponseErrorCode =
  | 'RESPONSE_TOO_LARGE'
  | 'RESPONSE_EMPTY'
  | 'RESPONSE_INVALID_JSON'
  | 'RESPONSE_ABORTED';

export class BoundedJsonResponseError extends Error {
  constructor(readonly code: BoundedJsonResponseErrorCode) {
    super(code);
    this.name = 'BoundedJsonResponseError';
  }
}

interface BoundedJsonResponseOptions {
  maxBytes: number;
  signal: AbortSignal;
}

/**
 * 在适配器边界内读取 JSON；声明长度与实际流量都不能绕过同一字节上限。
 */
export async function readBoundedJsonResponse(
  response: Response,
  options: BoundedJsonResponseOptions
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new BoundedJsonResponseError('RESPONSE_EMPTY');

  let aborted = options.signal.aborted;
  const cancelReader = async (): Promise<void> => {
    try {
      await reader.cancel();
    } catch {
      // cancel 只负责尽快停止上游；原始边界分类不能被清理失败覆盖。
    }
  };
  const handleAbort = (): void => {
    aborted = true;
    void cancelReader();
  };

  try {
    const declaredBytes = parseContentLength(
      response.headers.get('content-length')
    );
    if (declaredBytes !== null && declaredBytes > options.maxBytes) {
      await cancelReader();
      throw new BoundedJsonResponseError('RESPONSE_TOO_LARGE');
    }

    options.signal.addEventListener('abort', handleAbort, { once: true });
    if (aborted) {
      await cancelReader();
      throw new BoundedJsonResponseError('RESPONSE_ABORTED');
    }

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const item = await reader.read();
      if (aborted) {
        throw new BoundedJsonResponseError('RESPONSE_ABORTED');
      }
      if (item.done) break;
      totalBytes += item.value.byteLength;
      if (totalBytes > options.maxBytes) {
        await cancelReader();
        throw new BoundedJsonResponseError('RESPONSE_TOO_LARGE');
      }
      chunks.push(item.value);
    }

    if (totalBytes === 0) {
      throw new BoundedJsonResponseError('RESPONSE_EMPTY');
    }
    const text = Buffer.concat(
      chunks.map(chunk => Buffer.from(
        chunk.buffer,
        chunk.byteOffset,
        chunk.byteLength
      )),
      totalBytes
    ).toString('utf8');
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new BoundedJsonResponseError('RESPONSE_INVALID_JSON');
    }
  } catch (error) {
    if (error instanceof BoundedJsonResponseError) throw error;
    if (aborted) {
      throw new BoundedJsonResponseError('RESPONSE_ABORTED');
    }
    throw new BoundedJsonResponseError('RESPONSE_INVALID_JSON');
  } finally {
    options.signal.removeEventListener('abort', handleAbort);
    reader.releaseLock();
  }
}

function parseContentLength(value: string | null): number | null {
  if (value === null || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}
