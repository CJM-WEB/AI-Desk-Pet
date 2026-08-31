import { describe, expect, it } from 'vitest';

import { ApiError, jsonResponse } from '../src/errors.js';

describe('jsonResponse', () => {
  it('成功信封只包含必填 requestId 与 data', () => {
    const response = jsonResponse(200, { ok: true }, null, 'request-1');

    expect(JSON.parse(response.body)).toEqual({
      requestId: 'request-1',
      data: { ok: true }
    });
  });

  it('不向响应公开内部错误原因', () => {
    const response = jsonResponse(
      500,
      null,
      new ApiError('INTERNAL_ERROR', 500, '数据库密码：secret-for-test'),
      'request-2'
    );

    expect(JSON.parse(response.body)).toEqual({
      error: { code: 'INTERNAL_ERROR' },
      requestId: 'request-2'
    });
    expect(JSON.parse(response.body).data).toBeUndefined();
    expect(response.body).not.toContain('secret-for-test');
  });

  it('未找到路由使用固定公开文案', () => {
    const response = jsonResponse(
      404,
      null,
      new ApiError('NOT_FOUND', 404, '内部路由：/admin/private'),
      'request-3'
    );

    expect(JSON.parse(response.body)).toEqual({
      error: { code: 'NOT_FOUND' },
      requestId: 'request-3'
    });
    expect(response.body).not.toContain('/admin/private');
  });
});
