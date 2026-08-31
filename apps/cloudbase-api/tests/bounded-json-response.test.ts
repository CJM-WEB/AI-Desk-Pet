import { describe, expect, it, vi } from 'vitest';

import { readBoundedJsonResponse } from
  '../src/adapters/bounded-json-response.js';

describe('有界 JSON 响应读取', () => {
  it('预先 abort 优先于空正文和声明长度超限', async () => {
    const controller = new AbortController();
    controller.abort();
    const reader = {
      read: vi.fn(),
      cancel: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn()
    };
    const declaredOversize = {
      headers: new Headers({ 'content-length': '9' }),
      body: { getReader: () => reader }
    } as unknown as Response;

    await expect(readBoundedJsonResponse(new Response(null), {
      maxBytes: 8,
      signal: controller.signal
    })).rejects.toMatchObject({ code: 'RESPONSE_ABORTED' });
    await expect(readBoundedJsonResponse(declaredOversize, {
      maxBytes: 8,
      signal: controller.signal
    })).rejects.toMatchObject({ code: 'RESPONSE_ABORTED' });
    expect(reader.read).not.toHaveBeenCalled();
    expect(reader.cancel).toHaveBeenCalledOnce();
    expect(reader.releaseLock).toHaveBeenCalledOnce();
  });

  it('声明长度超过上限时不读取正文并取消 reader', async () => {
    const reader = {
      read: vi.fn(),
      cancel: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn()
    };
    const response = {
      headers: new Headers({ 'content-length': '9' }),
      body: { getReader: () => reader }
    } as unknown as Response;

    await expect(readBoundedJsonResponse(response, {
      maxBytes: 8,
      signal: new AbortController().signal
    })).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
    expect(reader.read).not.toHaveBeenCalled();
    expect(reader.cancel).toHaveBeenCalledOnce();
    expect(reader.releaseLock).toHaveBeenCalledOnce();
  });

  it('无声明长度的分块正文实际超过上限时立即取消 reader', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"value":'));
        controller.enqueue(new TextEncoder().encode('123456789}'));
      },
      cancel() {
        cancelled = true;
      }
    });

    await expect(readBoundedJsonResponse(new Response(body), {
      maxBytes: 12,
      signal: new AbortController().signal
    })).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
    expect(cancelled).toBe(true);
  });

  it('接受字节数恰好等于上限的合法 JSON', async () => {
    const text = '{"a":1}';

    await expect(readBoundedJsonResponse(new Response(text), {
      maxBytes: 7,
      signal: new AbortController().signal
    })).resolves.toEqual({ a: 1 });
  });

  it.each([
    { label: '空正文', body: '', code: 'RESPONSE_EMPTY' },
    { label: '畸形 JSON', body: '{', code: 'RESPONSE_INVALID_JSON' }
  ])('把$label归一化为稳定分类', async ({ body, code }) => {
    await expect(readBoundedJsonResponse(new Response(body), {
      maxBytes: 8,
      signal: new AbortController().signal
    })).rejects.toMatchObject({ code });
  });

  it('正文读取途中 abort 时取消 reader', async () => {
    let cancelled = false;
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode('{'));
      },
      cancel() {
        cancelled = true;
      }
    });
    const pending = readBoundedJsonResponse(new Response(body), {
      maxBytes: 8,
      signal: controller.signal
    });

    await Promise.resolve();
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'RESPONSE_ABORTED' });
    expect(cancelled).toBe(true);
  });

  it.each([
    {
      label: '声明长度超限',
      headers: new Headers({ 'content-length': '9' }),
      read: vi.fn()
    },
    {
      label: '实际分块超限',
      headers: new Headers(),
      read: vi.fn().mockResolvedValue({
        done: false,
        value: new Uint8Array(9)
      })
    }
  ])('$label不等待永不完成的 cancel', async ({ headers, read }) => {
    const reader = {
      read,
      cancel: vi.fn(() => new Promise<void>(() => undefined)),
      releaseLock: vi.fn()
    };
    const response = {
      headers,
      body: { getReader: () => reader }
    } as unknown as Response;
    const operation = readBoundedJsonResponse(response, {
      maxBytes: 8,
      signal: new AbortController().signal
    }).then(
      () => ({ status: 'resolved' }),
      (error: unknown) => ({
        status: 'rejected',
        code: error instanceof Error && 'code' in error
          ? error.code
          : undefined
      })
    );

    await expect(Promise.race([
      operation,
      new Promise(resolve => setTimeout(
        () => resolve({ status: 'pending' }),
        0
      ))
    ])).resolves.toEqual({
      status: 'rejected',
      code: 'RESPONSE_TOO_LARGE'
    });
    expect(reader.cancel).toHaveBeenCalledOnce();
  });

  it('releaseLock 抛错不覆盖成功 JSON', async () => {
    const reader = {
      read: vi.fn()
        .mockResolvedValueOnce({
          done: false,
          value: new TextEncoder().encode('{"a":1}')
        })
        .mockResolvedValueOnce({ done: true, value: undefined }),
      cancel: vi.fn(),
      releaseLock: vi.fn(() => {
        throw new Error('release failed');
      })
    };
    const response = {
      headers: new Headers(),
      body: { getReader: () => reader }
    } as unknown as Response;

    await expect(readBoundedJsonResponse(response, {
      maxBytes: 7,
      signal: new AbortController().signal
    })).resolves.toEqual({ a: 1 });
  });

  it('releaseLock 抛错不覆盖原始边界错误', async () => {
    const reader = {
      read: vi.fn(),
      cancel: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn(() => {
        throw new Error('release failed');
      })
    };
    const response = {
      headers: new Headers({ 'content-length': '9' }),
      body: { getReader: () => reader }
    } as unknown as Response;

    await expect(readBoundedJsonResponse(response, {
      maxBytes: 8,
      signal: new AbortController().signal
    })).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
  });
});
