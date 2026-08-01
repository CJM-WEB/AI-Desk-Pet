'use client';

import type { FormEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { SubmissionStatus, SubmissionStatusView } from '@myself/shared-types';
import { useI18n } from '../../components/i18n/I18nProvider';
import type { MessageKey } from '../../components/i18n/i18n-types';
import type { ApiClient } from '../../lib/api-client';
import { querySubmissionStatus, readStatusToken } from '../../lib/submission-status';
import styles from './status-page.module.css';

const statusMessageKeys: Record<SubmissionStatus, MessageKey> = {
  uploading: 'submissionStatus.status.uploading',
  system_reviewing: 'submissionStatus.status.systemReviewing',
  manual_review_pending: 'submissionStatus.status.manualReviewPending',
  published: 'submissionStatus.status.published',
  auto_rejected: 'submissionStatus.status.autoRejected',
  admin_rejected: 'submissionStatus.status.adminRejected',
  deleted_quarantined: 'submissionStatus.status.deletedQuarantined',
  purged: 'submissionStatus.status.purged'
};

type QueryPhase = 'idle' | 'loading' | 'success' | 'error';

interface SubmissionStatusPageProps {
  api: ApiClient;
}

/** 匿名查询视图不创建账号，也不把一次性令牌写入任何持久化存储。 */
export function SubmissionStatusPage({ api }: SubmissionStatusPageProps) {
  const { t } = useI18n();
  const [manualToken, setManualToken] = useState('');
  const [phase, setPhase] = useState<QueryPhase>('idle');
  const [result, setResult] = useState<SubmissionStatusView | null>(null);
  const mountedRef = useRef(false);
  const requestGenerationRef = useRef(0);
  const autoStartedRef = useRef(false);
  const previousApiRef = useRef(api);

  const query = async (statusToken: string) => {
    const generation = ++requestGenerationRef.current;
    setPhase('loading');
    setResult(null);
    try {
      const nextResult = await querySubmissionStatus(api, statusToken);
      if (!mountedRef.current || generation !== requestGenerationRef.current) return;
      setResult(nextResult);
      setManualToken('');
      setPhase('success');
    } catch {
      if (!mountedRef.current || generation !== requestGenerationRef.current) return;
      setPhase('error');
    }
  };

  useEffect(() => {
    const apiChanged = previousApiRef.current !== api;
    if (apiChanged) {
      previousApiRef.current = api;
      requestGenerationRef.current += 1;
      setResult(null);
      setPhase('idle');
    }
    mountedRef.current = true;
    const fragmentToken = readStatusToken(window.location.hash);
    const search = new URLSearchParams(window.location.search);
    const hasSensitiveQuery = search.has('statusToken');
    search.delete('statusToken');

    // 无论 Fragment 是否有效，都先清理地址栏中的敏感参数和 Fragment。
    if (hasSensitiveQuery || window.location.hash) {
      const remainingQuery = search.toString();
      window.history.replaceState(
        window.history.state,
        '',
        `${window.location.pathname}${remainingQuery ? `?${remainingQuery}` : ''}`
      );
    }
    if (fragmentToken && !autoStartedRef.current) {
      autoStartedRef.current = true;
      void query(fragmentToken);
    }
    return () => {
      mountedRef.current = false;
      // StrictMode 会同步再次 setup；只有真正保持卸载时才延后废弃请求。
      queueMicrotask(() => {
        if (!mountedRef.current) requestGenerationRef.current += 1;
      });
    };
  }, [api]);

  const submitManualToken = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const candidate = readStatusToken(`#${manualToken.trim()}`);
    if (!candidate) {
      setResult(null);
      setPhase('error');
      return;
    }
    void query(candidate);
  };

  return (
    <main className={styles.page}>
      <section className={styles.card} aria-labelledby="submission-status-title">
        <p className={styles.eyebrow}>{t('submissionStatus.eyebrow')}</p>
        <h1 id="submission-status-title">{t('submissionStatus.title')}</h1>
        <p className={styles.introduction}>{t('submissionStatus.introduction')}</p>

        {phase === 'loading' ? (
          <p className={styles.notice} role="status">{t('submissionStatus.loading')}</p>
        ) : null}

        {phase === 'success' && result ? (
          <div className={styles.result} role="status">
            <p className={styles.resultLabel}>{t('submissionStatus.resultLabel')}</p>
            <h2>{t(statusMessageKeys[result.status])}</h2>
            {result.publicReason ? <p>{result.publicReason}</p> : null}
          </div>
        ) : null}

        {phase === 'error' ? (
          <p className={styles.error} role="alert">{t('submissionStatus.error')}</p>
        ) : null}

        {(phase === 'idle' || phase === 'error') ? (
          <form className={styles.form} onSubmit={submitManualToken}>
            <label htmlFor="submission-status-token">{t('submissionStatus.tokenLabel')}</label>
            <input
              id="submission-status-token"
              value={manualToken}
              onChange={(event) => setManualToken(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <button type="submit">{t('submissionStatus.submit')}</button>
          </form>
        ) : null}

        <p className={styles.privacy}>{t('submissionStatus.privacy')}</p>
      </section>
    </main>
  );
}
