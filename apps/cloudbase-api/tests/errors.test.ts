import { describe, expect, it } from 'vitest';

import { ApiError, jsonResponse } from '../src/errors.js';

describe('jsonResponse', () => {
  it('未定义数据仍保留固定 data 信封字段', () => {
    const response = jsonResponse(200, undefined, null, 'request-1');

    expect(JSON.parse(response.body)).toEqual({
      data: null,
      error: null,
      requestId: 'request-1'
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
      data: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: '服务暂时不可用'
      },
      requestId: 'request-2'
    });
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
      data: null,
      error: {
        code: 'NOT_FOUND',
        message: '接口不存在'
      },
      requestId: 'request-3'
    });
    expect(response.body).not.toContain('/admin/private');
  });
});
