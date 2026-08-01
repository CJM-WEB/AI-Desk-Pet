// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AdminApp } from '../components/admin/AdminApp';
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
  render(<AdminApp auth={auth} api={api} />);
  return { api, auth, row };
}

describe('管理员审核工作台', () => {
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
  });

  it('401 会登出并返回登录，403 显示明确无权限状态', async () => {
    const unauthorized = setup({
      listQueue: vi.fn().mockRejectedValue(new ApiClientError('UNAUTHORIZED', 401))
    });
    expect(await screen.findByLabelText('管理员邮箱')).toBeTruthy();
    expect(unauthorized.auth.signOut).toHaveBeenCalledTimes(1);
    cleanup();

    setup({
      listQueue: vi.fn().mockRejectedValue(new ApiClientError('FORBIDDEN', 403))
    });
    expect(await screen.findByText('该邮箱没有管理员权限')).toBeTruthy();
  });
});
