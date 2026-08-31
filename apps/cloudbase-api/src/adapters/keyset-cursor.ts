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
  sortTime: z.string().datetime({ offset: true }),
  id: z.string().min(1).max(128)
}).strict();

export type KeysetCursorScope = z.infer<typeof cursorScopeSchema>;

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
    const payload = cursorPayloadSchema.parse(JSON.parse(bytes.toString('utf8')));
    if (payload.scope !== expectedScope) throw new Error('cursor scope');
    return { sortTime: payload.sortTime, id: payload.id };
  } catch {
    throw new ApiError('INVALID_CURSOR', 400);
  }
}
