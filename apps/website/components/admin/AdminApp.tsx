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
    return <main className={styles.centerPage}><p role="status">正在初始化管理员模式…</p></main>;
  }
  return <AdminWorkspace auth={runtime.auth} api={runtime.api} />;
}

function AdminWorkspace({
  auth: resolvedAuth,
  api: resolvedApi
}: Required<AdminAppProps>) {

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

  const handleApiError = useCallback(async (error: unknown): Promise<boolean> => {
    if (!(error instanceof ApiClientError)) return false;
    if (error.statusCode === 401) {
      setAccessToken(null);
      setPhase('login');
      await resolvedAuth.signOut();
      return true;
    }
    if (error.statusCode === 403) {
      setAccessToken(null);
      setPhase('forbidden');
      return true;
    }
    return false;
  }, [resolvedAuth]);

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
      if (sequence !== queueSequence.current || controller.signal.aborted) return;
      setItems(previous => append ? mergeById(previous, page.items) : [...page.items]);
      setNextCursor(page.nextCursor);
    } catch (error) {
      if (isAbort(error)) return;
      if (!await handleApiError(error)) setNotice('审核队列暂时无法加载，请稍后重试。');
    } finally {
      if (sequence === queueSequence.current) setQueueLoading(false);
    }
  }, [accessToken, handleApiError, resolvedApi]);

  useEffect(() => {
    if (phase !== 'workspace' || activeView === 'audit') return;
    seenCursors.current.clear();
    setItems([]);
    setNextCursor(null);
    setNotice(null);
    void loadQueue(activeView as QueueStatus);
    return () => queueAbort.current?.abort();
  }, [activeView, loadQueue, phase]);

  const loadDetail = useCallback(async (id: string): Promise<void> => {
    if (!accessToken) return;
    const sequence = ++detailSequence.current;
    detailAbort.current?.abort();
    const controller = new AbortController();
    detailAbort.current = controller;
    setDetailLoading(true);
    try {
      const result = await resolvedApi.getDetail(accessToken, id, controller.signal);
      if (sequence === detailSequence.current && !controller.signal.aborted) setDetail(result);
    } catch (error) {
      if (isAbort(error)) return;
      if (!await handleApiError(error)) setNotice('投稿详情暂时无法加载，请稍后重试。');
    } finally {
      if (sequence === detailSequence.current) setDetailLoading(false);
    }
  }, [accessToken, handleApiError, resolvedApi]);

  useEffect(() => {
    if (!selectedId || phase !== 'workspace') return;
    void loadDetail(selectedId);
    return () => detailAbort.current?.abort();
  }, [loadDetail, phase, selectedId]);

  async function applyAction(action: AdminAction['action'], reason: string): Promise<void> {
    if (!accessToken || !detail || actingRef.current || !reason) return;
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
      setNotice('操作已完成，队列已刷新。');
      setSelectedId(null);
      setDetail(null);
      if (activeView !== 'audit') await loadQueue(activeView as QueueStatus);
    } catch (error) {
      if (error instanceof ApiClientError && error.statusCode === 409) {
        setNotice(error.code === 'VERSION_CONFLICT'
          ? '状态已变化，已刷新最新内容。'
          : stableActionError(error.code));
        await Promise.all([
          loadDetail(detail.id),
          activeView === 'audit' ? Promise.resolve() : loadQueue(activeView as QueueStatus)
        ]);
      } else if (!await handleApiError(error)) {
        setNotice(error instanceof ApiClientError
          ? stableActionError(error.code)
          : '审核操作暂时无法完成，请稍后重试。');
      }
    } finally {
      actingRef.current = false;
      setActing(false);
    }
  }

  async function signOut(): Promise<void> {
    await resolvedAuth.signOut();
    setAccessToken(null);
    setPhase('login');
  }

  if (phase === 'checking') {
    return <main className={styles.centerPage}><p role="status">正在检查管理员会话…</p></main>;
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
          <h1>该邮箱没有管理员权限</h1>
          <p>管理员权限由服务端白名单校验，当前会话无法进入工作台。</p>
          <button type="button" className={styles.secondaryButton} onClick={() => void signOut()}>退出当前会话</button>
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
          <div><p className={styles.eyebrow}>PRIVATE ADMIN MODE</p><h1>内容审核控制台</h1></div>
          <button type="button" className={styles.textButton} onClick={() => void signOut()}>退出登录</button>
        </header>
        {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
        {activeView === 'audit' ? <AdminAuditLog detail={detail} /> : (
          <div className={styles.reviewGrid}>
            <AdminQueue
              items={items}
              selectedId={selectedId}
              loading={queueLoading}
              hasMore={nextCursor !== null}
              onSelect={setSelectedId}
              onLoadMore={() => {
                if (nextCursor === null || seenCursors.current.has(nextCursor)) return;
                seenCursors.current.add(nextCursor);
                void loadQueue(activeView as QueueStatus, nextCursor, true);
              }}
            />
            <AdminDetail detail={detail} loading={detailLoading} acting={acting} onAction={(action, reason) => void applyAction(action, reason)} />
          </div>
        )}
      </div>
    </main>
  );
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

function stableActionError(code: string): string {
  if (code === 'TECHNICAL_SCAN_REQUIRED') return '技术扫描未明确通过，不能批准共享包。';
  if (code === 'INVALID_ADMIN_ACTION') return '当前状态不允许执行该操作，已保留原状态。';
  return '审核操作暂时无法完成，请稍后重试。';
}
