// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ChatIsland } from '../src/renderer/src/chat/ChatIsland';

afterEach(() => { cleanup(); vi.useRealTimers(); });

function setup() {
  let command: (value: { type: string }) => void = () => undefined;
  const api = {
    setLayout: vi.fn().mockResolvedValue(undefined),
    onCommand: vi.fn((listener: typeof command) => { command = listener; return vi.fn(); })
  };
  const onNewConversation = vi.fn();
  const onSettings = vi.fn();
  render(<ChatIsland api={api as never} busy={false}
    onNewConversation={onNewConversation} onSettings={onSettings}
    history={<p>保留的完整对话</p>}
    input={<textarea aria-label="和我说点什么" />}
    send={<button type="submit" aria-label="发送给 AI Pet">发送</button>} />);
  return { api, onNewConversation, onSettings, command: (type: string) => act(() => command({ type })) };
}

test('顶边只露提示，点击后才展开三球输入', () => {
  vi.useFakeTimers();
  const view = setup();
  expect(screen.queryByRole('textbox')).toBeNull();
  view.command('peek');
  expect(screen.getByRole('button', { name: '打开聊天' })).toBeTruthy();
  expect(screen.queryByRole('textbox')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '打开聊天' }));
  expect(screen.getByRole('textbox')).toBeTruthy();
  act(() => vi.advanceTimersByTime(520));
  expect(document.querySelector('[data-island-mode="open"]')).toBeTruthy();
  expect(view.onNewConversation).not.toHaveBeenCalled();
});

test('菜单与历史独立开关，输入区域只关菜单', () => {
  vi.useFakeTimers();
  const view = setup();
  view.command('open');
  act(() => vi.advanceTimersByTime(520));
  fireEvent.click(screen.getByRole('button', { name: '选项' }));
  fireEvent.click(screen.getByRole('menuitem', { name: '历史' }));
  expect(screen.getByRole('region', { name: '历史对话' })).toBeTruthy();
  expect(screen.getByRole('menu')).toBeTruthy();
  fireEvent.pointerDown(screen.getByRole('textbox'));
  expect(screen.queryByRole('menu')).toBeNull();
  expect(screen.getByRole('region', { name: '历史对话' })).toBeTruthy();
  expect(document.querySelector('[data-island-mode="open"]')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '选项' }));
  fireEvent.click(screen.getByRole('menuitem', { name: '历史' }));
  expect(screen.queryByRole('region', { name: '历史对话' })).toBeNull();
});

test('外部关闭走反向动画并清菜单，不触发新对话', () => {
  vi.useFakeTimers();
  const view = setup();
  view.command('open');
  act(() => vi.advanceTimersByTime(520));
  fireEvent.click(screen.getByRole('button', { name: '选项' }));
  view.command('close');
  expect(document.querySelector('[data-island-mode="closing"]')).toBeTruthy();
  act(() => vi.advanceTimersByTime(520));
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByRole('menu')).toBeNull();
  expect(view.onNewConversation).not.toHaveBeenCalled();
  expect(view.onSettings).not.toHaveBeenCalled();
});

test('新对话和设置仍调用传入的原入口', () => {
  vi.useFakeTimers();
  const view = setup();
  view.command('open');
  act(() => vi.advanceTimersByTime(520));
  fireEvent.click(screen.getByRole('button', { name: '选项' }));
  fireEvent.click(screen.getByRole('menuitem', { name: '新对话' }));
  expect(view.onNewConversation).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: '选项' }));
  fireEvent.click(screen.getByRole('menuitem', { name: '设置' }));
  expect(view.onSettings).toHaveBeenCalledOnce();
});

test('关闭动画中再次打开，不被旧计时器重新隐藏', () => {
  vi.useFakeTimers();
  const view = setup();
  view.command('open');
  act(() => vi.advanceTimersByTime(520));
  view.command('close');
  act(() => vi.advanceTimersByTime(100));
  view.command('open');
  act(() => vi.advanceTimersByTime(520));
  expect(document.querySelector('[data-island-mode="open"]')).toBeTruthy();
  expect(screen.getByRole('textbox')).toBeTruthy();
});

test('气泡投递失败的新内容能唤出可操作的顶部回退', () => {
  vi.useFakeTimers();
  const api = { setLayout: vi.fn().mockResolvedValue(undefined), onCommand: vi.fn(() => vi.fn()) };
  render(<ChatIsland api={api} busy={false} attentionKey="failed-permission-1"
    onNewConversation={vi.fn()} onSettings={vi.fn()} history={null} input={<textarea />} send={<button>发送</button>} />);
  act(() => vi.advanceTimersByTime(520));
  expect(document.querySelector('[data-island-mode="open"]')).toBeTruthy();
});

test('会话清理后撤下历史与菜单，并重新上报输入区域', () => {
  vi.useFakeTimers();
  const view = setup();
  view.command('open'); act(() => vi.advanceTimersByTime(520));
  fireEvent.click(screen.getByRole('button', { name: '选项' }));
  fireEvent.click(screen.getByRole('menuitem', { name: '历史' }));
  const count = view.api.setLayout.mock.calls.length;
  view.command('reset');
  expect(screen.queryByRole('region', { name: '历史对话' })).toBeNull();
  expect(screen.queryByRole('menu')).toBeNull();
  expect(screen.getByRole('textbox')).toBeTruthy();
  expect(view.api.setLayout.mock.calls.length).toBeGreaterThan(count);
});
