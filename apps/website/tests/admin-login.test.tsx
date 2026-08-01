// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AdminLogin } from '../components/admin/AdminLogin';
import type { AdminAuthClient } from '../lib/admin-auth';

afterEach(cleanup);

describe('管理员邮箱验证码登录', () => {
  it('验证码验证并取得访问令牌后才进入工作台', async () => {
    const verify = vi.fn().mockResolvedValue(undefined);
    const auth = {
      requestEmailOtp: vi.fn().mockResolvedValue({ verify }),
      getAccessToken: vi.fn().mockResolvedValue('admin-access-token'),
      signOut: vi.fn()
    } satisfies AdminAuthClient;
    const onAuthenticated = vi.fn();
    render(<AdminLogin auth={auth} onAuthenticated={onAuthenticated} />);

    fireEvent.change(screen.getByLabelText('管理员邮箱'), {
      target: { value: 'admin@example.com' }
    });
    fireEvent.click(screen.getByRole('button', { name: '发送验证码' }));
    expect(await screen.findByLabelText('邮箱验证码')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('邮箱验证码'), {
      target: { value: '123456' }
    });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith('admin-access-token'));
    expect(verify).toHaveBeenCalledWith('123456');
  });

  it('OTP 失败只显示稳定中文提示且不暴露 SDK 原始错误', async () => {
    const auth = {
      requestEmailOtp: vi.fn().mockRejectedValue(
        new Error('ADMIN_OTP_REQUEST_FAILED', { cause: new Error('secret sdk response') })
      ),
      getAccessToken: vi.fn(),
      signOut: vi.fn()
    } satisfies AdminAuthClient;
    render(<AdminLogin auth={auth} onAuthenticated={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('管理员邮箱'), {
      target: { value: 'admin@example.com' }
    });
    fireEvent.click(screen.getByRole('button', { name: '发送验证码' }));

    expect(await screen.findByText('验证码暂时无法发送，请稍后重试。')).toBeTruthy();
    expect(screen.queryByText(/secret sdk response/u)).toBeNull();
  });
});
