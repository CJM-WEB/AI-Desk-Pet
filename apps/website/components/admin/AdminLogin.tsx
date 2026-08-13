'use client';

import { useState, type FormEvent } from 'react';

import type { AdminAuthClient, AdminOtpChallenge } from '../../lib/admin-auth';
import { useI18n } from '../i18n/I18nProvider';
import type { Translate } from '../i18n/i18n-types';
import styles from './admin.module.css';

interface AdminLoginProps {
  auth: AdminAuthClient;
  onAuthenticated(accessToken: string): void;
  initialError?: string | null;
}

/** 管理员登录只提供预注册邮箱 OTP，不提供注册或密码入口。 */
export function AdminLogin({ auth, onAuthenticated, initialError }: AdminLoginProps) {
  const { t } = useI18n();
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
      setError(authErrorMessage(requestError, t));
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
      setError(authErrorMessage(signInError, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={styles.loginPage}>
      <section className={styles.loginCard} aria-labelledby="admin-login-title">
        <p className={styles.eyebrow}>AI PET CONTROL ROOM</p>
        <h1 id="admin-login-title">{t('admin.login.title')}</h1>
        <p className={styles.muted}>{t('admin.login.subtitle')}</p>
        <form onSubmit={challenge ? signIn : sendCode} className={styles.formStack}>
          <label className={styles.field}>
            <span>{t('admin.login.email')}</span>
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
              <span>{t('admin.login.code')}</span>
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
            {challenge
              ? (busy ? t('admin.login.signingIn') : t('admin.login.signIn'))
              : (busy ? t('admin.login.sending') : t('admin.login.send'))}
          </button>
        </form>
      </section>
    </main>
  );
}

function authErrorMessage(error: unknown, t: Translate): string {
  const code = error instanceof Error ? error.message : '';
  if (code === 'ADMIN_EMAIL_INVALID') return t('admin.login.error.email');
  if (code.includes('OTP_REQUEST')) return t('admin.login.error.request');
  if (code.includes('OTP_VERIFY')) return t('admin.login.error.verify');
  return t('admin.login.error.generic');
}
