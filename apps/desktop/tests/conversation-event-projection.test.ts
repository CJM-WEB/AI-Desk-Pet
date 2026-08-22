import type { TaskEvent } from '@myself/shared-types';
import { describe, expect, test, vi } from 'vitest';
import { ConversationEventProjection } from '../src/main/conversation/conversation-event-projection';
import { ipcChannels } from '../src/shared/ipc-channels';

function target(destroyed = false) {
  return {
    isDestroyed: vi.fn(() => destroyed),
    send: vi.fn()
  };
}

const validPendingFileActionEvent = {
  type: 'pending_action',
  action: {
    category: 'file',
    actionId: 'action-file-1',
    conversationId: 'conversation-1',
    risk: 'write',
    operation: 'create_file',
    summary: '创建测试文件',
    targetRelativePath: 'safe.txt',
    contentCharacters: 4,
    contentPreview: 'safe',
    contentPreviewSuppressedReason: null,
    previewTruncated: false,
    createdAt: '2026-08-15T00:00:00.000Z',
    expiresAt: '2026-08-15T00:05:00.000Z'
  }
} as const;

describe('ConversationEventProjection', () => {
  test('pending_action 完整进入聊天窗口与主进程行为，且不投递给宠物窗口', () => {
    const chat = target();
    const pet = target();
    const behavior = { handleTaskEvent: vi.fn() };
    const projection = new ConversationEventProjection({
      getChatTarget: () => chat,
      getPetTarget: () => pet,
      behavior
    });

    expect(projection.publish(validPendingFileActionEvent)).toEqual(validPendingFileActionEvent);
    expect(chat.send).toHaveBeenCalledWith(ipcChannels.taskEvent, validPendingFileActionEvent);
    expect(behavior.handleTaskEvent).toHaveBeenCalledWith(validPendingFileActionEvent);
    expect(pet.send).not.toHaveBeenCalled();
  });

  test('pet 只接收严格 phase，且不接收票据、命令、正文或披露请求', () => {
    const chat = target();
    const pet = target();
    const behavior = { handleTaskEvent: vi.fn() };
    const projection = new ConversationEventProjection({
      getChatTarget: () => chat,
      getPetTarget: () => pet,
      behavior
    });
    const phase = { type: 'phase', phase: 'awaiting_confirmation' } as const;

    projection.publish(phase);
    expect(pet.send).toHaveBeenCalledWith(ipcChannels.taskEvent, phase);
    expect(pet.send.mock.calls[0]?.[1]).toStrictEqual({
      type: 'phase',
      phase: 'awaiting_confirmation'
    });

    pet.send.mockClear();
    projection.publish(validPendingFileActionEvent);

    expect(pet.send).not.toHaveBeenCalled();
    expect(behavior.handleTaskEvent).toHaveBeenCalledWith(validPendingFileActionEvent);
  });

  test('无效事件会在任何副作用前失败', () => {
    const chat = target();
    const pet = target();
    const behavior = { handleTaskEvent: vi.fn() };
    const projection = new ConversationEventProjection({
      getChatTarget: () => chat,
      getPetTarget: () => pet,
      behavior
    });

    expect(() => projection.publish({ type: 'phase', phase: 'thinking', actionId: 'leak' }))
      .toThrow();
    expect(() => projection.publish({
      type: 'pending_action',
      action: { category: 'file', operation: 'create_file' }
    })).toThrow();
    expect(behavior.handleTaskEvent).not.toHaveBeenCalled();
    expect(chat.send).not.toHaveBeenCalled();
    expect(pet.send).not.toHaveBeenCalled();
  });

  test('跳过空或已销毁目标', () => {
    const destroyedChat = target(true);
    const projection = new ConversationEventProjection({
      getChatTarget: () => destroyedChat,
      getPetTarget: () => null,
      behavior: { handleTaskEvent: vi.fn() }
    });

    projection.publish({ type: 'phase', phase: 'thinking' });

    expect(destroyedChat.isDestroyed).toHaveBeenCalledOnce();
    expect(destroyedChat.send).not.toHaveBeenCalled();
  });

  test('目标发送失败按窗口隔离报告，且不包含事件或异常', () => {
    const chat = target();
    const pet = target();
    chat.send.mockImplementation(() => { throw new Error('PRIVATE_PAYLOAD'); });
    const reportDeliveryFailure = vi.fn();
    const projection = new ConversationEventProjection({
      getChatTarget: () => chat,
      getPetTarget: () => pet,
      behavior: { handleTaskEvent: vi.fn() },
      reportDeliveryFailure
    });
    const phase: TaskEvent = { type: 'phase', phase: 'thinking' };

    projection.publish(phase);

    expect(reportDeliveryFailure).toHaveBeenCalledWith('chat');
    expect(reportDeliveryFailure).toHaveBeenCalledTimes(1);
    expect(pet.send).toHaveBeenCalledWith(ipcChannels.taskEvent, {
      type: 'phase',
      phase: 'thinking'
    });
  });

  test.each(['chat', 'pet'] as const)(
    '报告器对 %s 发送失败抛错时仍隔离另一个窗口',
    failedTarget => {
      const chat = target();
      const pet = target();
      const failed = failedTarget === 'chat' ? chat : pet;
      const delivered = failedTarget === 'chat' ? pet : chat;
      failed.send.mockImplementation(() => { throw new Error('PRIVATE_PAYLOAD'); });
      const reportDeliveryFailure = vi.fn(() => { throw new Error('REPORTER_FAILED'); });
      const projection = new ConversationEventProjection({
        getChatTarget: () => chat,
        getPetTarget: () => pet,
        behavior: { handleTaskEvent: vi.fn() },
        reportDeliveryFailure
      });
      const phase: TaskEvent = { type: 'phase', phase: 'thinking' };
      let result: TaskEvent | undefined;

      expect(() => { result = projection.publish(phase); }).not.toThrow();

      expect(result).toStrictEqual(phase);
      expect(reportDeliveryFailure).toHaveBeenCalledWith(failedTarget);
      expect(delivered.send).toHaveBeenCalledWith(ipcChannels.taskEvent, {
        type: 'phase',
        phase: 'thinking'
      });
    }
  );
});
