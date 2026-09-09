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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.NEXT_PUBLIC_ADMIN_ORIGIN;
});

function detail(overrides: Partial<AdminSubmissionDetail> = {}): AdminSubmissionDetail {
  return {
    id: 'submission-1',
    kind: 'feedback',
    status: 'manual_review_pending',
    statusVersion: 3,
    title: '改进建议',
    body: '希望增加桌宠快捷动作。',
    purgeAfter: null,
    preQuarantineStatus: null,
    publishedAt: null,
    publicationBasis: null,
    createdAt: '2026-07-30T12:00:00.000Z',
    updatedAt: '2026-07-30T12:01:00.000Z',
    riskSummary: { labels: ['ai-pet'], summary: '与产品相关' },
    autoRejectionReason: null,
    coverPreview: null,
    packageDownload: null,
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
    getOfficialWindowsDownloadClickCount: vi.fn().mockResolvedValue(12),
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
  it('配置不同 HTTPS 来源时在认证初始化前跳转到固定管理员路径', async () => {
    process.env.NEXT_PUBLIC_ADMIN_ORIGIN = 'https://admin.example.com/';
    const replace = vi.fn();
    vi.stubGlobal('location', {
      origin: 'https://www.example.com',
      replace
    });

    const { auth } = setup();

    await waitFor(() => expect(replace).toHaveBeenCalledWith('https://admin.example.com/admin/'));
    expect(auth.getAccessToken).not.toHaveBeenCalled();
  });

  it('配置与当前来源相同时不跳转且正常初始化认证', async () => {
    process.env.NEXT_PUBLIC_ADMIN_ORIGIN = 'https://admin.example.com';
    const replace = vi.fn();
    vi.stubGlobal('location', {
      origin: 'https://admin.example.com',
      replace
    });

    const { auth } = setup();

    expect(await screen.findByText('改进建议')).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
    expect(auth.getAccessToken).toHaveBeenCalledOnce();
  });

  it('未配置管理员来源时保持现有初始化行为', async () => {
    const replace = vi.fn();
    vi.stubGlobal('location', {
      origin: 'https://www.example.com',
      replace
    });

    const { auth } = setup();

    expect(await screen.findByText('改进建议')).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
    expect(auth.getAccessToken).toHaveBeenCalledOnce();
  });

  it.each([
    'http://admin.example.com',
    'https://user:password@admin.example.com',
    'https://admin.example.com/path',
    'https://admin.example.com/./',
    'https://admin.example.com?',
    'https://admin.example.com?next=/admin',
    'https://admin.example.com#',
    'https://admin.example.com#token'
  ])('拒绝非纯 HTTPS origin 配置：%s', async configuredOrigin => {
    process.env.NEXT_PUBLIC_ADMIN_ORIGIN = configuredOrigin;
    const replace = vi.fn();
    vi.stubGlobal('location', {
      origin: 'https://www.example.com',
      replace
    });

    const { auth } = setup();

    expect((await screen.findByRole('alert')).textContent).toBe(
      '管理员模式配置暂时不可用，请联系站点管理员。'
    );
    expect(replace).not.toHaveBeenCalled();
    expect(auth.getAccessToken).not.toHaveBeenCalled();
  });

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

  it('已认证工作台显示官方安装包累计点击及其统计限制', async () => {
    const { api } = setup({ getOfficialWindowsDownloadClickCount: vi.fn().mockResolvedValue(12) });

    expect(await screen.findByText('12')).toBeTruthy();
    expect(screen.getByText('官方安装包下载点击')).toBeTruthy();
    expect(screen.getByText('这是可重复、可能含自动请求的近似按钮点击，不代表独立用户、传输完成或安装成功。')).toBeTruthy();
    expect(api.getOfficialWindowsDownloadClickCount).toHaveBeenCalledWith(
      'access-token',
      expect.any(AbortSignal)
    );
  });

  it('指标读取失败只显示暂不可用且审核队列仍可使用', async () => {
    setup({ getOfficialWindowsDownloadClickCount: vi.fn().mockRejectedValue(new Error('offline')) });

    expect(await screen.findByText('暂不可用')).toBeTruthy();
    expect(screen.getByText('改进建议')).toBeTruthy();
  });

  it('退出后不接收迟到的指标响应', async () => {
    let resolveMetric: ((value: number) => void) | undefined;
    const getOfficialWindowsDownloadClickCount = vi.fn().mockReturnValue(new Promise<number>(resolve => {
      resolveMetric = resolve;
    }));
    setup({ getOfficialWindowsDownloadClickCount });

    await waitFor(() => expect(getOfficialWindowsDownloadClickCount).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: '退出登录' }));
    resolveMetric?.(99);

    await Promise.resolve();
    expect(screen.queryByText('99')).toBeNull();
    expect(screen.getByRole('heading', { name: '管理员模式' })).toBeTruthy();
  });

  it('卸载工作台时取消未完成的指标读取', async () => {
    let resolveMetric: ((value: number) => void) | undefined;
    let metricSignal: AbortSignal | undefined;
    const getOfficialWindowsDownloadClickCount = vi.fn((_: string, signal?: AbortSignal) => {
      metricSignal = signal;
      return new Promise<number>(resolve => { resolveMetric = resolve; });
    });
    const { view } = setup({ getOfficialWindowsDownloadClickCount });

    await waitFor(() => expect(getOfficialWindowsDownloadClickCount).toHaveBeenCalledOnce());
    view.unmount();
    resolveMetric?.(99);

    await Promise.resolve();
    expect(metricSignal?.aborted).toBe(true);
  });

  it('指标读取返回 403 时清除会话且不显示累计值', async () => {
    setup({
      getOfficialWindowsDownloadClickCount: vi.fn().mockRejectedValue(
        new ApiClientError('FORBIDDEN', 403)
      )
    });

    expect(await screen.findByText('该邮箱没有管理员权限')).toBeTruthy();
    expect(screen.queryByText('12')).toBeNull();
  });

  it('管理员详情只在服务端提供待审 ZIP 时显示五分钟下载链接', async () => {
    const row = detail({
      kind: 'shared_package',
      packageDownload: {
        url: 'https://storage.example/review-pet.zip',
        expiresAt: '2026-07-30T12:06:00.000Z'
      },
      assets: [{
        role: 'package',
        storageKey: 'private/review-pet.zip',
        fileName: 'review-pet.zip',
        declaredBytes: 12,
        actualBytes: 12,
        contentType: 'application/zip'
      }]
    });
    setup({ getDetail: vi.fn().mockResolvedValue(row) });

    fireEvent.click(await screen.findByText('改进建议'));
    const link = await screen.findByRole('link', { name: '下载待审 ZIP（5分钟）' });
    expect(link.getAttribute('href')).toBe('https://storage.example/review-pet.zip');
  });

  it('管理员详情未提供待审 ZIP 时不显示下载链接', async () => {
    setup();

    fireEvent.click(await screen.findByText('改进建议'));
    await screen.findByText('希望增加桌宠快捷动作。');
    expect(screen.queryByRole('link', { name: '下载待审 ZIP（5分钟）' })).toBeNull();
  });

  it('动作成功替换队列后允许复用新一代页面返回的相同游标', async () => {
    const first = detail({ id: 'first', title: '第一页', body: '待审核正文' });
    const second = detail({ id: 'second', title: '第二页' });
    const listQueue = vi.fn()
      .mockResolvedValueOnce({ items: [queuePage(first).items[0]!], nextCursor: 'v1.same-next' })
      .mockResolvedValueOnce({ items: [queuePage(second).items[0]!], nextCursor: null })
      .mockResolvedValueOnce({ items: [queuePage(first).items[0]!], nextCursor: 'v1.same-next' })
      .mockResolvedValueOnce({ items: [queuePage(second).items[0]!], nextCursor: null });
    setup({ listQueue, getDetail: vi.fn().mockResolvedValue(first) });
    await screen.findByText('第一页');
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
    await screen.findByText('第二页');

    fireEvent.click(screen.getByText('第一页'));
    await screen.findByText('待审核正文');
    fireEvent.change(screen.getByLabelText('审核理由'), { target: { value: '审核通过' } });
    fireEvent.click(screen.getByRole('button', { name: '批准发布' }));
    await waitFor(() => expect(listQueue).toHaveBeenCalledTimes(3));
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }));

    await waitFor(() => expect(listQueue).toHaveBeenCalledTimes(4));
    expect(listQueue.mock.calls[3]?.[2]).toBe('v1.same-next');
  });

  it('版本冲突替换队列后允许复用新一代页面返回的相同游标', async () => {
    const first = detail({ id: 'first', title: '冲突第一页', body: '冲突正文' });
    const second = detail({ id: 'second', title: '冲突第二页' });
    const listQueue = vi.fn()
      .mockResolvedValueOnce({ items: [queuePage(first).items[0]!], nextCursor: 'v1.same-next' })
      .mockResolvedValueOnce({ items: [queuePage(second).items[0]!], nextCursor: null })
      .mockResolvedValueOnce({ items: [queuePage(first).items[0]!], nextCursor: 'v1.same-next' })
      .mockResolvedValueOnce({ items: [queuePage(second).items[0]!], nextCursor: null });
    setup({
      listQueue,
      getDetail: vi.fn().mockResolvedValue(first),
      applyAction: vi.fn().mockRejectedValue(new ApiClientError('VERSION_CONFLICT', 409))
    });
    await screen.findByText('冲突第一页');
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
    await screen.findByText('冲突第二页');

    fireEvent.click(screen.getByText('冲突第一页'));
    await screen.findByText('冲突正文');
    fireEvent.change(screen.getByLabelText('审核理由'), { target: { value: '重新复核' } });
    fireEvent.click(screen.getByRole('button', { name: '批准发布' }));
    await waitFor(() => expect(listQueue).toHaveBeenCalledTimes(3));
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }));

    await waitFor(() => expect(listQueue).toHaveBeenCalledTimes(4));
    expect(listQueue.mock.calls[3]?.[2]).toBe('v1.same-next');
  });

  it('分页失败可重试且成功后阻止服务端重复游标', async () => {
    const first = detail({ id: 'first', title: '第一页' });
    const second = detail({ id: 'second', title: '第二页' });
    const listQueue = vi.fn()
      .mockResolvedValueOnce({ items: [queuePage(first).items[0]!], nextCursor: 'v1.admin-next' })
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce({ items: [queuePage(second).items[0]!], nextCursor: 'v1.admin-next' });
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

  it('人工审核共享包缺少技术证据时禁用批准并显示稳定原因', async () => {
    const pending = detail({
      id: 'manual-package',
      kind: 'shared_package',
      status: 'manual_review_pending',
      title: '待人工审核共享包'
    });
    setup({
      listQueue: vi.fn().mockResolvedValue(queuePage(pending)),
      getDetail: vi.fn().mockResolvedValue(pending)
    });

    fireEvent.click(await screen.findByText('待人工审核共享包'));
    fireEvent.change(await screen.findByLabelText('审核理由'), {
      target: { value: '尝试批准' }
    });

    expect((screen.getByRole('button', { name: '批准发布' }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect((screen.getByRole('button', { name: '强制发布' }) as HTMLButtonElement).disabled)
      .toBe(false);
    expect(screen.getByText('技术扫描未明确通过，不能批准共享包。')).toBeTruthy();
  });

  it('系统审核中的投稿提供独立转人工动作', async () => {
    const reviewing = detail({
      id: 'reviewing-feedback',
      status: 'system_reviewing',
      title: '系统审核中的反馈'
    });
    setup({
      listQueue: vi.fn().mockResolvedValue(queuePage(reviewing)),
      getDetail: vi.fn().mockResolvedValue(reviewing)
    });

    fireEvent.click(await screen.findByText('系统审核中的反馈'));
    fireEvent.change(await screen.findByLabelText('审核理由'), {
      target: { value: '需要管理员人工复核' }
    });

    expect((screen.getByRole('button', { name: '转人工审核' }) as HTMLButtonElement).disabled)
      .toBe(false);
  });

  it('强制发布第一次只展开可访问确认区，取消不发送，第二次确认才提交精确风险值', async () => {
    const pending = detail({
      id: 'override-package',
      kind: 'shared_package',
      status: 'manual_review_pending',
      title: '待强制发布共享包'
    });
    const { api } = setup({
      listQueue: vi.fn().mockResolvedValue(queuePage(pending)),
      getDetail: vi.fn().mockResolvedValue(pending)
    });
    fireEvent.click(await screen.findByText('待强制发布共享包'));
    fireEvent.change(await screen.findByLabelText('审核理由'), {
      target: { value: '管理员已核对来源并接受下载风险' }
    });

    const openConfirmation = screen.getByRole('button', { name: '强制发布' });
    fireEvent.click(openConfirmation);
    expect(api.applyAction).not.toHaveBeenCalled();
    const confirmation = screen.getByRole('alertdialog', { name: '确认强制发布风险' });
    expect(confirmation.getAttribute('aria-describedby')).toBeTruthy();
    expect(confirmation.textContent).toContain('该文件未通过安全扫描，发布后用户可能下载危险文件');
    const confirm = screen.getByRole('button', { name: '确认强制发布' });
    const cancel = screen.getByRole('button', { name: '取消强制发布' });
    expect(confirm.tagName).toBe('BUTTON');
    expect(cancel.tagName).toBe('BUTTON');
    expect(document.activeElement).toBe(
      screen.getByText('该文件未通过安全扫描，发布后用户可能下载危险文件')
    );

    fireEvent.click(cancel);
    expect(screen.queryByRole('alertdialog', { name: '确认强制发布风险' })).toBeNull();
    expect(api.applyAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '强制发布' }));
    fireEvent.click(screen.getByRole('button', { name: '确认强制发布' }));
    await waitFor(() => expect(api.applyAction).toHaveBeenCalledWith(
      'access-token',
      'override-package',
      expect.objectContaining({
        action: 'force_publish',
        version: 3,
        reason: '管理员已核对来源并接受下载风险',
        riskAcknowledgement: 'ADMIN_OVERRIDE_ACCEPTED',
        idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/u)
      })
    ));
  });

  it('强制发布提交期间锁住确认区并阻止重复请求', async () => {
    const pending = detail({
      id: 'acting-override-package',
      kind: 'shared_package',
      status: 'manual_review_pending',
      title: '提交中的强制发布'
    });
    let resolveAction: (() => void) | undefined;
    const applyAction = vi.fn().mockReturnValue(new Promise(resolve => {
      resolveAction = () => resolve({ submission: detail(), replayed: false });
    }));
    setup({
      listQueue: vi.fn().mockResolvedValue(queuePage(pending)),
      getDetail: vi.fn().mockResolvedValue(pending),
      applyAction
    });
    fireEvent.click(await screen.findByText('提交中的强制发布'));
    fireEvent.change(await screen.findByLabelText('审核理由'), {
      target: { value: '接受风险' }
    });
    fireEvent.click(screen.getByRole('button', { name: '强制发布' }));
    const confirm = screen.getByRole('button', { name: '确认强制发布' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    expect(applyAction).toHaveBeenCalledTimes(1);
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '取消强制发布' }) as HTMLButtonElement).disabled)
      .toBe(true);
    resolveAction?.();
  });

  it('人工审核共享包的过期技术证据不能解除批准门禁', async () => {
    const pending = detail({
      id: 'manual-package',
      kind: 'shared_package',
      status: 'manual_review_pending',
      title: '证据过期共享包',
      assets: [{
        role: 'package', storageKey: 'private/manual-package.zip', fileName: 'manual-package.zip',
        declaredBytes: 20, actualBytes: 20, contentType: 'application/zip'
      }],
      moderationResults: [{
        kind: 'package_scan', provider: 'isolated-scanner', suggestion: 'Pass', label: '扫描通过',
        score: null,
        evidence: {
          submissionId: 'manual-package',
          packageStorageKey: 'private/manual-package.zip',
          packageSizeBytes: 20,
          submissionStatusVersion: 2,
          scanCode: 'CHARACTER_PACKAGE_SCAN_PASSED'
        },
        createdAt: '2026-07-30T12:00:00.000Z'
      }]
    });
    setup({
      listQueue: vi.fn().mockResolvedValue(queuePage(pending)),
      getDetail: vi.fn().mockResolvedValue(pending)
    });

    fireEvent.click(await screen.findByText('证据过期共享包'));
    fireEvent.change(await screen.findByLabelText('审核理由'), {
      target: { value: '尝试批准' }
    });

    expect((screen.getByRole('button', { name: '批准发布' }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect(screen.getByText('技术扫描未明确通过，不能批准共享包。')).toBeTruthy();
  });

  it('人工审核共享包具有完整当前技术证据时恢复批准按钮', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(
      Date.parse('2026-07-30T12:30:00.000Z')
    );
    const pending = detail({
      id: 'scanned-package',
      kind: 'shared_package',
      status: 'manual_review_pending',
      title: '已扫描共享包',
      assets: [{
        role: 'package', storageKey: 'private/scanned-package.zip', fileName: 'scanned-package.zip',
        declaredBytes: 20, actualBytes: 20, contentType: 'application/zip'
      }],
      moderationResults: [{
        kind: 'package_scan', provider: 'isolated-scanner', suggestion: 'Pass', label: '扫描通过',
        score: null,
        evidence: {
          submissionId: 'scanned-package',
          packageStorageKey: 'private/scanned-package.zip',
          packageSizeBytes: 20,
          archiveSizeBytes: 20,
          archiveSha256: 'a'.repeat(64),
          protocolVersion: '2026-08-15',
          ruleVersion: 'character-package-2026-08-15',
          completedAt: '2026-07-30T12:00:00.000Z',
          expiresAt: '2026-07-31T12:00:00.000Z',
          submissionStatusVersion: 3,
          scanCode: 'CHARACTER_PACKAGE_SCAN_PASSED'
        },
        createdAt: '2026-07-30T12:00:00.000Z'
      }]
    });
    setup({
      listQueue: vi.fn().mockResolvedValue(queuePage(pending)),
      getDetail: vi.fn().mockResolvedValue(pending)
    });

    fireEvent.click(await screen.findByText('已扫描共享包'));
    fireEvent.change(await screen.findByLabelText('审核理由'), {
      target: { value: '技术证据完整' }
    });

    expect((screen.getByRole('button', { name: '批准发布' }) as HTMLButtonElement).disabled)
      .toBe(false);
    expect(screen.queryByRole('button', { name: '强制发布' })).toBeNull();
    expect(screen.queryByText('技术扫描未明确通过，不能批准共享包。')).toBeNull();
  });

  it('建议投稿不依赖共享包技术证据且可提交批准', async () => {
    const pending = detail({ id: 'suggestion-1', kind: 'suggestion', title: '新增建议' });
    const { api } = setup({
      listQueue: vi.fn().mockResolvedValue(queuePage(pending)),
      getDetail: vi.fn().mockResolvedValue(pending)
    });

    fireEvent.click(await screen.findByText('新增建议'));
    fireEvent.change(await screen.findByLabelText('审核理由'), {
      target: { value: '建议符合主题' }
    });
    const approve = screen.getByRole('button', { name: '批准发布' });
    expect((approve as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(approve);

    await waitFor(() => expect(api.applyAction).toHaveBeenCalledWith(
      'access-token',
      'suggestion-1',
      expect.objectContaining({ action: 'approve', reason: '建议符合主题' })
    ));
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
    expect(screen.queryByRole('button', { name: '批准发布' })).toBeNull();
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

  it('队列失败只记录稳定错误码，不记录访问令牌或投稿内容', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setup({
      listQueue: vi.fn().mockRejectedValue(
        new ApiClientError('AUTH_SERVICE_UNAVAILABLE', 503)
      )
    });

    expect(await screen.findByText('审核队列暂时无法加载，请稍后重试。')).toBeTruthy();
    expect(warning).toHaveBeenCalledWith(
      '管理员接口请求失败 scope=queue code=AUTH_SERVICE_UNAVAILABLE status=503'
    );
    warning.mockRestore();
  });

  it('英文环境提供可访问的核心管理员文案', async () => {
    const row = detail({ title: 'English submission' });
    const api = {
      listQueue: vi.fn().mockResolvedValue(queuePage(row)),
      getDetail: vi.fn().mockResolvedValue(row),
      getOfficialWindowsDownloadClickCount: vi.fn().mockResolvedValue(12),
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
