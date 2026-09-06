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

describe('ConversationEventProjection', () => {
  test('新任务许可的准确命令和目录只进入聊天，pet 仍只接收阶段', () => {
    const chat = target();
    const pet = target();
    const projection = new ConversationEventProjection({ getChatTarget: () => chat, getPetTarget: () => pet, behavior: { handleTaskEvent: vi.fn() } });
    const permission = { type: 'task_permission_required', actionId: 'permission-1', summary: '运行命令', request: { action: 'bash', command: 'pnpm.cmd test', cwd: 'D:\\project', resources: ['command-sha256:fixture'] } } as const;
    expect(projection.publish(permission)).toEqual(permission);
    expect(chat.send).toHaveBeenCalledWith(ipcChannels.taskEvent, permission);
    expect(pet.send).not.toHaveBeenCalled();
    projection.publish({ type: 'phase', phase: 'awaiting_confirmation' });
    expect(pet.send).toHaveBeenCalledExactlyOnceWith(ipcChannels.taskEvent, { type: 'phase', phase: 'awaiting_confirmation' });
  });
  test('同一 Director 先更新 blockers 再向窗口投影事件', () => {
    const order: string[] = [];
    const chat = target();
    const pet = target();
    chat.send.mockImplementation(() => { order.push('chat'); });
    pet.send.mockImplementation(() => { order.push('pet'); });
    const projection = new ConversationEventProjection({
      getChatTarget: () => chat,
      getPetTarget: () => pet,
      behavior: {
        handleTaskEvent: vi.fn(() => { order.push('blockers'); })
      }
    });

    projection.publish({ type: 'phase', phase: 'thinking' });

    expect(order).toEqual(['blockers', 'chat', 'pet']);
  });

  test('pet 只接收严格 phase 投影', () => {
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
