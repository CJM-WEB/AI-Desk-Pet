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
  'system_reviewing' | 'manual_review_pending' | 'auto_rejected' | 'published' | 'deleted_quarantined'>;
type Phase = 'checking' | 'login' | 'workspace' | 'forbidden';

/** 管理员页面只在内存持有令牌；真实授权仍由每个后端路由执行。 */
export function AdminApp({ auth, api }: AdminAppProps) {
  const { t } = useI18n();
  const configuredAdminOrigin = process.env.NEXT_PUBLIC_ADMIN_ORIGIN;
  const [runtime, setRuntime] = useState<{ auth: AdminAuthClient; api: AdminApi } | null>(
    !configuredAdminOrigin && auth && api ? { auth, api } : null
  );
  const [initializationFailed, setInitializationFailed] = useState(false);

  // 管理员来源必须在认证 SDK 初始化前裁决，避免根域误启动不可用的认证会话。
  useEffect(() => {
    if (runtime || initializationFailed) return;
    try {
      if (configuredAdminOrigin) {
        const target = new URL(configuredAdminOrigin);
        if (
          target.protocol !== 'https:'
          || target.username
          || target.password
          || target.pathname !== '/'
          || target.search
          || target.hash
        ) throw new Error('INVALID_ADMIN_ORIGIN');
        if (target.origin !== globalThis.location.origin) {
          globalThis.location.replace(`${target.origin}/admin/`);
          return;
        }
      }
      setRuntime({
        auth: auth ?? createRuntimeAdminAuth(),
        api: api ?? new AdminApiClient(new ApiClient(
          process.env.NEXT_PUBLIC_API_BASE_URL ?? '/api/v1'
        ))
      });
    } catch {
      setInitializationFailed(true);
    }
  }, [api, auth, configuredAdminOrigin, initializationFailed, runtime]);

  if (initializationFailed) {
    return <main className={styles.centerPage}><p role="alert">{t('admin.error.config')}</p></main>;
  }

  if (!runtime) {
    return <main className={styles.centerPage}><p role="status">{t('admin.initializing')}</p></main>;
  }
  return <AdminWorkspace auth={runtime.auth} api={runtime.api} />;
}

