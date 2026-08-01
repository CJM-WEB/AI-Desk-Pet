// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SubmissionStatusView } from '@myself/shared-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../components/i18n/I18nProvider';
import { readStatusToken } from '../lib/submission-status';
import { SubmissionStatusPage } from '../app/submission-status/submission-status-page';
import type { ApiClient } from '../lib/api-client';

const token = 'a'.repeat(43);

function status(overrides: Partial<SubmissionStatusView> = {}): SubmissionStatusView {
  return {
    submissionId: 'submission-1',
    status: 'system_reviewing',
    publicReason: '内容正在进行系统审核。',
    createdAt: '2026-07-30T12:00:00.000Z',
    updatedAt: '2026-07-30T12:01:00.000Z',
    ...overrides
  };
}

function renderPage(request = vi.fn().mockResolvedValue(status())) {
  const api = { request } as unknown as ApiClient;
  render(
    <I18nProvider initialLocale="zh-CN">
      <SubmissionStatusPage api={api} />
    </I18nProvider>
  );
  return request;
}

afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/');
});

describe('匿名投稿状态令牌', () => {
  it('只接受 Fragment 中的 43 位 URL 安全令牌', () => {
    expect(readStatusToken(`#${token}`)).toBe(token);
    expect(readStatusToken(`#${'a'.repeat(42)}`)).toBeNull();
    expect(readStatusToken('#statusToken=secret')).toBeNull();
    expect(readStatusToken('')).toBeNull();
  });

  it('先清除地址栏 Fragment，再只发送状态令牌查询', async () => {
    window.history.replaceState({}, '', `/submission-status/?statusToken=query-secret#${token}`);
    const request = vi.fn().mockImplementation(async () => {
      expect(window.location.hash).toBe('');
      return status();
    });

    renderPage(request);

    await screen.findByText('系统审核中');
    expect(window.location.search).toBe('?statusToken=query-secret');
    expect(request).toHaveBeenCalledWith('/submission-status', {
      method: 'POST',
      body: JSON.stringify({ statusToken: token })
    });
  });

  it('忽略 query 中的同名令牌，并允许手动粘贴后重试', async () => {
    window.history.replaceState({}, '', `/submission-status/?statusToken=${token}`);
    const request = renderPage();

    expect(await screen.findByLabelText('状态令牌')).toBeTruthy();
    expect(request).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('状态令牌'), { target: { value: token } });
    fireEvent.click(screen.getByRole('button', { name: '查询状态' }));

    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  });

  it.each([
    ['system_reviewing', '系统审核中'],
    ['manual_review_pending', '等待管理员审核'],
    ['published', '已发布'],
    ['auto_rejected', '系统未通过'],
    ['admin_rejected', '管理员未通过'],
    ['deleted_quarantined', '已下架'],
    ['purged', '已清理']
  ] as const)('将 %s 映射为公开状态文案', async (submissionStatus, label) => {
    window.history.replaceState({}, '', `/submission-status/#${token}`);
    renderPage(vi.fn().mockResolvedValue(status({ status: submissionStatus })));
    expect(await screen.findByText(label)).toBeTruthy();
  });

  it('只展示后端返回的公开说明，并在失败后保留手动重试入口', async () => {
    window.history.replaceState({}, '', `/submission-status/#${token}`);
    const request = vi.fn()
      .mockRejectedValueOnce(new Error('internal moderation evidence'))
      .mockResolvedValueOnce(status({ publicReason: '公开说明' }));
    renderPage(request);

    expect(await screen.findByText('暂时无法查询，请检查令牌后重试。')).toBeTruthy();
    expect(screen.queryByText(/internal moderation evidence/u)).toBeNull();

    fireEvent.change(screen.getByLabelText('状态令牌'), { target: { value: token } });
    fireEvent.click(screen.getByRole('button', { name: '查询状态' }));
    expect(await screen.findByText('公开说明')).toBeTruthy();
  });
});
