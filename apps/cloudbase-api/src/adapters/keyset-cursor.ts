import { TextDecoder } from 'node:util';
import { z } from 'zod';

import { ApiError } from '../errors.js';

const MAX_CURSOR_LENGTH = 512;
const cursorScopeSchema = z.enum([
  'community',
  'feedback:feedback',
  'feedback:suggestion',
  'admin:all',
  'admin:uploading',
  'admin:system_reviewing',
  'admin:manual_review_pending',
  'admin:published',
  'admin:auto_rejected',
  'admin:admin_rejected',
  'admin:deleted_quarantined',
  'admin:purged'
]);
const cursorPayloadSchema = z.object({
  scope: cursorScopeSchema,
  sortTime: z.string().datetime({ offset: true }).refine(isSemanticDateTime),
  id: z.string().min(1).max(128)
}).strict();

export type KeysetCursorScope = z.infer<typeof cursorScopeSchema>;

const strictUtf8Decoder = new TextDecoder('utf-8', { fatal: true });

/** 数据库只接收真实 RFC 3339 时刻，避免宽松正则把非法日历或时区交给 timestamptz。 */
function isSemanticDateTime(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const offsetHour = match[7] === 'Z' ? 0 : Number(match[9]);
  const offsetMinute = match[7] === 'Z' ? 0 : Number(match[10]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year > 0
    && month >= 1
    && month <= 12
    && day >= 1
    && day <= monthDays[month - 1]!
    && Number(match[4]) <= 23
    && Number(match[5]) <= 59
    && Number(match[6]) <= 59
    && offsetHour <= 14
    && offsetMinute <= 59
    && (offsetHour < 14 || offsetMinute === 0)
    && Number.isFinite(Date.parse(value));
}

/** 游标只携带稳定键集位置和 scope，不使用会自然过期的时间声明。 */
export function encodeKeysetCursor(
  scope: KeysetCursorScope,
  sortTime: string,
  id: string
): string {
  const payload = cursorPayloadSchema.parse({ scope, sortTime, id });
  return `v1.${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
}

/** 解码时同时验证版本、规范 base64url、字段形状与调用方 scope。 */
export function decodeKeysetCursor(
  cursor: string,
  expectedScope: KeysetCursorScope
): { sortTime: string; id: string } {
  try {
    if (cursor.length > MAX_CURSOR_LENGTH || !/^v1\.[A-Za-z0-9_-]+$/u.test(cursor)) {
      throw new Error('cursor format');
    }
    const encoded = cursor.slice(3);
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) throw new Error('cursor encoding');
    const payload = cursorPayloadSchema.parse(JSON.parse(strictUtf8Decoder.decode(bytes)));
    if (payload.scope !== expectedScope) throw new Error('cursor scope');
    return { sortTime: payload.sortTime, id: payload.id };
  } catch {
    throw new ApiError('INVALID_CURSOR', 400);
  }
}
