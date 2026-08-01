'use client';

import { useState, type FormEvent } from 'react';

import type { AdminAuthClient, AdminOtpChallenge } from '../../lib/admin-auth';
import styles from './admin.module.css';

interface AdminLoginProps {
  auth: AdminAuthClient;
  onAuthenticated(accessToken: string): void;
  initialError?: string | null;
}

/** 管理员登录只提供预注册邮箱 OTP，不提供注册或密码入口。 */
export function AdminLogin({ auth, onAuthenticated, initialError }: AdminLoginProps) {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<AdminOtpChallenge | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);

  async function sendCode(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!email.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      setChallenge(await auth.requestEmailOtp(email));
    } catch (requestError) {
      setError(authErrorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function signIn(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!challenge || !code.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await challenge.verify(code);
      onAuthenticated(await auth.getAccessToken());
    } catch (signInError) {
      setError(authErrorMessage(signInError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={styles.loginPage}>
      <section className={styles.loginCard} aria-labelledby="admin-login-title">
        <p className={styles.eyebrow}>AI PET CONTROL ROOM</p>
        <h1 id="admin-login-title">管理员模式</h1>
        <p className={styles.muted}>仅限已预先配置的管理员邮箱。</p>
        <form onSubmit={challenge ? signIn : sendCode} className={styles.formStack}>
          <label className={styles.field}>
            <span>管理员邮箱</span>
            <input
              type="email"
              autoComplete="email"
              value={email}
              onChange={event => setEmail(event.target.value)}
              disabled={busy || challenge !== null}
              required
            />
          </label>
          {challenge ? (
            <label className={styles.field}>
              <span>邮箱验证码</span>
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={event => setCode(event.target.value)}
                disabled={busy}
                required
              />
            </label>
          ) : null}
          {error ? <p role="alert" className={styles.error}>{error}</p> : null}
          <button className={styles.primaryButton} type="submit" disabled={busy}>
            {challenge ? (busy ? '正在登录…' : '登录') : (busy ? '正在发送…' : '发送验证码')}
          </button>
        </form>
      </section>
    </main>
  );
}

function authErrorMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  if (code === 'ADMIN_EMAIL_INVALID') return '请输入有效的管理员邮箱。';
  if (code.includes('OTP_REQUEST')) return '验证码暂时无法发送，请稍后重试。';
  if (code.includes('OTP_VERIFY')) return '验证码无效或已过期，请重新获取。';
  return '登录暂时无法完成，请稍后重试。';
}
