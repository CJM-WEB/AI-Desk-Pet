import { createHash, randomBytes } from 'node:crypto';

/** 生成 32 字节随机状态令牌，base64url 编码后固定为 43 个字符。 */
export function createStatusToken(): string {
  return randomBytes(32).toString('base64url');
}

/** 数据库只保存状态令牌的 SHA-256 十六进制摘要。 */
export function hashStatusToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
