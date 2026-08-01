// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SubmissionStatusView } from '@myself/shared-types';
import { StrictMode } from 'react';
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
    window.history.replaceState(
      {},
      '',
      `/submission-status/?keep=visible&statusToken=query-secret&statusToken=query-secret-2#${token}`
    );
    const request = vi.fn().mockImplementation(async () => {
      expect(window.location.hash).toBe('');
      return status();
    });

    renderPage(request);

    await screen.findByText('系统审核中');
    expect(window.location.search).toBe('?keep=visible');
    expect(request).toHaveBeenCalledWith('/submission-status', {
      method: 'POST',
      body: JSON.stringify({ statusToken: token })
    });
  });

  it('StrictMode 重放 effect 后仍能完成 Fragment 自动查询', async () => {
    window.history.replaceState({}, '', `/submission-status/#${token}`);
    const request = vi.fn().mockResolvedValue(status({ status: 'published' }));
    const api = { request } as unknown as ApiClient;

    render(
      <StrictMode>
        <I18nProvider initialLocale="zh-CN">
          <SubmissionStatusPage api={api} />
        </I18nProvider>
      </StrictMode>
    );

    expect(await screen.findByText('已发布')).toBeTruthy();
    expect(window.location.hash).toBe('');
    expect(request).toHaveBeenCalledWith('/submission-status', {
      method: 'POST',
      body: JSON.stringify({ statusToken: token })
    });
  });

  it('无有效 Fragment 时也清除敏感 query，且绝不使用 query 令牌', async () => {
    window.history.replaceState(
      {},
      '',
      `/submission-status/?keep=visible&statusToken=${token}#invalid-fragment`
    );
    const request = renderPage();

    expect(await screen.findByLabelText('状态令牌')).toBeTruthy();
    expect(window.location.search).toBe('?keep=visible');
    expect(window.location.hash).toBe('');
    expect(request).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('状态令牌'), { target: { value: token } });
    fireEvent.click(screen.getByRole('button', { name: '查询状态' }));

    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  });

  it('后续查询发生后忽略已过期的延迟响应', async () => {
    const secondToken = 'b'.repeat(43);
    let resolveFirst: ((value: SubmissionStatusView) => void) | undefined;
    const firstRequest = vi.fn().mockReturnValue(new Promise<SubmissionStatusView>((resolve) => {
      resolveFirst = resolve;
    }));
    const secondRequest = vi.fn().mockResolvedValue(status({ status: 'published' }));
    const firstApi = { request: firstRequest } as unknown as ApiClient;
    const secondApi = { request: secondRequest } as unknown as ApiClient;
    window.history.replaceState({}, '', `/submission-status/#${token}`);

    const view = render(
      <I18nProvider initialLocale="zh-CN">
        <SubmissionStatusPage api={firstApi} />
      </I18nProvider>
    );
    await waitFor(() => expect(firstRequest).toHaveBeenCalledTimes(1));

    window.history.replaceState({}, '', `/submission-status/#${secondToken}`);
    view.rerender(
      <I18nProvider initialLocale="zh-CN">
        <SubmissionStatusPage api={secondApi} />
      </I18nProvider>
    );
    expect(await screen.findByText('已发布')).toBeTruthy();

    await act(async () => {
      resolveFirst?.(status({ status: 'system_reviewing' }));
    });
    expect(screen.queryByText('系统审核中')).toBeNull();
  });

  it('组件卸载后安全忽略尚未完成的响应', async () => {
    let resolveRequest: ((value: SubmissionStatusView) => void) | undefined;
    const request = vi.fn().mockReturnValue(new Promise<SubmissionStatusView>((resolve) => {
      resolveRequest = resolve;
    }));
    window.history.replaceState({}, '', `/submission-status/#${token}`);
    const view = render(
      <I18nProvider initialLocale="zh-CN">
        <SubmissionStatusPage api={{ request } as unknown as ApiClient} />
      </I18nProvider>
    );
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));

    view.unmount();
    await act(async () => {
      resolveRequest?.(status({ status: 'published' }));
    });

    expect(screen.queryByText('已发布')).toBeNull();
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
