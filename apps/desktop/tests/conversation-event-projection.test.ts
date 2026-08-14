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

const validPowerShellActionEvent = {
  type: 'pending_action',
  action: {
    category: 'powershell',
    actionId: 'action-shell-1',
    conversationId: 'conversation-1',
    risk: 'shell',
    operation: 'powershell',
    summary: '运行测试命令',
    command: 'Write-Output safe',
    workingDirectoryLabel: '已授权工作目录',
    runMode: 'foreground',
    createdAt: '2026-08-15T00:00:00.000Z',
    expiresAt: '2026-08-15T00:05:00.000Z'
  }
} as const;

const validHistoryDisclosureEvent = {
  type: 'history_disclosure_required',
  requestId: 'request-1',
  targetProviderName: '目标模型',
  messageCount: 2,
  characterCount: 16
} as const;

const completeChatEvents = [
  { type: 'phase', phase: 'thinking' },
  { type: 'message', role: 'assistant', text: '安全正文' },
  validPendingFileActionEvent,
  validPowerShellActionEvent,
  { type: 'error', code: 'TASK_FAILED', message: '任务失败', nextAction: '请重试' },
  { type: 'character_emotion', label: 'calm' },
  { type: 'character_carrying', carrying: true },
  validHistoryDisclosureEvent,
  { type: 'conversation_reset', generation: 'generation-2' }
] as const;

describe('ConversationEventProjection', () => {
  test.each(completeChatEvents)('将完整的合法 %s 事件投递给聊天窗口', event => {
    const chat = target();
    const pet = target();
    const applyCharacterBehavior = vi.fn();
    const projection = new ConversationEventProjection({
      getChatTarget: () => chat,
      getPetTarget: () => pet,
      applyCharacterBehavior
    });

    expect(projection.publish(event)).toEqual(event);
    expect(chat.send).toHaveBeenCalledWith(ipcChannels.taskEvent, event);
    expect(applyCharacterBehavior).toHaveBeenCalledWith(event);
  });

  test('pet 只接收严格 phase，且不接收票据、命令、正文或披露请求', () => {
    const chat = target();
    const pet = target();
    const applyCharacterBehavior = vi.fn();
    const projection = new ConversationEventProjection({
      getChatTarget: () => chat,
      getPetTarget: () => pet,
      applyCharacterBehavior
    });
    const phase = { type: 'phase', phase: 'awaiting_confirmation' } as const;

    projection.publish(phase);
    expect(pet.send).toHaveBeenCalledWith(ipcChannels.taskEvent, phase);
    expect(pet.send.mock.calls[0]?.[1]).toStrictEqual({
      type: 'phase',
      phase: 'awaiting_confirmation'
    });

    pet.send.mockClear();
    for (const event of completeChatEvents.filter(event => event.type !== 'phase')) {
      projection.publish(event);
    }

    expect(pet.send).not.toHaveBeenCalled();
    expect(applyCharacterBehavior).toHaveBeenCalledWith(validPendingFileActionEvent);
    expect(applyCharacterBehavior).toHaveBeenCalledWith({
      type: 'character_carrying',
      carrying: true
    });
  });

  test('无效事件会在任何副作用前失败', () => {
    const chat = target();
    const pet = target();
    const applyCharacterBehavior = vi.fn();
    const projection = new ConversationEventProjection({
      getChatTarget: () => chat,
      getPetTarget: () => pet,
      applyCharacterBehavior
    });

    expect(() => projection.publish({ type: 'phase', phase: 'thinking', actionId: 'leak' }))
      .toThrow();
    expect(() => projection.publish({
      type: 'pending_action',
      action: { category: 'file', operation: 'create_file' }
    })).toThrow();
    expect(applyCharacterBehavior).not.toHaveBeenCalled();
    expect(chat.send).not.toHaveBeenCalled();
    expect(pet.send).not.toHaveBeenCalled();
  });

  test('跳过空或已销毁目标', () => {
    const destroyedChat = target(true);
    const projection = new ConversationEventProjection({
      getChatTarget: () => destroyedChat,
      getPetTarget: () => null,
      applyCharacterBehavior: vi.fn()
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
      applyCharacterBehavior: vi.fn(),
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
        applyCharacterBehavior: vi.fn(),
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
