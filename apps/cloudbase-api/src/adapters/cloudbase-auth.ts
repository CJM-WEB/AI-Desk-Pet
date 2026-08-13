import { ApiError } from '../errors.js';
import type {
  AdminIdentity,
  AdminIdentityProvider
} from '../ports.js';

interface CloudBaseUserProfile {
  sub?: unknown;
  email?: unknown;
  status?: unknown;
}

type AuthFetch = typeof fetch;

/** 使用当前 HTTP 请求的访问令牌校验用户，避免复用云函数冷启动时的身份上下文。 */
export class CloudBaseAdminIdentityProvider implements AdminIdentityProvider {
  private readonly normalizedAdminEmail: string;
  private readonly userInfoUrl: string;

  constructor(
    envId: string,
    adminEmail: string,
    private readonly timeoutMs: number,
    private readonly authFetch: AuthFetch = fetch
  ) {
    this.normalizedAdminEmail = normalizeEmail(adminEmail);
    this.userInfoUrl = `https://${envId}.api.tcloudbasegateway.com/auth/v1/user/me`;
  }

  async requireAdmin(accessToken: string): Promise<AdminIdentity> {
    let response: Response;
    try {
      response = await this.authFetch(this.userInfoUrl, {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch {
      throw new ApiError('AUTH_SERVICE_UNAVAILABLE', 503);
    }

    if (response.status === 401 || response.status === 403) {
      throw new ApiError('UNAUTHORIZED', 401);
    }
    if (!response.ok) {
      throw new ApiError('AUTH_SERVICE_UNAVAILABLE', 503);
    }

    const profile = await readProfile(response);
    if (
      typeof profile.sub !== 'string'
      || profile.sub.length === 0
      || typeof profile.email !== 'string'
    ) {
      throw new ApiError('UNAUTHORIZED', 401);
    }

    const normalizedEmail = normalizeEmail(profile.email);
    if (normalizedEmail !== this.normalizedAdminEmail) {
      throw new ApiError('FORBIDDEN', 403);
    }
    return { uid: profile.sub, email: normalizedEmail };
  }
}

async function readProfile(response: Response): Promise<CloudBaseUserProfile> {
  try {
    const value: unknown = await response.json();
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('用户信息响应不是对象');
    }
    return value as CloudBaseUserProfile;
  } catch {
    throw new ApiError('AUTH_SERVICE_UNAVAILABLE', 503);
  }
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
