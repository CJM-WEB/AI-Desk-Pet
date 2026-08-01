import { describe, expect, it, vi } from 'vitest';

import { CloudBaseAdminIdentityProvider } from '../src/adapters/cloudbase-auth.js';

describe('CloudBase 唯一管理员授权', () => {
  it('未登录时返回 401', async () => {
    const provider = new CloudBaseAdminIdentityProvider({
      getUserInfo: () => ({ uid: '' }),
      getEndUserInfo: vi.fn()
    }, 'admin@example.com');

    await expect(provider.requireAdmin()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401
    });
  });

  it('登录邮箱不等于白名单时返回 403', async () => {
    const provider = new CloudBaseAdminIdentityProvider({
      getUserInfo: () => ({ uid: 'uid-other' }),
      getEndUserInfo: vi.fn(async () => ({
        userInfo: { email: 'other@example.com' }
      }))
    }, 'admin@example.com');

    await expect(provider.requireAdmin()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403
    });
  });

  it('邮箱忽略大小写且返回最小身份字段', async () => {
    const provider = new CloudBaseAdminIdentityProvider({
      getUserInfo: () => ({ uid: 'uid-admin' }),
      getEndUserInfo: vi.fn(async () => ({
        userInfo: { email: 'ADMIN@example.com' }
      }))
    }, 'admin@example.com');

    await expect(provider.requireAdmin()).resolves.toEqual({
      uid: 'uid-admin',
      email: 'admin@example.com'
    });
  });
});

