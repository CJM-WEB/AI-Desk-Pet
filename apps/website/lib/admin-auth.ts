import {
  getCloudBaseClient,
  type CloudBaseBrowserClient,
  type CloudBaseBrowserSession,
  type CloudBaseSdkResult
} from './cloudbase-client';

export type { CloudBaseBrowserClient } from './cloudbase-client';

export interface AdminOtpChallenge {
  verify(code: string): Promise<void>;
}

export interface AdminAuthClient {
  requestEmailOtp(email: string): Promise<AdminOtpChallenge>;
  getAccessToken(): Promise<string>;
  signOut(): Promise<void>;
}

/** 管理员认证仅封装 CloudBase 邮箱 OTP 与现有浏览器会话。 */
export function createAdminAuth(client: CloudBaseBrowserClient = getCloudBaseClient()): AdminAuthClient {
  const auth = client.auth();

  return {
    async requestEmailOtp(email) {
      const normalizedEmail = email.trim().toLowerCase();
      if (!normalizedEmail || normalizedEmail.length > 320) {
        throw new Error('ADMIN_EMAIL_INVALID');
      }

      const result = await auth.signInWithOtp({
        email: normalizedEmail,
        options: { shouldCreateUser: false }
      });
      throwSdkError(result, 'ADMIN_OTP_REQUEST_FAILED');
      const challenge = result.data;
      if (!challenge) {
        throw new Error('ADMIN_OTP_CHALLENGE_REQUIRED');
      }

      return {
        async verify(code) {
          const verification = await challenge.verifyOtp({ token: code.trim() });
          throwSdkError(verification, 'ADMIN_OTP_VERIFY_FAILED');
        }
      };
    },

    async getAccessToken() {
      const initialSession = await auth.getSession();
      throwSdkError(initialSession, 'ADMIN_SESSION_LOOKUP_FAILED');
      const initialToken = getAccessToken(initialSession.data?.session);
      if (initialToken) {
        return initialToken;
      }

      const refreshResult = await auth.refreshSession();
      throwSdkError(refreshResult, 'ADMIN_SESSION_REFRESH_FAILED');
      const refreshedSession = await auth.getSession();
      throwSdkError(refreshedSession, 'ADMIN_SESSION_LOOKUP_FAILED');
      const refreshedToken = getAccessToken(refreshedSession.data?.session);
      if (refreshedToken) {
        return refreshedToken;
      }

      throw new Error('ADMIN_SESSION_REQUIRED');
    },

    async signOut() {
      await auth.signOut();
    }
  };
}

/** 从 SDK 会话响应中提取非空的短期访问令牌。 */
function getAccessToken(session: CloudBaseBrowserSession | null | undefined): string | undefined {
  return typeof session?.access_token === 'string' && session.access_token
    ? session.access_token
    : undefined;
}

/** 将 SDK 失败转为稳定错误码，同时通过 cause 保留原始诊断信息。 */
function throwSdkError(result: CloudBaseSdkResult<unknown>, code: string): void {
  if (result.error) {
    throw new Error(code, { cause: result.error });
  }
}
