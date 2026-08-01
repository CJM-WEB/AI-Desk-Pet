'use client';

import type { FormEvent } from 'react';
import { useEffect, useState } from 'react';
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

  const query = async (statusToken: string) => {
    setPhase('loading');
    setResult(null);
    try {
      const nextResult = await querySubmissionStatus(api, statusToken);
      setResult(nextResult);
      setManualToken('');
      setPhase('success');
    } catch {
      setPhase('error');
    }
  };

  useEffect(() => {
    const fragmentToken = readStatusToken(window.location.hash);
    if (!fragmentToken) return;

    // 必须先从地址栏移除令牌，再发起网络请求。

    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${window.location.search}`
    );
    void query(fragmentToken);
    // API 客户端在页面生命周期内稳定，查询只在首次挂载时执行。
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
