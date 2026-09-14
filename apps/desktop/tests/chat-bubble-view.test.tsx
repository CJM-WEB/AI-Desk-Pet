// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ChatBubbleView } from '../src/renderer/src/chat/ChatBubbleView';
import type { ChatPresentationCommand, ChatPresentationSnapshot } from '../src/shared/chat-presentation';

afterEach(cleanup);

function setup() {
  let receive: (snapshot: ChatPresentationSnapshot | null) => void = () => undefined;
  let command: (value: ChatPresentationCommand) => void = () => undefined;
  const api = {
    onSnapshot: vi.fn((listener: typeof receive) => { receive = listener; return vi.fn(); }),
    onCommand: vi.fn((listener: typeof command) => { command = listener; return vi.fn(); }),
    ready: vi.fn().mockResolvedValue({ revisionFloor: 0 }),
    dispatch: vi.fn().mockResolvedValue(undefined),
    setLayout: vi.fn().mockResolvedValue(undefined)
  };
  render(<ChatBubbleView api={api as never} />);
  return { api, receive: (value: ChatPresentationSnapshot | null) => act(() => receive(value)), command: (value: ChatPresentationCommand) => act(() => command(value)) };
}

const snapshot: ChatPresentationSnapshot = {
  epoch: 'bubble-test-epoch', revision: 4, conversationRevision: 2, reply: { id: 'reply-one', text: '刚刚完成了你的请求。' },
  confirmation: null
};

test('只消费 Main 局部锚点改变尾部朝向，不改变正文或发出业务点击', () => {
  const view = setup(); view.receive(snapshot);
  view.command({ type: 'bubble-anchor', bodyLeft: 12, tailX: 38, side: 'top' } as never);
  const tail = document.querySelector('.speech-tail') as HTMLElement;
  expect(tail.getAttribute('data-side')).toBe('top');
  expect(tail.style.left).toBe('32px');
  expect(screen.getByText(snapshot.reply!.text)).toBeTruthy();
  expect(view.api.dispatch).not.toHaveBeenCalled();
});

test('气泡仅消费展示快照，关闭绑定当前消息和修订', async () => {
  const view = setup();
  view.receive(snapshot);
  expect(screen.getByText(snapshot.reply!.text)).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '关闭回复气泡' })));
  expect(view.api.dispatch).toHaveBeenCalledExactlyOnceWith({
    epoch: 'bubble-test-epoch', revision: 4, conversationRevision: 2, targetId: 'reply-one', action: 'dismiss-reply'
  });
  view.receive(null);
  expect(screen.queryByText(snapshot.reply!.text)).toBeNull();
});

test('覆盖授权默认一句话，展开原详情后仍以原身份回传决定', async () => {
  const view = setup();
  view.receive({ ...snapshot, confirmation: {
    id: 'permission-one', kind: 'permission', title: '明确文件编辑操作',
    details: ['D:\\project\\note.txt', '本次操作将覆盖已有文件，请核对目标。'],
    approveLabel: '覆盖', approveDescription: '确认覆盖文件', rejectDescription: '拒绝本次操作',
    busy: false, error: null
  } });
  expect(screen.queryByText(snapshot.reply!.text)).toBeNull();
  expect(screen.queryByText('D:\\project\\note.txt')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '明确文件编辑操作' }));
  expect(screen.getByText('D:\\project\\note.txt')).toBeTruthy();
  expect(screen.getByRole('button', { name: '确认覆盖文件' }).textContent).toBe('覆盖');
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '确认覆盖文件' })));
  expect(view.api.dispatch).toHaveBeenCalledExactlyOnceWith({
    epoch: 'bubble-test-epoch', revision: 4, conversationRevision: 2, targetId: 'permission-one', action: 'confirm'
  });
});

test('授权等待不使用普通回复的自动关闭计时', async () => {
  vi.useFakeTimers();
  try {
    const view = setup();
    view.receive({ ...snapshot, confirmation: {
      id: 'auth-one', kind: 'capability', title: '待授权操作', details: ['目录：D:\\project'],
      approveLabel: '授权', approveDescription: '授权并开始任务', rejectDescription: '拒绝进入任务',
      busy: true, error: null
    } });
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(screen.getByRole('button', { name: '待授权操作' })).toBeTruthy();
    expect((screen.getByRole('button', { name: '授权并开始任务' }) as HTMLButtonElement).disabled).toBe(true);
    expect(view.api.dispatch).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

test('气泡发送失败显示可重试提示，不在本地假装授权成功', async () => {
  const view = setup();
  view.api.dispatch.mockRejectedValueOnce(new Error('不可用'));
  view.receive(snapshot);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '关闭回复气泡' })));
  expect(screen.getByText('操作未送达，请重试。')).toBeTruthy();
  expect(screen.getByText(snapshot.reply!.text)).toBeTruthy();
});
