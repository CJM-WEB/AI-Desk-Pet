import { describe, expect, it } from 'vitest';

import { createRouter } from '../src/http/router.js';

describe('createRouter', () => {
  it('未知 API 路径返回稳定 404', async () => {
    const response = await createRouter([])({
      httpMethod: 'GET',
      path: '/api/v1/missing',
      headers: {},
      body: ''
    });

    expect(response).toMatchObject({
      statusCode: 404,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store'
      }
    });
    expect(JSON.parse(response.body)).toMatchObject({
      data: null,
      error: { code: 'NOT_FOUND' },
      requestId: expect.any(String)
    });
  });
});
