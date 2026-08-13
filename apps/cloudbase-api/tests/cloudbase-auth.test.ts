import { describe, expect, it, vi } from 'vitest';

import { CloudBaseAdminIdentityProvider } from '../src/adapters/cloudbase-auth.js';

const accessToken = 'valid-access-token';

describe('CloudBase 唯一管理员授权', () => {
  it('访问令牌无效时返回 401', async () => {
    const authFetch = vi.fn(async () => new Response(null, { status: 401 }));
    const provider = new CloudBaseAdminIdentityProvider(
      'env-test',
      'admin@example.com',
      1_000,
      authFetch
    );

    await expect(provider.requireAdmin(accessToken)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401
    });
    expect(authFetch).toHaveBeenCalledWith(
      'https://env-test.api.tcloudbasegateway.com/auth/v1/user/me',
      expect.objectContaining({
        headers: { authorization: `Bearer ${accessToken}` }
      })
    );
  });

  it('登录邮箱不等于白名单时返回 403', async () => {
    const provider = createProvider({
      sub: 'uid-other',
      email: 'other@example.com'
    });

    await expect(provider.requireAdmin(accessToken)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403
    });
  });

  it('邮箱忽略大小写且返回最小身份字段', async () => {
    const provider = createProvider({
      sub: 'uid-admin',
      email: 'ADMIN@example.com'
    });

    await expect(provider.requireAdmin(accessToken)).resolves.toEqual({
      uid: 'uid-admin',
      email: 'admin@example.com'
    });
  });

  it('认证服务异常时使用稳定的 503 错误', async () => {
    const provider = new CloudBaseAdminIdentityProvider(
      'env-test',
      'admin@example.com',
      1_000,
      vi.fn(async () => new Response(null, { status: 500 }))
    );

    await expect(provider.requireAdmin(accessToken)).rejects.toMatchObject({
      code: 'AUTH_SERVICE_UNAVAILABLE',
      statusCode: 503
    });
  });
});

function createProvider(profile: Record<string, unknown>) {
  return new CloudBaseAdminIdentityProvider(
    'env-test',
    'admin@example.com',
    1_000,
    vi.fn(async () => Response.json(profile))
  );
}
