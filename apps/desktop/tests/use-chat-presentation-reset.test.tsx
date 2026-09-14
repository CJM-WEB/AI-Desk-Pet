// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { ChatPresentationCommand, ChatPresentationIntent, ChatPresentationSnapshot } from '../src/shared/chat-presentation';
import { useChatPresentation } from '../src/renderer/src/chat/use-chat-presentation';

afterEach(cleanup);
const epoch = '11111111-1111-4111-8111-111111111111';
const nextEpoch = '22222222-2222-4222-8222-222222222222';
const confirmation: NonNullable<ChatPresentationSnapshot['confirmation']> = {
  id: 'permission-reused', kind: 'permission', title: '待授权操作', details: ['准确目标'],
  approveLabel: '授权', approveDescription: '确认访问目标', rejectDescription: '拒绝本次操作', busy: false, error: null
};

/** 模拟原业务仓库先更新、React 尚未提交新 props 的消息边界。 */
function setup() {
  let currentRevision = 2;
  let command: (value: ChatPresentationCommand) => void = () => undefined;
  let intent: (value: ChatPresentationIntent) => void = () => undefined;
  const api = { chatPresentation: {
    ready: vi.fn().mockResolvedValue({ epoch, revisionFloor: 10 }),
    publish: vi.fn().mockResolvedValue(undefined),
    onCommand: vi.fn(listener => { command = listener; return vi.fn(); }),
    onIntent: vi.fn(listener => { intent = listener; return vi.fn(); })
  } };
  const onConfirm = vi.fn(), onReject = vi.fn();
  const hook = renderHook(({ revision }) => {
    const options = { api: api as never, conversationRevision: revision, confirmation,
      readCurrentRevision: () => currentRevision, onConfirm, onReject };
    return useChatPresentation(options);
  }, { initialProps: { revision: 2 } });
  return { ...hook, api, onConfirm, onReject,
    updateCurrentRevision: (revision: number) => { currentRevision = revision; },
    command: (value: ChatPresentationCommand) => command(value),
    intent: (value: ChatPresentationIntent) => intent(value) };
}

test('清理仅抑制原会话确认，新会话合法同 ID 请求仍可展示', async () => {
  const view = setup();
  await act(async () => { await Promise.resolve(); });
  act(() => view.command({ type: 'reset', epoch: nextEpoch, revisionFloor: 20 }));
  expect(view.api.chatPresentation.publish.mock.lastCall![0].confirmation).toBeNull();
  view.updateCurrentRevision(3);
  view.rerender({ revision: 3 });
  expect(view.api.chatPresentation.publish.mock.lastCall![0]).toMatchObject({
    epoch: nextEpoch, conversationRevision: 3, confirmation
  });
});

test('业务会话已更新但 React props 尚未提交时，旧点击不能进入原处理器', async () => {
  const view = setup();
  await act(async () => { await Promise.resolve(); });
  const published = view.api.chatPresentation.publish.mock.lastCall![0];
  view.updateCurrentRevision(3);
  act(() => view.intent({ epoch: published.epoch, revision: published.revision,
    conversationRevision: 2, targetId: confirmation.id, action: 'confirm' }));
  expect(view.onConfirm).not.toHaveBeenCalled();
  expect(view.onReject).not.toHaveBeenCalled();
});
