// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AdminApp } from '../components/admin/AdminApp';
import { I18nProvider } from '../components/i18n/I18nProvider';
import type { AdminAuthClient } from '../lib/admin-auth';
import type {
  AdminApi,
  AdminQueuePage,
  AdminSubmissionDetail
} from '../lib/admin-api-client';
import { ApiClientError } from '../lib/api-client';

afterEach(cleanup);

function detail(overrides: Partial<AdminSubmissionDetail> = {}): AdminSubmissionDetail {
  return {
    id: 'submission-1',
    kind: 'feedback',
    status: 'manual_review_pending',
    statusVersion: 3,
    title: '改进建议',
    body: '希望增加桌宠快捷动作。',
    moderationLeaseUntil: null,
    purgeAfter: null,
    preQuarantineStatus: null,
    publishedAt: null,
    createdAt: '2026-07-30T12:00:00.000Z',
    updatedAt: '2026-07-30T12:01:00.000Z',
    riskSummary: { labels: ['ai-pet'], summary: '与产品相关' },
    autoRejectionReason: null,
    coverPreview: null,
    assets: [],
    moderationResults: [],
    auditLogs: [],
    ...overrides
  };
}

function queuePage(item = detail()): AdminQueuePage {
  const { assets: _assets, moderationResults: _results, auditLogs: _logs, ...summary } = item;
  return { items: [summary], nextCursor: null };
}

function setup(overrides: Partial<AdminApi> = {}, authOverrides: Partial<AdminAuthClient> = {}) {
  const row = detail();
  const api = {
    listQueue: vi.fn().mockResolvedValue(queuePage(row)),
    getDetail: vi.fn().mockResolvedValue(row),
    applyAction: vi.fn().mockResolvedValue({
      submission: { ...row, status: 'published', statusVersion: 4 },
      replayed: false
    }),
    ...overrides
  } satisfies AdminApi;
  const auth = {
    requestEmailOtp: vi.fn(),
    getAccessToken: vi.fn().mockResolvedValue('access-token'),
    signOut: vi.fn().mockResolvedValue(undefined),
    ...authOverrides
  } satisfies AdminAuthClient;
  const view = render(<AdminApp auth={auth} api={api} />);
  return { api, auth, row, view };
}

