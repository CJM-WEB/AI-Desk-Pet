// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { TaskEvent } from '@myself/shared-types';
import type { ChatPresentationCommand, ChatPresentationIntent, ChatPresentationSnapshot } from '../src/shared/chat-presentation';
import { useChatPresentation } from '../src/renderer/src/chat/use-chat-presentation';

afterEach(cleanup);
const epoch = '11111111-1111-4111-8111-111111111111';
const confirmation: ChatPresentationSnapshot['confirmation'] = {
  id: 'permission-1', kind: 'permission', title: '待授权操作', details: ['完整命令'],
  approveLabel: '授权', approveDescription: '确认运行命令', rejectDescription: '拒绝本次操作', busy: false, error: null
};
function setup() {
  let event: (value: TaskEvent) => void = () => undefined;
  let intent: (value: ChatPresentationIntent) => void = () => undefined;
  let command: (value: ChatPresentationCommand) => void = () => undefined;
  const api = { onTaskEvent: vi.fn(listener => { event = listener; return vi.fn(); }), chatPresentation: {
    ready: vi.fn().mockResolvedValue({ epoch, revisionFloor: 10 }), publish: vi.fn().mockResolvedValue(undefined),
    onIntent: vi.fn(listener => { intent = listener; return vi.fn(); }), onCommand: vi.fn(listener => { command = listener; return vi.fn(); })
  } };
  const confirm = vi.fn(), reject = vi.fn();
  const hook = renderHook(({ revision, value }) => useChatPresentation({ api: api as never, conversationRevision: revision,
    confirmation: value, onConfirm: confirm, onReject: reject }), { initialProps: { revision: 2, value: confirmation } });
  return { ...hook, api, confirm, reject, event, intent, command };
}

test('握手后递增发布，只把匹配当前确认的点击交给原处理器', async () => {
  const view = setup();
  await act(async () => { await Promise.resolve(); });
  const published = view.api.chatPresentation.publish.mock.lastCall![0];
  expect(published).toMatchObject({ epoch, revision: 11, conversationRevision: 2, confirmation });
  act(() => view.intent({ ...published, targetId: confirmation!.id, action: 'confirm' }));
  expect(view.confirm).toHaveBeenCalledOnce();
  act(() => view.intent({ ...published, targetId: 'old-permission', action: 'reject' }));
  expect(view.reject).not.toHaveBeenCalled();
});

test('实时回复关闭只改变展示，不调用业务确认和拒绝', async () => {
  const view = setup();
  await act(async () => { await Promise.resolve(); });
  act(() => view.event({ type: 'message', role: 'assistant', text: '实时回复' }));
  const published = view.api.chatPresentation.publish.mock.lastCall![0];
  expect(published.reply.text).toBe('实时回复');
  act(() => view.intent({ ...published, targetId: published.reply.id, action: 'dismiss-reply' }));
  expect(view.api.chatPresentation.publish.mock.lastCall![0].reply).toBeNull();
  expect(view.confirm).not.toHaveBeenCalled();
  expect(view.reject).not.toHaveBeenCalled();
});

test('每段正文均发布新修订与累计文字，完成前不会等待整条回复', async () => {
  const view = setup();
  await act(async () => { await Promise.resolve(); });
  act(() => view.event({ type: 'assistant_message_start', turnId: 'stream' }));
  let text = '';
  let previousRevision = view.api.chatPresentation.publish.mock.lastCall![0].revision;
  for (const delta of ['你', '好，', '这是一段逐渐变长的回复。\n下一行继续。']) {
    text += delta;
    act(() => view.event({ type: 'assistant_message_delta', turnId: 'stream', delta }));
    const snapshot = view.api.chatPresentation.publish.mock.lastCall![0];
    expect(snapshot.reply).toEqual({ id: 'assistant-stream-stream', text });
    expect(snapshot.revision).toBeGreaterThan(previousRevision);
    previousRevision = snapshot.revision;
  }
  expect(view.confirm).not.toHaveBeenCalled();
  expect(view.reject).not.toHaveBeenCalled();
});

test('新展示代次清除旧回复并抑制旧确认，迟到握手不能回退代次', async () => {
  const view = setup();
  await act(async () => { await Promise.resolve(); });
  act(() => view.event({ type: 'message', role: 'assistant', text: '旧回复' }));
  act(() => view.command({ type: 'reset', epoch: '22222222-2222-4222-8222-222222222222', revisionFloor: 20 }));
  expect(view.api.chatPresentation.publish.mock.lastCall![0]).toMatchObject({ revision: 21, reply: null, confirmation: null });
  view.rerender({ revision: 3, value: { ...confirmation!, id: 'permission-new' } });
  expect(view.api.chatPresentation.publish.mock.lastCall![0].confirmation.id).toBe('permission-new');
});

test('气泡不可用或发布失败时保留完整原界面回退', async () => {
  const view = setup();
  await act(async () => { await Promise.resolve(); });
  act(() => view.command({ type: 'availability', available: true }));
  expect(view.result.current.fallback).toBe(false);
  view.api.chatPresentation.publish.mockRejectedValueOnce(new Error('过长'));
  await act(async () => view.event({ type: 'message', role: 'assistant', text: '完整正文' }));
  expect(view.result.current.fallback).toBe(true);
  expect(view.result.current.reply?.text).toBe('完整正文');
});

test('仅重建气泡时撤销旧回复，但原聊天待授权继续可见', async () => {
  const view = setup();
  await act(async () => { await Promise.resolve(); });
  act(() => view.event({ type: 'message', role: 'assistant', text: '不恢复的旧回复' }));
  act(() => view.command({ type: 'reset', epoch: 'new-bubble-epoch', revisionFloor: 20, preserveConfirmation: true } as never));
  expect(view.api.chatPresentation.publish.mock.lastCall![0]).toMatchObject({
    epoch: 'new-bubble-epoch', reply: null, confirmation
  });
});
