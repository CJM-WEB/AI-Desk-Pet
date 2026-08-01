import { describe, expect, it, vi } from 'vitest';

import { createAdminAuth, type CloudBaseBrowserClient } from '../lib/admin-auth';

function createClient() {
  const verifyOtp = vi.fn();
  const signInWithOtp = vi.fn().mockResolvedValue({
    data: { verifyOtp },
    error: null
  });
  const getSession = vi.fn();
  const refreshSession = vi.fn();
  const signOut = vi.fn().mockResolvedValue(undefined);

  const client: CloudBaseBrowserClient = {
    auth: () => ({
      signInWithOtp,
      getSession,
      refreshSession,
      signOut
    })
  };

  return { client, getSession, refreshSession, signInWithOtp, signOut, verifyOtp };
}

describe('管理员 CloudBase 认证适配器', () => {
  it('邮箱 OTP 规范化输入且禁止自动创建用户', async () => {
    const { client, signInWithOtp } = createClient();
    const auth = createAdminAuth(client);

    await auth.requestEmailOtp('  Admin@Example.COM  ');

    expect(signInWithOtp).toHaveBeenCalledWith({
      email: 'admin@example.com',
      options: { shouldCreateUser: false }
    });
  });

  it('拒绝空邮箱和超过 320 字符的邮箱', async () => {
    const { client, signInWithOtp } = createClient();
    const auth = createAdminAuth(client);

    await expect(auth.requestEmailOtp('   ')).rejects.toThrow('ADMIN_EMAIL_INVALID');
    await expect(auth.requestEmailOtp(`${'a'.repeat(309)}@example.com`)).rejects.toThrow('ADMIN_EMAIL_INVALID');
    expect(signInWithOtp).not.toHaveBeenCalled();
  });

  it('OTP 请求失败时保留 SDK 原始错误并提供稳定错误码', async () => {
    const { client, signInWithOtp } = createClient();
    const sdkError = new Error('CloudBase request failed');
    signInWithOtp.mockResolvedValue({ data: null, error: sdkError });
    const auth = createAdminAuth(client);

    await expect(auth.requestEmailOtp('admin@example.com')).rejects.toMatchObject({
      message: 'ADMIN_OTP_REQUEST_FAILED',
      cause: sdkError
    });
  });

  it('只使用 SDK 返回挑战对象的 verifyOtp 验证已修剪的验证码', async () => {
    const { client, verifyOtp } = createClient();
    verifyOtp.mockResolvedValue({ data: { session: { access_token: 'access-token' } }, error: null });
    const auth = createAdminAuth(client);

    const challenge = await auth.requestEmailOtp('admin@example.com');
    await challenge.verify('  123456  ');

    expect(verifyOtp).toHaveBeenCalledWith({ token: '123456' });
  });

  it('无有效会话时只刷新一次再读取 Access Token', async () => {
    const { client, getSession, refreshSession } = createClient();
    getSession
      .mockResolvedValueOnce({ data: { session: null }, error: null })
      .mockResolvedValueOnce({ data: { session: { access_token: 'access-token' } }, error: null });
    refreshSession.mockResolvedValue({ data: { session: null }, error: null });
    const auth = createAdminAuth(client);

    await expect(auth.getAccessToken()).resolves.toBe('access-token');
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(getSession).toHaveBeenCalledTimes(2);
  });

  it('刷新后仍无令牌时返回稳定会话错误', async () => {
    const { client, getSession, refreshSession } = createClient();
    getSession.mockResolvedValue({ data: { session: null }, error: null });
    refreshSession.mockResolvedValue({ data: { session: null }, error: null });
    const auth = createAdminAuth(client);

    await expect(auth.getAccessToken()).rejects.toThrow('ADMIN_SESSION_REQUIRED');
    expect(refreshSession).toHaveBeenCalledTimes(1);
  });

  it('读取会话失败时保留 SDK 原始错误而不降级为会话缺失', async () => {
    const { client, getSession, refreshSession } = createClient();
    const sdkError = new Error('CloudBase session lookup failed');
    getSession.mockResolvedValue({ data: null, error: sdkError });
    const auth = createAdminAuth(client);

    await expect(auth.getAccessToken()).rejects.toMatchObject({
      message: 'ADMIN_SESSION_LOOKUP_FAILED',
      cause: sdkError
    });
    expect(refreshSession).not.toHaveBeenCalled();
  });

  it('刷新会话失败时保留 SDK 原始错误而不降级为会话缺失', async () => {
    const { client, getSession, refreshSession } = createClient();
    const sdkError = new Error('CloudBase session refresh failed');
    getSession.mockResolvedValue({ data: { session: null }, error: null });
    refreshSession.mockResolvedValue({ data: null, error: sdkError });
    const auth = createAdminAuth(client);

    await expect(auth.getAccessToken()).rejects.toMatchObject({
      message: 'ADMIN_SESSION_REFRESH_FAILED',
      cause: sdkError
    });
  });

  it('将登出交由 SDK 客户端执行', async () => {
    const { client, signOut } = createClient();
    const auth = createAdminAuth(client);

    await auth.signOut();

    expect(signOut).toHaveBeenCalledTimes(1);
  });
});