/** E2E 静态构建只连接同源 Memory API；常规构建不含令牌时仍走 CloudBase 会话。 */
function createRuntimeAdminAuth(): AdminAuthClient {
  const e2eToken = process.env.NEXT_PUBLIC_WEBSITE_E2E_ADMIN_TOKEN;
  if (!e2eToken) return createAdminAuth();
  return {
    requestEmailOtp: async () => { throw new Error('E2E_ADMIN_SESSION_ONLY'); },
    getAccessToken: async () => e2eToken,
    signOut: async () => undefined
  };
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
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [clickCount, setClickCount] = useState<number | null>(null);
  const [metricUnavailable, setMetricUnavailable] = useState(false);
  const [queueLoading, setQueueLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminSubmissionDetail | null>(null);
  const [detailRevision, setDetailRevision] = useState(0);
  const [detailLoading, setDetailLoading] = useState(false);
  const [acting, setActing] = useState(false);
  const actingRef = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  const queueSequence = useRef(0);
  const detailSequence = useRef(0);
  const metricSequence = useRef(0);
  const queueAbort = useRef<AbortController | null>(null);
  const detailAbort = useRef<AbortController | null>(null);
  const metricAbort = useRef<AbortController | null>(null);
  const seenCursors = useRef(new Set<string>());
  const pendingCursors = useRef(new Set<string>());
  const sessionEpoch = useRef(0);

  /** 清除当前页面持有的敏感状态；只有用户主动退出时才销毁 CloudBase 会话。 */
  const clearSensitiveSessionState = useCallback((nextPhase: 'login' | 'forbidden') => {
    queueAbort.current?.abort();
    detailAbort.current?.abort();
    metricAbort.current?.abort();
    queueSequence.current += 1;
    detailSequence.current += 1;
    metricSequence.current += 1;
    sessionEpoch.current += 1;
    actingRef.current = false;
    seenCursors.current.clear();
    pendingCursors.current.clear();
    setAccessToken(null);
    setItems([]);
    setNextCursor(null);
    setClickCount(null);
    setMetricUnavailable(false);
    setSelectedId(null);
    setDetail(null);
    setNotice(null);
    setQueueLoading(false);
    setDetailLoading(false);
    setActing(false);
    setActiveView('manual_review_pending');
    setPhase(nextPhase);
  }, []);

  useEffect(() => () => {
    queueAbort.current?.abort();
    detailAbort.current?.abort();
    metricAbort.current?.abort();
    queueSequence.current += 1;
    detailSequence.current += 1;
    metricSequence.current += 1;
    sessionEpoch.current += 1;
  }, []);

  const handleApiError = useCallback(async (error: unknown): Promise<boolean> => {
    if (!(error instanceof ApiClientError)) return false;
    // 单次 401 可能来自网关或令牌刷新时序，保留工作台并交由当前操作显示可重试错误。
    if (error.statusCode === 401) return false;
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
    cursor?: string,
    append = false
  ): Promise<void> => {
    if (!accessToken) return;
    // 替换刷新开启新的分页代际，相同 opaque token 在新快照中必须可以再次消费。
    if (!append) {
      seenCursors.current = new Set();
      pendingCursors.current = new Set();
    }
    const seenCursorGeneration = seenCursors.current;
    const pendingCursorGeneration = pendingCursors.current;
    if (append && cursor !== undefined) {
      if (seenCursorGeneration.has(cursor) || pendingCursorGeneration.has(cursor)) return;
      pendingCursorGeneration.add(cursor);
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
      if (append && cursor !== undefined) seenCursorGeneration.add(cursor);
    } catch (error) {
      if (epoch !== sessionEpoch.current || isAbort(error)) return;
      // 仅记录稳定错误元数据，线上诊断不得包含访问令牌或投稿内容。
      if (error instanceof ApiClientError) {
        console.warn(
          `管理员接口请求失败 scope=queue code=${error.code} status=${error.statusCode}`
        );
      }
      if (!await handleApiError(error)) setNotice(t('admin.error.queue'));
    } finally {
      if (append && cursor !== undefined) pendingCursorGeneration.delete(cursor);
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

  useEffect(() => {
    if (phase !== 'workspace' || !accessToken) return;
    const epoch = sessionEpoch.current;
    const sequence = ++metricSequence.current;
    metricAbort.current?.abort();
    const controller = new AbortController();
    metricAbort.current = controller;
    setClickCount(null);
    setMetricUnavailable(false);

    void resolvedApi.getOfficialWindowsDownloadClickCount(accessToken, controller.signal)
      .then(count => {
        if (
          epoch === sessionEpoch.current
          && sequence === metricSequence.current
          && !controller.signal.aborted
        ) setClickCount(count);
      })
      .catch(async error => {
        if (epoch !== sessionEpoch.current || controller.signal.aborted) return;
        if (!await handleApiError(error)) setMetricUnavailable(true);
      });

    return () => controller.abort();
  }, [accessToken, handleApiError, phase, resolvedApi]);

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
      const baseAction = {
        version: detail.statusVersion,
        idempotencyKey: crypto.randomUUID(),
        reason
      };
      await resolvedApi.applyAction(
        accessToken,
        detail.id,
        action === 'force_publish'
          ? { ...baseAction, action, riskAcknowledgement: 'ADMIN_OVERRIDE_ACCEPTED' }
          : { ...baseAction, action }
      );
      if (epoch !== sessionEpoch.current) return;
      setNotice(t('admin.notice.completed'));
      setSelectedId(null);
      setDetail(null);
      await loadQueue(queueStatusForView(activeView));
    } catch (error) {
      if (epoch !== sessionEpoch.current) return;
      if (error instanceof ApiClientError && error.statusCode === 409) {
        setDetailRevision(revision => revision + 1);
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
    void resolvedAuth.signOut().catch(() => undefined);
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
          <div className={styles.topbarActions}>
            <section className={styles.downloadMetric} aria-label={t('admin.metric.label')}>
              <span>{t('admin.metric.label')}</span>
              <strong>{clickCount ?? (metricUnavailable
                ? t('admin.metric.unavailable')
                : t('admin.metric.loading'))}</strong>
              <p>{t('admin.metric.description')}</p>
            </section>
            <button type="button" className={styles.textButton} onClick={signOut}>{t('admin.app.logout')}</button>
          </div>
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
                  key={`${detail?.id ?? 'none'}:${detail?.statusVersion ?? 0}:${detailRevision}`}
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
