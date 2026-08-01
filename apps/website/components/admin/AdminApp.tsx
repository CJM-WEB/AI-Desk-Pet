'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AdminAction, SubmissionStatus } from '@myself/shared-types';

import { AdminApiClient, type AdminApi, type AdminSubmissionDetail, type AdminSubmissionSummary } from '../../lib/admin-api-client';
import { createAdminAuth, type AdminAuthClient } from '../../lib/admin-auth';
import { ApiClient, ApiClientError } from '../../lib/api-client';
import { AdminAuditLog } from './AdminAuditLog';
import { AdminDetail } from './AdminDetail';
import { AdminLogin } from './AdminLogin';
import { AdminQueue } from './AdminQueue';
import { AdminSidebar, type AdminView } from './AdminSidebar';
import { useI18n } from '../i18n/I18nProvider';
import type { Translate } from '../i18n/i18n-types';
import styles from './admin.module.css';

interface AdminAppProps {
  auth?: AdminAuthClient;
  api?: AdminApi;
}

type QueueStatus = Extract<SubmissionStatus,
  'manual_review_pending' | 'auto_rejected' | 'published' | 'deleted_quarantined'>;
type Phase = 'checking' | 'login' | 'workspace' | 'forbidden';

/** 管理员页面只在内存持有令牌；真实授权仍由每个后端路由执行。 */
export function AdminApp({ auth, api }: AdminAppProps) {
  const { t } = useI18n();
  const [runtime, setRuntime] = useState<{ auth: AdminAuthClient; api: AdminApi } | null>(
    auth && api ? { auth, api } : null
  );

  useEffect(() => {
    if (runtime) return;
    setRuntime({
      auth: auth ?? createAdminAuth(),
      api: api ?? new AdminApiClient(new ApiClient(
        process.env.NEXT_PUBLIC_API_BASE_URL ?? '/api/v1'
      ))
    });
  }, [api, auth, runtime]);

  if (!runtime) {
    return <main className={styles.centerPage}><p role="status">{t('admin.initializing')}</p></main>;
  }
  return <AdminWorkspace auth={runtime.auth} api={runtime.api} />;
}

