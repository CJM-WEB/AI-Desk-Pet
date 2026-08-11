// @vitest-environment jsdom

import type { SubmissionReceipt } from '@myself/shared-types';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../components/i18n/I18nProvider';
import { SupportChapter } from '../components/website-experience/support/SupportChapter';
import type {
  FeedbackEntry,
  FeedbackKind,
  FeedbackRepository
} from '../components/website-experience/feedback/feedback-types';

function createEntry(kind: FeedbackKind): FeedbackEntry {
  return {
    id: `${kind}-1`,
    kind,
    authorId: 'author-1',
    authorName: '测试用户',
    content: kind === 'feedback' ? '这是一条用于测试的用户反馈。' : '这是一条用于测试的更新建议。',
    likeCount: 3,
    createdAt: '2026-08-01T08:00:00.000Z',
    updatedAt: '2026-08-01T08:00:00.000Z',
    source: 'local-user',
    likedByCurrentBrowser: false
  };
}

function createRepository() {
  const entries = [createEntry('feedback'), createEntry('suggestion')];
  const receipt: SubmissionReceipt = {
    submissionId: 'submission-1',
    statusToken: 'a'.repeat(43),
    statusPath: '/submission-status/',
    status: 'system_reviewing'
  };
  return {
    list: vi.fn((kind: FeedbackKind) => entries.filter((entry) => entry.kind === kind)),
    refresh: vi.fn(async () => undefined),
    create: vi.fn(async () => receipt),
    toggleLike: vi.fn(async (id: string) => entries.find((entry) => entry.id === id)!),
    subscribe: vi.fn(() => () => undefined)
  } satisfies FeedbackRepository;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('合并后的反馈与支持模块', () => {
  it('只渲染一个第五模块并提供三项反馈与三项支付入口', () => {
    render(<SupportChapter interactive repository={createRepository()} />);

    expect(screen.getByTestId('support-chapter')).toBeTruthy();
    expect(screen.getByRole('button', { name: '查看更新建议' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '查看用户反馈' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '新建投稿' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '打开微信付款码' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '打开支付宝付款码' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '打开PayPal付款码' })).toBeTruthy();
    expect(screen.getAllByTestId('pointer-tilt-text')).toHaveLength(2);
  });

  it('进入模块时刷新两类反馈快照', async () => {
    const repository = createRepository();
    render(<SupportChapter interactive repository={repository} />);

    await waitFor(() => {
      expect(repository.refresh).toHaveBeenCalledWith('feedback');
      expect(repository.refresh).toHaveBeenCalledWith('suggestion');
    });
  });

  it('点击反馈按钮直接打开对应列表面板', () => {
    render(<SupportChapter interactive repository={createRepository()} />);

    const feedbackButton = screen.getByRole('button', { name: '查看用户反馈' });
    fireEvent.click(feedbackButton);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(feedbackButton);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('这是一条用于测试的用户反馈。')).toBeTruthy();
  });

  it('点击支付按钮直接打开对应二维码面板', () => {
    render(<SupportChapter interactive repository={createRepository()} />);

    const alipayButton = screen.getByRole('button', { name: '打开支付宝付款码' });
    fireEvent.click(alipayButton);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(alipayButton);
    expect(screen.getByRole('dialog', { name: '支付宝付款码' })).toBeTruthy();
  });

  it('两组局部滚轮分别循环选中项且不影响另一组', () => {
    render(<SupportChapter interactive repository={createRepository()} />);
    const feedbackGroup = screen.getByRole('group', { name: '选择反馈操作' });
    const paymentGroup = screen.getByRole('group', { name: '选择付款方式' });

    fireEvent.wheel(feedbackGroup, { deltaY: 100 });
    expect(feedbackGroup.getAttribute('data-active-action')).toBe('feedback');
    expect(paymentGroup.getAttribute('data-active-payment')).toBe('wechat');

    fireEvent.wheel(paymentGroup, { deltaY: 100 });
    expect(paymentGroup.getAttribute('data-active-payment')).toBe('alipay');
  });

  it('左右按钮组共用景深层级，且只有清晰层可执行当前操作', () => {
    render(<SupportChapter interactive repository={createRepository()} />);

    const feedbackGroup = screen.getByRole('group', { name: '选择反馈操作' });
    const paymentGroup = screen.getByRole('group', { name: '选择付款方式' });

    for (const group of [feedbackGroup, paymentGroup]) {
      expect(group.querySelectorAll('[data-depth-index="0"]')).toHaveLength(1);
      expect(group.querySelectorAll('[data-depth-index="1"]')).toHaveLength(1);
      expect(group.querySelectorAll('[data-depth-index="2"]')).toHaveLength(1);
      expect(group.querySelectorAll('[data-active="true"]')).toHaveLength(1);
      expect(group.querySelector('[data-depth-index="0"]')?.getAttribute('aria-pressed')).toBe('true');
      expect(group.querySelector('[data-depth-index="0"]')?.getAttribute('data-blur-px')).toBe('0');
      expect(group.querySelector('[data-depth-index="1"]')?.getAttribute('data-blur-px')).toBe('2.5');
      expect(group.querySelector('[data-depth-index="2"]')?.getAttribute('data-blur-px')).toBe('5');
    }
  });

  it('反馈组后层首次点击只切换，清晰层点击才打开反馈业务', () => {
    render(<SupportChapter interactive repository={createRepository()} />);

    const feedbackGroup = screen.getByRole('group', { name: '选择反馈操作' });
    fireEvent.click(feedbackGroup.querySelector('[data-depth-index="1"]')!);

    expect(feedbackGroup.getAttribute('data-active-action')).toBe('feedback');
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(feedbackGroup.querySelector('[data-depth-index="0"]')!);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('付款组后层首次点击只切换，清晰层点击才打开付款业务', () => {
    render(<SupportChapter interactive repository={createRepository()} />);

    const paymentGroup = screen.getByRole('group', { name: '选择付款方式' });
    fireEvent.click(paymentGroup.querySelector('[data-depth-index="1"]')!);

    expect(paymentGroup.getAttribute('data-active-payment')).toBe('alipay');
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(paymentGroup.querySelector('[data-depth-index="0"]')!);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('新建投稿直接使用原反馈仓库接口', async () => {
    const repository = createRepository();
    render(<SupportChapter interactive repository={repository} />);

    const createButton = screen.getByRole('button', { name: '新建投稿' });
    fireEvent.click(createButton);
    fireEvent.click(createButton);
    fireEvent.change(screen.getByLabelText('正文'), {
      target: { value: '这是一段长度满足要求的新投稿正文。' }
    });
    fireEvent.click(screen.getByRole('button', { name: '发布投稿' }));

    await waitFor(() => expect(repository.create).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('投稿已收到，正在系统审核。')).toBeTruthy();
  });

  it('不可交互时六个入口全部禁用', () => {
    render(<SupportChapter interactive={false} repository={createRepository()} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(6);
    expect(buttons.every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
  });

  it('英文环境同步反馈与支付按钮文案', () => {
    render(
      <I18nProvider initialLocale="en">
        <SupportChapter interactive repository={createRepository()} />
      </I18nProvider>
    );

    expect(screen.getByRole('button', { name: 'View Feedback' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open PayPal QR code' })).toBeTruthy();
  });
});
