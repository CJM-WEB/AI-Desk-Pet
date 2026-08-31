import { describe, expect, it } from 'vitest';

import {
  decodeKeysetCursor,
  encodeKeysetCursor
} from '../src/adapters/keyset-cursor.js';

describe('键集游标 codec', () => {
  const sortTime = '2026-08-31T03:00:00.000Z';

  it('版本化 opaque token 可无损往返且不暴露原始字段', () => {
    const cursor = encodeKeysetCursor('community', sortTime, 'same-time-b');

    expect(cursor).toMatch(/^v1\.[A-Za-z0-9_-]+$/u);
    expect(cursor).not.toContain('community');
    expect(cursor).not.toContain('same-time-b');
    expect(decodeKeysetCursor(cursor, 'community')).toEqual({
      sortTime,
      id: 'same-time-b'
    });
  });

  it('拒绝跨 scope 与管理员 status 复用', () => {
    const publicCursor = encodeKeysetCursor('feedback:feedback', sortTime, 'feedback-2');
    expect(() => decodeKeysetCursor(publicCursor, 'feedback:suggestion'))
      .toThrow('INVALID_CURSOR');

    const adminCursor = encodeKeysetCursor(
      'admin:system_reviewing',
      sortTime,
      'submission-2'
    );
    expect(() => decodeKeysetCursor(adminCursor, 'admin:manual_review_pending'))
      .toThrow('INVALID_CURSOR');
  });

  it.each([
    'v2.eyJzIjoiY29tbXVuaXR5IiwidCI6IjIwMjYtMDgtMzFUMDM6MDA6MDAuMDAwWiIsImkiOiJhIn0',
    'v1.not+base64',
    'v1.',
    `v1.${'a'.repeat(510)}`
  ])('拒绝未知版本、非 base64url、空载荷与 513 字符输入：%s', cursor => {
    expect(() => decodeKeysetCursor(cursor, 'community')).toThrow('INVALID_CURSOR');
  });

  it.each([
    ['not-a-date', 'valid-id'],
    [sortTime, ''],
    [sortTime, 'x'.repeat(129)]
  ])('拒绝非法日期或 id：%s / %s', (invalidTime, invalidId) => {
    const payload = Buffer.from(JSON.stringify({
      scope: 'community',
      sortTime: invalidTime,
      id: invalidId
    })).toString('base64url');
    expect(() => decodeKeysetCursor(`v1.${payload}`, 'community'))
      .toThrow('INVALID_CURSOR');
  });
});