function AdminWorkspace({
  auth: resolvedAuth,
  api: resolvedApi
}: Required<AdminAppProps>) {
  const { t } = useI18n();

  const [phase, setPhase] = useState<Phase>('checking');
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<AdminView>('manual_review_pending');
  const [items, setItems] = useState<AdminSubmissionSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [queueLoading, setQueueLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminSubmissionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [acting, setActing] = useState(false);
  const actingRef = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  const queueSequence = useRef(0);
  const detailSequence = useRef(0);
  const queueAbort = useRef<AbortController | null>(null);
  const detailAbort = useRef<AbortController | null>(null);
  const seenCursors = useRef(new Set<number>());
  const pendingCursors = useRef(new Set<number>());
  const sessionEpoch = useRef(0);

  /** 在任何会话边界同步擦除敏感状态，异步登出只做尽力清理。 */
  const clearSensitiveSessionState = useCallback((nextPhase: 'login' | 'forbidden') => {
    queueAbort.current?.abort();
    detailAbort.current?.abort();
    queueSequence.current += 1;
    detailSequence.current += 1;
    sessionEpoch.current += 1;
    actingRef.current = false;
    seenCursors.current.clear();
    pendingCursors.current.clear();
    setAccessToken(null);
    setItems([]);
    setNextCursor(null);
    setSelectedId(null);
    setDetail(null);
    setNotice(null);
    setQueueLoading(false);
    setDetailLoading(false);
    setActing(false);
    setActiveView('manual_review_pending');
    setPhase(nextPhase);
    void resolvedAuth.signOut().catch(() => undefined);
  }, [resolvedAuth]);

  useEffect(() => () => {
    queueAbort.current?.abort();
    detailAbort.current?.abort();
    queueSequence.current += 1;
    detailSequence.current += 1;
    sessionEpoch.current += 1;
  }, []);

  const handleApiError = useCallback(async (error: unknown): Promise<boolean> => {
    if (!(error instanceof ApiClientError)) return false;
    if (error.statusCode === 401) {
      clearSensitiveSessionState('login');
      return true;
    }
    if (error.statusCode === 403) {
      clearSensitiveSessionState('forbidden');
      return true;
    }
    return false;
  }, [clearSensitiveSessionState]);

  useEffect(() => {
    let active = true;
    void resolvedAuth.getAccessToken().then(token => {
      if (!active) return;
      setAccessToken(token);
      setPhase('workspace');
    }).catch(() => {
      if (active) setPhase('login');
    });
    return () => { active = false; };
  }, [resolvedAuth]);

  const loadQueue = useCallback(async (
    status: QueueStatus,
    cursor?: number,
    append = false
  ): Promise<void> => {
    if (!accessToken) return;
    if (append && cursor !== undefined) {
      if (seenCursors.current.has(cursor) || pendingCursors.current.has(cursor)) return;
      pendingCursors.current.add(cursor);
    }
    const epoch = sessionEpoch.current;
    const sequence = ++queueSequence.current;
    queueAbort.current?.abort();
    const controller = new AbortController();
    queueAbort.current = controller;
    setQueueLoading(true);
    try {
      const page = await resolvedApi.listQueue(
        accessToken,
        status,
        cursor,
        controller.signal
      );
      if (
        epoch !== sessionEpoch.current
        || sequence !== queueSequence.current
        || controller.signal.aborted
      ) return;
      setItems(previous => append ? mergeById(previous, page.items) : [...page.items]);
      setNextCursor(page.nextCursor);
      if (append && cursor !== undefined) seenCursors.current.add(cursor);
    } catch (error) {
      if (epoch !== sessionEpoch.current || isAbort(error)) return;
      if (!await handleApiError(error)) setNotice(t('admin.error.queue'));
    } finally {
      if (append && cursor !== undefined) pendingCursors.current.delete(cursor);
      if (epoch === sessionEpoch.current && sequence === queueSequence.current) {
        setQueueLoading(false);
      }
    }
  }, [accessToken, handleApiError, resolvedApi, t]);

  useEffect(() => {
    if (phase !== 'workspace') return;
    seenCursors.current.clear();
    pendingCursors.current.clear();
    setItems([]);
    setNextCursor(null);
    setNotice(null);
    void loadQueue(queueStatusForView(activeView));
    return () => queueAbort.current?.abort();
  }, [activeView, loadQueue, phase]);

  const loadDetail = useCallback(async (id: string): Promise<void> => {
    if (!accessToken) return;
    const epoch = sessionEpoch.current;
    const sequence = ++detailSequence.current;
    detailAbort.current?.abort();
    const controller = new AbortController();
    detailAbort.current = controller;
    setDetailLoading(true);
    try {
      const result = await resolvedApi.getDetail(accessToken, id, controller.signal);
      if (
        epoch === sessionEpoch.current
        && sequence === detailSequence.current
        && !controller.signal.aborted
      ) setDetail(result);
    } catch (error) {
      if (epoch !== sessionEpoch.current || isAbort(error)) return;
      if (!await handleApiError(error)) setNotice(t('admin.error.detail'));
    } finally {
      if (epoch === sessionEpoch.current && sequence === detailSequence.current) {
        setDetailLoading(false);
      }
    }
  }, [accessToken, handleApiError, resolvedApi, t]);

  useEffect(() => {
    if (!selectedId || phase !== 'workspace') return;
    void loadDetail(selectedId);
    return () => detailAbort.current?.abort();
  }, [loadDetail, phase, selectedId]);

  async function applyAction(action: AdminAction['action'], reason: string): Promise<void> {
    if (!accessToken || !detail || actingRef.current || !reason) return;
    const epoch = sessionEpoch.current;
    actingRef.current = true;
    setActing(true);
    setNotice(null);
    try {
      await resolvedApi.applyAction(accessToken, detail.id, {
        action,
        version: detail.statusVersion,
        idempotencyKey: crypto.randomUUID(),
        reason
      });
      if (epoch !== sessionEpoch.current) return;
      setNotice(t('admin.notice.completed'));
      setSelectedId(null);
      setDetail(null);
      await loadQueue(queueStatusForView(activeView));
    } catch (error) {
      if (epoch !== sessionEpoch.current) return;
      if (error instanceof ApiClientError && error.statusCode === 409) {
        setNotice(error.code === 'VERSION_CONFLICT'
          ? t('admin.notice.conflict')
          : stableActionError(error.code, t));
        setDetail(null);
        await Promise.all([
          loadDetail(detail.id),
          loadQueue(queueStatusForView(activeView))
        ]);
      } else if (!await handleApiError(error)) {
        setNotice(error instanceof ApiClientError
          ? stableActionError(error.code, t)
          : t('admin.error.action'));
      }
    } finally {
      if (epoch === sessionEpoch.current) {
        actingRef.current = false;
        setActing(false);
      }
    }
  }

  function signOut(): void {
    clearSensitiveSessionState('login');
  }

  if (phase === 'checking') {
    return <main className={styles.centerPage}><p role="status">{t('admin.checkingSession')}</p></main>;
  }
  if (phase === 'login') {
    return <AdminLogin auth={resolvedAuth} onAuthenticated={token => {
      setAccessToken(token);
      setPhase('workspace');
    }} />;
  }
  if (phase === 'forbidden') {
    return (
      <main className={styles.centerPage}>
        <section className={styles.forbiddenCard}>
          <h1>{t('admin.forbidden.title')}</h1>
          <p>{t('admin.forbidden.body')}</p>
          <button type="button" className={styles.secondaryButton} onClick={signOut}>{t('admin.forbidden.logout')}</button>
        </section>
      </main>
    );
  }

  return (
    <main className={styles.adminShell}>
      <AdminSidebar activeView={activeView} onSelect={view => {
        setActiveView(view);
        setNotice(null);
        if (view !== 'audit') {
          setSelectedId(null);
          setDetail(null);
        }
      }} />
      <div className={styles.workspace}>
        <header className={styles.topbar}>
          <div><p className={styles.eyebrow}>PRIVATE ADMIN MODE</p><h1>{t('admin.app.title')}</h1></div>
          <button type="button" className={styles.textButton} onClick={signOut}>{t('admin.app.logout')}</button>
        </header>
        {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
        <div className={styles.reviewGrid}>
            <AdminQueue
              items={items}
              selectedId={selectedId}
              loading={queueLoading}
              hasMore={nextCursor !== null}
              onSelect={setSelectedId}
              onLoadMore={() => {
                if (nextCursor === null) return;
                void loadQueue(queueStatusForView(activeView), nextCursor, true);
              }}
            />
            {activeView === 'audit'
              ? <AdminAuditLog detail={detail} />
              : <AdminDetail
                  key={`${detail?.id ?? 'none'}:${detail?.statusVersion ?? 0}`}
                  detail={detail}
                  loading={detailLoading}
                  acting={acting}
                  onAction={(action, reason) => void applyAction(action, reason)}
                />}
        </div>
      </div>
    </main>
  );
}

function queueStatusForView(view: AdminView): QueueStatus {
  return view === 'audit' ? 'manual_review_pending' : view as QueueStatus;
}

function mergeById(
  previous: readonly AdminSubmissionSummary[],
  incoming: readonly AdminSubmissionSummary[]
): AdminSubmissionSummary[] {
  const rows = new Map(previous.map(item => [item.id, item]));
  for (const item of incoming) rows.set(item.id, item);
  return [...rows.values()];
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function stableActionError(code: string, t: Translate): string {
  if (code === 'TECHNICAL_SCAN_REQUIRED') return t('admin.detail.technicalBlocked');
  if (code === 'INVALID_ADMIN_ACTION') return t('admin.error.invalidAction');
  return t('admin.error.action');
}
