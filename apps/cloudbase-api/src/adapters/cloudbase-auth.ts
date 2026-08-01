import { ApiError } from '../errors.js';
import type {
  AdminIdentity,
  AdminIdentityProvider
} from '../ports.js';

interface CloudBaseAuthUserInfo {
  uid?: unknown;
}

interface CloudBaseEndUserInfo {
  userInfo?: unknown;
}

/** CloudBase 身份认证适配器的最小表面，便于隔离 SDK 的宽泛返回类型。 */
export interface CloudBaseAuthClient {
  getUserInfo(): CloudBaseAuthUserInfo;
  getEndUserInfo(uid: string): Promise<CloudBaseEndUserInfo> | CloudBaseEndUserInfo;
}

/** 只允许当前登录邮箱与唯一管理员白名单完全匹配。 */
export class CloudBaseAdminIdentityProvider implements AdminIdentityProvider {
  private readonly normalizedAdminEmail: string;

  constructor(
    private readonly auth: CloudBaseAuthClient,
    adminEmail: string
  ) {
    this.normalizedAdminEmail = normalizeEmail(adminEmail);
  }

  async requireAdmin(): Promise<AdminIdentity> {
    const uid = this.auth.getUserInfo().uid;
    if (typeof uid !== 'string' || uid.length === 0) {
      throw new ApiError('UNAUTHORIZED', 401);
    }

    const result = await this.auth.getEndUserInfo(uid);
    const email = readEmail(result.userInfo);
    if (typeof email !== 'string') {
      throw new ApiError('FORBIDDEN', 403);
    }
    const normalizedEmail = normalizeEmail(email);
    if (normalizedEmail !== this.normalizedAdminEmail) {
      throw new ApiError('FORBIDDEN', 403);
    }
    return { uid, email: normalizedEmail };
  }
}

function readEmail(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return (value as Record<string, unknown>).email;
}

function normalizeEmail(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length === 0
    || normalized.length > 320
    || !normalized.includes('@')
  ) {
    throw new ApiError('ADMIN_EMAIL_INVALID', 500);
  }
  return normalized;
}