describe('管理员审核工作台', () => {
  it('浏览器配置缺失时显示受控错误而不是让页面崩溃', async () => {
    render(<AdminApp api={{} as AdminApi} />);

    expect((await screen.findByRole('alert')).textContent).toBe(
      '管理员模式配置暂时不可用，请联系站点管理员。'
    );
  });

  it('取得现有会话后加载队列并提供五个侧栏视图', async () => {
    const { api } = setup();

    expect(await screen.findByText('改进建议')).toBeTruthy();
    for (const label of ['待我审核', '自动驳回', '已发布', '隔离区', '审计记录']) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
    expect(api.listQueue).toHaveBeenCalledWith(
      'access-token',
      'manual_review_pending',
      undefined,
      expect.any(AbortSignal)
    );
  });

  it('管理员动作必须携带当前版本、非空理由与 UUID 幂等键', async () => {
    const { api } = setup();
    fireEvent.click(await screen.findByText('改进建议'));
    expect(await screen.findByText('希望增加桌宠快捷动作。')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('审核理由'), {
      target: { value: '确认内容符合产品主题' }
    });
    fireEvent.click(screen.getByRole('button', { name: '批准发布' }));

    await waitFor(() => expect(api.applyAction).toHaveBeenCalledWith(
      'access-token',
      'submission-1',
      expect.objectContaining({
        action: 'approve',
        version: 3,
        reason: '确认内容符合产品主题',
        idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/u)
      })
    ));
  });

  it('动作提交中锁住重复点击且空理由不能提交', async () => {
    let resolveAction: (() => void) | undefined;
    const applyAction = vi.fn().mockReturnValue(new Promise(resolve => {
      resolveAction = () => resolve({ submission: detail(), replayed: false });
    }));
    setup({ applyAction });
    fireEvent.click(await screen.findByText('改进建议'));
    await screen.findByText('希望增加桌宠快捷动作。');

    expect((screen.getByRole('button', { name: '批准发布' }) as HTMLButtonElement).disabled)
      .toBe(true);
    fireEvent.change(screen.getByLabelText('审核理由'), {
      target: { value: '内容符合要求' }
    });
    const approve = screen.getByRole('button', { name: '批准发布' });
    fireEvent.click(approve);
    fireEvent.click(approve);

    expect(applyAction).toHaveBeenCalledTimes(1);
    resolveAction?.();
  });

  it('版本冲突只刷新详情与队列，不重复提交动作', async () => {
    const row = detail();
    const applyAction = vi.fn().mockRejectedValue(
      new ApiClientError('VERSION_CONFLICT', 409)
    );
    const getDetail = vi.fn().mockResolvedValue(row);
    const { api } = setup({ applyAction, getDetail });
    fireEvent.click(await screen.findByText('改进建议'));
    await screen.findByText('希望增加桌宠快捷动作。');
    fireEvent.change(screen.getByLabelText('审核理由'), {
      target: { value: '复核通过' }
    });
    fireEvent.click(screen.getByRole('button', { name: '批准发布' }));

    expect(await screen.findByText('状态已变化，已刷新最新内容。')).toBeTruthy();
    expect(applyAction).toHaveBeenCalledTimes(1);
    expect(getDetail).toHaveBeenCalledTimes(2);
    expect(api.listQueue).toHaveBeenCalledTimes(2);
    expect((screen.getByLabelText('审核理由') as HTMLTextAreaElement).value).toBe('');
  });

  it('分页失败可重试且成功后阻止服务端重复游标', async () => {
    const first = detail({ id: 'first', title: '第一页' });
    const second = detail({ id: 'second', title: '第二页' });
    const listQueue = vi.fn()
      .mockResolvedValueOnce({ items: [queuePage(first).items[0]!], nextCursor: 20 })
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce({ items: [queuePage(second).items[0]!], nextCursor: 20 });
    setup({ listQueue });
    await screen.findByText('第一页');

    fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
    await screen.findByText('审核队列暂时无法加载，请稍后重试。');
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
    expect(await screen.findByText('第二页')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }));

    expect(listQueue).toHaveBeenCalledTimes(3);
  });

  it('较旧的详情响应不能覆盖后来选择的投稿', async () => {
    const first = detail({ id: 'first', title: '第一条', body: '第一条正文' });
    const second = detail({ id: 'second', title: '第二条', body: '第二条正文' });
    let resolveFirst: ((value: AdminSubmissionDetail) => void) | undefined;
    const getDetail = vi.fn((_: string, id: string) => id === 'first'
      ? new Promise<AdminSubmissionDetail>(resolve => { resolveFirst = resolve; })
      : Promise.resolve(second));
    setup({
      listQueue: vi.fn().mockResolvedValue({
        items: [queuePage(first).items[0]!, queuePage(second).items[0]!],
        nextCursor: null
      }),
      getDetail
    });

    fireEvent.click(await screen.findByText('第一条'));
    fireEvent.click(screen.getByText('第二条'));
    expect(await screen.findByText('第二条正文')).toBeTruthy();
    resolveFirst?.(first);
    await waitFor(() => expect(screen.queryByText('第一条正文')).toBeNull());
  });

  it('切换投稿会清空上一条的审核理由', async () => {
    const first = detail({ id: 'first', title: '第一条' });
    const second = detail({ id: 'second', title: '第二条', body: '第二条新正文' });
    setup({
      listQueue: vi.fn().mockResolvedValue({
        items: [queuePage(first).items[0]!, queuePage(second).items[0]!],
        nextCursor: null
      }),
      getDetail: vi.fn((_: string, id: string) => Promise.resolve(id === 'first' ? first : second))
    });
    fireEvent.click(await screen.findByText('第一条'));
    fireEvent.change(await screen.findByLabelText('审核理由'), {
      target: { value: '仅属于第一条的理由' }
    });
    fireEvent.click(screen.getByText('第二条'));

    await screen.findByText('第二条新正文');
    expect((screen.getByLabelText('审核理由') as HTMLTextAreaElement).value).toBe('');
    expect((screen.getByRole('button', { name: '批准发布' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('退出后同步擦除旧详情且旧请求不能回填下一会话', async () => {
    const oldRow = detail({ id: 'old', title: '旧会话内容', body: '旧敏感正文' });
    const newRow = detail({ id: 'new', title: '新会话内容', body: '新会话正文' });
    let resolveOldDetail: ((value: AdminSubmissionDetail) => void) | undefined;
    const getDetail = vi.fn((token: string) => token === 'token-a'
      ? new Promise<AdminSubmissionDetail>(resolve => { resolveOldDetail = resolve; })
      : Promise.resolve(newRow));
    const challenge = { verify: vi.fn().mockResolvedValue(undefined) };
    const auth = {
      getAccessToken: vi.fn().mockResolvedValueOnce('token-a').mockResolvedValueOnce('token-b'),
      requestEmailOtp: vi.fn().mockResolvedValue(challenge),
      signOut: vi.fn().mockResolvedValue(undefined)
    } satisfies AdminAuthClient;
    const listQueue = vi.fn((token: string) => Promise.resolve(
      token === 'token-a' ? queuePage(oldRow) : queuePage(newRow)
    ));
    setup({ listQueue, getDetail }, auth);
    fireEvent.click(await screen.findByText('旧会话内容'));
    fireEvent.click(screen.getByRole('button', { name: '退出登录' }));
    expect(screen.queryByText('旧会话内容')).toBeNull();

    fireEvent.change(screen.getByLabelText('管理员邮箱'), { target: { value: 'b@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: '发送验证码' }));
    fireEvent.change(await screen.findByLabelText('邮箱验证码'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    expect(await screen.findByText('新会话内容')).toBeTruthy();
    resolveOldDetail?.(oldRow);
    await waitFor(() => expect(screen.queryByText('旧敏感正文')).toBeNull());
  });

  it('自动驳回共享包执行技术扫描门禁，隔离内容提供恢复动作', async () => {
    const blocked = detail({ id: 'blocked', kind: 'shared_package', status: 'auto_rejected', title: '待复核共享包' });
    const { view } = setup({
      listQueue: vi.fn().mockResolvedValue(queuePage(blocked)),
      getDetail: vi.fn().mockResolvedValue(blocked)
    });
    fireEvent.click(await screen.findByRole('button', { name: '自动驳回' }));
    fireEvent.click(await screen.findByText('待复核共享包'));
    await screen.findByLabelText('审核理由');
    fireEvent.change(screen.getByLabelText('审核理由'), { target: { value: '人工复核' } });
    expect((screen.getByRole('button', { name: '批准发布' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '转人工审核' }) as HTMLButtonElement).disabled).toBe(false);

    cleanup();
    const quarantined = detail({ id: 'deleted', status: 'deleted_quarantined', title: '隔离内容', preQuarantineStatus: 'published' });
    setup({
      listQueue: vi.fn().mockResolvedValue(queuePage(quarantined)),
      getDetail: vi.fn().mockResolvedValue(quarantined)
    });
    fireEvent.click(await screen.findByRole('button', { name: '隔离区' }));
    fireEvent.click(await screen.findByText('隔离内容'));
    expect(await screen.findByRole('button', { name: '恢复内容' })).toBeTruthy();
    void view;
  });

  it('审计记录入口保留可选队列且日志只读', async () => {
    const row = detail({
      auditLogs: [{
        action: 'approve',
        beforeStatus: 'manual_review_pending',
        afterStatus: 'published',
        reason: '内容合规',
        createdAt: '2026-07-30T12:02:00.000Z'
      }]
    });
    setup({ getDetail: vi.fn().mockResolvedValue(row) });
    fireEvent.click(await screen.findByRole('button', { name: '审计记录' }));
    fireEvent.click(await screen.findByText('改进建议'));

    expect(await screen.findByText('内容合规')).toBeTruthy();
    expect(screen.queryByLabelText('审核理由')).toBeNull();
  });

  it('401 保留当前会话供重试，403 显示明确无权限状态', async () => {
    const unauthorized = setup({
      listQueue: vi.fn().mockRejectedValue(new ApiClientError('UNAUTHORIZED', 401))
    });
    expect(await screen.findByText('审核队列暂时无法加载，请稍后重试。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '退出登录' })).toBeTruthy();
    expect(unauthorized.auth.signOut).not.toHaveBeenCalled();
    cleanup();

    setup({
      listQueue: vi.fn().mockRejectedValue(new ApiClientError('FORBIDDEN', 403))
    });
    expect(await screen.findByText('该邮箱没有管理员权限')).toBeTruthy();
  });

  it('英文环境提供可访问的核心管理员文案', async () => {
    const row = detail({ title: 'English submission' });
    const api = {
      listQueue: vi.fn().mockResolvedValue(queuePage(row)),
      getDetail: vi.fn().mockResolvedValue(row),
      applyAction: vi.fn()
    } satisfies AdminApi;
    const auth = {
      requestEmailOtp: vi.fn(),
      getAccessToken: vi.fn().mockResolvedValue('token-en'),
      signOut: vi.fn().mockResolvedValue(undefined)
    } satisfies AdminAuthClient;
    render(
      <I18nProvider initialLocale="en">
        <AdminApp auth={auth} api={api} />
      </I18nProvider>
    );

    expect(await screen.findByRole('button', { name: 'Pending review' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
    expect(screen.getByLabelText('Review queue')).toBeTruthy();
  });
});
