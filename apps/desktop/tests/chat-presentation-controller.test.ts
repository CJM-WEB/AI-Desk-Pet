import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ASSISTANT_STREAM_TEXT_MAX_CHARACTERS, type TaskEvent } from '@myself/shared-types';
import {
  ChatReplyPresentationController,
  type ChatReplyPresentation
} from '../src/renderer/src/chat/chat-presentation-controller';

function createController() {
  const changes: Array<ChatReplyPresentation | null> = [];
  const controller = new ChatReplyPresentationController({
    onChange: reply => changes.push(reply),
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout
  });
  return { controller, changes };
}

function startReply(controller: ChatReplyPresentationController, turnId = 'one', text = '你好') {
  controller.accept({ type: 'assistant_message_start', turnId });
  controller.accept({ type: 'assistant_message_delta', turnId, delta: text });
}

describe('普通回复气泡展示生命周期', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test('流式片段持续展示，正式提交后恰好三十秒消失', () => {
    const { controller, changes } = createController();
    startReply(controller, 'one', '你');
    controller.accept({ type: 'assistant_message_delta', turnId: 'one', delta: '好' });
    expect(controller.snapshot()).toMatchObject({ text: '你好' });
    const id = controller.snapshot()!.id;
    vi.advanceTimersByTime(90_000);
    expect(controller.snapshot()).toEqual({ id, text: '你好' });
    controller.accept({ type: 'assistant_message_commit', turnId: 'one', text: '你好呀' });
    vi.advanceTimersByTime(29_999);
    expect(controller.snapshot()).toEqual({ id, text: '你好呀' });
    vi.advanceTimersByTime(1);
    expect(controller.snapshot()).toBeNull();
    expect(changes.at(-1)).toBeNull();
  });

  test('普通助手消息使用独立身份，新回复替换并重新计时', () => {
    const { controller } = createController();
    controller.accept({ type: 'message', role: 'assistant', text: '第一条' });
    const firstId = controller.snapshot()!.id;
    vi.advanceTimersByTime(20_000);
    controller.accept({ type: 'message', role: 'assistant', text: '第二条' });
    const secondId = controller.snapshot()!.id;
    expect(secondId).not.toBe(firstId);
    vi.advanceTimersByTime(10_000);
    expect(controller.snapshot()).toEqual({ id: secondId, text: '第二条' });
    vi.advanceTimersByTime(19_999);
    expect(controller.snapshot()?.text).toBe('第二条');
    vi.advanceTimersByTime(1);
    expect(controller.snapshot()).toBeNull();
  });

  test('普通助手完整正文不受流式预算裁剪', () => {
    const { controller } = createController();
    const text = '完整正文'.repeat(2_000);
    controller.accept({ type: 'message', role: 'assistant', text });
    expect(controller.snapshot()?.text).toBe(text);
  });

  test('四千 Unicode 码点的合法流式回复持续显示且正常提交', () => {
    const { controller } = createController();
    startReply(controller, 'unicode', '😀'.repeat(2000));
    controller.accept({ type: 'assistant_message_delta', turnId: 'unicode', delta: '😀'.repeat(2000) });
    expect(controller.snapshot()?.text).toBe('😀'.repeat(4000));
    controller.accept({ type: 'assistant_message_commit', turnId: 'unicode', text: '😀'.repeat(4000) });
    expect(controller.snapshot()?.text).toBe('😀'.repeat(4000));
  });

  test('新流式回复取消旧回复倒计时且不接受旧流的增量与提交', () => {
    const { controller } = createController();
    startReply(controller, 'old', '旧回复');
    controller.accept({ type: 'assistant_message_commit', turnId: 'old', text: '旧回复' });
    vi.advanceTimersByTime(20_000);
    startReply(controller, 'new', '新回复');
    controller.accept({ type: 'assistant_message_delta', turnId: 'old', delta: '迟到' });
    controller.accept({ type: 'assistant_message_commit', turnId: 'old', text: '陈旧提交' });
    vi.advanceTimersByTime(90_000);
    expect(controller.snapshot()?.text).toBe('新回复');
  });

  test('普通消息替代未完成流后，迟到提交不能覆盖新气泡', () => {
    const { controller } = createController();
    startReply(controller, 'old');
    controller.accept({ type: 'message', role: 'assistant', text: '正式新消息' });
    controller.accept({ type: 'assistant_message_commit', turnId: 'old', text: '旧流提交' });
    expect(controller.snapshot()?.text).toBe('正式新消息');
  });

  test('关闭流式气泡后同条增量和提交不复活，新回复仍可显示', () => {
    const { controller, changes } = createController();
    startReply(controller);
    controller.dismiss(controller.snapshot()!.id);
    const changeCount = changes.length;
    controller.accept({ type: 'assistant_message_delta', turnId: 'one', delta: '后续' });
    controller.accept({ type: 'assistant_message_commit', turnId: 'one', text: '完整正文' });
    vi.advanceTimersByTime(30_000);
    expect(controller.snapshot()).toBeNull();
    expect(changes).toHaveLength(changeCount);
    startReply(controller, 'next', '下一条');
    expect(controller.snapshot()?.text).toBe('下一条');
  });

  test('陈旧关闭身份不能隐藏新回复，当前关闭会清理倒计时', () => {
    const { controller } = createController();
    controller.accept({ type: 'message', role: 'assistant', text: '旧回复' });
    const oldId = controller.snapshot()!.id;
    controller.accept({ type: 'message', role: 'assistant', text: '新回复' });
    controller.dismiss(oldId);
    expect(controller.snapshot()?.text).toBe('新回复');
    controller.dismiss(controller.snapshot()!.id);
    expect(controller.snapshot()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('已提交流不接受重复提交或迟到增量，也不延长原倒计时', () => {
    const { controller } = createController();
    startReply(controller);
    controller.accept({ type: 'assistant_message_commit', turnId: 'one', text: '完成' });
    vi.advanceTimersByTime(20_000);
    controller.accept({ type: 'assistant_message_commit', turnId: 'one', text: '重复' });
    controller.accept({ type: 'assistant_message_delta', turnId: 'one', delta: '迟到' });
    expect(controller.snapshot()?.text).toBe('完成');
    vi.advanceTimersByTime(10_000);
    expect(controller.snapshot()).toBeNull();
  });

  test.each(['thinking', 'idle', 'success', 'error', 'cancelled'] as const)('%s 阶段清理未提交流而不复活迟到提交', phase => {
    const { controller } = createController();
    startReply(controller);
    controller.accept({ type: 'phase', phase });
    controller.accept({ type: 'assistant_message_commit', turnId: 'one', text: '迟到' });
    expect(controller.snapshot()).toBeNull();
  });

  test('正式回复不因任务终态回落而消失或重新计时', () => {
    const { controller } = createController();
    startReply(controller);
    controller.accept({ type: 'assistant_message_commit', turnId: 'one', text: '正式回复' });
    vi.advanceTimersByTime(20_000);
    for (const phase of ['success', 'error', 'cancelled', 'idle'] as const) {
      controller.accept({ type: 'phase', phase });
    }
    expect(controller.snapshot()?.text).toBe('正式回复');
    vi.advanceTimersByTime(10_000);
    expect(controller.snapshot()).toBeNull();
  });

  test('错误事件清理未完成片段，但不生成错误气泡或清除已提交回复', () => {
    const { controller } = createController();
    const error: TaskEvent = { type: 'error', code: 'REQUEST_FAILED', message: '请求失败' };
    startReply(controller);
    controller.accept(error);
    expect(controller.snapshot()).toBeNull();
    controller.accept({ type: 'message', role: 'assistant', text: '已完成' });
    controller.accept(error);
    expect(controller.snapshot()?.text).toBe('已完成');
  });

  test.each([false, true])('会话重置清空气泡与计时，保留历史标志为 %s 时均不重放', preserveMessages => {
    const { controller } = createController();
    controller.accept({ type: 'message', role: 'assistant', text: '此前回复' });
    const oldId = controller.snapshot()!.id;
    controller.accept({ type: 'conversation_reset', generation: 'new', preserveMessages });
    expect(controller.snapshot()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    controller.accept({ type: 'message', role: 'assistant', text: '新会话' });
    expect(controller.snapshot()!.id).not.toBe(oldId);
    controller.dismiss(oldId);
    expect(controller.snapshot()?.text).toBe('新会话');
  });

  test('会话重置退役当前流，迟到增量和提交不能生成气泡', () => {
    const { controller } = createController();
    startReply(controller);
    controller.accept({ type: 'conversation_reset', generation: 'new' });
    controller.accept({ type: 'assistant_message_delta', turnId: 'one', delta: '迟到' });
    controller.accept({ type: 'assistant_message_commit', turnId: 'one', text: '旧会话' });
    expect(controller.snapshot()).toBeNull();
  });

  test('新建控制器不重放历史，用户消息、角色状态与许可事件不产生回复', () => {
    const { controller, changes } = createController();
    const events: TaskEvent[] = [
      { type: 'message', role: 'user', text: '你好' },
      { type: 'phase', phase: 'thinking' },
      { type: 'character_emotion', label: 'happy' },
      { type: 'character_carrying', carrying: true },
      { type: 'history_disclosure_required', requestId: 'history', targetProviderName: '模型', messageCount: 2, characterCount: 10 },
      { type: 'assistant_message_delta', turnId: 'unknown', delta: '没有起点' },
      { type: 'assistant_message_commit', turnId: 'unknown', text: '没有起点' }
    ];
    for (const event of events) controller.accept(event);
    vi.advanceTimersByTime(30_000);
    expect(controller.snapshot()).toBeNull();
    expect(changes).toEqual([]);
  });

  test('等待许可不重置普通回复计时，也不会把许可内容变成普通气泡', () => {
    const { controller } = createController();
    controller.accept({ type: 'message', role: 'assistant', text: '已完成回复' });
    vi.advanceTimersByTime(20_000);
    controller.accept({ type: 'history_disclosure_required', requestId: 'history', targetProviderName: '模型', messageCount: 2, characterCount: 10 });
    controller.accept({ type: 'phase', phase: 'awaiting_confirmation' });
    expect(controller.snapshot()?.text).toBe('已完成回复');
    vi.advanceTimersByTime(10_000);
    expect(controller.snapshot()).toBeNull();
  });

  test('超过既有累计流式预算的片段被退役，后续提交不能复活', () => {
    const { controller } = createController();
    startReply(controller, 'one', '字'.repeat(ASSISTANT_STREAM_TEXT_MAX_CHARACTERS));
    controller.accept({ type: 'assistant_message_delta', turnId: 'one', delta: '超出' });
    controller.accept({ type: 'assistant_message_commit', turnId: 'one', text: '晚到提交' });
    expect(controller.snapshot()).toBeNull();
  });

  test('销毁清理计时与快照，迟到事件和关闭不再通知界面', () => {
    const { controller, changes } = createController();
    controller.accept({ type: 'message', role: 'assistant', text: '待关闭' });
    const id = controller.snapshot()!.id;
    const changeCount = changes.length;
    controller.dispose();
    expect(controller.snapshot()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    controller.accept({ type: 'message', role: 'assistant', text: '迟到' });
    controller.dismiss(id);
    controller.dispose();
    vi.advanceTimersByTime(30_000);
    expect(changes).toHaveLength(changeCount);
  });
});
