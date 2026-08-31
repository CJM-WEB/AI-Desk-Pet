import { describe, expect, it } from 'vitest';

import { jsonResponse } from '../src/errors.js';
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
      error: { code: 'NOT_FOUND' },
      requestId: expect.any(String)
    });
  });

  it('精确派发已注册的路由', async () => {
    const router = createRouter([{
      method: 'GET',
      path: '/api/v1/health',
      handler: async event => jsonResponse(200, { path: event.path }, null, 'request-health')
    }]);

    const response = await router({
      httpMethod: 'GET',
      path: '/api/v1/health',
      headers: {},
      body: ''
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      data: { path: '/api/v1/health' },
      requestId: 'request-health'
    });
  });
});
